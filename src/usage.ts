import { spawn } from "node:child_process";

import { decodeJwtClaims, deriveAccountIdentity } from "./auth";
import type {
  CodexAuthFile,
  UsageResetCreditsSummary,
  UsageSnapshot,
  UsageWindowSummary,
} from "./types";

const BACKEND_BASE_URL = "https://chatgpt.com/backend-api";
const ORIGINATOR = "codex_vscode";
const REQUEST_TIMEOUT_MS = 20_000;
const STATUS_MARKER = "__CODEX_STATUS__:";
const TOKEN_REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_REFRESH_STALE_MS = 8 * 24 * 60 * 60 * 1000;
const RESET_CREDITS_ENDPOINT = `${BACKEND_BASE_URL}/wham/rate-limit-reset-credits`;

type RateLimitWindowPayload = {
  limit_window_seconds?: number | string | null;
  reset_after_seconds?: number | string | null;
  reset_at?: number | string | null;
  resets_at?: number | string | null;
  used_percent?: number | string | null;
  window_minutes?: number | string | null;
};

type RateLimitPayload = {
  primary_window?: RateLimitWindowPayload | null;
  secondary_window?: RateLimitWindowPayload | null;
};

type RateLimitResetCreditsPayload = {
  available_count?: number | string | null;
  availableCount?: number | string | null;
};

type AdditionalRateLimitPayload = {
  limit_name?: string | null;
  rate_limit?: RateLimitPayload | null;
};

type CreditsPayload = {
  balance?: number | string | null;
  has_credits?: boolean | null;
  unlimited?: boolean | null;
  approx_local_messages?: [number, number] | null;
  approx_cloud_messages?: [number, number] | null;
};

type RateLimitStatusPayload = {
  account_id?: string | null;
  additional_rate_limits?: AdditionalRateLimitPayload[] | null;
  code_review_rate_limit?: RateLimitPayload | null;
  credits?: CreditsPayload | null;
  email?: string | null;
  plan_type?: string | null;
  promo?: unknown;
  rate_limit?: RateLimitPayload | null;
  rate_limit_name?: string | null;
  rate_limit_reset_credits?: RateLimitResetCreditsPayload | null;
  rateLimitResetCredits?: RateLimitResetCreditsPayload | null;
  user_id?: string | null;
};

type ResetCreditPayload = {
  expires_at?: string | null;
  expiresAt?: string | null;
  reset_type?: string | null;
  resetType?: string | null;
  status?: string | null;
};

type ResetCreditsPayload = RateLimitResetCreditsPayload & {
  credits?: ResetCreditPayload[] | null;
};

type NormalizedRateWindow = {
  windowMinutes: number;
  usedPercent: number;
  resetsAt: number | null;
};

type NormalizedWindowEntry = {
  key: "primary" | "secondary";
  window: NormalizedRateWindow;
};

type UsageResponse<T> = {
  body: T;
  fetchedAt: string;
  sourceTimestamp: string | null;
};

export interface UsageFetchResult {
  usage: UsageSnapshot;
  auth: CodexAuthFile;
  authRefreshed: boolean;
}

export interface UsageFetchOptions {
  allowTokenRefresh?: boolean;
  includeResetCreditDetails?: boolean;
}

export class UsageService {
  public async fetchUsage(
    auth: CodexAuthFile,
    options: UsageFetchOptions = {},
  ): Promise<UsageFetchResult> {
    const allowTokenRefresh = options.allowTokenRefresh ?? true;
    const includeResetCreditDetails = options.includeResetCreditDetails ?? true;
    let workingAuth = cloneAuthFile(auth);
    let authRefreshed = false;

    if (allowTokenRefresh && shouldProactivelyRefresh(workingAuth)) {
      workingAuth = await this.refreshAuthTokens(workingAuth);
      authRefreshed = true;
    }

    const accessToken = workingAuth.tokens?.access_token;
    if (!accessToken) {
      throw new Error("This account snapshot does not contain an access token.");
    }

    const identity = deriveAccountIdentity(workingAuth);
    const headers = new Map<string, string>([
      ["Authorization", `Bearer ${accessToken}`],
      ["originator", ORIGINATOR],
    ]);
    if (identity.chatgptAccountId) {
      headers.set("ChatGPT-Account-Id", identity.chatgptAccountId);
    }

    const endpoint = `${BACKEND_BASE_URL}/wham/usage`;
    try {
      return {
        usage: await this.fetchUsageSnapshot(
          endpoint,
          headers,
          includeResetCreditDetails,
        ),
        auth: workingAuth,
        authRefreshed,
      };
    } catch (error) {
      if (
        !allowTokenRefresh ||
        !shouldRetryWithRefresh(error, workingAuth, authRefreshed)
      ) {
        throw error;
      }

      workingAuth = await this.refreshAuthTokens(workingAuth);
      const retriedAccessToken = workingAuth.tokens?.access_token;
      if (!retriedAccessToken) {
        throw new Error("Token refresh succeeded but access token is still missing.");
      }
      headers.set("Authorization", `Bearer ${retriedAccessToken}`);
      return {
        usage: await this.fetchUsageSnapshot(
          endpoint,
          headers,
          includeResetCreditDetails,
        ),
        auth: workingAuth,
        authRefreshed: true,
      };
    }
  }

  public async refreshTokens(auth: CodexAuthFile): Promise<CodexAuthFile> {
    return this.refreshAuthTokens(auth);
  }

  private async fetchUsageSnapshot(
    endpoint: string,
    headers: Map<string, string>,
    includeResetCreditDetails: boolean,
  ): Promise<UsageSnapshot> {
    const response = await this.requestJson<RateLimitStatusPayload>(endpoint, headers);
    const usage = parseUsagePayload(response.body, {
      fetchedAt: response.fetchedAt,
      sourceTimestamp: response.sourceTimestamp,
    });
    if (
      !includeResetCreditDetails ||
      !usage.resetCredits ||
      usage.resetCredits.availableCount <= 0
    ) {
      return usage;
    }

    const resetHeaders = new Map(headers);
    resetHeaders.set("Accept", "application/json");
    resetHeaders.set("OpenAI-Beta", "codex-1");
    resetHeaders.set("originator", "Codex Desktop");
    try {
      const details = await this.requestJson<ResetCreditsPayload>(
        RESET_CREDITS_ENDPOINT,
        resetHeaders,
      );
      return {
        ...usage,
        resetCredits: mergeResetCreditDetails(
          usage.resetCredits,
          parseResetCreditsPayload(details.body),
        ),
      };
    } catch {
      // Detailed expiry data is optional. Keep the count from /wham/usage.
      return usage;
    }
  }

  private async requestJson<T>(
    url: string,
    headers: Map<string, string>,
  ): Promise<UsageResponse<T>> {
    try {
      return await requestJsonWithCurl<T>(url, headers);
    } catch (curlError) {
      try {
        return await requestJsonWithFetch<T>(url, headers);
      } catch (fetchError) {
        const curlMessage = toErrorMessage(curlError);
        const fetchMessage = toErrorMessage(fetchError);
        throw new Error(
          `Unable to fetch usage. curl: ${curlMessage}; fetch: ${fetchMessage}`,
        );
      }
    }
  }

  private async refreshAuthTokens(auth: CodexAuthFile): Promise<CodexAuthFile> {
    const refreshToken = normalizeString(auth.tokens?.refresh_token);
    if (!refreshToken) {
      throw new Error("This account does not have a refresh token. Please run `codex login` again.");
    }

    const response = await requestTokenRefresh(refreshToken);
    return mergeRefreshedTokens(auth, response);
  }
}

export function parseUsagePayload(
  payload: RateLimitStatusPayload,
  metadata?: {
    fetchedAt?: string | null;
    sourceTimestamp?: string | null;
  },
): UsageSnapshot {
  const referenceTimeSeconds =
    toEpochSeconds(metadata?.sourceTimestamp) ?? Math.floor(Date.now() / 1000);
  const credits = normalizeCredits(payload.credits);
  const primaryWindows =
    pickUsageWindows(
      payload.rate_limit,
      normalizeString(payload.rate_limit_name),
      referenceTimeSeconds,
    ) ??
    pickFirstAdditionalUsageWindows(
      payload.additional_rate_limits,
      referenceTimeSeconds,
    ) ??
    pickUsageWindows(
      payload.code_review_rate_limit,
      "code-review",
      referenceTimeSeconds,
    ) ??
    [];

  return {
    fetchedAt: normalizeIsoTimestamp(metadata?.fetchedAt) ?? new Date().toISOString(),
    sourceTimestamp: normalizeIsoTimestamp(metadata?.sourceTimestamp),
    planType: normalizeString(payload.plan_type),
    creditsUnlimited: credits.unlimited,
    creditBalance: credits.balance,
    creditLabel: formatCreditLabel(credits.unlimited, credits.balance, credits.hasCredits),
    windows: primaryWindows,
    resetCredits: parseResetCreditsPayload(
      payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits,
    ),
  };
}

export function formatUsageShortSummary(usage: UsageSnapshot | undefined): string | null {
  if (!usage) {
    return null;
  }

  const parts: string[] = [];

  if (usage.planType) {
    parts.push(usage.planType);
  }
  for (const window of usage.windows) {
    if (window.remainingPercent != null) {
      parts.push(`${window.label} ${window.remainingPercent}%`);
    }
  }
  if (usage.resetCredits) {
    parts.push(`resets ${usage.resetCredits.availableCount}`);
  }
  if (parts.length === 0 && usage.creditLabel) {
    parts.push(usage.creditLabel);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

function pickFirstAdditionalUsageWindows(
  additionalRateLimits: AdditionalRateLimitPayload[] | null | undefined,
  referenceTimeSeconds: number,
): UsageWindowSummary[] | null {
  if (!Array.isArray(additionalRateLimits)) {
    return null;
  }

  for (const entry of additionalRateLimits) {
    const windows = pickUsageWindows(
      entry.rate_limit,
      normalizeString(entry.limit_name),
      referenceTimeSeconds,
    );
    if (windows && windows.length > 0) {
      return windows;
    }
  }

  return null;
}

function pickUsageWindows(
  rateLimit: RateLimitPayload | null | undefined,
  limitName: string | null,
  referenceTimeSeconds: number,
): UsageWindowSummary[] | null {
  const windows: NormalizedWindowEntry[] = [];
  const primaryWindow = normalizeRateWindow(
    rateLimit?.primary_window,
    referenceTimeSeconds,
  );
  const secondaryWindow = normalizeRateWindow(
    rateLimit?.secondary_window,
    referenceTimeSeconds,
  );
  if (primaryWindow) {
    windows.push({ key: "primary", window: primaryWindow });
  }
  if (secondaryWindow) {
    windows.push({ key: "secondary", window: secondaryWindow });
  }

  if (windows.length === 0) {
    return null;
  }

  return windows.map(({ key, window }) =>
    toWindowSummary(key, formatWindowLabel(window.windowMinutes), limitName, window),
  );
}

function normalizeRateWindow(
  payload: RateLimitWindowPayload | null | undefined,
  referenceTimeSeconds: number,
): NormalizedRateWindow | null {
  if (!payload) {
    return null;
  }

  const windowMinutes =
    toNullableNumber(payload.window_minutes) ??
    secondsToMinutes(payload.limit_window_seconds);
  if (windowMinutes == null || windowMinutes <= 0) {
    return null;
  }

  return {
    windowMinutes,
    usedPercent: clampPercent(toNullableNumber(payload.used_percent) ?? 0),
    resetsAt:
      toNullableNumber(payload.reset_at ?? payload.resets_at) ??
      addSeconds(referenceTimeSeconds, payload.reset_after_seconds),
  };
}

function toWindowSummary(
  key: string,
  label: string,
  limitName: string | null,
  window: NormalizedRateWindow,
): UsageWindowSummary {
  const remainingPercent = clampPercent(100 - window.usedPercent);
  return {
    key,
    label,
    limitName,
    windowMinutes: window.windowMinutes,
    usedPercent: window.usedPercent,
    remainingPercent,
    resetsAt:
      window.resetsAt != null
        ? new Date(window.resetsAt * 1000).toISOString()
        : null,
  };
}

function formatWindowLabel(windowMinutes: number): string {
  const roundedMinutes = Math.round(windowMinutes);
  if (
    roundedMinutes >= 28 * 24 * 60 &&
    roundedMinutes <= 32 * 24 * 60
  ) {
    return "1mo";
  }
  const weeks = roundedMinutes / (7 * 24 * 60);
  if (Number.isInteger(weeks)) {
    return `${weeks}w`;
  }

  const days = roundedMinutes / (24 * 60);
  if (Number.isInteger(days)) {
    return `${days}d`;
  }

  const hours = roundedMinutes / 60;
  if (Number.isInteger(hours)) {
    return `${hours}h`;
  }

  return `${roundedMinutes}m`;
}

export function parseResetCreditsPayload(
  payload: ResetCreditsPayload | null | undefined,
): UsageResetCreditsSummary | undefined {
  if (!payload) {
    return undefined;
  }

  const expiresAt = Array.isArray(payload.credits)
    ? payload.credits
        .filter((credit) => {
          const resetType = normalizeString(credit.reset_type ?? credit.resetType);
          const status = normalizeString(credit.status);
          return (
            (!resetType || resetType === "codex_rate_limits") &&
            (!status || status === "available")
          );
        })
        .map((credit) => normalizeIsoTimestamp(credit.expires_at ?? credit.expiresAt))
        .filter((value): value is string => value !== null)
        .sort()
    : [];
  const explicitCount = toNullableNumber(
    payload.available_count ?? payload.availableCount,
  );
  if (explicitCount == null && expiresAt.length === 0) {
    return undefined;
  }

  return {
    availableCount: Math.max(0, Math.floor(explicitCount ?? expiresAt.length)),
    expiresAt,
    nextExpiresAt: expiresAt[0] ?? null,
  };
}

function mergeResetCreditDetails(
  summary: UsageResetCreditsSummary,
  details: UsageResetCreditsSummary | undefined,
): UsageResetCreditsSummary {
  if (!details) {
    return summary;
  }
  return {
    availableCount: details.availableCount,
    expiresAt: details.expiresAt,
    nextExpiresAt: details.nextExpiresAt,
  };
}

function normalizeCredits(credits: CreditsPayload | null | undefined): {
  balance: number | null;
  hasCredits: boolean;
  unlimited: boolean;
} {
  return {
    balance: toNullableNumber(credits?.balance),
    hasCredits: Boolean(credits?.has_credits),
    unlimited: Boolean(credits?.unlimited),
  };
}

function formatCreditLabel(
  unlimited: boolean,
  balance: number | null,
  hasCredits: boolean,
): string {
  if (unlimited) {
    return "Unlimited";
  }
  if (balance != null) {
    return `${formatDecimal(balance)} credits`;
  }
  return hasCredits ? "Credit unavailable" : "No credits";
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

async function requestJsonWithFetch<T>(
  url: string,
  headers: Map<string, string>,
): Promise<UsageResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: Object.fromEntries(headers),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new HttpStatusError(response.status);
    }

    return {
      body: (await response.json()) as T,
      fetchedAt: new Date().toISOString(),
      sourceTimestamp: normalizeHttpDate(response.headers.get("date")),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJsonWithCurl<T>(
  url: string,
  headers: Map<string, string>,
): Promise<UsageResponse<T>> {
  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    "-D",
    "-",
    "-w",
    `\n${STATUS_MARKER}%{http_code}`,
    url,
  ];
  for (const [key, value] of headers) {
    args.push("-H", `${key}: ${value}`);
  }

  const { statusCode, body, headersMap } = await runCurl(args);
  if (statusCode < 200 || statusCode >= 300) {
    throw new HttpStatusError(statusCode);
  }

  return {
    body: JSON.parse(body) as T,
    fetchedAt: new Date().toISOString(),
    sourceTimestamp: normalizeHttpDate(headersMap.date ?? null),
  };
}

async function runCurl(args: string[]): Promise<{
  statusCode: number;
  body: string;
  headersMap: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const markerIndex = stdout.lastIndexOf(STATUS_MARKER);
      if (markerIndex < 0) {
        if (code === 0 && stdout.trim().length > 0) {
          resolve({
            statusCode: 200,
            body: stdout.trim(),
            headersMap: {},
          });
          return;
        }
        reject(new Error(stderr.trim() || `curl exited with code ${code ?? -1}`));
        return;
      }

      const body = stdout.slice(0, markerIndex).trim();
      const statusText = stdout
        .slice(markerIndex + STATUS_MARKER.length)
        .trim()
        .split(/\s+/)[0];
      const statusCode = Number.parseInt(statusText, 10);
      if (!Number.isFinite(statusCode)) {
        reject(new Error(`Unable to parse curl status: ${statusText}`));
        return;
      }
      if (code !== 0 && body.length === 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }

      const parsedResponse = parseCurlResponse(body);

      resolve({
        statusCode,
        body: parsedResponse.body,
        headersMap: parsedResponse.headersMap,
      });
    });
  });
}

function parseCurlResponse(output: string): {
  body: string;
  headersMap: Record<string, string>;
} {
  const normalizedOutput = output.replace(/\r\n/g, "\n");
  if (!normalizedOutput.startsWith("HTTP/")) {
    return {
      body: output.trim(),
      headersMap: {},
    };
  }

  let cursor = 0;
  let lastHeadersBlock = "";
  while (normalizedOutput.startsWith("HTTP/", cursor)) {
    const headerEnd = normalizedOutput.indexOf("\n\n", cursor);
    if (headerEnd < 0) {
      break;
    }

    lastHeadersBlock = normalizedOutput.slice(cursor, headerEnd);
    cursor = headerEnd + 2;
    if (!normalizedOutput.startsWith("HTTP/", cursor)) {
      break;
    }
  }

  const headersMap = parseHeaderLines(lastHeadersBlock);
  return {
    body: normalizedOutput.slice(cursor).trim(),
    headersMap,
  };
}

function parseHeaderLines(headersBlock: string): Record<string, string> {
  const headersMap: Record<string, string> = {};
  const lines = headersBlock.split("\n");
  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      headersMap[key] = value;
    }
  }
  return headersMap;
}

function clampPercent(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 100);
}

class HttpStatusError extends Error {
  public constructor(public readonly statusCode: number) {
    super(`HTTP ${statusCode}`);
    this.name = "HttpStatusError";
  }
}

function shouldRetryWithRefresh(
  error: unknown,
  auth: CodexAuthFile,
  authRefreshed: boolean,
): boolean {
  if (authRefreshed || !normalizeString(auth.tokens?.refresh_token)) {
    return false;
  }

  return (
    error instanceof HttpStatusError &&
    (error.statusCode === 401 || error.statusCode === 403)
  );
}

function shouldProactivelyRefresh(auth: CodexAuthFile): boolean {
  if (!normalizeString(auth.tokens?.refresh_token)) {
    return false;
  }

  const accessClaims = decodeJwtClaims(auth.tokens?.access_token);
  const expiresAtMs =
    typeof accessClaims?.exp === "number" ? accessClaims.exp * 1000 : NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() <= 60_000) {
    return true;
  }

  const lastRefreshMs = parseLastRefreshMs(auth.last_refresh);
  return Number.isFinite(lastRefreshMs)
    ? Date.now() - lastRefreshMs >= TOKEN_REFRESH_STALE_MS
    : false;
}

function parseLastRefreshMs(value: string | number | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return NaN;
    }
    const isNumericLiteral = /^-?\d+(\.\d+)?$/.test(trimmed);
    if (isNumericLiteral) {
      const asNumber = Number.parseFloat(trimmed);
      if (Number.isFinite(asNumber)) {
        return asNumber;
      }
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

type TokenRefreshPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  error?: string | { code?: string };
  code?: string;
};

async function requestTokenRefresh(refreshToken: string): Promise<TokenRefreshPayload> {
  const payload = {
    client_id: TOKEN_REFRESH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email",
  };

  const response = await fetch(TOKEN_REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let json: TokenRefreshPayload | null = null;
  try {
    json = JSON.parse(responseText) as TokenRefreshPayload;
  } catch {
    json = null;
  }

  if (response.status === 401) {
    const errorCode = extractRefreshErrorCode(json);
    switch (errorCode) {
      case "refresh_token_reused":
        throw new Error("Refresh token was already used. Please run `codex login` again.");
      case "refresh_token_invalidated":
        throw new Error("Refresh token was revoked. Please run `codex login` again.");
      case "refresh_token_expired":
      default:
        throw new Error("Refresh token expired. Please run `codex login` again.");
    }
  }

  if (!response.ok || !json) {
    throw new Error(
      `Token refresh failed: HTTP ${response.status}${responseText ? ` ${responseText}` : ""}`,
    );
  }

  if (!normalizeString(json.access_token)) {
    throw new Error("Token refresh response did not include a new access token.");
  }

  return json;
}

function extractRefreshErrorCode(payload: TokenRefreshPayload | null): string | null {
  if (!payload) {
    return null;
  }
  if (typeof payload.error === "string") {
    return payload.error;
  }
  if (typeof payload.error?.code === "string") {
    return payload.error.code;
  }
  return typeof payload.code === "string" ? payload.code : null;
}

function mergeRefreshedTokens(
  auth: CodexAuthFile,
  payload: TokenRefreshPayload,
): CodexAuthFile {
  return {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...(auth.tokens ?? {}),
      access_token: payload.access_token ?? auth.tokens?.access_token,
      refresh_token: payload.refresh_token ?? auth.tokens?.refresh_token,
      id_token: payload.id_token ?? auth.tokens?.id_token,
    },
  };
}

function cloneAuthFile(auth: CodexAuthFile): CodexAuthFile {
  return {
    ...auth,
    tokens: auth.tokens ? { ...auth.tokens } : undefined,
  };
}

function normalizeString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function secondsToMinutes(value: number | string | null | undefined): number | null {
  const seconds = toNullableNumber(value);
  if (seconds == null) {
    return null;
  }
  return seconds / 60;
}

function addSeconds(
  baseSeconds: number,
  value: number | string | null | undefined,
): number | null {
  const seconds = toNullableNumber(value);
  if (seconds == null) {
    return null;
  }
  return baseSeconds + seconds;
}

function normalizeHttpDate(value: string | null | undefined): string | null {
  return normalizeIsoTimestamp(value);
}

function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function toEpochSeconds(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
