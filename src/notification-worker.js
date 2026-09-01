import pg from 'pg';
import { processNotificationBatch, purgeNotificationHistory } from './notification-service.js';

const pool = new pg.Pool({ max: 4, idleTimeoutMillis: 30_000 });
let stopping = false;
let lastPurge = 0;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; });
try {
  while (!stopping) {
    if (Date.now()-lastPurge>3_600_000) { const purged=await purgeNotificationHistory(pool);lastPurge=Date.now();if(purged.messages||purged.devices)console.log(JSON.stringify({event:'notification_history_purged',...purged})); }
    const count = await processNotificationBatch(pool);
    if (count) console.log(JSON.stringify({ event: 'notification_delivery_batch', count }));
    await new Promise(resolve => setTimeout(resolve, count ? 250 : 2_000));
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'notification_worker_failed', code: String(error.code || error.message || 'unknown').slice(0, 80) }));
  process.exitCode = 1;
} finally { await pool.end(); }
