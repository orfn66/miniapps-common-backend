const destinations = {
  to_triage: ['none'], to_do: ['auto', 'chatgpt', 'codex'],
  to_discuss: ['chatgpt'], not_needed: ['none'],
};
export const decisionFields = 'chris_decision,decision_destination,decision_note,decision_version,decision_updated_at';
export const decisionSelect = decisionFields.split(',').map(name => `f.${name}`).join(',');

export function canEditDecision(actor) {
  return actor?.kind === 'service' && !!actor.session_hash && !!actor.credential_id &&
    actor.scopes.includes('feedback:read') && actor.scopes.includes('feedback:write');
}

export function validateDecision(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = ['chris_decision', 'decision_destination', 'decision_note', 'expected_version'];
  if (Object.keys(input).some(key => !keys.includes(key))) return null;
  if (typeof input.chris_decision !== 'string' || typeof input.decision_destination !== 'string' ||
      !Object.hasOwn(destinations, input.chris_decision) || !destinations[input.chris_decision].includes(input.decision_destination)) return null;
  if (!Number.isInteger(input.expected_version) || input.expected_version < 0 || input.expected_version >= 2147483647) return null;
  if (typeof input.decision_note !== 'string' || [...input.decision_note].length > 1000 || input.decision_note.includes('\0')) return null;
  return { ...input, decision_note: input.decision_note.trim() };
}

export function hasDecisionFields(input) {
  return !!input && typeof input === 'object' && Object.keys(input).some(key =>
    key === 'chris_decision' || key.startsWith('decision_') || key === 'expected_version');
}

// Called only after session + CSRF authentication; keeps the authorization
// check here too so a future caller cannot accidentally accept service tokens.
export async function changeDecision(pool, actor, publicId, input) {
  if (!canEditDecision(actor)) return { status: 403, body: { error: 'human_admin_required' } };
  const value = validateDecision(input);
  if (!value) return { status: 400, body: { error: 'decision_invalid' } };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT f.id,f.public_id,${decisionSelect}
      FROM feedback f JOIN installations i ON i.id=f.installation_id
      WHERE f.public_id=$1 AND ($2::text[] IS NULL OR i.game_slug=ANY($2::text[])) FOR UPDATE OF f`, [publicId, actor.app_ids]);
    if (!current.rowCount) {
      await client.query('ROLLBACK'); return { status: 404, body: { error: 'feedback_not_found' } };
    }
    const previous = current.rows[0];
    if (previous.decision_version !== value.expected_version) {
      await client.query('ROLLBACK'); return { status: 409, body: { error: 'decision_conflict' } };
    }
    const state = row => ({ chris_decision: row.chris_decision, decision_destination: row.decision_destination, decision_note: row.decision_note });
    if (JSON.stringify(state(previous)) === JSON.stringify(state(value))) {
      await client.query('COMMIT'); delete previous.id;
      return { status: 200, body: { feedback: previous, changed: false } };
    }
    const updated = await client.query(`UPDATE feedback SET chris_decision=$2,decision_destination=$3,decision_note=$4,
      decision_version=decision_version+1,decision_updated_at=now(),updated_at=now()
      WHERE id=$1 RETURNING public_id,${decisionFields}`, [previous.id, value.chris_decision, value.decision_destination, value.decision_note]);
    const feedback = updated.rows[0];
    await client.query(`INSERT INTO platform_audit_log(actor,action,target_type,target_id,details)
      VALUES($1,'feedback.decision_update','feedback',$2,$3)`, [actor.name, publicId,
      { version: feedback.decision_version, before: state(previous), after: state(feedback) }]);
    await client.query('COMMIT');
    return { status: 200, body: { feedback, changed: true } };
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}
