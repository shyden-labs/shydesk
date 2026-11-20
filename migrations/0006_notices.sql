-- Each notice email sent to a customer, sent from its own bounce address
-- bounce-<id>@BOUNCE_DOMAIN, and the bounce once one comes back
-- (shyden-labs/shydesk#232). Deleted with the ticket's text, since it holds
-- the customer's address. message_id is the reply it announces, null for a new
-- ticket or appeal.
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  message_id TEXT,
  to_address TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  bounced_at INTEGER,
  bounce_status TEXT,
  bounce_reason TEXT
);
CREATE INDEX notices_ticket ON notices (ticket_id, sent_at);
