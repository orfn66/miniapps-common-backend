import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { hashToken } from "../src/domain.js";
import { processNotificationBatch } from '../src/notification-service.js';
import { testDecisions } from './decision.integration.mjs';

const adminUrl = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_platform_test";
const parsedAdminUrl = new URL(adminUrl);
const databaseHost = parsedAdminUrl.hostname;
const databasePort = parsedAdminUrl.port || "5432";
const databaseName = decodeURIComponent(parsedAdminUrl.pathname.slice(1));
const databaseUser = decodeURIComponent(parsedAdminUrl.username);
const databasePassword = decodeURIComponent(parsedAdminUrl.password);
if (!['127.0.0.1','localhost'].includes(databaseHost) || !databaseName.startsWith('app_platform_')) throw new Error('Integration tests require an isolated local app_platform_* database');
const apiPort = process.env.TEST_API_PORT || "3100";
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const runtimePassword = "runtime-integration-only";
const notificationEncryptionKey = Buffer.alloc(32, 17).toString('base64');
const notificationIdentitySecret = 'integration-notification-identity-secret-2026';
const directory = await mkdtemp(join(tmpdir(), "app-platform-integration-"));
const admin = new pg.Client({ connectionString: adminUrl });
let server;

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(`${apiOrigin}/api/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("integration server did not become healthy");
}

async function json(path, init = {}) {
  const response = await fetch(`${apiOrigin}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

try {
  await admin.connect();
  if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='miniapps_api'")).rowCount) {
    await admin.query(`CREATE ROLE miniapps_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${runtimePassword}'`);
  }
  await admin.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(databaseName)} TO miniapps_api; GRANT USAGE ON SCHEMA public TO miniapps_api`);
  await admin.query("CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
  await admin.query(await readFile(new URL("../migrations/001_initial.sql", import.meta.url), "utf8"));
  await admin.query("INSERT INTO schema_migrations(filename) VALUES('001_initial.sql')");
  const legacyInstallation = randomUUID();
  await admin.query("INSERT INTO installations(id,game_slug,token_hash,client_version) VALUES($1,'perfect-tap',$2,'0.2.0')", [legacyInstallation, "f".repeat(64)]);
  await admin.query("INSERT INTO feedback(installation_id,type,comment,status) VALUES($1,'like','','check')", [legacyInstallation]);
  await new Promise((resolve, reject) => {
    const migration = spawn(process.execPath, ["src/migrate.js"], { stdio: "inherit", env: { ...process.env, PGHOST: databaseHost, PGPORT: databasePort, PGDATABASE: databaseName, PGUSER: databaseUser, PGPASSWORD: databasePassword } });
    migration.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`migration exited ${code}`)));
  });
  const converted = await admin.query("SELECT type,status,title FROM feedback WHERE installation_id=$1", [legacyInstallation]);
  assert.deepEqual(converted.rows[0], { type: "review", status: "to_analyze", title: "Avis utilisateur" });
  const registry = await admin.query("SELECT slug,status,active FROM games ORDER BY slug");
  assert.deepEqual(registry.rows, [{ slug: "mema", status: "active", active: true }, { slug: "minigames-hub", status: "active", active: true }, { slug: "perfect-tap", status: "archived", active: false }]);

  const adminToken = randomBytes(48).toString("base64url"), codexToken = randomBytes(48).toString("base64url");
  await admin.query("INSERT INTO service_accounts(name,token_hash,scopes,app_ids) VALUES('integration-admin',$1,$2,NULL),('codex-reader',$3,$4,ARRAY['minigames-hub'])", [hashToken(adminToken), ["apps:read","apps:write","feedback:read","feedback:write","attachments:read","attachments:delete","logs:read","notifications:read"], hashToken(codexToken), ["apps:read","feedback:read","attachments:read","logs:read"]]);
  const hubNotificationToken=randomBytes(48).toString('base64url'),memaNotificationToken=randomBytes(48).toString('base64url');
  await admin.query("INSERT INTO service_accounts(name,token_hash,scopes,app_ids) VALUES('hub-notifications',$1,$2,ARRAY['minigames-hub']),('mema-notifications',$3,$2,ARRAY['mema'])", [hashToken(hubNotificationToken), ['notifications:devices:write','notifications:send','notifications:read'], hashToken(memaNotificationToken)]);
  server = spawn(process.execPath, ["src/server.js"], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PGHOST: databaseHost, PGPORT: databasePort, PGDATABASE: databaseName, PGUSER: "miniapps_api", PGPASSWORD: runtimePassword, PORT: apiPort, ATTACHMENTS_DIR: directory, CORS_ALLOWED_ORIGINS: "http://localhost", NOTIFICATION_TOKEN_ENCRYPTION_KEY:notificationEncryptionKey, NOTIFICATION_IDENTITY_HMAC_SECRET:notificationIdentitySecret } });
  await waitForHealth();
  assert.equal((await fetch(`${apiOrigin}/admin`)).status, 200);
  const installation = await json("/api/v1/installations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: "minigames-hub", client_version: "0.1.0" }) });
  assert.equal(installation.response.status, 201);
  const auth = { authorization: `Bearer ${installation.body.token}` };
  const ticket = await json("/api/v1/feedback", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ type: "bug", message: "Integration test", technical_context: { area: "home", module: "perfect-tap" } }) });
  assert.equal(ticket.response.status, 201);
  const pixel = Buffer.from("89504e470d0a1a0a", "hex");
  const upload = await json(`/api/v1/feedback/${ticket.body.feedback.public_id}/attachments`, { method: "POST", headers: { ...auth, "content-type": "image/png", "x-attachment-consent": "true", "x-file-name": "pixel.png" }, body: pixel });
  assert.equal(upload.response.status, 201);
  const adminHeaders = { authorization: `Bearer ${adminToken}` }, codexHeaders = { authorization: `Bearer ${codexToken}` };
  assert.equal((await json("/api/v1/admin/feedback", { headers: adminHeaders })).response.status, 200);
  assert.equal((await fetch(`${apiOrigin}/api/v1/admin/attachments/${upload.body.attachment.id}`, { headers: codexHeaders })).status, 200);
  assert.equal((await json(`/api/v1/admin/feedback/${ticket.body.feedback.public_id}`, { method: "PATCH", headers: { ...codexHeaders, "content-type": "application/json" }, body: JSON.stringify({ status: "to_analyze" }) })).response.status, 403);
  const outsideScope = await json("/api/v1/admin/feedback?app_id=perfect-tap", { headers: codexHeaders });
  assert.equal(outsideScope.response.status, 200);
  assert.deepEqual(outsideScope.body.feedback, []);
  assert.equal((await json(`/api/v1/admin/feedback/${ticket.body.feedback.public_id}`, { method: "PATCH", headers: { ...adminHeaders, "content-type": "application/json" }, body: JSON.stringify({ status: "to_analyze" }) })).response.status, 200);
  assert.equal((await json("/api/v1/admin/logs", { headers: codexHeaders })).response.status, 200);

  // The same notification API serves both apps, while app-scoped credentials
  // cannot register or target another application's devices.
  const hubNotificationHeaders={authorization:`Bearer ${hubNotificationToken}`,'content-type':'application/json'};
  const memaNotificationHeaders={authorization:`Bearer ${memaNotificationToken}`,'content-type':'application/json'};
  const hubDevice={app_id:'minigames-hub',recipient_reference:'player-2',device_reference:'android-test-001',transport:'fcm',platform:'android',permission:'granted',capability:'fcm-test-token-'.padEnd(64,'x')};
  const hubRegistration=await json('/api/v1/notifications/devices',{method:'POST',headers:hubNotificationHeaders,body:JSON.stringify(hubDevice)});
  assert.equal(hubRegistration.response.status,200);
  assert.equal((await json('/api/v1/notifications/devices',{method:'POST',headers:memaNotificationHeaders,body:JSON.stringify(hubDevice)})).response.status,400);
  const memaDevice={app_id:'mema',recipient_reference:'parent-1',device_reference:'pwa-test-001',transport:'web_push',platform:'pwa',permission:'granted',capability:{endpoint:'https://push.example.invalid/mema-test',expirationTime:null,keys:{p256dh:'p'.repeat(32),auth:'a'.repeat(16)}}};
  assert.equal((await json('/api/v1/notifications/devices',{method:'POST',headers:memaNotificationHeaders,body:JSON.stringify(memaDevice)})).response.status,200);
  const hubMessage={app_id:'minigames-hub',event_type:'challenge.created',recipient_reference:'player-2',notification:{title:'Nouveau défi',body:'Un ami vous a lancé un défi.',data:{challenge_id:'challenge-test'}},deep_link:'/challenges/challenge-test'};
  const messageHeaders={...hubNotificationHeaders,'idempotency-key':'challenge:test:v1'};
  const queued=await json('/api/v1/notifications/messages',{method:'POST',headers:messageHeaders,body:JSON.stringify(hubMessage)});
  assert.equal(queued.response.status,202);assert.equal(queued.body.notification.device_count,1);
  assert.equal((await json('/api/v1/notifications/messages',{method:'POST',headers:messageHeaders,body:JSON.stringify(hubMessage)})).response.status,200);
  assert.equal((await json('/api/v1/notifications/messages',{method:'POST',headers:messageHeaders,body:JSON.stringify({...hubMessage,event_type:'challenge.changed'})})).response.status,409);
  assert.equal((await json('/api/v1/admin/notifications',{headers:codexHeaders})).response.status,403);
  assert.equal((await json('/api/v1/notifications/devices',{method:'POST',headers:codexHeaders,body:JSON.stringify(hubDevice)})).response.status,403);
  assert.equal((await json('/api/v1/notifications/messages',{method:'POST',headers:{...codexHeaders,'idempotency-key':'reader-write-denied'},body:JSON.stringify(hubMessage)})).response.status,403);
  assert.equal((await json('/api/v1/admin/notifications',{headers:adminHeaders})).response.status,200);
  const runtimePool=new pg.Pool({host:databaseHost,port:Number(databasePort),database:databaseName,user:'miniapps_api',password:runtimePassword});
  process.env.NOTIFICATION_TOKEN_ENCRYPTION_KEY=notificationEncryptionKey;process.env.NOTIFICATION_IDENTITY_HMAC_SECRET=notificationIdentitySecret;
  let transient=true;
  const deliveries={fcm:async()=>{if(transient){transient=false;throw Object.assign(new Error('provider_unavailable'),{code:'provider_unavailable'});}return{providerMessageId:'fake-fcm-1'};},web_push:async()=>({providerMessageId:'fake-web-1'})};
  assert.equal(await processNotificationBatch(runtimePool,{deliveryTransports:deliveries}),1);
  let delivery=await admin.query('SELECT status,attempt_count,last_error_code FROM notification_deliveries');
  assert.deepEqual(delivery.rows[0],{status:'pending',attempt_count:1,last_error_code:'provider_unavailable'});
  await admin.query('UPDATE notification_deliveries SET next_attempt_at=now()');
  assert.equal(await processNotificationBatch(runtimePool,{deliveryTransports:deliveries}),1);
  delivery=await admin.query('SELECT status,attempt_count,last_error_code FROM notification_deliveries');
  assert.deepEqual(delivery.rows[0],{status:'delivered',attempt_count:2,last_error_code:null});
  assert.equal((await json('/api/v1/notifications/devices',{method:'POST',headers:hubNotificationHeaders,body:JSON.stringify({...hubDevice,device_reference:'permission-denied-001',permission:'denied',capability:null})})).response.status,200);
  assert.equal((await admin.query("SELECT count(*)::integer AS count FROM notification_devices WHERE device_reference_hash IS NOT NULL")).rows[0].count,2);
  const deadDevice={...hubDevice,recipient_reference:'dead-player',device_reference:'android-dead-001',capability:'dead-fcm-token-'.padEnd(64,'z')};
  await json('/api/v1/notifications/devices',{method:'POST',headers:hubNotificationHeaders,body:JSON.stringify(deadDevice)});
  const deadMessage={...hubMessage,recipient_reference:'dead-player'};
  await json('/api/v1/notifications/messages',{method:'POST',headers:{...hubNotificationHeaders,'idempotency-key':'challenge:dead:v1'},body:JSON.stringify(deadMessage)});
  const permanent={...deliveries,fcm:async()=>{throw Object.assign(new Error('UNREGISTERED'),{code:'UNREGISTERED',permanent:true})}};
  assert.equal(await processNotificationBatch(runtimePool,{deliveryTransports:permanent}),1);
  assert.equal((await admin.query("SELECT state FROM notification_devices WHERE capability_hash=$1",[(await import('../src/notification-domain.js')).capabilityHash(deadDevice.capability)])).rows[0].state,'invalid');
  assert.equal((await json(`/api/v1/notifications/devices/${hubRegistration.body.device.id}`,{method:'DELETE',headers:hubNotificationHeaders})).response.status,200);
  assert.equal((await json(`/api/v1/notifications/devices/${hubRegistration.body.device.id}`,{method:'DELETE',headers:memaNotificationHeaders})).response.status,404);
  await runtimePool.end();
  const stored=await admin.query("SELECT position(convert_to($1,'UTF8') in capability_ciphertext)>0 AS leaked FROM notification_devices ORDER BY app_id",[hubDevice.capability]);
  assert.equal(stored.rows.some(row=>row.leaked),false);

  // Password authentication is additive: setup needs a full unrestricted admin bearer.
  const authOrigin = `https://127.0.0.1:${apiPort}`;
  const password = 'Isolated test passphrase 2026!';
  const loginInput = {email:'Test.Admin@example.invalid',password};
  const authPost = (action, body, extra={}) => json(`/api/v1/auth/${action}`, {
    method:'POST',headers:{origin:authOrigin,'content-type':'application/json',...extra},body:JSON.stringify(body),
  });
  assert.equal((await fetch(`${apiOrigin}/`,{redirect:'manual'})).headers.get('location'), '/admin');
  assert.equal((await authPost('setup',loginInput)).response.status,403);
  assert.equal((await authPost('setup',loginInput,codexHeaders)).response.status,403);
  assert.equal((await authPost('setup',loginInput,{...adminHeaders,origin:'https://hostile.example'})).response.status,403);
  assert.equal((await authPost('setup',{...loginInput,password:'short'},adminHeaders)).response.status,400);
  const setup = await authPost('setup',loginInput,adminHeaders);
  assert.equal(setup.response.status,201);
  const setupCookieHeader = setup.response.headers.get('set-cookie');
  for (const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/','Max-Age=43200']) assert.ok(setupCookieHeader.includes(flag));
  assert.ok(setupCookieHeader.startsWith('__Host-'));
  assert.equal(setupCookieHeader.includes('Domain='),false);
  const setupCookie = setupCookieHeader.split(';')[0];
  assert.equal((await authPost('setup',loginInput,adminHeaders)).response.status,409);
  assert.equal((await authPost('login',{...loginInput,password:'incorrect'})).response.status,401);
  assert.equal((await authPost('login',{email:'unknown@example.invalid',password})).response.status,401);
  const login = await authPost('login',{...loginInput,email:'test.admin@example.invalid'});
  assert.equal(login.response.status,200);
  const loginCookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.notEqual(loginCookie,setupCookie);
  const session = await json('/api/v1/auth/session',{headers:{cookie:loginCookie}});
  assert.equal(session.response.status,200);
  assert.equal(session.body.email,'test.admin@example.invalid');
  assert.equal((await json('/api/v1/admin/feedback',{headers:{cookie:loginCookie}})).response.status,200);
  assert.equal((await fetch(`${apiOrigin}/api/v1/admin/attachments/${upload.body.attachment.id}`,{headers:{cookie:loginCookie}})).status,200);
  assert.equal((await json('/api/v1/admin/feedback',{headers:{cookie:loginCookie,authorization:'Bearer invalid'}})).response.status,401);
  const cookiePatch = headers => json(`/api/v1/admin/feedback/${ticket.body.feedback.public_id}`,{method:'PATCH',headers:{cookie:loginCookie,'content-type':'application/json','x-forwarded-proto':'https',...headers},body:JSON.stringify({status:'confirmed'})});
  assert.equal((await cookiePatch({origin:authOrigin})).response.status,403);
  assert.equal((await cookiePatch({origin:'https://hostile.example','x-csrf-token':login.body.csrf_token})).response.status,403);
  assert.equal((await cookiePatch({origin:authOrigin,'x-csrf-token':login.body.csrf_token})).response.status,200);
  await testDecisions({json,admin,id:ticket.body.feedback.public_id,legacyInstallation,auth,adminHeaders,codexHeaders,loginCookie,csrf:login.body.csrf_token,authOrigin});
  assert.equal((await authPost('logout',{}, {cookie:loginCookie})).response.status,403);
  assert.equal((await authPost('logout',{}, {cookie:loginCookie,'x-csrf-token':login.body.csrf_token})).response.status,200);
  assert.equal((await json('/api/v1/auth/session',{headers:{cookie:loginCookie}})).response.status,401);

  const newPassword = 'A different isolated passphrase 2026!';
  assert.equal((await authPost('password',{current_password:'wrong',password:newPassword},{cookie:setupCookie,'x-csrf-token':setup.body.csrf_token})).response.status,401);
  const changed = await authPost('password',{current_password:password,password:newPassword},{cookie:setupCookie,'x-csrf-token':setup.body.csrf_token});
  assert.equal(changed.response.status,200);
  assert.equal((await json('/api/v1/auth/session',{headers:{cookie:setupCookie}})).response.status,401);
  assert.equal((await authPost('login',loginInput)).response.status,401);
  const newLogin = await authPost('login',{...loginInput,password:newPassword});
  assert.equal(newLogin.response.status,200);
  const newCookie = newLogin.response.headers.get('set-cookie').split(';')[0];
  await admin.query("UPDATE service_accounts SET active=false WHERE name='integration-admin'");
  assert.equal((await json('/api/v1/auth/session',{headers:{cookie:newCookie}})).response.status,401);
  await admin.query("UPDATE service_accounts SET active=true WHERE name='integration-admin'");
  await admin.query("UPDATE admin_sessions SET expires_at=now()-interval '1 second'");
  assert.equal((await json('/api/v1/auth/session',{headers:{cookie:newCookie}})).response.status,401);
  assert.equal((await json('/api/v1/admin/feedback',{headers:adminHeaders})).response.status,200);
  await admin.query("UPDATE admin_auth_budget SET attempts=20,started_at=now()");
  assert.equal((await authPost('login',{...loginInput,password:newPassword})).response.status,429);
  console.log(JSON.stringify({ event: "integration_complete", status: "ok" }));
} finally {
  if (server) { server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); }
  await admin.end().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
