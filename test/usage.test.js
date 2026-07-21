const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatUsageShortSummary,
  parseResetCreditsPayload,
  parseUsagePayload,
} = require("../out/usage.js");

const metadata = {
  fetchedAt: "2026-07-21T08:00:00.000Z",
  sourceTimestamp: "2026-07-21T08:00:00.000Z",
};

test("keeps a weekly-only Codex quota without inventing a 5h window", () => {
  const usage = parseUsagePayload(
    {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 18,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_after_seconds: 3600,
        },
      },
    },
    metadata,
  );

  assert.deepEqual(
    usage.windows.map((window) => ({ key: window.key, label: window.label })),
    [{ key: "primary", label: "1w" }],
  );
  assert.equal(usage.windows[0].remainingPercent, 82);
  assert.equal(formatUsageShortSummary(usage), "plus | 1w 82%");
});

test("labels current monthly and legacy short windows from their real duration", () => {
  const monthly = parseUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 30 * 24 * 60 * 60,
      },
    },
  });
  const legacy = parseUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 20,
        limit_window_seconds: 5 * 60 * 60,
      },
      secondary_window: {
        used_percent: 30,
        limit_window_seconds: 7 * 24 * 60 * 60,
      },
    },
  });

  assert.deepEqual(monthly.windows.map((window) => window.label), ["1mo"]);
  const averageMonth = parseUsagePayload({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 2_628_000,
      },
    },
  });
  assert.deepEqual(averageMonth.windows.map((window) => window.label), ["1mo"]);
  assert.deepEqual(legacy.windows.map((window) => window.label), ["5h", "1w"]);
});

test("parses reset credit count and only available Codex expiry details", () => {
  const usage = parseUsagePayload({
    rate_limit_reset_credits: { available_count: 2 },
  });
  const details = parseResetCreditsPayload({
    available_count: 2,
    credits: [
      {
        reset_type: "codex_rate_limits",
        status: "available",
        expires_at: "2026-07-25T00:00:00Z",
      },
      {
        resetType: "codex_rate_limits",
        status: "available",
        expiresAt: "2026-07-24T00:00:00Z",
      },
      {
        reset_type: "codex_rate_limits",
        status: "consumed",
        expires_at: "2026-07-23T00:00:00Z",
      },
      {
        reset_type: "other",
        status: "available",
        expires_at: "2026-07-22T00:00:00Z",
      },
    ],
  });

  assert.equal(usage.resetCredits.availableCount, 2);
  assert.deepEqual(details, {
    availableCount: 2,
    expiresAt: [
      "2026-07-24T00:00:00.000Z",
      "2026-07-25T00:00:00.000Z",
    ],
    nextExpiresAt: "2026-07-24T00:00:00.000Z",
  });
});
