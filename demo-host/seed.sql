-- The demo support page's product on Non-Prod (shyden-labs/shydesk#19),
-- upserted by every dev deploy: allowed only on the demo page's own origin,
-- with a support type asking for the device. Its monthly email share is 0,
-- so the demo never sends mail and always shows the keep-this-link text.
INSERT INTO products (id, name, sender_address, ticket_page_url, allowed_origins_json, monthly_email_share, created_at)
VALUES ('demo', 'Demo', 'no-reply@example.com', 'https://shydesk-demo.shydesk-non-prod.workers.dev/support/ticket', '["https://shydesk-demo.shydesk-non-prod.workers.dev"]', 0, 0)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, sender_address = excluded.sender_address,
  ticket_page_url = excluded.ticket_page_url, allowed_origins_json = excluded.allowed_origins_json,
  monthly_email_share = excluded.monthly_email_share;

INSERT INTO ticket_types (id, product_id, kind, name, fields_json, reasons_json, enabled)
VALUES ('demo:support', 'demo', 'support', 'Support', '[{"label":"Device","kind":"text","required":true}]', '[]', 1)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, fields_json = excluded.fields_json;
