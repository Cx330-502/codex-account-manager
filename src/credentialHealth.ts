import { createHash } from "node:crypto";

import { decodeJwtClaims } from "./auth";
import type { CodexAuthFile } from "./types";

export type AuthTokenKind = "access" | "refresh" | "id";

export interface AuthTokenSummary {
  present: boolean;
  fingerprint: string | null;
  expiresAt: string | null;
}

export interface CredentialHealthSummary {
  access: AuthTokenSummary;
  refresh: AuthTokenSummary;
  id: AuthTokenSummary;
  lastRefreshAt: string | null;
}

export function summarizeCredentialHealth(
  auth: CodexAuthFile,
): CredentialHealthSummary {
  return {
    access: summarizeToken(auth.tokens?.access_token),
    refresh: summarizeToken(auth.tokens?.refresh_token),
    id: summarizeToken(auth.tokens?.id_token),
    lastRefreshAt: normalizeTimestamp(auth.last_refresh),
  };
}

export function getAuthToken(
  auth: CodexAuthFile,
  tokenKind: AuthTokenKind,
): string | null {
  const value =
    tokenKind === "access"
      ? auth.tokens?.access_token
      : tokenKind === "refresh"
        ? auth.tokens?.refresh_token
        : auth.tokens?.id_token;
  return normalizeString(value);
}

function summarizeToken(value: string | undefined): AuthTokenSummary {
  const token = normalizeString(value);
  if (!token) {
    return {
      present: false,
      fingerprint: null,
      expiresAt: null,
    };
  }

  const claims = decodeJwtClaims(token);
  return {
    present: true,
    fingerprint: createHash("sha256").update(token).digest("hex").slice(0, 10),
    expiresAt: toIsoDate(claims?.exp),
  };
}

function normalizeTimestamp(value: string | number | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
    return toValidIsoDate(milliseconds);
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    const numeric = Number.parseFloat(normalized);
    if (Number.isFinite(numeric)) {
      const milliseconds = Math.abs(numeric) < 1_000_000_000_000
        ? numeric * 1000
        : numeric;
      return toValidIsoDate(milliseconds);
    }
  }

  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeString(value: string | number | undefined): string | null {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIsoDate(epochSeconds: number | undefined): string | null {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) {
    return null;
  }
  return toValidIsoDate(epochSeconds * 1000);
}

function toValidIsoDate(milliseconds: number): string | null {
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
