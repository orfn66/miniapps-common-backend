import { createHash, createHmac } from 'node:crypto';

const kinds = new Map([['bug', 'bug'], ['opinion', 'review'], ['improvement', 'suggestion']]);
const platforms = new Set(['android', 'ios', 'desktop', 'unknown']);
const locales = new Set(['fr', 'nl', 'en']);

function exactKeys(input, allowed) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every((key) => allowed.includes(key));
}
function bounded(value, minimum, maximum) {
  return typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum && !value.includes('\0');
}

export function validateMemaFeedback(input, idempotencyKey) {
  const allowed = ['source_feedback_id', 'kind', 'description', 'app_version', 'app_build', 'platform', 'interface_locale', 'current_screen', 'client_occurred_at'];
  if (!exactKeys(input, allowed) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.source_feedback_id ?? '') || idempotencyKey !== input.source_feedback_id) return null;
  if (!kinds.has(input.kind) || !bounded(input.description, 1, 4000) || !bounded(input.app_version, 1, 64) || !bounded(input.app_build, 1, 64)) return null;
  if (!platforms.has(input.platform) || !locales.has(input.interface_locale) || !bounded(input.current_screen, 1, 64)) return null;
  const occurredAt = new Date(input.client_occurred_at);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt < new Date(Date.now() - 8 * 86_400_000) || occurredAt > new Date(Date.now() + 86_400_000)) return null;
  return {
    sourceFeedbackId: input.source_feedback_id,
    sourceKind: input.kind,
    type: kinds.get(input.kind),
    description: input.description.trim(),
    title: input.kind === 'bug' ? 'Bug Mema' : input.kind === 'opinion' ? 'Avis Mema' : 'Suggestion Mema',
    appVersion: input.app_version,
    appBuild: input.app_build,
    platform: input.platform,
    locale: input.interface_locale,
    screen: input.current_screen.trim(),
    occurredAt: occurredAt.toISOString(),
  };
}

export function validatePushSubscription(input) {
  if (!exactKeys(input, ['endpoint', 'expirationTime', 'keys'])) return null;
  if (!bounded(input.endpoint, 16, 4096) || !/^https:\/\//i.test(input.endpoint)) return null;
  if (input.expirationTime !== null && input.expirationTime !== undefined && (!Number.isSafeInteger(input.expirationTime) || input.expirationTime <= Date.now())) return null;
  if (!exactKeys(input.keys, ['p256dh', 'auth']) || !bounded(input.keys.p256dh, 16, 512) || !bounded(input.keys.auth, 8, 256)) return null;
  return { endpoint: input.endpoint, expirationTime: input.expirationTime ?? null, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

export function actorHash(userId, secret) {
  if (!bounded(userId, 1, 128) || !bounded(secret, 32, 4096)) throw new Error('mema_integration_not_configured');
  return createHmac('sha256', secret).update(`mema:${userId}`).digest('hex');
}

export function endpointHash(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

export async function authenticateMemaUser(request, fetchImpl = fetch) {
  const url = process.env.MEMA_SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.MEMA_SUPABASE_PUBLISHABLE_KEY;
  const authorization = request.headers.authorization ?? '';
  if (!url || !publishableKey || !/^Bearer [A-Za-z0-9_.-]{80,4096}$/.test(authorization)) return null;
  const response = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, authorization }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) return null;
  const user = await response.json().catch(() => null);
  return typeof user?.id === 'string' ? { id: user.id, actorHash: actorHash(user.id, process.env.INTEGRATION_HASH_SECRET ?? '') } : null;
}
