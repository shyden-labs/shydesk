-- Release 1 schema (shyden-labs/shydesk#15; plan Task 2). Release 2 adds
-- holds, punishments, appeals and reports beside these tables, never altering
-- them. Times are Unix epoch milliseconds. Emails are stored lower-cased.

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  ticket_page_url TEXT NOT NULL,
  allowed_origins_json TEXT NOT NULL,
  monthly_email_share INTEGER NOT NULL,
  attachments_keep_days INTEGER NOT NULL DEFAULT 30,
  text_keep_days INTEGER NOT NULL DEFAULT 365,
  created_at INTEGER NOT NULL
);

CREATE TABLE ticket_types (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  kind TEXT NOT NULL CHECK (kind IN ('support', 'report', 'appeal')),
  name TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);

CREATE TABLE staff (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'rep')),
  created_at INTEGER NOT NULL
);

CREATE TABLE staff_products (
  email TEXT NOT NULL REFERENCES staff (email) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products (id),
  PRIMARY KEY (email, product_id)
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  type_id TEXT NOT NULL REFERENCES ticket_types (id),
  status TEXT NOT NULL CHECK (status IN ('open', 'waiting', 'closed')),
  customer_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  seq INTEGER NOT NULL
);
CREATE INDEX tickets_by_product_status_updated ON tickets (product_id, status, updated_at);
CREATE INDEX tickets_by_product_seq ON tickets (product_id, seq);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  author TEXT NOT NULL CHECK (author IN ('customer', 'staff')),
  staff_email TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((author = 'staff') = (staff_email IS NOT NULL))
);
CREATE INDEX messages_by_ticket ON messages (ticket_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  ticket_id TEXT REFERENCES tickets (id),
  message_id TEXT REFERENCES messages (id),
  r2_key TEXT NOT NULL,
  r2_upload_id TEXT,
  thumb_key TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration_ms INTEGER,
  state TEXT NOT NULL CHECK (state IN ('pending', 'stored', 'deleted')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX attachments_by_ticket ON attachments (ticket_id);

CREATE TABLE canned_replies (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  type_id TEXT REFERENCES ticket_types (id),
  name TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE api_keys (
  hash TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Rate limits, monthly email use, stored bytes, and 'feed_seq', from which
-- every ticket change takes its tickets.seq.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  window_start INTEGER
);

-- The last tickets.seq each staff member has seen, for the unread badge.
CREATE TABLE reads (
  email TEXT NOT NULL REFERENCES staff (email) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  read_seq INTEGER NOT NULL,
  PRIMARY KEY (email, ticket_id)
);
