import * as fs from "node:fs/promises";
import * as path from "node:path";

export type CliRunMode = "manual-only" | "usage-auto";

export interface CliConfig {
  runMode: CliRunMode;
  usageAutoRefreshIntervalMinutes: number;
}

const DEFAULT_INTERVAL_MINUTES = 10;

export function defaultCliConfig(): CliConfig {
  return {
    runMode: "manual-only",
    usageAutoRefreshIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
  };
}

export function getCliConfigPath(managerRoot: string): string {
  return path.join(managerRoot, "cli-config.json");
}

export async function readCliConfig(managerRoot: string): Promise<CliConfig> {
  const filePath = getCliConfigPath(managerRoot);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeCliConfig(JSON.parse(raw) as Partial<CliConfig>);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return defaultCliConfig();
    }

    throw error;
  }
}

export async function writeCliConfig(
  managerRoot: string,
  config: CliConfig,
): Promise<void> {
  const filePath = getCliConfigPath(managerRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(normalizeCliConfig(config), null, 2)}\n`,
    "utf8",
  );
}

export function normalizeCliConfig(
  value: Partial<CliConfig> | null | undefined,
): CliConfig {
  const fallback = defaultCliConfig();
  const runMode =
    value?.runMode === "usage-auto" || value?.runMode === "manual-only"
      ? value.runMode
      : fallback.runMode;
  const interval = clampInterval(value?.usageAutoRefreshIntervalMinutes);

  return {
    runMode,
    usageAutoRefreshIntervalMinutes: interval ?? fallback.usageAutoRefreshIntervalMinutes,
  };
}

function clampInterval(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.round(value);
  if (rounded < 1) {
    return 1;
  }

  return rounded;
}
