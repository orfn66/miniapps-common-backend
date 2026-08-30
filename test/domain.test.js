import test from "node:test";
import assert from "node:assert/strict";
import {
  hashToken,
  issueInstallationCredential,
  validateFeedback,
  validateApplication,
  validateInstallation,
  validatePlaySession,
  validateStatusTransition,
} from "../src/domain.js";

test("installation credentials are random and stored as hashes", () => {
  const first = issueInstallationCredential();
  const second = issueInstallationCredential();
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashToken(first.token));
  assert.equal(first.tokenHash.length, 64);
  assert.equal(first.token.length >= 40, true);
});

test("installation input accepts a known shape and rejects malformed slugs", () => {
  assert.deepEqual(validateInstallation({ game_slug: "perfect-tap", client_version: "1.0.0" }), {
    gameSlug: "perfect-tap",
    clientVersion: "1.0.0",
  });
  assert.equal(validateInstallation({ game_slug: "../admin", client_version: "1" }), null);
});

test("feedback uses the transversal vocabulary and keeps legacy mappings", () => {
  assert.equal(validateFeedback({ type: "bug", comment: "" }), null);
  assert.equal(validateFeedback({ type: "like", comment: "" })?.type, "review");
  assert.equal(validateFeedback({ type: "idea", comment: "Daily mode" })?.type, "suggestion");
  assert.deepEqual(validateFeedback({ type: "improvement", message: "Plus lisible", priority: "high", route: "/stats" }), {
    type: "improvement", comment: "Plus lisible", title: "Amélioration proposée", priority: "high",
    occurredAt: undefined, technicalContext: {}, route: "/stats", device: undefined, os: undefined,
    browser: undefined, resolution: undefined, userReference: undefined,
  });
});

test("application registry and workflow transitions are bounded", () => {
  assert.deepEqual(validateApplication({ app_id: "minigames-hub", name: "MiniGames Hub", type: "pwa", platforms: ["web"] }), {
    appId: "minigames-hub", name: "MiniGames Hub", appType: "pwa", platforms: ["web"], currentVersion: undefined,
  });
  assert.equal(validateStatusTransition("new", "to_analyze"), true);
  assert.equal(validateStatusTransition("new", "fixed"), false);
  assert.equal(validateApplication({ app_id: "x", name: "X", type: "unknown", platforms: ["web"] }), null);
});

test("technical context rejects credential-shaped fields", () => {
  assert.equal(validateFeedback({ type: "bug", message: "Erreur", technical_context: { auth_token: "secret" } }), null);
  assert.equal(validateFeedback({ type: "bug", message: "Erreur", technical_context: { detail: "Bearer abcdefghijklmnopqrstuvwxyz" } }), null);
});

test("play sessions enforce bounds and idempotency keys", () => {
  assert.deepEqual(validatePlaySession({ duration_seconds: 42, score: 900 }, "session_12345678"), {
    durationSeconds: 42,
    score: 900,
    idempotencyKey: "session_12345678",
  });
  assert.equal(validatePlaySession({ duration_seconds: -1 }, "session_12345678"), null);
  assert.equal(validatePlaySession({ duration_seconds: 1 }, "short"), null);
});
