import { createHash, randomBytes, randomUUID } from "node:crypto";

const feedbackTypes = new Set(["like", "neutral", "dislike", "bug", "idea"]);

export function issueInstallationCredential() {
  const token = randomBytes(32).toString("base64url");
  return {
    id: randomUUID(),
    token,
    tokenHash: hashToken(token),
  };
}

export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function validateInstallation(input) {
  const gameSlug = stringValue(input?.game_slug, 64);
  const clientVersion = stringValue(input?.client_version, 64);
  if (!gameSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameSlug) || !clientVersion) {
    return null;
  }
  return { gameSlug, clientVersion };
}

export function validateFeedback(input) {
  const type = stringValue(input?.type, 16);
  const comment = stringValue(input?.comment, 1000, true);
  if (!feedbackTypes.has(type) || comment === null) return null;
  if ((type === "bug" || type === "idea") && comment.length === 0) return null;
  return { type, comment };
}

export function validatePlaySession(input, idempotencyKey) {
  const durationSeconds = Number(input?.duration_seconds);
  const score = input?.score === null || input?.score === undefined ? null : Number(input.score);
  const key = stringValue(idempotencyKey, 64);
  if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) return null;
  if (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 86400) return null;
  if (score !== null && (!Number.isSafeInteger(score) || Math.abs(score) > 1_000_000_000)) return null;
  return { durationSeconds, score, idempotencyKey: key };
}

function stringValue(value, maxLength, allowEmpty = false) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) return null;
  return normalized;
}
