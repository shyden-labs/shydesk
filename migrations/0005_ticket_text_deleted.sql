-- When a closed ticket's text timer deleted its text and left a bare row, because Release 2
-- records (reports, punishments, appeals, legal holds, authority reports) point at it
-- (shyden-labs/shydesk#191, Shyden's ruling 2026-11-17). Null while the text is kept.
ALTER TABLE tickets ADD COLUMN text_deleted_at INTEGER;
