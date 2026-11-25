-- The thumbnail's own size (shyden-labs/shydesk#271): `bytes` stays the file plus its
-- thumbnail for storage accounting, and the desk shows `bytes - thumb_bytes`, the
-- size of the file staff open. 0 until a thumbnail is stored.
ALTER TABLE attachments ADD COLUMN thumb_bytes INTEGER NOT NULL DEFAULT 0;
