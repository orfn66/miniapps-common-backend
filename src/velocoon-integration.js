import { createHmac } from 'node:crypto';

const categories = new Map([
  ['remarque', ['review', 'Remarque Velocoon']],
  ['problème', ['bug', 'Problème Velocoon']],
  ['idée', ['suggestion', 'Idée Velocoon']],
  ['question', ['review', 'Question Velocoon']],
]);
const platforms = new Set(['android', 'ios', 'desktop']);
const locales = new Set(['fr', 'nl', 'en']);

function exactKeys(input, allowed) {
  return input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every((key) => allowed.includes(key));
}
function bounded(value, minimum, maximum) {
  return typeof value === 'string' && value.trim().length >= minimum && value.length <= maximum && !value.includes('\0');
}

export function validateVelocoonFeedback(input, idempotencyKey, now = Date.now()) {
  const allowed = ['source_feedback_id', 'category', 'message', 'app_version', 'platform', 'interface_locale', 'current_screen', 'viewport', 'has_attachment', 'client_occurred_at'];
  if (!exactKeys(input, allowed) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.source_feedback_id ?? '') || idempotencyKey !== input.source_feedback_id) return null;
  if (!categories.has(input.category) || !bounded(input.message, 1, 3000) || !bounded(input.app_version, 1, 64)) return null;
  if (!platforms.has(input.platform) || !locales.has(input.interface_locale) || !bounded(input.current_screen, 1, 128) || !bounded(input.viewport, 3, 32)) return null;
  if (typeof input.has_attachment !== 'boolean') return null;
  const occurredAt = new Date(input.client_occurred_at);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt < new Date(now - 30 * 86_400_000) || occurredAt > new Date(now + 86_400_000)) return null;
  const [type, title] = categories.get(input.category);
  return { sourceFeedbackId: input.source_feedback_id, sourceKind: input.category, type, title, message: input.message.trim(), appVersion: input.app_version, platform: input.platform, locale: input.interface_locale, screen: input.current_screen.trim(), viewport: input.viewport.trim(), hasAttachment: input.has_attachment, occurredAt: occurredAt.toISOString() };
}

export function velocoonActorHash(userId, secret) {
  if (!bounded(userId, 1, 128) || !bounded(secret, 32, 4096)) throw new Error('velocoon_integration_not_configured');
  return createHmac('sha256', secret).update(`velocoon:${userId}`).digest('hex');
}

export async function authenticateVelocoonUser(request, fetchImpl = fetch) {
  const url = process.env.VELOCOON_SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.VELOCOON_SUPABASE_PUBLISHABLE_KEY;
  const authorization = request.headers.authorization ?? '';
  if (!url || !publishableKey || !/^Bearer [A-Za-z0-9_.-]{80,4096}$/.test(authorization)) return null;
  const response = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: publishableKey, authorization }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) return null;
  const user = await response.json().catch(() => null);
  return typeof user?.id === 'string' ? { id: user.id, actorHash: velocoonActorHash(user.id, process.env.INTEGRATION_HASH_SECRET ?? '') } : null;
}
