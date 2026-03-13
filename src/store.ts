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
  SharedStateInfo,
  UsageSnapshot,
} from "./types";

const REGISTRY_VERSION = 1 as const;

export class CodexAccountStore {
  public readonly authPath: string;
  public readonly managerRoot: string;
  public readonly accountsRoot: string;
  public readonly registryPath: string;
  public readonly sessionsPath: string;
  public readonly memoriesPath: string;
  public readonly sqlitePath: string;

  public constructor(public readonly codexHome: string) {
    this.authPath = path.join(this.codexHome, "auth.json");
    this.managerRoot = path.join(this.codexHome, "account-manager");
    this.accountsRoot = path.join(this.managerRoot, "accounts");
    this.registryPath = path.join(this.managerRoot, "registry.json");
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
      sessionsPath: this.sessionsPath,
      memoriesPath: this.memoriesPath,
      sqlitePath: this.sqlitePath,
    };
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
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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
