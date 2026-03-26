export interface LoginConfig {
  loginBrowserCommand: string;
  loginEnvironment: Record<string, string>;
}

export function defaultLoginConfig(): LoginConfig {
  return {
    loginBrowserCommand: "",
    loginEnvironment: {},
  };
}

export function normalizeLoginConfig(
  value: Partial<LoginConfig> | null | undefined,
): LoginConfig {
  const fallback = defaultLoginConfig();

  return {
    loginBrowserCommand:
      typeof value?.loginBrowserCommand === "string"
        ? value.loginBrowserCommand.trim()
        : fallback.loginBrowserCommand,
    loginEnvironment: normalizeEnvironmentOverrides(value?.loginEnvironment),
  };
}

export function normalizeEnvironmentOverrides(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries: Array<[string, string]> = [];
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || rawValue == null) {
      continue;
    }

    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      throw new Error(
        `Login environment override "${normalizedKey}" must be a string, number, or boolean.`,
      );
    }

    entries.push([normalizedKey, String(rawValue)]);
  }

  return Object.fromEntries(entries);
}

export function buildLoginEnvironmentOverrides(
  config: Partial<LoginConfig> | null | undefined,
): Record<string, string> {
  const normalized = normalizeLoginConfig(config);
  const overrides = { ...normalized.loginEnvironment };

  if (normalized.loginBrowserCommand) {
    overrides.BROWSER = normalized.loginBrowserCommand;
  }

  return overrides;
}
