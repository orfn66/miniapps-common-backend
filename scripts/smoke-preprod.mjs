import assert from "node:assert/strict";

const platformBaseUrl = requiredUrl("PLATFORM_BASE_URL");
const hubBaseUrl = optionalUrl("HUB_BASE_URL");
const adminToken = requiredSecret("APP_PLATFORM_ADMIN_TOKEN");
const codexToken = requiredSecret("APP_PLATFORM_CODEX_TOKEN");
const pilotAppId = process.env.PILOT_APP_ID || "minigames-hub";

function requiredSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  const value = requiredSecret(name);
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url.origin;
}

function optionalUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url.origin;
}

async function request(path, { token, ...init } = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${platformBaseUrl}${path}`, { ...init, headers, redirect: "error" });
}

async function json(path, options) {
  const response = await request(path, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const health = await json("/api/health");
assert.equal(health.response.status, 200);
assert.equal(health.body.status, "ok");

assert.equal((await request("/admin")).status, 200);
const cors = await request("/api/v1/feedback", {
  method: "OPTIONS",
  headers: {
    origin: hubBaseUrl || platformBaseUrl,
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type",
  },
});
assert.equal(cors.status, 204);
if (hubBaseUrl) assert.equal(cors.headers.get("access-control-allow-origin"), hubBaseUrl);

const registry = await json("/api/v1/apps");
assert.equal(registry.response.status, 200);
assert.ok(registry.body.apps.some((app) => app.app_id === pilotAppId));

const adminHeaders = { token: adminToken };
const codexHeaders = { token: codexToken };
const adminTickets = await json(`/api/v1/admin/feedback?app_id=${encodeURIComponent(pilotAppId)}`, adminHeaders);
assert.equal(adminTickets.response.status, 200);
const codexTickets = await json(`/api/v1/admin/feedback?app_id=${encodeURIComponent(pilotAppId)}`, codexHeaders);
assert.equal(codexTickets.response.status, 200);
assert.deepEqual(codexTickets.body.feedback, adminTickets.body.feedback);

const outsideScope = await json("/api/v1/admin/feedback?app_id=perfect-tap", codexHeaders);
assert.equal(outsideScope.response.status, 200);
assert.deepEqual(outsideScope.body.feedback, []);

const ticket = codexTickets.body.feedback[0];
assert.ok(ticket, `No feedback exists for ${pilotAppId}`);
const detail = await json(`/api/v1/admin/feedback/${ticket.public_id}`, codexHeaders);
assert.equal(detail.response.status, 200);
assert.equal(detail.body.feedback.app_id, pilotAppId);

const deniedWrite = await json(`/api/v1/admin/feedback/${ticket.public_id}`, {
  ...codexHeaders,
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: ticket.status }),
});
assert.equal(deniedWrite.response.status, 403);

const logs = await json(`/api/v1/admin/logs?feedback_id=${encodeURIComponent(ticket.public_id)}`, codexHeaders);
assert.equal(logs.response.status, 200);

const attachment = detail.body.attachments[0];
assert.ok(attachment, `No private attachment exists for ${pilotAppId}`);
assert.equal((await request(`/api/v1/admin/attachments/${attachment.id}`)).status, 401);
const authorizedAttachment = await request(`/api/v1/admin/attachments/${attachment.id}`, codexHeaders);
assert.equal(authorizedAttachment.status, 200);
assert.equal((await authorizedAttachment.arrayBuffer()).byteLength, attachment.byte_size);

if (hubBaseUrl) assert.equal((await fetch(hubBaseUrl, { redirect: "error" })).status, 200);

console.log(JSON.stringify({
  event: "preprod_smoke_complete",
  status: "ok",
  app_id: pilotAppId,
  checks: 14,
}));
