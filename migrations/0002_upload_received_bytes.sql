-- What a pending upload has sent so far, counted in the running total as each
-- part arrives and given back if the upload is refused or abandoned
-- (shyden-labs/shydesk#20).
ALTER TABLE attachments ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
