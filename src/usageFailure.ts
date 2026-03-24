export type UsageFailureKind = "auth" | "network" | "service" | "other";

export interface UsageFailureInfo {
  kind: UsageFailureKind;
  typeLabel: string;
  detail: string;
}

const FAILURE_MARKER = "__usage_failure_v2__:";

export function classifyUsageFailure(message: string): UsageFailureKind {
  const normalized = message.toLowerCase();
  const httpCodes = extractHttpStatusCodes(normalized);
  if (httpCodes.some((code) => code === 401 || code === 403)) {
    return "auth";
  }
  if (httpCodes.some((code) => code === 502 || code === 503 || code === 504)) {
    return "network";
  }
  if (
    httpCodes.some(
      (code) => code === 408 || code === 425 || code === 429 || (code >= 500 && code <= 599),
    )
  ) {
    return "service";
  }

  if (
    normalized.includes("refresh token") ||
    normalized.includes("access token") ||
    normalized.includes("token refresh") ||
    normalized.includes("please run `codex login` again")
  ) {
    return "auth";
  }

  if (
    normalized.includes("fetch failed") ||
    normalized.includes("unable to fetch usage") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econn") ||
    normalized.includes("enotfound") ||
    normalized.includes("eai_again") ||
    normalized.includes("socket") ||
    normalized.includes("network") ||
    normalized.includes("tls") ||
    normalized.includes("ssl") ||
    normalized.includes("could not resolve host") ||
    normalized.includes("failed to connect")
  ) {
    return "network";
  }

  return "other";
}

export function getUsageFailureTypeLabel(kind: UsageFailureKind): string {
  switch (kind) {
    case "auth":
      return "认证过期或无效";
    case "network":
      return "网络错误";
    case "service":
      return "服务异常或限流";
    default:
      return "未知错误";
  }
}

export function toUsageFailureInfo(rawMessage: string): UsageFailureInfo {
  const decoded = decodeUsageFailure(rawMessage);
  if (decoded) {
    return {
      kind: decoded.kind,
      typeLabel: getUsageFailureTypeLabel(decoded.kind),
      detail: decoded.detail,
    };
  }

  const kind = classifyUsageFailure(rawMessage);
  return {
    kind,
    typeLabel: getUsageFailureTypeLabel(kind),
    detail: rawMessage,
  };
}

export function encodeUsageFailure(rawMessage: string): string {
  const kind = classifyUsageFailure(rawMessage);
  return `${FAILURE_MARKER}${JSON.stringify({
    kind,
    detail: rawMessage,
  })}`;
}

export function formatUsageFailureSummary(rawMessage: string): string {
  const info = toUsageFailureInfo(rawMessage);
  return `${info.typeLabel}：${info.detail}`;
}

function decodeUsageFailure(
  message: string,
): { kind: UsageFailureKind; detail: string } | null {
  if (!message.startsWith(FAILURE_MARKER)) {
    return null;
  }
  const payloadText = message.slice(FAILURE_MARKER.length);
  try {
    const payload = JSON.parse(payloadText) as {
      kind?: UsageFailureKind;
      detail?: string;
    };
    if (!payload || typeof payload.detail !== "string") {
      return null;
    }
    if (!isUsageFailureKind(payload.kind)) {
      return null;
    }
    return {
      kind: payload.kind,
      detail: payload.detail,
    };
  } catch {
    return null;
  }
}

function isUsageFailureKind(kind: unknown): kind is UsageFailureKind {
  return kind === "auth" || kind === "network" || kind === "service" || kind === "other";
}

function extractHttpStatusCodes(message: string): number[] {
  const matches = message.match(/\bhttp\s+(\d{3})\b/gi) ?? [];
  const codes: number[] = [];
  for (const item of matches) {
    const parsed = Number.parseInt(item.replace(/[^0-9]/g, ""), 10);
    if (Number.isFinite(parsed)) {
      codes.push(parsed);
    }
  }
  return codes;
}
