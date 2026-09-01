import { createHash } from 'node:crypto';
import { capabilityHash, open, retryDelaySeconds, scopedHash, seal, validateDevice, validateMessage } from './notification-domain.js';
import { transports } from './notification-transports.js';

const allowed = (actor, appId) => actor?.kind === 'service' && (actor.app_ids === null || actor.app_ids.includes(appId));
const has = (actor, scope) => actor?.scopes?.includes(scope);
const canReadTechnicalState = actor => has(actor, 'notifications:read') || Boolean(actor?.session_hash && has(actor, 'feedback:read'));

export function createNotificationHandler({ pool, reply, readJson }) {
  return async function handle(request, response, url, origin, actor) {
    if (!url.pathname.startsWith('/api/v1/notifications/') && !url.pathname.startsWith('/api/v1/admin/notifications')) return null;
    if (request.method === 'POST' && url.pathname === '/api/v1/notifications/devices') {
      if (!has(actor, 'notifications:devices:write')) { reply(response, 403, { error: 'forbidden' }, origin); return 403; }
      const input = validateDevice(await readJson(request, 12_000));
      if (!input || !allowed(actor, input.app_id)) { reply(response, 400, { error: 'input_invalid_or_forbidden' }, origin); return 400; }
      const recipientHash = scopedHash(input.app_id, input.recipient_reference), deviceHash = scopedHash(input.app_id, input.device_reference);
      if (input.permission === 'denied') {
        await pool.query("UPDATE notification_devices SET permission='denied',state='disabled',revoked_at=now(),updated_at=now() WHERE app_id=$1 AND device_reference_hash=$2", [input.app_id, deviceHash]);
        reply(response, 200, { enabled: false }, origin); return 200;
      }
      const sealed = seal(input.capability), hash = capabilityHash(input.capability);
      let result;
      try { result = await pool.query(`INSERT INTO notification_devices(app_id,recipient_hash,device_reference_hash,transport,platform,capability_hash,capability_ciphertext,capability_iv,capability_tag,permission)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,'granted' FROM games WHERE slug=$1 AND active=true
          ON CONFLICT(app_id,device_reference_hash) DO UPDATE SET recipient_hash=EXCLUDED.recipient_hash,transport=EXCLUDED.transport,platform=EXCLUDED.platform,capability_hash=EXCLUDED.capability_hash,capability_ciphertext=EXCLUDED.capability_ciphertext,capability_iv=EXCLUDED.capability_iv,capability_tag=EXCLUDED.capability_tag,permission='granted',state='active',last_error_code=NULL,last_seen_at=now(),updated_at=now(),revoked_at=NULL
          RETURNING id,transport,platform,state,created_at,updated_at`, [input.app_id, recipientHash, deviceHash, input.transport, input.platform, hash, sealed.ciphertext, sealed.iv, sealed.tag]); }
      catch (error) { if (error.code === '23505') { reply(response, 409, { error: 'capability_already_registered' }, origin); return 409; } throw error; }
      if (!result.rowCount) { reply(response, 404, { error: 'app_unknown_or_inactive' }, origin); return 404; }
      reply(response, 200, { device: result.rows[0] }, origin); return 200;
    }
    const deviceMatch = /^\/api\/v1\/notifications\/devices\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (request.method === 'DELETE' && deviceMatch) {
      if (!has(actor, 'notifications:devices:write')) { reply(response, 403, { error: 'forbidden' }, origin); return 403; }
      const result = await pool.query("UPDATE notification_devices SET state='disabled',revoked_at=now(),updated_at=now() WHERE id=$1 AND ($2::text[] IS NULL OR app_id=ANY($2::text[])) RETURNING id", [deviceMatch[1], actor.app_ids]);
      if (!result.rowCount) { reply(response, 404, { error: 'device_not_found' }, origin); return 404; }
      reply(response, 200, { enabled: false }, origin); return 200;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/notifications/messages') {
      if (!has(actor, 'notifications:send')) { reply(response, 403, { error: 'forbidden' }, origin); return 403; }
      const input = validateMessage(await readJson(request, 8_192), request.headers['idempotency-key']);
      if (!input || !allowed(actor, input.app_id)) { reply(response, 400, { error: 'input_invalid_or_forbidden' }, origin); return 400; }
      const recipientHash = scopedHash(input.app_id, input.recipient_reference), payload = { ...input.notification, deep_link: input.deep_link }, sealed = seal(payload), payloadHash = createHash('sha256').update(JSON.stringify({ event_type: input.event_type, ...payload })).digest('hex');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let message = await client.query(`INSERT INTO notification_messages(app_id,event_type,recipient_hash,idempotency_key,payload_hash,payload_ciphertext,payload_iv,payload_tag,deep_link)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(app_id,idempotency_key) DO NOTHING RETURNING id,public_id,status,created_at`, [input.app_id, input.event_type, recipientHash, input.idempotencyKey, payloadHash, sealed.ciphertext, sealed.iv, sealed.tag, input.deep_link]);
        let code = 202;
        if (!message.rowCount) {
          message = await client.query('SELECT id,public_id,status,created_at,payload_hash,recipient_hash FROM notification_messages WHERE app_id=$1 AND idempotency_key=$2', [input.app_id, input.idempotencyKey]);
          if (message.rows[0].payload_hash !== payloadHash || message.rows[0].recipient_hash !== recipientHash) { await client.query('ROLLBACK'); reply(response, 409, { error: 'idempotency_conflict' }, origin); return 409; }
          code = 200;
        } else {
          await client.query(`INSERT INTO notification_deliveries(message_id,device_id)
            SELECT $1,id FROM notification_devices WHERE app_id=$2 AND recipient_hash=$3 AND permission='granted' AND state='active' AND revoked_at IS NULL`, [message.rows[0].id, input.app_id, recipientHash]);
          const count = await client.query('UPDATE notification_messages SET device_count=(SELECT count(*) FROM notification_deliveries WHERE message_id=$1),status=CASE WHEN EXISTS(SELECT 1 FROM notification_deliveries WHERE message_id=$1) THEN \'queued\' ELSE \'failed\' END,completed_at=CASE WHEN EXISTS(SELECT 1 FROM notification_deliveries WHERE message_id=$1) THEN NULL ELSE now() END WHERE id=$1 RETURNING device_count,status', [message.rows[0].id]);
          Object.assign(message.rows[0], count.rows[0]);
        }
        await client.query('COMMIT'); delete message.rows[0].id; delete message.rows[0].payload_hash; delete message.rows[0].recipient_hash;
        reply(response, code, { notification: message.rows[0] }, origin); return code;
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/admin/notifications') {
      if (!canReadTechnicalState(actor)) { reply(response, 403, { error: 'forbidden' }, origin); return 403; }
      const values = actor.app_ids === null ? [] : [actor.app_ids], restriction = actor.app_ids === null ? '' : 'WHERE m.app_id=ANY($1::text[])';
      const result = await pool.query(`SELECT m.public_id,m.app_id,m.event_type,m.status,m.device_count,m.delivered_count,m.failed_count,m.deep_link,m.created_at,m.completed_at FROM notification_messages m ${restriction} ORDER BY m.created_at DESC LIMIT 200`, values);
      reply(response, 200, { notifications: result.rows }, origin); return 200;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/admin/notifications/devices') {
      if (!canReadTechnicalState(actor)) { reply(response, 403, { error: 'forbidden' }, origin); return 403; }
      const values = actor.app_ids === null ? [] : [actor.app_ids], restriction = actor.app_ids === null ? '' : 'WHERE app_id=ANY($1::text[])';
      const result = await pool.query(`SELECT id,app_id,transport,platform,permission,state,last_error_code,last_seen_at,created_at,updated_at FROM notification_devices ${restriction} ORDER BY updated_at DESC LIMIT 200`, values);
      reply(response, 200, { devices: result.rows }, origin); return 200;
    }
    reply(response, 404, { error: 'not_found' }, origin); return 404;
  };
}

export async function processNotificationBatch(pool, { deliveryTransports = transports, batchSize = 25 } = {}) {
  const client = await pool.connect(), claimed = [];
  try {
    await client.query('BEGIN');
    await client.query("UPDATE notification_deliveries SET status=CASE WHEN attempt_count>=5 THEN 'failed' ELSE 'pending' END,next_attempt_at=now(),last_error_code='worker_interrupted',updated_at=now() WHERE status='processing' AND updated_at<now()-interval '2 minutes'");
    await client.query(`UPDATE notification_messages m SET delivered_count=s.delivered,failed_count=s.failed,status=CASE WHEN s.pending>0 THEN 'processing' WHEN s.delivered=s.total THEN 'delivered' WHEN s.delivered>0 THEN 'partial' ELSE 'failed' END,completed_at=CASE WHEN s.pending=0 THEN coalesce(m.completed_at,now()) ELSE NULL END
      FROM (SELECT message_id,count(*)::integer total,count(*) FILTER(WHERE status IN ('pending','processing'))::integer pending,count(*) FILTER(WHERE status='delivered')::integer delivered,count(*) FILTER(WHERE status='failed')::integer failed FROM notification_deliveries GROUP BY message_id) s WHERE m.id=s.message_id AND m.status IN ('queued','processing')`);
    const result = await client.query(`SELECT d.id,d.message_id,d.device_id,d.attempt_count,v.transport,v.capability_ciphertext,v.capability_iv,v.capability_tag,m.payload_ciphertext,m.payload_iv,m.payload_tag
      FROM notification_deliveries d JOIN notification_devices v ON v.id=d.device_id JOIN notification_messages m ON m.id=d.message_id
      WHERE d.status='pending' AND d.next_attempt_at<=now() AND v.state='active' AND v.revoked_at IS NULL ORDER BY d.next_attempt_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT $1`, [batchSize]);
    for (const row of result.rows) {
      await client.query("UPDATE notification_deliveries SET status='processing',attempt_count=attempt_count+1,updated_at=now() WHERE id=$1", [row.id]); claimed.push(row);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  for (const row of claimed) {
    try {
      const capability = open({ ciphertext: row.capability_ciphertext, iv: row.capability_iv, tag: row.capability_tag });
      const payload = open({ ciphertext: row.payload_ciphertext, iv: row.payload_iv, tag: row.payload_tag });
      const delivered = await deliveryTransports[row.transport](capability, payload);
      await pool.query("UPDATE notification_deliveries SET status='delivered',provider_message_id=$2,delivered_at=now(),updated_at=now(),last_error_code=NULL WHERE id=$1", [row.id, delivered.providerMessageId || null]);
    } catch (error) {
      const attempt = row.attempt_count + 1, permanent = error.permanent === true, final = permanent || attempt >= 5, code = String(error.code || error.message || 'delivery_failed').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
      await pool.query("UPDATE notification_deliveries SET status=$2::varchar(16),last_error_code=$3,next_attempt_at=CASE WHEN $2::text='pending' THEN now()+($4||' seconds')::interval ELSE next_attempt_at END,updated_at=now() WHERE id=$1", [row.id, final ? 'failed' : 'pending', code, retryDelaySeconds(attempt)]);
      if (permanent) await pool.query("UPDATE notification_devices SET state='invalid',revoked_at=now(),last_error_code=$2,updated_at=now() WHERE id=$1", [row.device_id, code]);
    }
    await pool.query(`UPDATE notification_messages m SET delivered_count=s.delivered,failed_count=s.failed,status=CASE WHEN s.pending>0 THEN 'processing' WHEN s.delivered=s.total THEN 'delivered' WHEN s.delivered>0 THEN 'partial' ELSE 'failed' END,completed_at=CASE WHEN s.pending=0 THEN now() ELSE NULL END
      FROM (SELECT message_id,count(*)::integer total,count(*) FILTER(WHERE status IN ('pending','processing'))::integer pending,count(*) FILTER(WHERE status='delivered')::integer delivered,count(*) FILTER(WHERE status='failed')::integer failed FROM notification_deliveries WHERE message_id=$1 GROUP BY message_id) s WHERE m.id=s.message_id`, [row.message_id]);
  }
  return claimed.length;
}

export async function purgeNotificationHistory(pool) {
  const messages=await pool.query("DELETE FROM notification_messages WHERE completed_at<now()-interval '90 days'");
  const devices=await pool.query("DELETE FROM notification_devices WHERE revoked_at<now()-interval '180 days' AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.device_id=notification_devices.id)");
  return { messages: messages.rowCount, devices: devices.rowCount };
}
