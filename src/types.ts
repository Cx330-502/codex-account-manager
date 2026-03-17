export interface CodexTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  [key: string]: unknown;
}

export interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  last_refresh?: string | number;
  tokens?: CodexTokens;
  [key: string]: unknown;
}

export interface TokenClaims {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
  exp?: number;
  [key: string]: unknown;
}

export type AccountSource = "auto" | "manual" | "import";

export interface AccountIdentity {
  fingerprint: string;
  email?: string;
  name?: string;
  subject?: string;
  accountId?: string;
  chatgptAccountId?: string;
  authMode?: string;
  expiresAt?: string;
}

export interface UsageWindowSummary {
  key: "5h" | "1w";
  label: string;
  limitName: string | null;
  windowMinutes: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fetchedAt: string;
  sourceTimestamp: string | null;
  planType: string | null;
  creditsUnlimited: boolean;
  creditBalance: number | null;
  creditLabel: string;
  windows: UsageWindowSummary[];
}

export interface AccountRecord {
  id: string;
  label?: string;
  email?: string;
  name?: string;
  subject?: string;
  accountId?: string;
  chatgptAccountId?: string;
  authMode?: string;
  createdAt: string;
  updatedAt: string;
  lastCapturedAt: string;
  lastUsedAt?: string;
  source: AccountSource;
  snapshotHash: string;
  usage?: UsageSnapshot;
  usageCheckedAt?: string | null;
  usageError?: string | null;
}

export interface AccountRegistry {
  version: 1;
  accounts: AccountRecord[];
}

export interface WindowSessionRecord {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  runtimeAccountId: string | null;
  acknowledgedSwitchGeneration: number;
}

export interface UsageRefreshLease {
  ownerWindowId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface SwitchMarker {
  generation: number;
  previousAccountId: string | null;
  nextAccountId: string | null;
  switchedAt: string;
}

export interface RuntimeState {
  version: 1;
  lastSwitch: SwitchMarker | null;
  windowSessions: WindowSessionRecord[];
  usageRefreshLease: UsageRefreshLease | null;
}

export interface ManagedAccount {
  record: AccountRecord;
  auth: CodexAuthFile;
  isActive: boolean;
  snapshotPath: string;
}

export interface ExportBundleEntry {
  record: AccountRecord;
  auth: CodexAuthFile;
}

export interface ExportBundle {
  version: 1;
  exportedAt: string;
  accounts: ExportBundleEntry[];
}

export interface SharedStateInfo {
  codexHome: string;
  authPath: string;
  registryPath: string;
  runtimeStatePath: string;
  sessionsPath: string;
  memoriesPath: string;
  sqlitePath: string;
}
