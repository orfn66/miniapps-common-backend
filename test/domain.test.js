import test from "node:test";
import assert from "node:assert/strict";
import {
  hashToken,
  issueInstallationCredential,
  validateFeedback,
  validateInstallation,
  validatePlaySession,
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

test("bug and idea feedback require a comment", () => {
  assert.equal(validateFeedback({ type: "bug", comment: "" }), null);
  assert.deepEqual(validateFeedback({ type: "like", comment: "" }), { type: "like", comment: "" });
  assert.deepEqual(validateFeedback({ type: "idea", comment: "Daily mode" }), {
    type: "idea",
    comment: "Daily mode",
  });
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
