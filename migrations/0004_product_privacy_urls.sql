-- shyden-labs/shydesk#78: each product links its English and Indonesian privacy
-- policies from the contact form. Existing products have none until an admin
-- adds them, and their form says it is not set up until then.
ALTER TABLE products ADD COLUMN privacy_url_en TEXT;
ALTER TABLE products ADD COLUMN privacy_url_id TEXT;
