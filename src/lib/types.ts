export type Role = 'super_admin' | 'investor';
export type KycStatus = 'pending' | 'verified' | 'rejected';
export type AccountStatus = 'active' | 'suspended';
export type PlanStatus = 'draft' | 'active' | 'inactive' | 'archived';
export type InvestmentStatus = 'pending_funding' | 'active' | 'matured' | 'redemption_requested' | 'redemption_processing' | 'redeemed' | 'cancelled';
export type PayoutStatus = 'accrued' | 'approved' | 'processing' | 'paid' | 'failed' | 'cancelled';
export type EarlyRedemption = 'not_permitted' | 'permitted_with_fee' | 'admin_discretion';

export interface Settings {
  id: 1; company_name: string; tagline: string; logo_url: string | null; primary_color: string;
  currency: string; locale: string; timezone: string; approaching_days: number; request_window_days: number;
  default_payout_lag_days: number; four_eyes: boolean; allow_custom_lockin: boolean; lockin_options: number[];
  default_terms: string; default_risk_disclosure: string; support_email: string; support_phone: string; legal_footer: string;
  property_site_url: string; show_properties_to: 'all' | 'unlocked';
  updated_at: string;
}

export interface Profile {
  id: string; role: Role; code: string | null; full_name: string; email: string; phone: string; address: string; city: string;
  id_number_masked: string; bank_name: string; bank_account_masked: string; bank_ifsc: string;
  kyc_status: KycStatus; account_status: AccountStatus; notify_email: boolean; branch_id: string | null; created_at: string; updated_at: string;
  /** Investors only: who brought the investor in and receives the bonus (a Super Admin or an investor). Never shown to the investor. */
  introduced_by?: string | null;
  /** Investors only: the Super Admin allowed this investor to add investors (they get the bonus on those investors). */
  can_introduce?: boolean;
  /** Investors: has a login (phone number + password). */
  has_login?: boolean;
  /** Investors: registered as an IB (introducing broker) who can have sub-investors. */
  is_ib?: boolean;
  password_changed_at?: string;
}

export interface Branch { id: string; code: string; name: string; city: string; status: 'active' | 'inactive'; created_at: string; updated_at: string }

export interface Plan {
  id: string; code: string; name: string; description: string; status: PlanStatus; current_version: number;
  created_at: string; updated_at: string;
}

export interface PlanVersion {
  id: string; plan_id: string; version: number; monthly_rate: number; min_amount: number; max_amount: number;
  lockin_options: number[]; allow_custom_lockin: boolean; eligible_from: string; eligible_to: string | null;
  early_redemption: EarlyRedemption; early_fee_pct: number; payout_lag_days: number; terms: string; risk_disclosure: string;
  effective_from: string; change_reason: string; created_by: string | null; created_at: string;
  /** % per month of the plan rate that goes to whoever introduced the investor. Set by the Super Admin on the plan. */
  bonus_rate?: number;
}

export interface Investment {
  id: string; code: string; investor_id: string; plan_id: string; plan_version_id: string; plan_name: string; plan_version: number;
  monthly_rate: number; lockin_months: number; early_redemption: EarlyRedemption; early_fee_pct: number; payout_lag_days: number;
  terms: string; risk_disclosure: string; principal: number; monthly_return: number; status: InvestmentStatus;
  expected_start: string | null; start_date: string | null; lockin_end_date: string | null; maturity_date: string | null;
  request_from_date: string | null; agreement_ref: string; deposit_ref: string; notes: string; cancelled_reason: string | null;
  created_by: string | null; created_at: string; activated_by: string | null; activated_at: string | null;
  /** Admin view only. monthly_rate is the plan rate; investor_rate is what the investor earns (monthly_return); the rest is the admin bonus. */
  investor_rate?: number; admin_bonus_rate?: number; admin_bonus?: number;
  /** The payment proof attached when the investment was recorded (private file). */
  proof_path?: string | null;
  /** The IB bonus is paid on top of the ROI (investor keeps the whole ROI). Older plan-based investments take it from the plan rate. */
  bonus_on_top?: boolean;
  /** How the investor takes the monthly ROI. */
  roi_method?: 'cash' | 'upi' | 'bank' | null;
  roi_upi?: string | null;
}

export interface AdminBonus {
  id: string; code: string; investment_id: string; investor_id: string; admin_id: string | null; accrual_id: string; period_no: number; accrual_date: string;
  rate: number; amount: number; status: 'accrued' | 'paid' | 'cancelled'; payment_ref: string | null; paid_on: string | null; paid_by: string | null; created_at: string; updated_at: string;
}

export interface Balance { investment_id: string; accrued: number; paid: number; processing: number; approved: number; unapproved: number; periods_accrued: number }

export interface Accrual {
  id: string; investment_id: string; period_no: number; kind: 'regular' | 'stub' | 'reversal'; period_start: string; period_end: string;
  accrual_date: string; days: number; days_in_period: number; amount: number; reverses_id: string | null; reason: string | null; created_at: string;
}

export interface Payout {
  id: string; code: string; accrual_id: string; investment_id: string; investor_id: string; amount: number; due_date: string;
  status: PayoutStatus; batch_ref: string | null; payment_ref: string | null; failure_reason: string | null;
  approved_by: string | null; approved_at: string | null; sent_by: string | null; sent_at: string | null;
  confirmed_by: string | null; confirmed_at: string | null; paid_on: string | null; updated_at: string;
}

export interface LedgerEntry {
  id: string; code: string; investment_id: string | null; investor_id: string | null; type: string; amount: number;
  status: 'pending' | 'posted' | 'confirmed' | 'failed' | 'reversed'; occurred_on: string; reference: string; note: string;
  source_table: string | null; source_id: string | null; created_at: string;
}


export interface Announcement {
  id: string; code: string; title: string; body: string; category: string; audience: 'all' | 'selected' | 'plan' | 'maturing';
  audience_plan_id: string | null; audience_days: number | null; audience_investor_ids: string[]; status: 'draft' | 'published';
  attachment_path: string | null; send_email: boolean; recipients: number; published_at: string | null; created_at: string; updated_at: string;
}

export interface Notification { id: string; user_id: string; kind: string; title: string; body: string; link: string; source_table: string | null; source_id: string | null; read_at: string | null; created_at: string }

export interface DocumentRow {
  id: string; owner_id: string | null; investment_id: string | null; kind: 'agreement' | 'statement' | 'kyc' | 'proof' | 'attachment' | 'other';
  title: string; storage_path: string; mime: string; size_bytes: number; visible_to_investor: boolean; created_at: string;
}

export interface AuditLog { id: number; at: string; actor_id: string | null; actor_name: string; action: string; entity_type: string; entity_id: string | null; entity_label: string; reason: string; before: unknown; after: unknown }

export interface Brochure {
  id: string; code: string; title: string; description: string; storage_path: string | null; file_name: string; mime: string; size_bytes: number;
  plan_id: string | null; branch_id: string | null; publish_on: string; starts_on: string | null; ends_on: string | null;
  status: 'draft' | 'published' | 'archived'; published_at: string | null; created_at: string; updated_at: string;
}
export interface MyBrochure {
  id: string; code: string; title: string; description: string; storage_path: string; file_name: string; mime: string; plan_id: string | null; plan_name: string | null;
  publish_on: string; starts_on: string | null; ends_on: string | null; seen: boolean; acknowledged: boolean;
}
export interface Property {
  id: string; title: string; location: string; property_type: string; price_text: string; description: string; image_url: string | null; url: string;
  status: 'draft' | 'published' | 'archived'; sort_order: number; created_at: string; updated_at: string;
}

export interface RateSplit { rate: number; investors: number; principal: number; count: number; unlocked?: number }
export interface BranchStats {
  id: string; code: string; name: string; status: string; investors: number; principal: number; unlocked: number; locked: number;
  accrued: number; paid: number; by_rate: RateSplit[];
}

export interface Dashboard {
  today: string; from: string; to: string; branch_id: string | null;
  registered_investors: number; total_investors: number; new_investors_month: number; investors_with_investments: number; live_investments: number;
  principal_invested: number; unlocked_principal: number; unlocked_count: number; locked_principal: number; locked_count: number;
  accrued_total: number; reversed_total: number; paid_total: number;
  outstanding_total: number; outstanding_count: number; maturing_count: number; maturing_principal: number;
  pending_funding: number; kyc_pending: number; unassigned_investors: number; unassigned_principal: number;
  payouts_by_status: Record<string, { count: number; amount: number }>;
  monthly: { month: string; accrued: number; paid: number; invested: number }[];
  by_branch: BranchStats[];
  by_rate: RateSplit[];
  by_plan: { plan_id: string; plan: string; code: string; rate: number; status: string; investors: number; principal: number; count: number }[];
  by_lockin: { months: number; count: number; principal: number; unlocked: number }[];
}

/** A withdrawal: taken from the investor's highest monthly ROI first; returns use the lower principal from the request date. */
export interface WithdrawalPart { investment_id: string; code: string; rate: number; plan_rate: number; amount: number; before: number; after: number }
/** A proof file (image or document) attached to a request. Stored privately; at most 3 MB. */
export interface Attachment { path: string; name: string; mime: string; size: number }
/** bank: to the registered bank account · mt5: to an MT5 trading account · ib: transferred to the investor's IB (needs Super Admin approval) · cash: recorded by the Super Admin. */
export type WithdrawalMethod = 'bank' | 'mt5' | 'ib' | 'cash';
export interface Withdrawal {
  id: string; code: string; investor_id: string; amount: number; method: WithdrawalMethod; note: string; status: 'pending' | 'completed' | 'cancelled';
  mt5_account?: string | null; ib_id?: string | null; attachments?: Attachment[];
  requested_on: string; requested_at: string; requested_by: string | null; allocations: WithdrawalPart[];
  completed_on: string | null; completed_by: string | null; payment_ref: string | null; admin_note: string | null; cancelled_reason: string | null; updated_at: string;
}
/** An investment requested from the portal (for the investor or, by an IB, for a sub-investor). The Super Admin approves it. */
export interface InvestmentRequest {
  id: string; code: string; kind: 'self' | 'sub'; requested_by: string; investor_id: string | null; new_sub: { name: string; phone: string; city?: string } | null;
  amount: number; lockin_months: number; start_date: string; reference: string; note: string; attachments: Attachment[];
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; decided_by: string | null; decided_at: string | null; decision_note: string | null;
  investment_id: string | null; investment_code: string | null; created_at: string; updated_at: string;
}
/** What the portal knows about the signed-in investor (see my_account on the server). */
export interface SubLite { id: string; code: string; full_name: string; phone: string; account_status: string; has_login: boolean; available: number; bank_name: string; bank_account: string }
export interface MyAccount { is_ib: boolean; ib: { name: string; code: string } | null; available: number; bank: { name: string; account: string; ifsc: string }; subs: SubLite[] }
/** A question from an investor, answered by the Super Admin. */
export interface QueryMessage { from: 'investor' | 'admin'; by: string; text: string; at: string }
export interface Query { id: string; code: string; investor_id: string; subject: string; status: 'open' | 'answered' | 'closed'; created_at: string; updated_at: string; messages: QueryMessage[] }
