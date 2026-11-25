-- Why a new ticket's first email to the customer was not sent (shyden-labs/shydesk#274):
-- 'share-used-up' or 'failed', so the desk says so; null once it was sent.
ALTER TABLE tickets ADD COLUMN first_notice_unsent TEXT;
