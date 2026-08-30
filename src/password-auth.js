import { randomBytes, scrypt as callbackScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { hashToken } from './domain.js';

const scrypt = promisify(callbackScrypt);
const scryptOptions = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const sessionCookie = '__Host-app-platform-session';
const lifetimeSeconds = 12 * 60 * 60;
const fullScopes = ['apps:read','apps:write','feedback:read','feedback:write','attachments:read','attachments:delete','logs:read'];
const dummyHash = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

export function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 15 && [...value].length <= 128 && Buffer.byteLength(value) <= 512;
}
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, scryptOptions);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 512) return false;
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded || '');
  if (!match) return false;
  const actual = await scrypt(password, match[1], 64, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
}
function rawSession(request) {
  const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${sessionCookie}=`));
  const value = cookie?.slice(sessionCookie.length + 1);
  return /^[A-Za-z0-9_-]{64}$/.test(value || '') ? value : null;
}
function csrfFor(raw) { return hashToken(`${raw}:csrf`); }
function sameOrigin(request) {
  return request.headers.origin === `https://${request.headers.host}`;
}
export function sessionMutationAllowed(request) {
  const raw = rawSession(request), csrf = request.headers['x-csrf-token'];
  return !!raw && sameOrigin(request) && typeof csrf === 'string' && /^[a-f0-9]{64}$/.test(csrf) && timingSafeEqual(Buffer.from(csrf), Buffer.from(csrfFor(raw)));
}
function writeCookie(response, raw, age = lifetimeSeconds) {
  response.setHeader('set-cookie', `${sessionCookie}=${raw}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`);
}

export function createPasswordAuth({ pool, readJson, reply, authenticateBearer }) {
  let expensiveRequests = 0;
  async function sessionActor(request) {
    const raw = rawSession(request);
    if (!raw) return null;
    const result = await pool.query(`SELECT a.id,a.name,a.scopes,a.app_ids,c.id AS credential_id,c.email,s.token_hash AS session_hash
      FROM admin_sessions s JOIN admin_credentials c ON c.id=s.credential_id JOIN service_accounts a ON a.id=c.service_account_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.active=true AND a.revoked_at IS NULL`, [hashToken(raw)]);
    return result.rowCount ? { kind: 'service', ...result.rows[0] } : null;
  }
  async function newSession(response, credentialId) {
    const raw = randomBytes(48).toString('base64url');
    await pool.query("INSERT INTO admin_sessions(token_hash,credential_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hashToken(raw), credentialId]);
    writeCookie(response, raw);
    return csrfFor(raw);
  }
  async function budgetAllowed() {
    const result = await pool.query(`INSERT INTO admin_auth_budget(name,started_at,attempts) VALUES('password-auth',now(),1)
      ON CONFLICT(name) DO UPDATE SET attempts=CASE WHEN admin_auth_budget.started_at<now()-interval '1 minute' THEN 1 ELSE admin_auth_budget.attempts+1 END,
      started_at=CASE WHEN admin_auth_budget.started_at<now()-interval '1 minute' THEN now() ELSE admin_auth_budget.started_at END RETURNING attempts`);
    return result.rows[0].attempts <= 20;
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/api/v1/auth/')) return null;
    const send = (status, body) => { reply(response, status, body); return status; };
    if (request.method === 'GET' && url.pathname === '/api/v1/auth/session') {
      const actor = await sessionActor(request);
      return actor ? send(200, { email: actor.email, csrf_token: csrfFor(rawSession(request)) }) : send(401, { error: 'unauthorized' });
    }
    const action = url.pathname.slice('/api/v1/auth/'.length);
    if (request.method !== 'POST' || !['setup','login','logout','password'].includes(action)) return send(404, { error: 'not_found' });
    // Auth endpoints intentionally do not use the application's cross-origin CORS list.
    if (!sameOrigin(request) || request.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, { error: 'same_origin_required' });
    if (action === 'logout') {
      if (!sessionMutationAllowed(request)) return send(403, { error: 'csrf_invalid' });
      const raw = rawSession(request);
      await pool.query('UPDATE admin_sessions SET revoked_at=now() WHERE token_hash=$1', [hashToken(raw)]);
      writeCookie(response, '', 0);
      return send(200, { ok: true });
    }
    if (expensiveRequests >= 2 || !await budgetAllowed()) return send(429, { error: 'rate_limited' });
    expensiveRequests += 1;
    try {
      const input = await readJson(request, 4096);
      if (action === 'setup') {
        const actor = await authenticateBearer(request);
        if (!actor || actor.kind !== 'service' || actor.app_ids !== null || !fullScopes.every(scope => actor.scopes.includes(scope))) return send(403, { error: 'admin_token_required' });
        const email = normalizeEmail(input.email);
        if (!email || !validPassword(input.password)) return send(400, { error: 'email_or_password_invalid' });
        const encoded = await hashPassword(input.password);
        const result = await pool.query(`INSERT INTO admin_credentials(service_account_id,email,password_hash) VALUES($1,$2,$3)
          ON CONFLICT DO NOTHING RETURNING id`, [actor.id, email, encoded]);
        if (!result.rowCount) return send(409, { error: 'account_already_configured' });
        const csrf = await newSession(response, result.rows[0].id);
        return send(201, { email, csrf_token: csrf });
      }
      if (action === 'password') {
        const actor = await sessionActor(request);
        if (!actor) return send(401, { error: 'unauthorized' });
        if (!sessionMutationAllowed(request)) return send(403, { error: 'csrf_invalid' });
        if (!validPassword(input.password)) return send(400, { error: 'password_invalid' });
        const credential = await pool.query('SELECT password_hash FROM admin_credentials WHERE id=$1', [actor.credential_id]);
        if (!await verifyPassword(input.current_password, credential.rows[0].password_hash)) return send(401, { error: 'credentials_invalid' });
        const encoded = await hashPassword(input.password);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const changed = await client.query('UPDATE admin_credentials SET password_hash=$2,updated_at=now() WHERE id=$1 AND password_hash=$3 RETURNING id', [actor.credential_id, encoded, credential.rows[0].password_hash]);
          if (!changed.rowCount) { await client.query('ROLLBACK'); return send(409, { error: 'credentials_changed' }); }
          await client.query('UPDATE admin_sessions SET revoked_at=now() WHERE credential_id=$1 AND revoked_at IS NULL', [actor.credential_id]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        const csrf = await newSession(response, actor.credential_id);
        return send(200, { email: actor.email, csrf_token: csrf });
      }
      const email = normalizeEmail(input.email);
      if (!email || typeof input.password !== 'string' || Buffer.byteLength(input.password) > 512) return send(401, { error: 'credentials_invalid' });
      const result = await pool.query(`SELECT c.id,c.email,c.password_hash FROM admin_credentials c JOIN service_accounts a ON a.id=c.service_account_id
        WHERE c.email=$1 AND a.active=true AND a.revoked_at IS NULL`, [email]);
      const credential = result.rows[0];
      const valid = await verifyPassword(input.password, credential?.password_hash || dummyHash);
      if (!credential || !valid) return send(401, { error: 'credentials_invalid' });
      // Recheck under a lock: a concurrent password change must not leave a fresh old-password session.
      const client = await pool.connect();
      const raw = randomBytes(48).toString('base64url');
      try {
        await client.query('BEGIN');
        const unchanged = await client.query('SELECT id FROM admin_credentials WHERE id=$1 AND password_hash=$2 FOR UPDATE', [credential.id, credential.password_hash]);
        if (!unchanged.rowCount) { await client.query('ROLLBACK'); return send(401, { error: 'credentials_invalid' }); }
        await client.query("INSERT INTO admin_sessions(token_hash,credential_id,expires_at) VALUES($1,$2,now()+interval '12 hours')", [hashToken(raw), credential.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      writeCookie(response, raw);
      return send(200, { email: credential.email, csrf_token: csrfFor(raw) });
    } finally { expensiveRequests -= 1; }
  }
  return { sessionActor, handle };
}
