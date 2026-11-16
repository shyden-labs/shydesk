-- Release 2 (shyden-labs/shydesk#57; plan docs/superpowers/plans/2026-11-07-shydesk-release-2.md, Task 1):
-- product settings for punishments, the callback and the appeal page, and the tables for
-- reports, punishments, appeals, legal holds and reports to the authorities. Reports and
-- appeals are tickets of kind 'report' and 'appeal', which Release 1 already allows.
-- No Release 1 table is dropped or recreated.
ALTER TABLE products ADD COLUMN punishments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN callback_url TEXT;
ALTER TABLE products ADD COLUMN callback_secret TEXT;
ALTER TABLE products ADD COLUMN appeal_page_url TEXT;

CREATE TABLE reports (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets (id),
  product_id TEXT NOT NULL REFERENCES products (id),
  reporter_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  subject_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  context_json TEXT NOT NULL
);
CREATE INDEX reports_subject ON reports (product_id, subject_user_id);

CREATE TABLE punishments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  report_ticket_id TEXT NOT NULL REFERENCES tickets (id),
  subject_user_id TEXT NOT NULL,
  punishment_key TEXT NOT NULL,
  label TEXT NOT NULL,
  duration_seconds INTEGER,
  applied_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  send_state TEXT NOT NULL CHECK (send_state IN ('sending', 'applied', 'failed')),
  send_error TEXT,
  appeal_token_hash TEXT NOT NULL UNIQUE,
  lifted_at INTEGER,
  lifted_by TEXT,
  lift_state TEXT CHECK (lift_state IN ('sending', 'applied', 'failed')),
  lift_error TEXT
);
CREATE INDEX punishments_subject ON punishments (product_id, subject_user_id);

CREATE TABLE appeals (
  punishment_id TEXT PRIMARY KEY REFERENCES punishments (id),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets (id),
  state TEXT NOT NULL CHECK (state IN ('open', 'upheld', 'rejected')),
  decided_by TEXT,
  decided_at INTEGER
);

CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  attachment_id TEXT REFERENCES attachments (id),
  reason TEXT NOT NULL CHECK (reason IN ('crime_unreported', 'reported', 'preservation')),
  csam INTEGER NOT NULL CHECK (csam IN (0, 1)),
  note TEXT NOT NULL,
  placed_by TEXT NOT NULL,
  placed_at INTEGER NOT NULL,
  basis_at INTEGER,
  renewals INTEGER NOT NULL DEFAULT 0,
  order_pending INTEGER NOT NULL DEFAULT 0 CHECK (order_pending IN (0, 1)),
  no_report_reason TEXT,
  lifted_at INTEGER,
  lifted_by TEXT
);
CREATE INDEX legal_holds_ticket ON legal_holds (ticket_id) WHERE lifted_at IS NULL;

CREATE TABLE legal_hold_events (
  hold_id TEXT NOT NULL REFERENCES legal_holds (id),
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('placed', 'renewed', 'order', 'reported', 'no_report', 'lifted')),
  detail TEXT NOT NULL
);

CREATE TABLE authority_reports (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets (id),
  reported_to TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  reference TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
