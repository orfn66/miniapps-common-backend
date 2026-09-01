import assert from 'node:assert/strict';
import test from 'node:test';
import { open, retryDelaySeconds, scopedHash, seal, validateDevice, validateMessage } from '../src/notification-domain.js';

const key = Buffer.alloc(32, 7).toString('base64');
const secret = 'notification-test-identity-secret-2026';

test('seals capabilities and payloads without plaintext storage', () => {
  const value = { token: 'private-device-capability' }, encrypted = seal(value, key);
  assert.equal(encrypted.ciphertext.includes(Buffer.from(value.token)), false);
  assert.deepEqual(open(encrypted, key), value);
  assert.throws(() => open(encrypted, Buffer.alloc(32, 8).toString('base64')));
});

test('identity hashes are deterministic and isolated by application', () => {
  assert.equal(scopedHash('mema', 'user-1', secret), scopedHash('mema', 'user-1', secret));
  assert.notEqual(scopedHash('mema', 'user-1', secret), scopedHash('minigames-hub', 'user-1', secret));
});

test('validates FCM and Web Push devices and explicit denial', () => {
  assert.ok(validateDevice({ app_id: 'mema', recipient_reference: 'user-1', device_reference: 'device-001', transport: 'fcm', platform: 'android', permission: 'granted', capability: 'x'.repeat(64) }));
  assert.ok(validateDevice({ app_id: 'minigames-hub', recipient_reference: 'user-1', device_reference: 'browser-001', transport: 'web_push', platform: 'pwa', permission: 'granted', capability: { endpoint: 'https://push.example.invalid/subscription', expirationTime: null, keys: { p256dh: 'p'.repeat(32), auth: 'a'.repeat(16) } } }));
  assert.ok(validateDevice({ app_id: 'mema', recipient_reference: 'user-1', device_reference: 'device-001', transport: 'fcm', platform: 'android', permission: 'denied', capability: null }));
  assert.equal(validateDevice({ app_id: 'mema', recipient_reference: 'user-1', device_reference: 'device-001', transport: 'fcm', platform: 'android', permission: 'granted', capability: 'short' }), null);
  assert.equal(validateDevice({ app_id: 'mema', recipient_reference: 'person@example.test', device_reference: 'device-001', transport: 'fcm', platform: 'android', permission: 'granted', capability: 'x'.repeat(64) }), null);
});

test('bounds notification payload, deep link and idempotency', () => {
  const valid = { app_id: 'minigames-hub', event_type: 'challenge.created', recipient_reference: 'player-2', notification: { title: 'Nouveau défi', body: 'Un ami vous a lancé un défi.', data: { challenge_id: 'opaque-123' } }, deep_link: '/challenges/opaque-123' };
  assert.ok(validateMessage(valid, 'challenge:opaque-123:v1'));
  assert.equal(validateMessage({ ...valid, deep_link: 'javascript:alert(1)' }, 'challenge:opaque-123:v1'), null);
  assert.equal(validateMessage({ ...valid, notification: { ...valid.notification, data: { authorization: 'Bearer secret' } } }, 'challenge:opaque-123:v1'), null);
  assert.equal(validateMessage(valid, 'short'), null);
});

test('retry schedule is bounded and finite', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelaySeconds), [15, 30, 60, 120, 240]);
  assert.equal(retryDelaySeconds(20), 900);
});
