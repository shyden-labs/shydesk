-- An encrypted copy of each ticket's token, so a staff reply's email can carry the
-- customer's private link (shyden-labs/shydesk#24). Tickets from before this have none.
ALTER TABLE tickets ADD COLUMN token_sealed TEXT;
