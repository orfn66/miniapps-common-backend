import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const transports = new Set(['fcm', 'web_push']);
const platforms = new Set(['android', 'pwa', 'web']);

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function bounded(value, min, max, pattern) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max && !value.includes('\0') && (!pattern || pattern.test(value));
}
const sensitiveReference = value => /@|\b(?:password|motdepasse|mot_de_passe|secret|token|cookie|authorization)\b/i.test(value);
function encryptionKey(value = process.env.NOTIFICATION_TOKEN_ENCRYPTION_KEY) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32) throw new Error('notification_encryption_not_configured');
  return key;
}

export function scopedHash(appId, value, secret = process.env.NOTIFICATION_IDENTITY_HMAC_SECRET) {
  if (!bounded(appId, 1, 64, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) || !bounded(value, 1, 256) || !bounded(secret, 32, 4096)) throw new Error('notification_identity_not_configured');
  return createHmac('sha256', secret).update(`${appId}:${value}`).digest('hex');
}
export const capabilityHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function seal(value, keyValue) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}
export function open(sealed, keyValue) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return JSON.parse(Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8'));
}

export function validateDevice(input) {
  if (!exactObject(input, ['app_id', 'recipient_reference', 'device_reference', 'transport', 'platform', 'permission', 'capability'])) return null;
  if (!bounded(input.app_id, 1, 64, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) || !bounded(input.recipient_reference, 1, 160) || sensitiveReference(input.recipient_reference) || !bounded(input.device_reference, 8, 160) || sensitiveReference(input.device_reference)) return null;
  if (!transports.has(input.transport) || !platforms.has(input.platform) || !['granted', 'denied'].includes(input.permission)) return null;
  if (input.permission === 'denied') return input.capability === null ? { ...input, capability: null } : null;
  if (input.transport === 'fcm') {
    if (!bounded(input.capability, 32, 4096)) return null;
  } else {
    if (!exactObject(input.capability, ['endpoint', 'expirationTime', 'keys']) || !bounded(input.capability.endpoint, 16, 4096, /^https:\/\//i)) return null;
    if (!exactObject(input.capability.keys, ['p256dh', 'auth']) || !bounded(input.capability.keys.p256dh, 16, 512) || !bounded(input.capability.keys.auth, 8, 256)) return null;
    if (input.capability.expirationTime !== null && input.capability.expirationTime !== undefined && !Number.isSafeInteger(input.capability.expirationTime)) return null;
  }
  return input;
}

export function validateMessage(input, idempotencyKey) {
  if (!exactObject(input, ['app_id', 'event_type', 'recipient_reference', 'notification', 'deep_link'])) return null;
  if (!bounded(input.app_id, 1, 64, /^[a-z0-9]+(?:-[a-z0-9]+)*$/) || !bounded(input.event_type, 1, 80, /^[a-z][a-z0-9_.-]*$/i) || !bounded(input.recipient_reference, 1, 160) || sensitiveReference(input.recipient_reference)) return null;
  if (!bounded(idempotencyKey, 8, 128, /^[A-Za-z0-9._:-]+$/)) return null;
  if (!exactObject(input.notification, ['title', 'body', 'data']) || !bounded(input.notification.title, 1, 120) || !bounded(input.notification.body, 1, 500)) return null;
  const data = input.notification.data ?? {};
  if (!exactObject(data, Object.keys(data)) || Object.keys(data).length > 12 || JSON.stringify(data).length > 2048) return null;
  if (!Object.entries(data).every(([key, value]) => /^[a-z][a-z0-9_]{0,39}$/i.test(key) && !/password|secret|token|cookie|authorization|email/i.test(key) && typeof value === 'string' && value.length <= 256 && !/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{16,}/i.test(value))) return null;
  if (input.deep_link !== undefined && input.deep_link !== null && !bounded(input.deep_link, 1, 512, /^(\/|https:\/\/)/i)) return null;
  return { ...input, notification: { title: input.notification.title.trim(), body: input.notification.body.trim(), data }, deep_link: input.deep_link || null, idempotencyKey };
}

export function retryDelaySeconds(attempt) {
  return Math.min(900, 15 * 2 ** Math.max(0, attempt - 1));
}
