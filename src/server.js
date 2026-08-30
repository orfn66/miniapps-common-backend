import { createServer } from "node:http";
import pg from "pg";
import {
  hashToken,
  issueInstallationCredential,
  validateFeedback,
  validateInstallation,
  validatePlaySession,
} from "./domain.js";

const { Pool } = pg;
const pool = new Pool({ max: 8, idleTimeoutMillis: 30_000 });
const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const rateWindows = new Map();
let installationWindow = { startedAt: Date.now(), count: 0 };

function reply(response, status, payload, origin) {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new Error("payload_too_large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("invalid_json");
  }
}

async function authenticate(request) {
  const header = request.headers.authorization || "";
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(header);
  if (!match) return null;
  const tokenHash = hashToken(match[1]);
  const result = await pool.query(
    "SELECT id, game_slug FROM installations WHERE token_hash = $1 AND revoked_at IS NULL",
    [tokenHash],
  );
  return result.rows[0] || null;
}

function rateAllowed(key) {
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 60;
}

function installationCreationAllowed() {
  const now = Date.now();
  if (now - installationWindow.startedAt >= 60_000) {
    installationWindow = { startedAt: now, count: 0 };
  }
  installationWindow.count += 1;
  return installationWindow.count <= 30;
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  const url = new URL(request.url, "http://localhost");
  const origin = request.headers.origin || "";
  let status = 500;

  try {
    if (origin && !allowedOrigins.has(origin)) {
      status = 403;
      return reply(response, status, { error: "origin_not_allowed" });
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, content-type, idempotency-key",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "600",
      });
      status = 204;
      return response.end();
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      await pool.query("SELECT 1");
      status = 200;
      return reply(response, status, { status: "ok" }, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/games") {
      const result = await pool.query("SELECT slug, name FROM games WHERE active = true ORDER BY slug");
      status = 200;
      return reply(response, status, { games: result.rows }, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/installations") {
      if (!installationCreationAllowed()) {
        status = 429;
        return reply(response, status, { error: "rate_limited" }, origin);
      }
      const input = validateInstallation(await readJson(request));
      if (!input) {
        status = 400;
        return reply(response, status, { error: "input_invalid" }, origin);
      }
      const credential = issueInstallationCredential();
      try {
        await pool.query(
          "INSERT INTO installations(id, game_slug, token_hash, client_version) VALUES ($1, $2, $3, $4)",
          [credential.id, input.gameSlug, credential.tokenHash, input.clientVersion],
        );
      } catch (error) {
        if (error.code === "23503") {
          status = 404;
          return reply(response, status, { error: "game_unknown" }, origin);
        }
        throw error;
      }
      status = 201;
      return reply(response, status, { installation_id: credential.id, token: credential.token }, origin);
    }

    const installation = await authenticate(request);
    if (!installation) {
      status = 401;
      return reply(response, status, { error: "unauthorized" }, origin);
    }
    if (!rateAllowed(installation.id)) {
      status = 429;
      return reply(response, status, { error: "rate_limited" }, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/feedback") {
      const input = validateFeedback(await readJson(request));
      if (!input) {
        status = 400;
        return reply(response, status, { error: "input_invalid" }, origin);
      }
      const result = await pool.query(
        "INSERT INTO feedback(installation_id, type, comment) VALUES ($1, $2, $3) RETURNING id, type, comment, status, created_at",
        [installation.id, input.type, input.comment],
      );
      status = 201;
      return reply(response, status, { feedback: result.rows[0] }, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/feedback/mine") {
      const result = await pool.query(
        "SELECT id, type, comment, status, created_at FROM feedback WHERE installation_id = $1 ORDER BY id DESC LIMIT 50",
        [installation.id],
      );
      status = 200;
      return reply(response, status, { feedback: result.rows }, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/v1/play-sessions") {
      const input = validatePlaySession(await readJson(request), request.headers["idempotency-key"]);
      if (!input) {
        status = 400;
        return reply(response, status, { error: "input_invalid" }, origin);
      }
      let result = await pool.query(
        `INSERT INTO play_sessions(installation_id, idempotency_key, duration_seconds, score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (installation_id, idempotency_key) DO NOTHING
         RETURNING id, duration_seconds, score, created_at`,
        [installation.id, input.idempotencyKey, input.durationSeconds, input.score],
      );
      status = 201;
      if (result.rowCount === 0) {
        result = await pool.query(
          `SELECT id, duration_seconds, score, created_at
           FROM play_sessions WHERE installation_id = $1 AND idempotency_key = $2`,
          [installation.id, input.idempotencyKey],
        );
        status = 200;
      }
      return reply(response, status, { play_session: result.rows[0] }, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/v1/stats/me") {
      const result = await pool.query(
        `SELECT count(*)::integer AS sessions,
                coalesce(sum(duration_seconds), 0)::integer AS duration_seconds,
                max(score) AS best_score
         FROM play_sessions WHERE installation_id = $1`,
        [installation.id],
      );
      status = 200;
      return reply(response, status, { stats: result.rows[0] }, origin);
    }

    status = 404;
    return reply(response, status, { error: "not_found" }, origin);
  } catch (error) {
    const known = new Map([["payload_too_large", 413], ["invalid_json", 400]]);
    status = known.get(error.message) || 500;
    console.error(JSON.stringify({ event: "request_error", code: error.code || error.message }));
    return reply(response, status, { error: "request_failed" }, origin);
  } finally {
    console.log(JSON.stringify({
      event: "request",
      method: request.method,
      path: url.pathname,
      status,
      duration_ms: Date.now() - startedAt,
    }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "server_started", port }));
});

async function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", signal }));
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
