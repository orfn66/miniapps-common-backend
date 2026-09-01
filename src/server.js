import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { createMemaHandler } from './mema-server.js';
import { createNotificationHandler } from './notification-service.js';
import { createPasswordAuth, sessionMutationAllowed } from "./password-auth.js";
import { canEditDecision, changeDecision, decisionSelect, hasDecisionFields } from './decision.js';
import { hashToken, issueInstallationCredential, validateApplication, validateFeedback, validateInstallation, validatePlaySession, validateStatusTransition } from "./domain.js";

const { Pool } = pg;
const pool = new Pool({ max: 8, idleTimeoutMillis: 30_000 });
const port = Number(process.env.PORT || 3000);
const attachmentDirectory = process.env.ATTACHMENTS_DIR || "/data/attachments";
const adminDirectory = fileURLToPath(new URL("../admin/", import.meta.url));
const allowedOrigins = new Set((process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
const rateWindows = new Map();
let installationWindow = { startedAt: Date.now(), count: 0 };
await mkdir(attachmentDirectory, { recursive: true });

function headers(contentType) {
  return { "cache-control": "no-store", "content-type": contentType, "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob:; connect-src 'self'", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
}
function reply(response, status, payload, origin) {
  const outgoing = headers("application/json; charset=utf-8");
  if (origin) outgoing["access-control-allow-origin"] = origin;
  response.writeHead(status, outgoing); response.end(JSON.stringify(payload));
}
async function readJson(request, maximum = 32_768) {
  let body = "";
  for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > maximum) throw new Error("payload_too_large"); }
  try { return JSON.parse(body || "{}"); } catch { throw new Error("invalid_json"); }
}
async function readBinary(request, maximum = 5_242_880) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > maximum) throw new Error("payload_too_large"); chunks.push(chunk); }
  if (!length) throw new Error("input_invalid");
  return Buffer.concat(chunks);
}
async function authenticateBearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(request.headers.authorization || "");
  if (!match) return null;
  const tokenHash = hashToken(match[1]);
  const installation = await pool.query("SELECT id,game_slug AS app_id FROM installations WHERE token_hash=$1 AND revoked_at IS NULL", [tokenHash]);
  if (installation.rowCount) return { kind: "installation", ...installation.rows[0] };
  const service = await pool.query("UPDATE service_accounts SET last_used_at=now() WHERE token_hash=$1 AND active=true AND revoked_at IS NULL RETURNING id,name,scopes,app_ids", [tokenHash]);
  return service.rowCount ? { kind: "service", ...service.rows[0] } : null;
}
const handleMema = createMemaHandler({ pool, reply, readJson, readBinary, attachmentDirectory, rateAllowed });
const handleNotifications = createNotificationHandler({ pool, reply, readJson });
const requireService = (actor, scope) => actor?.kind === "service" && actor.scopes.includes(scope);
const passwordAuth = createPasswordAuth({ pool, readJson, reply, authenticateBearer });
async function authenticate(request) {
  // An explicitly supplied invalid Bearer must never silently fall back to cookies.
  return request.headers.authorization ? authenticateBearer(request) : passwordAuth.sessionActor(request);
}
const serviceCanAccessApp = (actor, appId) => actor.app_ids === null || actor.app_ids.includes(appId);
function rateAllowed(key, maximum = 60) {
  const now = Date.now(), current = rateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) { rateWindows.set(key, { startedAt: now, count: 1 }); return true; }
  current.count += 1; return current.count <= maximum;
}
function installationCreationAllowed() {
  const now = Date.now(); if (now - installationWindow.startedAt >= 60_000) installationWindow = { startedAt: now, count: 0 };
  installationWindow.count += 1; return installationWindow.count <= 30;
}
function originAllowed(request, origin) {
  if (!origin || allowedOrigins.has(origin)) return true;
  return origin === `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}`;
}
function safeFilename(value) {
  if (typeof value !== "string") return undefined;
  return value.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 255) || undefined;
}
function detectImageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { type: "image/jpeg", extension: ".jpg" };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", extension: ".png" };
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return { type: "image/webp", extension: ".webp" };
  return null;
}
async function audit(actor, action, targetType, targetId, details = {}) {
  await pool.query("INSERT INTO platform_audit_log(actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)", [actor.name, action, targetType, targetId, details]);
}
async function purgeExpiredAttachments() {
  const expired = await pool.query("SELECT id,storage_name FROM feedback_attachments WHERE deleted_at IS NULL AND expires_at<=now() LIMIT 100");
  for (const item of expired.rows) {
    await unlink(join(attachmentDirectory, item.storage_name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await pool.query("UPDATE feedback_attachments SET deleted_at=now() WHERE id=$1", [item.id]);
  }
  if (expired.rowCount) console.log(JSON.stringify({ event: "attachments_purged", count: expired.rowCount }));
}
function listFilters(url, actor) {
  const clauses = [], values = [];
  const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  for (const [parameter, column] of [["app_id", "coalesce(i.game_slug,f.source_app)"], ["type", "f.type"], ["status", "f.status"], ["priority", "f.priority"], ["version", "f.client_version"], ["chris_decision", "f.chris_decision"]]) if (url.searchParams.get(parameter)) add(`${column} = ?`, url.searchParams.get(parameter));
  if (url.searchParams.get("from")) add("f.created_at >= ?::timestamptz", url.searchParams.get("from"));
  if (url.searchParams.get("to")) add("f.created_at < ?::timestamptz + interval '1 day'", url.searchParams.get("to"));
  if (actor.app_ids !== null) add("coalesce(i.game_slug,f.source_app) = ANY(?::text[])", actor.app_ids);
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}
async function sendAdminAsset(response, pathname) {
  const names = new Map([["/admin", "index.html"], ["/admin/", "index.html"], ["/admin/app.js", "app.js"], ["/admin/style.css", "style.css"]]);
  const name = names.get(pathname); if (!name) return false;
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  response.writeHead(200, headers(types[extname(name)]));
  createReadStream(join(adminDirectory, name)).pipe(response); return true;
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now(), url = new URL(request.url, "http://localhost"), origin = request.headers.origin || ""; let status = 500;
  try {
    const authStatus = await passwordAuth.handle(request, response, url);
    if (authStatus !== null) { status = authStatus; return; }
    if (request.method === 'GET' && url.pathname === '/') {
      status = 302; response.writeHead(status, { ...headers('text/plain'), location: '/admin' }); return response.end();
    }
    if (!originAllowed(request, origin)) { status = 403; return reply(response, status, { error: "origin_not_allowed" }); }
    if (request.method === "OPTIONS") {
      status = 204; response.writeHead(status, { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type, idempotency-key, x-attachment-consent, x-file-name", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-max-age": "600" }); return response.end();
    }
    if (request.method === "GET" && url.pathname.startsWith("/admin") && await sendAdminAsset(response, url.pathname)) { status = 200; return; }
    if (request.method === "GET" && url.pathname === "/api/health") { await pool.query("SELECT 1"); status = 200; return reply(response, status, { status: "ok", service: "app-platform", api_version: "v1" }, origin); }
    if (request.method === "GET" && url.pathname === "/api/v1/apps") {
      const result = await pool.query("SELECT slug AS app_id,name,app_type AS type,platforms,current_version,status FROM games WHERE active=true AND status='active' ORDER BY slug");
      status = 200; return reply(response, status, { apps: result.rows }, origin);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/games") {
      const result = await pool.query("SELECT slug,name FROM games WHERE app_type='mini_game' ORDER BY slug");
      status = 200; return reply(response, status, { games: result.rows }, origin);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/installations") {
      if (!installationCreationAllowed()) { status = 429; return reply(response, status, { error: "rate_limited" }, origin); }
      const input = validateInstallation(await readJson(request)); if (!input) { status = 400; return reply(response, status, { error: "input_invalid" }, origin); }
      const credential = issueInstallationCredential();
      const inserted = await pool.query("INSERT INTO installations(id,game_slug,token_hash,client_version) SELECT $1,slug,$3,$4 FROM games WHERE slug=$2 AND active=true AND status='active' RETURNING id", [credential.id, input.gameSlug, credential.tokenHash, input.clientVersion]);
      if (!inserted.rowCount) { status = 404; return reply(response, status, { error: "app_unknown_or_inactive" }, origin); }
      status = 201; return reply(response, status, { installation_id: credential.id, token: credential.token }, origin);
    }

    const memaStatus = await handleMema(request, response, url, origin);
    if (memaStatus !== null) { status = memaStatus; return; }
    const actor = await authenticate(request);
    if (!actor) { status = 401; return reply(response, status, { error: "unauthorized" }, origin); }
    if (actor.session_hash && !['GET','HEAD','OPTIONS'].includes(request.method) && !sessionMutationAllowed(request)) {
      status = 403; return reply(response, status, { error: 'csrf_invalid' }, origin);
    }
    if (!rateAllowed(`${actor.kind}:${actor.id}`, actor.kind === "service" ? 300 : 60)) { status = 429; return reply(response, status, { error: "rate_limited" }, origin); }

    const notificationStatus = await handleNotifications(request, response, url, origin, actor);
    if (notificationStatus !== null) { status = notificationStatus; return; }

    if (request.method === "POST" && url.pathname === "/api/v1/feedback" && actor.kind === "installation") {
      const input = validateFeedback(await readJson(request)); if (!input) { status = 400; return reply(response, status, { error: "input_invalid" }, origin); }
      const pseudonym = input.userReference ? createHash("sha256").update(`${actor.app_id}:${input.userReference}`).digest("hex") : null;
      const result = await pool.query(`INSERT INTO feedback(installation_id,type,comment,title,priority,client_version,client_occurred_at,route,device,os,browser,resolution,technical_context,pseudonymous_user_id)
        SELECT $1,$2,$3,$4,$5,i.client_version,$6,$7,$8,$9,$10,$11,$12,$13 FROM installations i WHERE i.id=$1
        RETURNING public_id,type,title,priority,status,created_at`, [actor.id, input.type, input.comment, input.title, input.priority, input.occurredAt, input.route, input.device, input.os, input.browser, input.resolution, input.technicalContext, pseudonym]);
      status = 201; return reply(response, status, { feedback: result.rows[0] }, origin);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/feedback/mine" && actor.kind === "installation") {
      const result = await pool.query("SELECT public_id,type,title,comment AS message,priority,status,created_at FROM feedback WHERE installation_id=$1 ORDER BY id DESC LIMIT 50", [actor.id]);
      status = 200; return reply(response, status, { feedback: result.rows }, origin);
    }
    const attachmentMatch = /^\/api\/v1\/feedback\/([0-9a-f-]{36})\/attachments$/.exec(url.pathname);
    if (request.method === "POST" && attachmentMatch && actor.kind === "installation") {
      if (request.headers["x-attachment-consent"] !== "true") { status = 400; return reply(response, status, { error: "explicit_consent_required" }, origin); }
      const ticket = await pool.query("SELECT id FROM feedback WHERE public_id=$1 AND installation_id=$2", [attachmentMatch[1], actor.id]);
      if (!ticket.rowCount) { status = 404; return reply(response, status, { error: "feedback_not_found" }, origin); }
      const buffer = await readBinary(request), detected = detectImageType(buffer);
      if (!detected || request.headers["content-type"]?.split(";")[0] !== detected.type) { status = 415; return reply(response, status, { error: "image_type_invalid" }, origin); }
      const storageName = `${randomBytes(24).toString("hex")}${detected.extension}`;
      await writeFile(join(attachmentDirectory, storageName), buffer, { flag: "wx", mode: 0o600 });
      let inserted;
      try { inserted = await pool.query("INSERT INTO feedback_attachments(feedback_id,storage_name,original_name,media_type,byte_size,sha256,consent_at) VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING id,media_type,byte_size,created_at,expires_at", [ticket.rows[0].id, storageName, safeFilename(request.headers["x-file-name"]), detected.type, buffer.length, createHash("sha256").update(buffer).digest("hex")]); }
      catch (error) { await unlink(join(attachmentDirectory, storageName)).catch(() => undefined); throw error; }
      status = 201; return reply(response, status, { attachment: inserted.rows[0] }, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/play-sessions" && actor.kind === "installation") {
      const input = validatePlaySession(await readJson(request), request.headers["idempotency-key"]); if (!input) { status = 400; return reply(response, status, { error: "input_invalid" }, origin); }
      let result = await pool.query("INSERT INTO play_sessions(installation_id,idempotency_key,duration_seconds,score) VALUES($1,$2,$3,$4) ON CONFLICT(installation_id,idempotency_key) DO NOTHING RETURNING id,duration_seconds,score,created_at", [actor.id, input.idempotencyKey, input.durationSeconds, input.score]); status = 201;
      if (!result.rowCount) { result = await pool.query("SELECT id,duration_seconds,score,created_at FROM play_sessions WHERE installation_id=$1 AND idempotency_key=$2", [actor.id, input.idempotencyKey]); status = 200; }
      return reply(response, status, { play_session: result.rows[0] }, origin);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/stats/me" && actor.kind === "installation") {
      const result = await pool.query("SELECT count(*)::integer AS sessions,coalesce(sum(duration_seconds),0)::integer AS duration_seconds,max(score) AS best_score FROM play_sessions WHERE installation_id=$1", [actor.id]); status = 200; return reply(response, status, { stats: result.rows[0] }, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/admin/apps" && requireService(actor, "apps:read")) {
      const values = actor.app_ids === null ? [] : [actor.app_ids], restriction = actor.app_ids === null ? "" : "WHERE slug=ANY($1::text[])";
      const result = await pool.query(`SELECT slug AS app_id,name,app_type AS type,platforms,current_version,status,created_at,updated_at FROM games ${restriction} ORDER BY name`, values); status = 200; return reply(response, status, { apps: result.rows }, origin);
    }
    if (request.method === "POST" && url.pathname === "/api/v1/admin/apps" && requireService(actor, "apps:write")) {
      const input = validateApplication(await readJson(request)); if (!input || !serviceCanAccessApp(actor, input.appId)) { status = 400; return reply(response, status, { error: "input_invalid_or_forbidden" }, origin); }
      const result = await pool.query("INSERT INTO games(slug,name,app_type,platforms,current_version,status,active) VALUES($1,$2,$3,$4,$5,'active',true) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name,app_type=EXCLUDED.app_type,platforms=EXCLUDED.platforms,current_version=EXCLUDED.current_version,updated_at=now() RETURNING slug AS app_id,name,app_type AS type,platforms,current_version,status", [input.appId, input.name, input.appType, input.platforms, input.currentVersion]);
      await audit(actor, "app.upsert", "app", input.appId); status = 200; return reply(response, status, { app: result.rows[0] }, origin);
    }
    const appMatch = /^\/api\/v1\/admin\/apps\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname);
    if (request.method === "PATCH" && appMatch && requireService(actor, "apps:write")) {
      const input = await readJson(request);
      if (!['active','archived'].includes(input.status) || !serviceCanAccessApp(actor, appMatch[1])) { status = 400; return reply(response, status, { error: "input_invalid_or_forbidden" }, origin); }
      const result = await pool.query("UPDATE games SET status=$2,active=($2='active'),updated_at=now() WHERE slug=$1 RETURNING slug AS app_id,name,status,updated_at", [appMatch[1], input.status]);
      if (!result.rowCount) { status = 404; return reply(response, status, { error: "app_not_found" }, origin); }
      await audit(actor, `app.${input.status}`, "app", appMatch[1]); status = 200; return reply(response, status, { app: result.rows[0] }, origin);
    }
    if (request.method === "GET" && url.pathname === "/api/v1/admin/feedback" && requireService(actor, "feedback:read")) {
      const { where, values } = listFilters(url, actor);
      const result = await pool.query(`SELECT f.public_id,${decisionSelect},f.type,f.title,f.comment AS message,f.priority,f.status,f.client_version,f.client_occurred_at,f.route,f.device,f.os,f.browser,f.resolution,f.technical_context,f.created_at,f.updated_at,coalesce(i.game_slug,f.source_app) AS app_id,g.name AS app_name,(SELECT count(*)::integer FROM feedback_attachments a WHERE a.feedback_id=f.id AND a.deleted_at IS NULL) AS attachment_count FROM feedback f LEFT JOIN installations i ON i.id=f.installation_id JOIN games g ON g.slug=coalesce(i.game_slug,f.source_app) ${where} ORDER BY f.created_at DESC LIMIT 500`, values);
      status = 200; return reply(response, status, { feedback: result.rows }, origin);
    }
    const ticketMatch = /^\/api\/v1\/admin\/feedback\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (request.method === "GET" && ticketMatch && requireService(actor, "feedback:read")) {
      const result = await pool.query(`SELECT f.id,f.public_id,${decisionSelect},f.type,f.title,f.comment AS message,f.priority,f.status,f.client_version,f.client_occurred_at,f.route,f.device,f.os,f.browser,f.resolution,f.technical_context,f.created_at,f.updated_at,coalesce(i.game_slug,f.source_app) AS app_id,g.name AS app_name FROM feedback f LEFT JOIN installations i ON i.id=f.installation_id JOIN games g ON g.slug=coalesce(i.game_slug,f.source_app) WHERE f.public_id=$1`, [ticketMatch[1]]);
      if (!result.rowCount || !serviceCanAccessApp(actor, result.rows[0].app_id)) { status = 404; return reply(response, status, { error: "feedback_not_found" }, origin); }
      const [history, attachments, decisions] = await Promise.all([
        pool.query("SELECT from_status,to_status,changed_by,note,created_at FROM feedback_status_history WHERE feedback_id=$1 ORDER BY created_at", [result.rows[0].id]),
        pool.query("SELECT id,original_name,media_type,byte_size,created_at,expires_at FROM feedback_attachments WHERE feedback_id=$1 AND deleted_at IS NULL ORDER BY created_at", [result.rows[0].id]),
        pool.query("SELECT actor,details,created_at FROM platform_audit_log WHERE target_type='feedback' AND target_id=$1 AND action='feedback.decision_update' ORDER BY id DESC LIMIT 50", [ticketMatch[1]]),
      ]);
      const feedback = result.rows[0]; delete feedback.id;
      status = 200; return reply(response, status, { feedback, history: history.rows, attachments: attachments.rows, decision_history: decisions.rows, can_edit_decision: canEditDecision(actor) }, origin);
    }
    const decisionMatch = /^\/api\/v1\/admin\/feedback\/([0-9a-f-]{36})\/decision$/.exec(url.pathname);
    if (request.method === 'PATCH' && decisionMatch) {
      if (!canEditDecision(actor)) { status = 403; return reply(response, status, { error: 'human_admin_required' }, origin); }
      const result = await changeDecision(pool, actor, decisionMatch[1], await readJson(request, 8192));
      status = result.status; return reply(response, status, result.body, origin);
    }
    if (request.method === "PATCH" && ticketMatch && requireService(actor, "feedback:write")) {
      const input = await readJson(request);
      if (hasDecisionFields(input)) { status = 400; return reply(response, status, { error: 'decision_endpoint_required' }, origin); }
      const current = await pool.query("SELECT f.id,f.status,coalesce(i.game_slug,f.source_app) AS app_id FROM feedback f LEFT JOIN installations i ON i.id=f.installation_id WHERE f.public_id=$1", [ticketMatch[1]]);
      if (!current.rowCount || !serviceCanAccessApp(actor, current.rows[0].app_id)) { status = 404; return reply(response, status, { error: "feedback_not_found" }, origin); }
      if (!validateStatusTransition(current.rows[0].status, input.status)) { status = 409; return reply(response, status, { error: "status_transition_invalid" }, origin); }
      const updated = await pool.query("UPDATE feedback SET status=$2::varchar(24),updated_at=now(),closed_at=CASE WHEN $2::text='closed' THEN now() ELSE NULL END WHERE id=$1 RETURNING public_id,status,updated_at", [current.rows[0].id, input.status]);
      await pool.query("INSERT INTO feedback_status_history(feedback_id,from_status,to_status,changed_by,note) VALUES($1,$2,$3,$4,$5)", [current.rows[0].id, current.rows[0].status, input.status, actor.name, typeof input.note === "string" ? input.note.slice(0, 1000) : null]);
      await audit(actor, "feedback.status_update", "feedback", ticketMatch[1], { from: current.rows[0].status, to: input.status }); status = 200; return reply(response, status, { feedback: updated.rows[0] }, origin);
    }
    const fileMatch = /^\/api\/v1\/admin\/attachments\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (request.method === "GET" && fileMatch && requireService(actor, "attachments:read")) {
      const result = await pool.query("SELECT a.storage_name,a.original_name,a.media_type,a.byte_size,coalesce(i.game_slug,f.source_app) AS app_id FROM feedback_attachments a JOIN feedback f ON f.id=a.feedback_id LEFT JOIN installations i ON i.id=f.installation_id WHERE a.id=$1 AND a.deleted_at IS NULL", [fileMatch[1]]);
      if (!result.rowCount || !serviceCanAccessApp(actor, result.rows[0].app_id)) { status = 404; return reply(response, status, { error: "attachment_not_found" }, origin); }
      await audit(actor, "attachment.download", "attachment", fileMatch[1]); status = 200; response.writeHead(status, { ...headers(result.rows[0].media_type), "content-length": result.rows[0].byte_size, "content-disposition": `attachment; filename="${safeFilename(result.rows[0].original_name) || "capture"}"` }); return createReadStream(join(attachmentDirectory, result.rows[0].storage_name)).pipe(response);
    }
    if (request.method === "DELETE" && fileMatch && requireService(actor, "attachments:delete")) {
      const result = await pool.query("SELECT a.id,a.storage_name,coalesce(i.game_slug,f.source_app) AS app_id FROM feedback_attachments a JOIN feedback f ON f.id=a.feedback_id LEFT JOIN installations i ON i.id=f.installation_id WHERE a.id=$1 AND a.deleted_at IS NULL", [fileMatch[1]]);
      if (!result.rowCount || !serviceCanAccessApp(actor, result.rows[0].app_id)) { status = 404; return reply(response, status, { error: "attachment_not_found" }, origin); }
      await unlink(join(attachmentDirectory, result.rows[0].storage_name)).catch((error) => { if (error.code !== "ENOENT") throw error; }); await pool.query("UPDATE feedback_attachments SET deleted_at=now() WHERE id=$1", [result.rows[0].id]); await audit(actor, "attachment.delete", "attachment", fileMatch[1]); status = 204; response.writeHead(status, headers("application/json")); return response.end();
    }
    if (request.method === "GET" && url.pathname === "/api/v1/admin/logs" && requireService(actor, "logs:read")) {
      const targetId = url.searchParams.get("feedback_id"), values = [], clauses = [];
      if (targetId) { values.push(targetId); clauses.push(`l.target_id=$${values.length}`); }
      if (actor.app_ids !== null) {
        values.push(actor.app_ids); const index = values.length;
        clauses.push(`((l.target_type='app' AND l.target_id=ANY($${index}::text[])) OR (l.target_type='feedback' AND EXISTS(SELECT 1 FROM feedback f LEFT JOIN installations i ON i.id=f.installation_id WHERE f.public_id::text=l.target_id AND coalesce(i.game_slug,f.source_app)=ANY($${index}::text[]))) OR (l.target_type='attachment' AND EXISTS(SELECT 1 FROM feedback_attachments a JOIN feedback f ON f.id=a.feedback_id LEFT JOIN installations i ON i.id=f.installation_id WHERE a.id::text=l.target_id AND coalesce(i.game_slug,f.source_app)=ANY($${index}::text[]))))`);
      }
      const result = await pool.query(`SELECT l.actor,l.action,l.target_type,l.target_id,l.details,l.created_at FROM platform_audit_log l ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY l.created_at DESC LIMIT 200`, values); status = 200; return reply(response, status, { logs: result.rows }, origin);
    }
    status = actor.kind === "service" ? 403 : 404; return reply(response, status, { error: status === 403 ? "forbidden" : "not_found" }, origin);
  } catch (error) {
    const known = new Map([["payload_too_large", 413], ["invalid_json", 400], ["input_invalid", 400]]); status = known.get(error.message) || 500;
    console.error(JSON.stringify({ event: "request_error", code: error.code || error.message })); return reply(response, status, { error: status === 500 ? "request_failed" : error.message }, origin);
  } finally { console.log(JSON.stringify({ event: "request", method: request.method, path: url.pathname, status, duration_ms: Date.now() - startedAt })); }
});
server.listen(port, "0.0.0.0", () => { console.log(JSON.stringify({ event: "server_started", port })); purgeExpiredAttachments().catch((error) => console.error(JSON.stringify({ event: "attachment_purge_error", code: error.code || error.message }))); });
setInterval(() => purgeExpiredAttachments().catch((error) => console.error(JSON.stringify({ event: "attachment_purge_error", code: error.code || error.message }))), 86_400_000).unref();
async function shutdown(signal) { console.log(JSON.stringify({ event: "shutdown", signal })); server.close(async () => { await pool.end(); process.exit(0); }); }
process.on("SIGTERM", () => shutdown("SIGTERM")); process.on("SIGINT", () => shutdown("SIGINT"));
