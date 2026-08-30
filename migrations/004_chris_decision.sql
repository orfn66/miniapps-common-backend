-- Human triage is independent from the technical workflow. No historical
-- decision is inferred from type, status or priority.
ALTER TABLE feedback
  ADD COLUMN chris_decision varchar(16) NOT NULL DEFAULT 'to_triage',
  ADD COLUMN decision_destination varchar(8) NOT NULL DEFAULT 'none',
  ADD COLUMN decision_note varchar(1000) NOT NULL DEFAULT '',
  ADD COLUMN decision_version integer NOT NULL DEFAULT 0 CHECK (decision_version >= 0),
  ADD COLUMN decision_updated_at timestamptz,
  ADD CONSTRAINT feedback_decision_routing_check CHECK (
    (chris_decision IN ('to_triage', 'not_needed') AND decision_destination = 'none') OR
    (chris_decision = 'to_discuss' AND decision_destination = 'chatgpt') OR
    (chris_decision = 'to_do' AND decision_destination IN ('auto', 'chatgpt', 'codex'))
  );

CREATE INDEX feedback_decision_created_idx ON feedback(chris_decision, created_at DESC);
-- Changes use the existing private platform_audit_log, in the same transaction.
-- No new service scope, grants, account, token, scheduler or outbound channel.
