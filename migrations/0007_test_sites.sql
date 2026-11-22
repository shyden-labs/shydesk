-- Products' TEST sites (shyden-labs/shydesk#263): their exact origins, let in like
-- the allowed origins, and the TEST site each ticket came from (null for a live one),
-- so the desk marks it TEST and its customer gets the test-version auto-reply.
ALTER TABLE products ADD COLUMN test_origins_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN test_origin TEXT;
