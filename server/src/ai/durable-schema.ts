export const AI_DURABLE_SCHEMA = `
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  envelope_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN (
    'queued','running','waiting_approval','retry_wait','reconciling','unknown_outcome',
    'completed','failed','cancelled','expired','superseded'
  )),
  state_version INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
  idempotency_key TEXT NOT NULL,
  target_version TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  input_snapshot_id TEXT NOT NULL,
  capability_policy_epoch INTEGER NOT NULL CHECK(capability_policy_epoch >= 0),
  kill_switch_epoch INTEGER NOT NULL CHECK(kill_switch_epoch >= 0),
  checkpoint_json TEXT,
  terminal_intent TEXT CHECK(terminal_intent IS NULL OR terminal_intent IN ('cancelled','expired','superseded','policy_stopped')),
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES ai_runs(id)
);
CREATE UNIQUE INDEX ai_jobs_scoped_idempotency
  ON ai_jobs(tenant_id,scope_kind,scope_id,idempotency_key,target_version);
CREATE INDEX ai_jobs_claimable ON ai_jobs(state,not_before,priority,created_at);

CREATE TABLE ai_job_attempts (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error_code TEXT,
  retryable INTEGER,
  PRIMARY KEY(job_id,attempt),
  FOREIGN KEY(job_id) REFERENCES ai_jobs(id)
);

CREATE TABLE ai_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  state TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  target_version TEXT NOT NULL,
  approval_set_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,revision_id),
  FOREIGN KEY(run_id) REFERENCES ai_runs(id),
  FOREIGN KEY(job_id) REFERENCES ai_jobs(id)
);

CREATE TABLE ai_external_call_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  logical_call_id TEXT NOT NULL,
  downstream_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  permission_projection_hash TEXT NOT NULL CHECK(length(permission_projection_hash)=64),
  capability_policy_epoch INTEGER NOT NULL,
  kill_switch_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','sent','reconciling','finished','revoked','expired','unknown_outcome','resolved_finished','resolved_unsent','resolved_abandoned')),
  owner TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
  provider_request_id TEXT,
  receipt_hash TEXT,
  response_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,run_id,job_id,logical_call_id),
  FOREIGN KEY(run_id) REFERENCES ai_runs(id),
  FOREIGN KEY(job_id) REFERENCES ai_jobs(id)
);

CREATE TABLE ai_external_call_attempts (
  reservation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  owner TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  downstream_key TEXT NOT NULL,
  capability_policy_epoch INTEGER NOT NULL,
  kill_switch_epoch INTEGER NOT NULL,
  sent_at TEXT,
  provider_request_id TEXT,
  response_hash TEXT,
  receipt_hash TEXT,
  outcome TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY(reservation_id,attempt),
  FOREIGN KEY(reservation_id) REFERENCES ai_external_call_reservations(id)
);

CREATE TABLE ai_external_call_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  conclusion TEXT NOT NULL CHECK(conclusion IN ('confirmed_executed','confirmed_unsent','closed_unknown')),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
  receipt_hash TEXT,
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  parent_job_disposition TEXT NOT NULL,
  FOREIGN KEY(reservation_id) REFERENCES ai_external_call_reservations(id)
);

CREATE TABLE ai_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','reconciling','delivered','revoked','unknown_outcome','resolved_abandoned','dead_letter')),
  state_version INTEGER NOT NULL DEFAULT 0,
  deduplication_key TEXT NOT NULL,
  downstream_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  approval_set_hash TEXT NOT NULL CHECK(length(approval_set_hash)=64),
  capability_policy_epoch INTEGER NOT NULL,
  kill_switch_epoch INTEGER NOT NULL,
  dispatch_owner TEXT,
  dispatch_lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
  not_before TEXT NOT NULL,
  receipt_hash TEXT,
  response_hash TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id,scope_id,deduplication_key),
  FOREIGN KEY(job_id) REFERENCES ai_jobs(id),
  FOREIGN KEY(proposal_id) REFERENCES ai_proposals(id)
);

CREATE TABLE ai_outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  downstream_key TEXT NOT NULL,
  evidence_hash TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY(outbox_id) REFERENCES ai_outbox(id)
);

CREATE TABLE ai_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  size INTEGER NOT NULL CHECK(size >= 0),
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired','deleted')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES ai_runs(id),
  FOREIGN KEY(job_id) REFERENCES ai_jobs(id)
);

CREATE TABLE ai_risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  job_id TEXT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('P0','P1','P2','P3')),
  detail_hash TEXT NOT NULL CHECK(length(detail_hash)=64),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(run_id) REFERENCES ai_runs(id),
  FOREIGN KEY(job_id) REFERENCES ai_jobs(id)
);

CREATE TRIGGER ai_job_attempts_no_delete BEFORE DELETE ON ai_job_attempts BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_external_call_attempts_no_delete BEFORE DELETE ON ai_external_call_attempts BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_external_call_resolutions_no_update BEFORE UPDATE ON ai_external_call_resolutions BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_external_call_resolutions_no_delete BEFORE DELETE ON ai_external_call_resolutions BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_outbox_events_no_update BEFORE UPDATE ON ai_outbox_events BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_outbox_events_no_delete BEFORE DELETE ON ai_outbox_events BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_risk_events_no_update BEFORE UPDATE ON ai_risk_events BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
CREATE TRIGGER ai_risk_events_no_delete BEFORE DELETE ON ai_risk_events BEGIN SELECT RAISE(ABORT,'ai append-only history'); END;
`
