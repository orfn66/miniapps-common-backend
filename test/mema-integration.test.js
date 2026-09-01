import assert from 'node:assert/strict';
import test from 'node:test';
import { actorHash, authenticateMemaUser, endpointHash, validateMemaFeedback, validatePushSubscription } from '../src/mema-integration.js';

const sourceId = '49700000-0000-4000-8000-000000000010';
const payload = { source_feedback_id: sourceId, kind: 'bug', description: 'Bouton bloqué', app_version: '0.1.0-rc.1', app_build: 'build1', platform: 'android', interface_locale: 'fr', current_screen: 'profile', client_occurred_at: new Date().toISOString() };

test('Mema feedback accepts only the narrow allowlist and matching idempotency key', () => {
  assert.equal(validateMemaFeedback(payload, sourceId).type, 'bug');
  assert.equal(validateMemaFeedback({ ...payload, email: 'private@example.invalid' }, sourceId), null);
  assert.equal(validateMemaFeedback(payload, 'other'), null);
  assert.equal(validateMemaFeedback({ ...payload, kind: 'other' }, sourceId), null);
});

test('push subscription validation rejects invalid endpoints and unknown fields', () => {
  const subscription = { endpoint: 'https://push.example.invalid/abc', expirationTime: null, keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(24) } };
  assert.ok(validatePushSubscription(subscription));
  assert.equal(validatePushSubscription({ ...subscription, endpoint: 'http://insecure.invalid' }), null);
  assert.equal(validatePushSubscription({ ...subscription, token: 'secret' }), null);
});

test('hashes are stable and app scoped without revealing identifiers', () => {
  const secret = 's'.repeat(32);
  assert.equal(actorHash('user-1', secret), actorHash('user-1', secret));
  assert.notEqual(actorHash('user-1', secret), actorHash('user-2', secret));
  assert.equal(endpointHash('https://push.example/1').length, 64);
});

test('Supabase Auth validation accepts valid users and rejects revoked/invalid tokens', async () => {
  process.env.MEMA_SUPABASE_URL = 'https://project.supabase.co';
  process.env.MEMA_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  process.env.INTEGRATION_HASH_SECRET = 's'.repeat(32);
  const request = { headers: { authorization: `Bearer ${'a'.repeat(90)}` } };
  const accepted = await authenticateMemaUser(request, async () => ({ ok: true, json: async () => ({ id: 'user-1' }) }));
  assert.equal(accepted.id, 'user-1');
  assert.equal(await authenticateMemaUser(request, async () => ({ ok: false })), null);
  delete process.env.MEMA_SUPABASE_URL; delete process.env.MEMA_SUPABASE_PUBLISHABLE_KEY; delete process.env.INTEGRATION_HASH_SECRET;
});
