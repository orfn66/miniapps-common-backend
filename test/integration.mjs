import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { hashToken } from "../src/domain.js";

const adminUrl = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_platform_test";
const parsedAdminUrl = new URL(adminUrl);
const databaseHost = parsedAdminUrl.hostname;
const databasePort = parsedAdminUrl.port || "5432";
const databaseName = decodeURIComponent(parsedAdminUrl.pathname.slice(1));
const databaseUser = decodeURIComponent(parsedAdminUrl.username);
const databasePassword = decodeURIComponent(parsedAdminUrl.password);
const apiPort = process.env.TEST_API_PORT || "3100";
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const runtimePassword = "runtime-integration-only";
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
  await admin.query(`CREATE ROLE miniapps_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${runtimePassword}'`);
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
  assert.deepEqual(registry.rows, [{ slug: "minigames-hub", status: "active", active: true }, { slug: "perfect-tap", status: "archived", active: false }]);

  const adminToken = randomBytes(48).toString("base64url"), codexToken = randomBytes(48).toString("base64url");
  await admin.query("INSERT INTO service_accounts(name,token_hash,scopes,app_ids) VALUES('integration-admin',$1,$2,NULL),('codex-reader',$3,$4,ARRAY['minigames-hub'])", [hashToken(adminToken), ["apps:read","apps:write","feedback:read","feedback:write","attachments:read","attachments:delete","logs:read"], hashToken(codexToken), ["apps:read","feedback:read","attachments:read","logs:read"]]);
  server = spawn(process.execPath, ["src/server.js"], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PGHOST: databaseHost, PGPORT: databasePort, PGDATABASE: databaseName, PGUSER: "miniapps_api", PGPASSWORD: runtimePassword, PORT: apiPort, ATTACHMENTS_DIR: directory, CORS_ALLOWED_ORIGINS: "http://localhost" } });
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
  assert.equal((await json("/api/v1/admin/logs", { headers: codexHeaders })).response.status, 200);
  console.log(JSON.stringify({ event: "integration_complete", status: "ok" }));
} finally {
  if (server) { server.kill("SIGTERM"); await new Promise((resolve) => server.once("exit", resolve)); }
  await admin.end().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
