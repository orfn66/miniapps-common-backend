import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validPassword, normalizeEmail, sessionMutationAllowed } from '../src/password-auth.js';
import { hashToken } from '../src/domain.js';

test('passwords use salted scrypt and bounded passphrases', async () => {
  const password = 'A test passphrase, not a real credential!';
  assert.equal(validPassword('short'), false);
  assert.equal(validPassword('x'.repeat(129)), false);
  assert.equal(validPassword(password), true);
  const first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect', first), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
});
test('email is normalized and session writes require CSRF and exact origin', () => {
  assert.equal(normalizeEmail('  Example@Example.com '), 'example@example.com');
  assert.equal(normalizeEmail('not an email'), null);
  const raw = 'x'.repeat(64);
  const headers = {host:'platform.example',origin:'https://platform.example',cookie:`__Host-app-platform-session=${raw}`,'x-csrf-token':hashToken(`${raw}:csrf`)};
  assert.equal(sessionMutationAllowed({headers}), true);
  assert.equal(sessionMutationAllowed({headers:{...headers,origin:'https://hub.example'}}), false);
  assert.equal(sessionMutationAllowed({headers:{...headers,'x-csrf-token':undefined}}), false);
  assert.equal(sessionMutationAllowed({headers:{...headers,'x-csrf-token':'f'.repeat(64)}}), false);
});
