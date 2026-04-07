import { spawn } from "node:child_process";

import { normalizeApiBaseUrl } from "./auth";
import type {
  ApiConfigFile,
  ApiHealthSnapshot,
  ApiModelSummary,
} from "./types";

const REQUEST_TIMEOUT_MS = 20_000;
const STATUS_MARKER = "__CODEX_STATUS__:";

type ModelsResponse = {
  data?: Array<{
    id?: string | null;
    owned_by?: string | null;
    created?: number | null;
  }> | null;
};

export interface ApiHealthCheckResult {
  config: ApiConfigFile;
  health: ApiHealthSnapshot;
}

export class ApiService {
  public async validateAndHydrateConfig(
    input: Pick<ApiConfigFile, "baseUrl" | "apiKey">,
  ): Promise<ApiHealthCheckResult> {
    const startedAt = Date.now();
    const baseUrl = normalizeApiBaseUrl(input.baseUrl);
    const apiKey = normalizeApiKey(input.apiKey);
    const endpoint = new URL("/v1/models", `${baseUrl}/`).toString();
    const headers = new Map<string, string>([
      ["Authorization", `Bearer ${apiKey}`],
      ["Content-Type", "application/json"],
    ]);

    const response = await this.requestJson<ModelsResponse>(endpoint, headers);
    const models = normalizeModels(response.body);

    return {
      config: {
        baseUrl,
        apiKey,
        models,
      },
      health: {
        status: "healthy",
        checkedAt: response.fetchedAt,
        latencyMs: Date.now() - startedAt,
        modelCount: models.length,
        baseUrl,
      },
    };
  }

  private async requestJson<T>(
    url: string,
    headers: Map<string, string>,
  ): Promise<{
    body: T;
    fetchedAt: string;
  }> {
    try {
      return await requestJsonWithCurl<T>(url, headers);
    } catch (curlError) {
      try {
        return await requestJsonWithFetch<T>(url, headers);
      } catch (fetchError) {
        throw new Error(
          `Unable to check API health. curl: ${toErrorMessage(curlError)}; fetch: ${toErrorMessage(fetchError)}`,
        );
      }
    }
  }
}

function normalizeApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("API key is required.");
  }
  return trimmed;
}

function normalizeModels(payload: ModelsResponse): ApiModelSummary[] {
  if (!Array.isArray(payload.data)) {
    return [];
  }

  const models: ApiModelSummary[] = [];
  for (const entry of payload.data) {
    const id = normalizeString(entry?.id);
    if (!id) {
      continue;
    }

    models.push({
      id,
      ownedBy: normalizeString(entry?.owned_by) ?? null,
      createdAt:
        typeof entry?.created === "number" && Number.isFinite(entry.created)
          ? new Date(entry.created * 1000).toISOString()
          : null,
    });
  }

  models.sort((left, right) => left.id.localeCompare(right.id));
  return models;
}

async function requestJsonWithFetch<T>(
  url: string,
  headers: Map<string, string>,
): Promise<{
  body: T;
  fetchedAt: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: Object.fromEntries(headers),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return {
      body: (await response.json()) as T,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJsonWithCurl<T>(
  url: string,
  headers: Map<string, string>,
): Promise<{
  body: T;
  fetchedAt: string;
}> {
  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    "-w",
    `\n${STATUS_MARKER}%{http_code}`,
    url,
  ];
  for (const [key, value] of headers) {
    args.push("-H", `${key}: ${value}`);
  }

  const { statusCode, body } = await runCurl(args);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`HTTP ${statusCode}`);
  }

  return {
    body: JSON.parse(body) as T,
    fetchedAt: new Date().toISOString(),
  };
}

async function runCurl(args: string[]): Promise<{
  statusCode: number;
  body: string;
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

      resolve({
        statusCode,
        body,
      });
    });
  });
}

function normalizeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
