import { unlink } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const directory = process.env.ATTACHMENTS_DIR || "/data/attachments";
const client = new pg.Client();
await client.connect();
let purged = 0;
try {
  const expired = await client.query("SELECT id,storage_name FROM feedback_attachments WHERE deleted_at IS NULL AND expires_at <= now() FOR UPDATE SKIP LOCKED");
  for (const attachment of expired.rows) {
    await unlink(join(directory, attachment.storage_name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await client.query("UPDATE feedback_attachments SET deleted_at=now() WHERE id=$1", [attachment.id]);
    purged += 1;
  }
} finally { await client.end(); }
console.log(JSON.stringify({ event: "attachments_purged", count: purged }));
