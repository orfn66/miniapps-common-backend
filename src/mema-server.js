import { createHash, createHmac, randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import webpush from 'web-push';
import { authenticateMemaUser, endpointHash, validateMemaFeedback, validatePushSubscription } from './mema-integration.js';

function imageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ['image/jpeg', '.jpg'];
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', '.png'];
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return ['image/webp', '.webp'];
  return null;
}

const cleanName = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 255) : undefined;
const pushConfigured = () => Boolean(process.env.MEMA_VAPID_SUBJECT && process.env.MEMA_VAPID_PUBLIC_KEY && process.env.MEMA_VAPID_PRIVATE_KEY);

export function createMemaHandler({ pool, reply, readJson, readBinary, attachmentDirectory, rateAllowed }) {
  return async function handle(request, response, url, origin) {
    if (!url.pathname.startsWith('/api/v1/integrations/mema/')) return null;
    const user = await authenticateMemaUser(request);
    if (!user) { reply(response, 401, { error: 'unauthorized' }, origin); return 401; }
    if (!rateAllowed(`mema:${user.actorHash}`, 60)) { reply(response, 429, { error: 'rate_limited' }, origin); return 429; }

    if (request.method === 'POST' && url.pathname === '/api/v1/integrations/mema/feedback') {
      const input = validateMemaFeedback(await readJson(request), request.headers['idempotency-key']);
      if (!input) { reply(response, 400, { error: 'input_invalid' }, origin); return 400; }
      let result = await pool.query(`INSERT INTO feedback(installation_id,type,comment,title,priority,client_version,client_occurred_at,technical_context,source_app,source_feedback_id,source_actor_hash,source_kind,source_created_at)
        VALUES(NULL,$1,$2,$3,'normal',$4,$5,$6,'mema',$7,$8,'supabase_feedback',$9)
        ON CONFLICT(source_app,source_feedback_id) WHERE source_feedback_id IS NOT NULL DO NOTHING
        RETURNING id,public_id,status,created_at`, [input.type, input.description, input.title, input.appBuild, input.occurredAt, { platform: input.platform, locale: input.locale, screen: input.screen, app_version: input.appVersion }, input.sourceFeedbackId, user.actorHash, input.occurredAt]);
      let code = 201;
      if (!result.rowCount) {
        result = await pool.query("SELECT id,public_id,status,created_at FROM feedback WHERE source_app='mema' AND source_feedback_id=$1 AND source_actor_hash=$2", [input.sourceFeedbackId, user.actorHash]);
        if (!result.rowCount) { reply(response, 409, { error: 'idempotency_conflict' }, origin); return 409; }
        code = 200;
      }
      const feedback = result.rows[0]; delete feedback.id;
      reply(response, code, { feedback }, origin); return code;
    }

    const attachment = /^\/api\/v1\/integrations\/mema\/feedback\/([0-9a-f-]{36})\/attachments$/.exec(url.pathname);
    if (request.method === 'POST' && attachment) {
      if (request.headers['x-attachment-consent'] !== 'true') { reply(response, 400, { error: 'explicit_consent_required' }, origin); return 400; }
      const ticket = await pool.query("SELECT id FROM feedback WHERE source_app='mema' AND source_feedback_id=$1 AND source_actor_hash=$2", [attachment[1], user.actorHash]);
      if (!ticket.rowCount) { reply(response, 404, { error: 'feedback_not_found' }, origin); return 404; }
      const buffer = await readBinary(request), detected = imageType(buffer);
      if (!detected || request.headers['content-type']?.split(';')[0] !== detected[0]) { reply(response, 415, { error: 'image_type_invalid' }, origin); return 415; }
      const storageName = `${randomBytes(24).toString('hex')}${detected[1]}`;
      await writeFile(join(attachmentDirectory, storageName), buffer, { flag: 'wx', mode: 0o600 });
      try {
        const inserted = await pool.query("INSERT INTO feedback_attachments(feedback_id,storage_name,original_name,media_type,byte_size,sha256,consent_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (feedback_id,sha256) WHERE deleted_at IS NULL DO UPDATE SET original_name=EXCLUDED.original_name RETURNING id,media_type,byte_size,created_at,expires_at", [ticket.rows[0].id, storageName, cleanName(request.headers['x-file-name']), detected[0], buffer.length, createHash('sha256').update(buffer).digest('hex')]);
        reply(response, 201, { attachment: inserted.rows[0] }, origin); return 201;
      } catch (error) { await unlink(join(attachmentDirectory, storageName)).catch(() => undefined); throw error; }
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/integrations/mema/push-subscriptions') {
      if (!pushConfigured()) { reply(response, 503, { error: 'push_not_configured' }, origin); return 503; }
      const subscription = validatePushSubscription(await readJson(request));
      if (!subscription) { reply(response, 400, { error: 'input_invalid' }, origin); return 400; }
      const hash = endpointHash(subscription.endpoint);
      await pool.query(`INSERT INTO push_subscriptions(source_app,source_actor_hash,endpoint,endpoint_hash,p256dh,auth)
        VALUES('mema',$1,$2,$3,$4,$5) ON CONFLICT(source_app,endpoint_hash) DO UPDATE SET source_actor_hash=EXCLUDED.source_actor_hash,endpoint=EXCLUDED.endpoint,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,revoked_at=NULL,updated_at=now()`, [user.actorHash, subscription.endpoint, hash, subscription.keys.p256dh, subscription.keys.auth]);
      webpush.setVapidDetails(process.env.MEMA_VAPID_SUBJECT, process.env.MEMA_VAPID_PUBLIC_KEY, process.env.MEMA_VAPID_PRIVATE_KEY);
      try { await webpush.sendNotification(subscription, JSON.stringify({ title: 'Mema', body: 'Mema notifications are enabled.', url: '/' }), { TTL: 60 }); }
      catch (error) {
        if ([404, 410].includes(error.statusCode)) await pool.query("UPDATE push_subscriptions SET revoked_at=now(),updated_at=now() WHERE source_app='mema' AND endpoint_hash=$1", [hash]);
        reply(response, 502, { error: 'push_delivery_failed' }, origin); return 502;
      }
      reply(response, 201, { enabled: true }, origin); return 201;
    }

    if (request.method === 'DELETE' && url.pathname === '/api/v1/integrations/mema/push-subscriptions') {
      const subscription = validatePushSubscription(await readJson(request));
      if (!subscription) { reply(response, 400, { error: 'input_invalid' }, origin); return 400; }
      await pool.query("UPDATE push_subscriptions SET revoked_at=now(),updated_at=now() WHERE source_app='mema' AND source_actor_hash=$1 AND endpoint_hash=$2", [user.actorHash, endpointHash(subscription.endpoint)]);
      reply(response, 200, { enabled: false }, origin); return 200;
    }
    reply(response, 404, { error: 'not_found' }, origin); return 404;
  };
}
