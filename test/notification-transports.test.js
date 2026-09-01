import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

test('FCM HTTP v1 signs locally and classifies an expired device token as permanent', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'fixture@app-platform.invalid',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'fixture-project'
  });
  const { deliverFcm } = await import('../src/notification-transports.js');
  const requests = [];
  const fetchOk = async (url, init) => {
    requests.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'synthetic-access-token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ name: 'projects/fixture/messages/1' }), { status: 200 });
  };
  const result = await deliverFcm('x'.repeat(64), { title: 'Titre', body: 'Corps', data: { event: 'fixture' }, deep_link: '/challenge/1' }, fetchOk);
  assert.equal(result.providerMessageId, 'projects/fixture/messages/1');
  assert.equal(requests.length, 2);
  assert.match(requests[0].init.body.toString(), /grant_type=/);
  const sent = JSON.parse(requests[1].init.body);
  assert.equal(sent.message.token, 'x'.repeat(64));
  assert.equal(sent.message.data.deep_link, '/challenge/1');

  const fetchExpired = async () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 400 });
  await assert.rejects(() => deliverFcm('y'.repeat(64), { title: 'Titre', body: 'Corps', data: {} }, fetchExpired), error => error.code === 'UNREGISTERED' && error.permanent === true);
});
