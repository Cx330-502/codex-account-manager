import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  computeSnapshotHash,
  deriveAccountIdentity,
} from "./auth";
import type {
  AccountRecord,
  AccountRegistry,
  AccountSource,
  CodexAuthFile,
  ExportBundle,
  ManagedAccount,
  RuntimeState,
  SharedStateInfo,
  SwitchMarker,
  UsageSnapshot,
  WindowSessionRecord,
} from "./types";

const REGISTRY_VERSION = 1 as const;
const RUNTIME_STATE_VERSION = 1 as const;
const WINDOW_SESSION_STALE_MS = 2 * 60_000;
const RUNTIME_LOCK_STALE_MS = 30_000;
const RUNTIME_LOCK_WAIT_MS = 3_000;

export class CodexAccountStore {
  public readonly authPath: string;
  public readonly managerRoot: string;
  public readonly accountsRoot: string;
  public readonly registryPath: string;
  public readonly runtimeStatePath: string;
  public readonly sessionsPath: string;
  public readonly memoriesPath: string;
  public readonly sqlitePath: string;

  public constructor(public readonly codexHome: string) {
    this.authPath = path.join(this.codexHome, "auth.json");
    this.managerRoot = path.join(this.codexHome, "account-manager");
    this.accountsRoot = path.join(this.managerRoot, "accounts");
    this.registryPath = path.join(this.managerRoot, "registry.json");
    this.runtimeStatePath = path.join(this.managerRoot, "runtime.json");
    this.sessionsPath = path.join(this.codexHome, "sessions");
    this.memoriesPath = path.join(this.codexHome, "memories");
    this.sqlitePath = path.join(this.codexHome, "state_5.sqlite");
  }

  public async ensureReady(): Promise<void> {
    await fs.mkdir(this.accountsRoot, { recursive: true, mode: 0o700 });
  }

  public async readCurrentAuth(): Promise<CodexAuthFile | null> {
    return this.readJsonFile<CodexAuthFile>(this.authPath);
  }

  public async captureCurrentAuth(source: AccountSource): Promise<AccountRecord | null> {
    const auth = await this.readCurrentAuth();
    if (!auth) {
      return null;
    }

    return this.saveSnapshotFromAuth(auth, source);
  }

  public async saveSnapshotFromAuth(
    auth: CodexAuthFile,
    source: AccountSource,
    importedRecord?: Partial<AccountRecord>,
  ): Promise<AccountRecord> {
    await this.ensureReady();

    const identity = deriveAccountIdentity(auth);
    const registry = await this.readRegistry();
    const existingRecord =
      registry.accounts.find((record) => record.id === identity.fingerprint) ?? null;
    const now = new Date().toISOString();
    const snapshotHash = computeSnapshotHash(auth);
    const nextRecord: AccountRecord = {
      id: identity.fingerprint,
      label: existingRecord?.label ?? importedRecord?.label,
      email: identity.email ?? importedRecord?.email ?? existingRecord?.email,
      name: identity.name ?? importedRecord?.name ?? existingRecord?.name,
      subject:
        identity.subject ?? importedRecord?.subject ?? existingRecord?.subject,
      accountId:
        identity.accountId ?? importedRecord?.accountId ?? existingRecord?.accountId,
      chatgptAccountId:
        identity.chatgptAccountId ??
        importedRecord?.chatgptAccountId ??
        existingRecord?.chatgptAccountId,
      authMode:
        identity.authMode ?? importedRecord?.authMode ?? existingRecord?.authMode,
      createdAt: existingRecord?.createdAt ?? importedRecord?.createdAt ?? now,
      updatedAt: now,
      lastCapturedAt:
        source === "import"
          ? importedRecord?.lastCapturedAt ?? existingRecord?.lastCapturedAt ?? now
          : now,
      lastUsedAt:
        existingRecord?.lastUsedAt ??
        importedRecord?.lastUsedAt ??
        (source === "manual" ? now : undefined),
      source: existingRecord?.source ?? importedRecord?.source ?? source,
      snapshotHash,
      usage: importedRecord?.usage ?? existingRecord?.usage,
      usageCheckedAt:
        importedRecord?.usageCheckedAt ??
        existingRecord?.usageCheckedAt ??
        importedRecord?.usage?.fetchedAt ??
        existingRecord?.usage?.fetchedAt ??
        null,
      usageError: importedRecord?.usageError ?? existingRecord?.usageError ?? null,
    };

    await this.writeJsonFile(this.getSnapshotPath(nextRecord.id), auth);

    const nextAccounts = registry.accounts.filter(
      (record) => record.id !== nextRecord.id,
    );
    nextAccounts.push(nextRecord);
    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });

    return nextRecord;
  }

  public async listAccounts(): Promise<ManagedAccount[]> {
    await this.ensureReady();

    const registry = await this.readRegistry();
    const currentAuth = await this.readCurrentAuth();
    const currentFingerprint = currentAuth
      ? deriveAccountIdentity(currentAuth).fingerprint
      : null;
    const managedAccounts: ManagedAccount[] = [];

    for (const record of registry.accounts) {
      const auth = await this.readJsonFile<CodexAuthFile>(this.getSnapshotPath(record.id));
      if (!auth) {
        continue;
      }

      managedAccounts.push({
        record,
        auth,
        isActive: record.id === currentFingerprint,
        snapshotPath: this.getSnapshotPath(record.id),
      });
    }

    managedAccounts.sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }

      const leftSortKey = left.record.lastUsedAt ?? left.record.updatedAt;
      const rightSortKey = right.record.lastUsedAt ?? right.record.updatedAt;
      return rightSortKey.localeCompare(leftSortKey);
    });

    return managedAccounts;
  }

  public async readAccountAuth(id: string): Promise<CodexAuthFile> {
    const auth = await this.readJsonFile<CodexAuthFile>(this.getSnapshotPath(id));
    if (!auth) {
      throw new Error(`Account snapshot not found: ${id}`);
    }

    return auth;
  }

  public async switchToAccount(id: string): Promise<AccountRecord> {
    await this.ensureReady();

    const currentAuth = await this.readCurrentAuth();
    if (currentAuth) {
      await this.saveSnapshotFromAuth(currentAuth, "auto");
    }

    const auth = await this.readAccountAuth(id);
    await this.writeJsonFile(this.authPath, auth);

    const registry = await this.readRegistry();
    const now = new Date().toISOString();
    const nextAccounts = registry.accounts.map((record) => {
      if (record.id !== id) {
        return record;
      }

      return {
        ...record,
        updatedAt: now,
        lastUsedAt: now,
      };
    });

    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });

    const updatedRecord = nextAccounts.find((record) => record.id === id);
    if (!updatedRecord) {
      throw new Error(`Managed account not found: ${id}`);
    }

    return updatedRecord;
  }

  public async renameAccount(id: string, label: string | undefined): Promise<AccountRecord> {
    const registry = await this.readRegistry();
    const normalizedLabel = label?.trim();
    const nextAccounts = registry.accounts.map((record) => {
      if (record.id !== id) {
        return record;
      }

      return {
        ...record,
        label: normalizedLabel && normalizedLabel.length > 0 ? normalizedLabel : undefined,
        updatedAt: new Date().toISOString(),
      };
    });

    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });

    const updatedRecord = nextAccounts.find((record) => record.id === id);
    if (!updatedRecord) {
      throw new Error(`Managed account not found: ${id}`);
    }

    return updatedRecord;
  }

  public async removeAccount(id: string): Promise<void> {
    const registry = await this.readRegistry();
    const nextAccounts = registry.accounts.filter((record) => record.id !== id);

    await fs.rm(this.getSnapshotPath(id), { force: true });
    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });
  }

  public async setUsage(
    id: string,
    usage: UsageSnapshot | undefined,
    usageError: string | null,
  ): Promise<void> {
    const registry = await this.readRegistry();
    const checkedAt = new Date().toISOString();
    const nextAccounts = registry.accounts.map((record) => {
      if (record.id !== id) {
        return record;
      }

      return {
        ...record,
        updatedAt: checkedAt,
        usage,
        usageCheckedAt: checkedAt,
        usageError,
      };
    });

    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });
  }

  public async updateAccountAuth(id: string, auth: CodexAuthFile): Promise<void> {
    await this.ensureReady();

    const identity = deriveAccountIdentity(auth);
    await this.writeJsonFile(this.getSnapshotPath(id), auth);

    const currentAuth = await this.readCurrentAuth();
    const currentFingerprint = currentAuth
      ? deriveAccountIdentity(currentAuth).fingerprint
      : null;
    if (currentFingerprint === id) {
      await this.writeJsonFile(this.authPath, auth);
    }

    const registry = await this.readRegistry();
    const now = new Date().toISOString();
    const nextAccounts = registry.accounts.map((record) => {
      if (record.id !== id) {
        return record;
      }

      return {
        ...record,
        updatedAt: now,
        email: identity.email ?? record.email,
        name: identity.name ?? record.name,
        subject: identity.subject ?? record.subject,
        accountId: identity.accountId ?? record.accountId,
        chatgptAccountId: identity.chatgptAccountId ?? record.chatgptAccountId,
        authMode: identity.authMode ?? record.authMode,
      };
    });

    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });
  }

  public async replaceAccountAuth(
    targetId: string,
    auth: CodexAuthFile,
  ): Promise<AccountRecord> {
    await this.ensureReady();

    const registry = await this.readRegistry();
    const targetRecord = registry.accounts.find((record) => record.id === targetId);
    if (!targetRecord) {
      throw new Error(`Managed account not found: ${targetId}`);
    }

    const identity = deriveAccountIdentity(auth);
    const nextId = identity.fingerprint;
    const mergedAt = new Date().toISOString();
    const existingAtNextId = registry.accounts.find(
      (record) => record.id === nextId && record.id !== targetId,
    );
    const nextRecord: AccountRecord = {
      ...targetRecord,
      id: nextId,
      updatedAt: mergedAt,
      lastCapturedAt: mergedAt,
      snapshotHash: computeSnapshotHash(auth),
      email: identity.email ?? targetRecord.email,
      name: identity.name ?? targetRecord.name,
      subject: identity.subject ?? targetRecord.subject,
      accountId: identity.accountId ?? targetRecord.accountId,
      chatgptAccountId: identity.chatgptAccountId ?? targetRecord.chatgptAccountId,
      authMode: identity.authMode ?? targetRecord.authMode,
      usage: undefined,
      usageCheckedAt: null,
      usageError: null,
    };

    await this.writeJsonFile(this.getSnapshotPath(nextId), auth);
    if (targetId !== nextId) {
      await fs.rm(this.getSnapshotPath(targetId), { force: true });
    }
    if (existingAtNextId && existingAtNextId.id !== targetId) {
      await fs.rm(this.getSnapshotPath(existingAtNextId.id), { force: true });
    }

    const nextAccounts = registry.accounts.filter(
      (record) => record.id !== targetId && record.id !== existingAtNextId?.id,
    );
    nextAccounts.push(nextRecord);
    await this.writeRegistry({
      version: REGISTRY_VERSION,
      accounts: nextAccounts,
    });

    return nextRecord;
  }

  public async exportBundle(targetPath: string): Promise<number> {
    const registry = await this.readRegistry();
    const accounts = [];

    for (const record of registry.accounts) {
      const auth = await this.readJsonFile<CodexAuthFile>(this.getSnapshotPath(record.id));
      if (!auth) {
        continue;
      }

      accounts.push({
        record,
        auth,
      });
    }

    const bundle: ExportBundle = {
      version: REGISTRY_VERSION,
      exportedAt: new Date().toISOString(),
      accounts,
    };
    await this.writeJsonFile(targetPath, bundle);
    return accounts.length;
  }

  public async importBundle(sourcePath: string): Promise<number> {
    const bundle = await this.readJsonFile<ExportBundle>(sourcePath);
    if (!bundle || bundle.version !== REGISTRY_VERSION || !Array.isArray(bundle.accounts)) {
      throw new Error("Invalid account bundle.");
    }

    let importedCount = 0;
    for (const entry of bundle.accounts) {
      if (!entry || typeof entry !== "object" || !entry.auth || !entry.record) {
        continue;
      }

      await this.saveSnapshotFromAuth(entry.auth, "import", entry.record);
      importedCount += 1;
    }

    return importedCount;
  }

  public getSharedStateInfo(): SharedStateInfo {
    return {
      codexHome: this.codexHome,
      authPath: this.authPath,
      registryPath: this.registryPath,
      runtimeStatePath: this.runtimeStatePath,
      sessionsPath: this.sessionsPath,
      memoriesPath: this.memoriesPath,
      sqlitePath: this.sqlitePath,
    };
  }

  public async getRuntimeState(): Promise<RuntimeState> {
    const runtime = await this.readRuntimeState();
    return runtime.state;
  }

  public async registerWindowSession(
    windowId: string,
    runtimeAccountId: string | null,
  ): Promise<void> {
    await this.withRuntimeStateLock(async () => {
      const { state } = await this.readRuntimeState();
      const now = new Date().toISOString();
      const generation = state.lastSwitch?.generation ?? 0;
      const nextSession: WindowSessionRecord = {
        id: windowId,
        startedAt: now,
        lastSeenAt: now,
        runtimeAccountId,
        acknowledgedSwitchGeneration: generation,
      };
      state.windowSessions = state.windowSessions.filter((session) => session.id !== windowId);
      state.windowSessions.push(nextSession);
      await this.writeRuntimeState(state);
    });
  }

  public async heartbeatWindowSession(windowId: string): Promise<void> {
    await this.withRuntimeStateLock(async () => {
      const { state } = await this.readRuntimeState();
      const session = state.windowSessions.find((entry) => entry.id === windowId);
      if (!session) {
        return;
      }

      session.lastSeenAt = new Date().toISOString();
      await this.writeRuntimeState(state);
    });
  }

  public async removeWindowSession(windowId: string): Promise<void> {
    await this.withRuntimeStateLock(async () => {
      const { state } = await this.readRuntimeState();
      const nextSessions = state.windowSessions.filter((session) => session.id !== windowId);
      if (nextSessions.length === state.windowSessions.length) {
        return;
      }
      state.windowSessions = nextSessions;
      await this.writeRuntimeState(state);
    });
  }

  public async recordSwitch(
    previousAccountId: string | null,
    nextAccountId: string | null,
  ): Promise<SwitchMarker> {
    return this.withRuntimeStateLock(async () => {
      const { state } = await this.readRuntimeState();
      const marker: SwitchMarker = {
        generation: (state.lastSwitch?.generation ?? 0) + 1,
        previousAccountId,
        nextAccountId,
        switchedAt: new Date().toISOString(),
      };
      state.lastSwitch = marker;
      await this.writeRuntimeState(state);
      return marker;
    });
  }

  public async tryAcquireUsageRefreshLease(
    windowId: string,
    leaseMs: number,
  ): Promise<boolean> {
    return this.withRuntimeStateLock(async () => {
      const { state } = await this.readRuntimeState();
      const nowMs = Date.now();
      const activeLease = state.usageRefreshLease;
      if (activeLease) {
        const expiresAtMs = Date.parse(activeLease.expiresAt);
        if (
          activeLease.ownerWindowId !== windowId &&
          Number.isFinite(expiresAtMs) &&
          expiresAtMs > nowMs
        ) {
          return false;
        }
      }

      state.usageRefreshLease = {
        ownerWindowId: windowId,
        acquiredAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + leaseMs).toISOString(),
      };
      await this.writeRuntimeState(state);
      return true;
    });
  }

  public async releaseUsageRefreshLease(windowId: string): Promise<void> {
    await this.withRuntimeStateLock(async () => {
      const { state } = await this.readRuntimeState();
      if (state.usageRefreshLease?.ownerWindowId !== windowId) {
        return;
      }
      state.usageRefreshLease = null;
      await this.writeRuntimeState(state);
    });
  }

  private async readRegistry(): Promise<AccountRegistry> {
    const registry = await this.readJsonFile<AccountRegistry>(this.registryPath);
    if (!registry) {
      return {
        version: REGISTRY_VERSION,
        accounts: [],
      };
    }

    if (registry.version !== REGISTRY_VERSION || !Array.isArray(registry.accounts)) {
      throw new Error("Invalid Codex account registry format.");
    }

    return registry;
  }

  private async writeRegistry(registry: AccountRegistry): Promise<void> {
    const sortedAccounts = [...registry.accounts].sort((left, right) => {
      return left.createdAt.localeCompare(right.createdAt);
    });
    await this.writeJsonFile(this.registryPath, {
      version: REGISTRY_VERSION,
      accounts: sortedAccounts,
    });
  }

  private getSnapshotPath(id: string): string {
    return path.join(this.accountsRoot, `${id}.json`);
  }

  private async readRuntimeState(): Promise<{
    state: RuntimeState;
  }> {
    const runtime = await this.readRuntimeStateFile();
    const normalizedState = this.normalizeRuntimeState(runtime);
    return {
      state: normalizedState,
    };
  }

  private normalizeRuntimeState(runtime: RuntimeState | null): RuntimeState {
    const baseState: RuntimeState =
      runtime &&
      runtime.version === RUNTIME_STATE_VERSION &&
      Array.isArray(runtime.windowSessions)
        ? runtime
        : {
            version: RUNTIME_STATE_VERSION,
            lastSwitch: null,
            windowSessions: [],
            usageRefreshLease: null,
          };

    const nowMs = Date.now();
    const windowSessions = baseState.windowSessions.filter((session) => {
      const lastSeenAtMs = Date.parse(session.lastSeenAt);
      return Number.isFinite(lastSeenAtMs) && nowMs - lastSeenAtMs <= WINDOW_SESSION_STALE_MS;
    });

    const lease = baseState.usageRefreshLease;
    const leaseExpiresAtMs = lease ? Date.parse(lease.expiresAt) : NaN;

    return {
      version: RUNTIME_STATE_VERSION,
      lastSwitch: baseState.lastSwitch ?? null,
      windowSessions,
      usageRefreshLease:
        lease && Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs > nowMs
          ? lease
          : null,
    };
  }

  private async writeRuntimeState(runtime: RuntimeState): Promise<void> {
    const sortedSessions = [...runtime.windowSessions].sort((left, right) => {
      return left.startedAt.localeCompare(right.startedAt);
    });
    await this.writeJsonFile(this.runtimeStatePath, {
      ...runtime,
      version: RUNTIME_STATE_VERSION,
      windowSessions: sortedSessions,
    });
  }

  private async readRuntimeStateFile(): Promise<RuntimeState | null> {
    try {
      return await this.readJsonFile<RuntimeState>(this.runtimeStatePath);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }

      const recovered = await this.tryRecoverRuntimeState();
      if (recovered) {
        return recovered;
      }
      return null;
    }
  }

  private async tryRecoverRuntimeState(): Promise<RuntimeState | null> {
    let raw = "";
    try {
      raw = await fs.readFile(this.runtimeStatePath, "utf8");
    } catch {
      return null;
    }

    const recovered = parseLeadingJsonObject<RuntimeState>(raw);
    if (!recovered) {
      return null;
    }

    try {
      const backupPath = `${this.runtimeStatePath}.corrupt-${Date.now()}.json`;
      await fs.rename(this.runtimeStatePath, backupPath);
    } catch {
      // Best effort backup only.
    }

    await this.writeJsonFile(this.runtimeStatePath, recovered);
    return recovered;
  }

  private async withRuntimeStateLock<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = `${this.runtimeStatePath}.lock`;
    const startedAt = Date.now();
    while (true) {
      const lockHandle = await this.tryAcquireLockFile(lockPath);
      if (lockHandle) {
        try {
          return await task();
        } finally {
          await this.releaseLockFile(lockHandle, lockPath);
        }
      }

      await this.clearStaleLock(lockPath);
      if (Date.now() - startedAt > RUNTIME_LOCK_WAIT_MS) {
        throw new Error("Timed out waiting for runtime state lock.");
      }
      await sleep(25);
    }
  }

  private async tryAcquireLockFile(filePath: string): Promise<fs.FileHandle | null> {
    try {
      return await fs.open(filePath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
      ) {
        return null;
      }
      throw error;
    }
  }

  private async releaseLockFile(
    lockHandle: fs.FileHandle,
    lockPath: string,
  ): Promise<void> {
    try {
      await lockHandle.close();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }

  private async clearStaleLock(lockPath: string): Promise<void> {
    try {
      const stats = await fs.stat(lockPath);
      if (Date.now() - stats.mtimeMs > RUNTIME_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // Ignore races/missing lock file.
    }
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const contents = await fs.readFile(filePath, "utf8");
      return JSON.parse(contents) as T;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  private async writeJsonFile(filePath: string, payload: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const directory = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const tempPath = path.join(
      directory,
      `.${baseName}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const contents = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.writeFile(tempPath, contents, "utf8");
    try {
      await fs.chmod(tempPath, 0o600);
    } catch {
      // chmod is best-effort only.
    }
    await fs.rename(tempPath, filePath);
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // chmod is best-effort only.
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseLeadingJsonObject<T>(input: string): T | null {
  const source = input.trimStart();
  if (!source.startsWith("{")) {
    return null;
  }

  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(0, index + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
