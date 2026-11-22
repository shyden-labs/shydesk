// One row type per table in migrations/0001_release_1.sql (shyden-labs/shydesk#15) and
// migrations/0004_release_2.sql (shyden-labs/shydesk#57), with the columns that
// 0002_upload_received_bytes.sql, 0003_ticket_token_sealed.sql, 0005_ticket_text_deleted.sql and 0007_test_sites.sql add.
// Times are Unix epoch milliseconds; *_json columns hold JSON text.

export type TicketKind = 'support' | 'report' | 'appeal';
export type TicketStatus = 'open' | 'waiting' | 'closed';
export type StaffRole = 'admin' | 'rep';
export type MessageAuthor = 'customer' | 'staff';
export type AttachmentState = 'pending' | 'stored' | 'deleted';

export interface ProductRow {
  id: string;
  name: string;
  sender_address: string;
  ticket_page_url: string;
  allowed_origins_json: string;
  monthly_email_share: number;
  attachments_keep_days: number;
  text_keep_days: number;
  created_at: number;
  // Release 2 (migrations/0004_release_2.sql).
  punishments_json: string;
  callback_url: string | null;
  callback_secret: string | null;
  appeal_page_url: string | null;
  // migrations/0007_test_sites.sql (shyden-labs/shydesk#263).
  test_origins_json: string;
}

export interface TicketTypeRow {
  id: string;
  product_id: string;
  kind: TicketKind;
  name: string;
  fields_json: string;
  reasons_json: string;
  enabled: 0 | 1;
}

export interface StaffRow {
  email: string;
  role: StaffRole;
  created_at: number;
}

export interface StaffProductRow {
  email: string;
  product_id: string;
}

export interface TicketRow {
  id: string;
  product_id: string;
  type_id: string;
  status: TicketStatus;
  customer_email: string;
  subject: string;
  category: string;
  fields_json: string;
  token_hash: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  seq: number;
  // migrations/0003_ticket_token_sealed.sql: the token, encrypted; null on tickets from before it.
  token_sealed: string | null;
  // migrations/0005_ticket_text_deleted.sql: when the text timer left a bare row; null while the text is kept.
  text_deleted_at: number | null;
  /** The TEST site the ticket came from (migrations/0007_test_sites.sql, shyden-labs/shydesk#263); null for a live one. */
  test_origin: string | null;
}

export interface MessageRow {
  id: string;
  ticket_id: string;
  author: MessageAuthor;
  staff_email: string | null;
  body: string;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  product_id: string;
  ticket_id: string | null;
  message_id: string | null;
  r2_key: string;
  r2_upload_id: string | null;
  thumb_key: string | null;
  mime: string;
  bytes: number;
  duration_ms: number | null;
  state: AttachmentState;
  created_at: number;
  deleted_at: number | null;
  // migrations/0002_upload_received_bytes.sql: bytes a pending upload has sent so far.
  received_bytes: number;
}

export interface CannedReplyRow {
  id: string;
  product_id: string;
  type_id: string | null;
  name: string;
  body: string;
}

export interface ApiKeyRow {
  hash: string;
  product_id: string;
  label: string;
  created_at: number;
  revoked_at: number | null;
}

export interface CounterRow {
  key: string;
  value: number;
  window_start: number | null;
}

export interface ReadRow {
  email: string;
  ticket_id: string;
  read_seq: number;
}

// Release 2 (shyden-labs/shydesk#57).

export type SendState = 'sending' | 'applied' | 'failed';
export type AppealState = 'open' | 'upheld' | 'rejected';
export type LegalHoldReason = 'crime_unreported' | 'reported' | 'preservation';
export type LegalHoldAction = 'placed' | 'renewed' | 'order' | 'reported' | 'no_report' | 'lifted';

export interface ReportRow {
  ticket_id: string;
  product_id: string;
  reporter_id: string;
  item_kind: string;
  item_id: string;
  subject_user_id: string;
  reason: string;
  context_json: string;
}

export interface PunishmentRow {
  id: string;
  product_id: string;
  report_ticket_id: string;
  subject_user_id: string;
  punishment_key: string;
  label: string;
  duration_seconds: number | null;
  applied_by: string;
  created_at: number;
  send_state: SendState;
  send_error: string | null;
  appeal_token_hash: string;
  lifted_at: number | null;
  lifted_by: string | null;
  lift_state: SendState | null;
  lift_error: string | null;
}

export interface AppealRow {
  punishment_id: string;
  ticket_id: string;
  state: AppealState;
  decided_by: string | null;
  decided_at: number | null;
}

export interface LegalHoldRow {
  id: string;
  ticket_id: string;
  attachment_id: string | null;
  reason: LegalHoldReason;
  csam: 0 | 1;
  note: string;
  placed_by: string;
  placed_at: number;
  // The report date ('reported') or the request date ('preservation'); null for 'crime_unreported'.
  basis_at: number | null;
  renewals: number;
  order_pending: 0 | 1;
  no_report_reason: string | null;
  lifted_at: number | null;
  lifted_by: string | null;
}

export interface HoldEventRow {
  hold_id: string;
  at: number;
  by: string;
  action: LegalHoldAction;
  detail: string;
}

export interface AuthorityReportRow {
  ticket_id: string;
  reported_to: string;
  reported_at: number;
  reference: string;
  recorded_by: string;
  recorded_at: number;
}
