import { authenticateVelocoonUser, validateVelocoonFeedback } from './velocoon-integration.js';

export function createVelocoonHandler({ pool, reply, readJson, rateAllowed }) {
  return async function handle(request, response, url, origin) {
    if (!url.pathname.startsWith('/api/v1/integrations/velocoon/')) return null;
    const user = await authenticateVelocoonUser(request);
    if (!user) { reply(response, 401, { error: 'unauthorized' }, origin); return 401; }
    if (!rateAllowed(`velocoon:${user.actorHash}`, 60)) { reply(response, 429, { error: 'rate_limited' }, origin); return 429; }
    if (request.method !== 'POST' || url.pathname !== '/api/v1/integrations/velocoon/feedback') { reply(response, 404, { error: 'not_found' }, origin); return 404; }
    const input = validateVelocoonFeedback(await readJson(request), request.headers['idempotency-key']);
    if (!input) { reply(response, 400, { error: 'input_invalid' }, origin); return 400; }
    let result = await pool.query(`INSERT INTO feedback(installation_id,type,comment,title,priority,client_version,client_occurred_at,technical_context,source_app,source_feedback_id,source_actor_hash,source_kind,source_status,source_created_at,source_status_updated_at,imported_at)
      VALUES(NULL,$1,$2,$3,'normal',$4,$5,$6,'velocoon',$7,$8,$9,'new',$10,$10,now())
      ON CONFLICT(source_app,source_feedback_id) WHERE source_feedback_id IS NOT NULL DO NOTHING
      RETURNING id,public_id,status,created_at`, [input.type, input.message, input.title, input.appVersion, input.occurredAt, { platform: input.platform, locale: input.locale, screen: input.screen, viewport: input.viewport, source_attachment_present: input.hasAttachment }, input.sourceFeedbackId, user.actorHash, input.sourceKind, input.occurredAt]);
    let code = 201;
    if (!result.rowCount) {
      result = await pool.query("SELECT id,public_id,status,created_at FROM feedback WHERE source_app='velocoon' AND source_feedback_id=$1 AND source_actor_hash=$2", [input.sourceFeedbackId, user.actorHash]);
      if (!result.rowCount) { reply(response, 409, { error: 'idempotency_conflict' }, origin); return 409; }
      code = 200;
    }
    const feedback = result.rows[0]; delete feedback.id;
    reply(response, code, { feedback }, origin); return code;
  };
}
