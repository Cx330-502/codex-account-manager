const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getAuthToken,
  summarizeCredentialHealth,
} = require("../out/credentialHealth.js");

function jwt(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

test("summarizes token health without returning raw credentials", () => {
  const accessToken = jwt({ exp: 1_800_000_000 });
  const idToken = jwt({ exp: 1_800_003_600 });
  const refreshToken = "refresh-secret-value";
  const summary = summarizeCredentialHealth({
    last_refresh: "2026-07-21T08:00:00Z",
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
    },
  });

  assert.equal(summary.access.present, true);
  assert.equal(summary.access.fingerprint.length, 10);
  assert.equal(summary.access.expiresAt, "2027-01-15T08:00:00.000Z");
  assert.equal(summary.refresh.present, true);
  assert.equal(summary.refresh.expiresAt, null);
  assert.equal(summary.lastRefreshAt, "2026-07-21T08:00:00.000Z");
  assert.equal(JSON.stringify(summary).includes(refreshToken), false);
});

test("returns a raw token only for an explicit extension-host copy request", () => {
  const auth = {
    tokens: {
      access_token: "access",
      refresh_token: "refresh",
      id_token: "id",
    },
  };

  assert.equal(getAuthToken(auth, "access"), "access");
  assert.equal(getAuthToken(auth, "refresh"), "refresh");
  assert.equal(getAuthToken(auth, "id"), "id");
});
