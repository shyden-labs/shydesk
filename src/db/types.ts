// One row type per table in migrations/0001_release_1.sql (shyden-labs/shydesk#15).
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
