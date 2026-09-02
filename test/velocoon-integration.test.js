import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateVelocoonUser, validateVelocoonFeedback, velocoonActorHash } from '../src/velocoon-integration.js';

const sourceId = '49700000-0000-4000-8000-000000000020';
const payload = { source_feedback_id: sourceId, category: 'problème', message: 'Le bouton reste bloqué.', app_version: '1.0.0-pilot.1', platform: 'desktop', interface_locale: 'fr', current_screen: '/garage', viewport: '1280x720', has_attachment: true, client_occurred_at: new Date().toISOString() };

test('Velocoon feedback accepts the narrow contract and matching idempotency key', () => {
  assert.equal(validateVelocoonFeedback(payload, sourceId).type, 'bug');
  assert.equal(validateVelocoonFeedback({ ...payload, screenshot_path: 'private/path.webp' }, sourceId), null);
  assert.equal(validateVelocoonFeedback({ ...payload, email: 'private@example.invalid' }, sourceId), null);
  assert.equal(validateVelocoonFeedback(payload, 'other'), null);
});

test('Velocoon actor hashes are stable, opaque and app scoped', () => {
  const secret = 's'.repeat(32);
  assert.equal(velocoonActorHash('user-1', secret), velocoonActorHash('user-1', secret));
  assert.notEqual(velocoonActorHash('user-1', secret), velocoonActorHash('user-2', secret));
  assert.equal(velocoonActorHash('user-1', secret).length, 64);
});

test('Velocoon authentication validates the access token through Supabase Auth', async () => {
  process.env.VELOCOON_SUPABASE_URL = 'https://project.supabase.co';
  process.env.VELOCOON_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  process.env.INTEGRATION_HASH_SECRET = 's'.repeat(32);
  const request = { headers: { authorization: `Bearer ${'a'.repeat(90)}` } };
  const accepted = await authenticateVelocoonUser(request, async () => ({ ok: true, json: async () => ({ id: 'user-1' }) }));
  assert.equal(accepted.id, 'user-1');
  assert.equal(await authenticateVelocoonUser(request, async () => ({ ok: false })), null);
  delete process.env.VELOCOON_SUPABASE_URL; delete process.env.VELOCOON_SUPABASE_PUBLISHABLE_KEY; delete process.env.INTEGRATION_HASH_SECRET;
});
