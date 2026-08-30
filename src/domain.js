import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hasDecisionFields } from './decision.js';

const feedbackTypes = new Set(["bug", "improvement", "suggestion", "review"]);
const legacyFeedbackTypes = new Map([
  ["idea", "suggestion"], ["like", "review"], ["neutral", "review"], ["dislike", "review"],
]);
const priorities = new Set(["low", "normal", "high", "critical"]);
const workflowStatuses = new Set(["new", "to_analyze", "confirmed", "in_progress", "to_test", "fixed", "closed"]);
const applicationTypes = new Set(["pwa", "web", "mini_game", "android", "capacitor", "cloudflare_worker", "supabase", "firebase", "wordpress", "service", "other"]);

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
  const gameSlug = stringValue(input?.app_id ?? input?.game_slug, 64);
  const clientVersion = stringValue(input?.client_version, 64);
  if (!gameSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameSlug) || !clientVersion) {
    return null;
  }
  return { gameSlug, clientVersion };
}

export function validateFeedback(input) {
  if (hasDecisionFields(input)) return null;
  const rawType = stringValue(input?.type, 16);
  const type = legacyFeedbackTypes.get(rawType) ?? rawType;
  const comment = stringValue(input?.message ?? input?.comment, 4000, true);
  const title = stringValue(input?.title, 160, true) || defaultFeedbackTitle(type);
  const priority = stringValue(input?.priority ?? "normal", 16);
  const legacyRating = ["like", "neutral", "dislike"].includes(rawType);
  if (!feedbackTypes.has(type) || !priorities.has(priority) || comment === null || (!legacyRating && comment.length === 0)) return null;

  const occurredAt = optionalDate(input?.occurred_at);
  if (input?.occurred_at && !occurredAt) return null;
  const technicalContext = plainObject(input?.technical_context) ? (input.technical_context ?? {}) : {};
  if (JSON.stringify(technicalContext).length > 4096 || Object.keys(technicalContext).length > 24) return null;
  for (const key of Object.keys(technicalContext)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/i.test(key) || /password|secret|token|cookie|authorization|email/i.test(key)) return null;
  }
  if (containsSecretPattern(technicalContext)) return null;

  const metadata = {
    route: optionalString(input?.route, 256),
    device: optionalString(input?.device, 160),
    os: optionalString(input?.os, 120),
    browser: optionalString(input?.browser, 120),
    resolution: optionalString(input?.resolution, 32),
    userReference: optionalString(input?.user_reference, 160),
  };
  if (Object.values(metadata).includes(null)) return null;
  if (metadata.userReference && looksSensitive(metadata.userReference)) return null;

  return { type, comment, title, priority, occurredAt, technicalContext, ...metadata };
}

export function validateApplication(input) {
  const appId = stringValue(input?.app_id, 64);
  const name = stringValue(input?.name, 100);
  const appType = stringValue(input?.type, 32);
  const platforms = Array.isArray(input?.platforms) ? [...new Set(input.platforms.map((value) => stringValue(value, 32)))] : [];
  const currentVersion = optionalString(input?.current_version, 64);
  if (!appId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appId) || !name || !applicationTypes.has(appType) || !platforms.length || platforms.length > 12 || platforms.includes(null) || currentVersion === null) return null;
  return { appId, name, appType, platforms, currentVersion };
}

export function validateStatusTransition(from, to) {
  if (!workflowStatuses.has(to)) return false;
  if (from === to) return true;
  const allowed = {
    new: ["to_analyze", "closed"],
    to_analyze: ["confirmed", "closed"],
    confirmed: ["in_progress", "closed"],
    in_progress: ["to_test", "confirmed", "closed"],
    to_test: ["fixed", "in_progress", "closed"],
    fixed: ["closed", "in_progress"],
    closed: ["to_analyze"],
  };
  return allowed[from]?.includes(to) ?? false;
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

function optionalString(value, maxLength) {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, maxLength);
}

function optionalDate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = Date.now();
  if (date.getTime() < now - 30 * 86400_000 || date.getTime() > now + 86400_000) return null;
  return date.toISOString();
}

function plainObject(value) {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value));
}

function defaultFeedbackTitle(type) {
  return type === "bug" ? "Bug signalé" : type === "improvement" ? "Amélioration proposée" : type === "suggestion" ? "Suggestion" : "Avis utilisateur";
}

function looksSensitive(value) {
  return /@|\b(?:password|motdepasse|mot_de_passe|secret|token)\b/i.test(value);
}

function containsSecretPattern(value) {
  if (typeof value === "string") return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{16,}/i.test(value);
  if (Array.isArray(value)) return value.some(containsSecretPattern);
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => /password|secret|token|cookie|authorization|email/i.test(key) || containsSecretPattern(item));
  return false;
}
