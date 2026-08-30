import { randomBytes } from "node:crypto";
import pg from "pg";
import { hashToken } from "./domain.js";

const [name, scopesCsv, appIdsCsv] = process.argv.slice(2);
if (!name || !scopesCsv) {
  console.error("Usage: npm run service-account:create -- <name> <scope,scope> [app-id,app-id|*]");
  process.exit(2);
}
const scopes = [...new Set(scopesCsv.split(",").map((value) => value.trim()).filter(Boolean))];
const appIds = !appIdsCsv || appIdsCsv === "*" ? null : [...new Set(appIdsCsv.split(",").map((value) => value.trim()).filter(Boolean))];
const token = randomBytes(48).toString("base64url");
const client = new pg.Client();
await client.connect();
try {
  await client.query("INSERT INTO service_accounts(name,token_hash,scopes,app_ids) VALUES($1,$2,$3,$4)", [name, hashToken(token), scopes, appIds]);
  console.log(JSON.stringify({ name, scopes, app_ids: appIds, token, warning: "This token is shown once. Store it in a secret manager." }));
} finally { await client.end(); }
