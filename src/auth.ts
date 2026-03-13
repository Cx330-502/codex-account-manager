import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import type { AccountRecord, CodexAuthFile, TokenClaims } from "./types";

const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

export function resolveCodexHome(configuredHome: string): string {
  const trimmedConfiguredHome = configuredHome.trim();
  if (trimmedConfiguredHome.length > 0) {
    return path.resolve(trimmedConfiguredHome);
  }

  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) {
    return path.resolve(envHome);
  }

  return path.join(os.homedir(), ".codex");
}

export function decodeJwtClaims(token: string | undefined): TokenClaims | null {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return null;
  }
}

export function deriveAccountIdentity(auth: CodexAuthFile): {
  fingerprint: string;
  email?: string;
  name?: string;
  subject?: string;
  accountId?: string;
  chatgptAccountId?: string;
  authMode?: string;
  expiresAt?: string;
} {
  const accessClaims = decodeJwtClaims(auth.tokens?.access_token);
  const idClaims = decodeJwtClaims(auth.tokens?.id_token);
  const email =
    normalizeEmail(idClaims?.email) ??
    normalizeEmail(accessClaims?.email) ??
    undefined;
  const subject = normalizeString(idClaims?.sub) ?? normalizeString(accessClaims?.sub);
  const name = normalizeString(idClaims?.name) ?? normalizeString(accessClaims?.name);
  const accountId = normalizeString(auth.tokens?.account_id as string | undefined);
  const chatgptAccountId =
    normalizeString(
      getNestedString(
        accessClaims,
        CHATGPT_AUTH_CLAIM,
        "chatgpt_account_id",
      ),
    ) ?? undefined;
  const authMode = normalizeString(auth.auth_mode);
  const expiresAt = toIsoDate(idClaims?.exp ?? accessClaims?.exp);

  const fingerprintBase =
    chatgptAccountId ??
    accountId ??
    email ??
    subject ??
    name ??
    JSON.stringify(auth);

  return {
    fingerprint: sha256(fingerprintBase).slice(0, 16),
    email: email ?? undefined,
    name: name ?? undefined,
    subject: subject ?? undefined,
    accountId: accountId ?? undefined,
    chatgptAccountId: chatgptAccountId ?? undefined,
    authMode: authMode ?? undefined,
    expiresAt,
  };
}

export function computeSnapshotHash(auth: CodexAuthFile): string {
  return sha256(JSON.stringify(auth));
}

export function getAccountLabel(record: AccountRecord): string {
  const customLabel = normalizeString(record.label);
  if (customLabel) {
    return customLabel;
  }

  return (
    normalizeString(record.email) ??
    normalizeString(record.name) ??
    normalizeString(record.chatgptAccountId) ??
    normalizeString(record.accountId) ??
    normalizeString(record.subject) ??
    "Unknown account"
  );
}

export function quoteForShell(input: string): string {
  if (process.platform === "win32") {
    return `"${input.replace(/"/g, '\\"')}"`;
  }

  return `'${input.replace(/'/g, `'\\''`)}'`;
}

function getNestedString(
  value: Record<string, unknown> | null,
  key: string,
  nestedKey: string,
): string | null {
  if (!value) {
    return null;
  }

  const nestedValue = value[key];
  if (!nestedValue || typeof nestedValue !== "object") {
    return null;
  }

  const nestedRecord = nestedValue as Record<string, unknown>;
  return normalizeString(nestedRecord[nestedKey] as string | undefined);
}

function normalizeString(value: string | number | undefined | null): string | null {
  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: string | undefined): string | null {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function toIsoDate(epochSeconds: number | undefined): string | undefined {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
    return undefined;
  }

  return new Date(epochSeconds * 1000).toISOString();
}
