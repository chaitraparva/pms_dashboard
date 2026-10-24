import { rpc } from './api';

/* Investors who bring in investors (the Super Admin gives them this right). */

export interface NetInvestment {
  id: string; code: string; plan_name: string; principal: number; investor_rate: number; bonus_rate: number; bonus_monthly: number;
  status: string; start_date: string | null; maturity_date: string | null; lockin_months: number; created_at: string; bonus_earned: number; bonus_paid: number;
}
export interface NetInvestor {
  id: string; code: string; name: string; email: string; phone: string; city: string; kyc_status: string; account_status: string; created_at: string; investments: NetInvestment[];
}
export interface NetBonus {
  id: string; code: string; investor_name: string; investor_code: string; investment_code: string; period_no: number; accrual_date: string; rate: number; amount: number; status: string; paid_on: string | null;
}
export interface NetPlan { id: string; name: string; rate: number; investor_rate: number; bonus_rate: number; min_amount: number; max_amount: number; lockin_options: number[] }
export interface Network { can_introduce: boolean; investors: NetInvestor[]; bonuses: NetBonus[]; plans: NetPlan[] }

export const loadNetwork = () => rpc<Network | null>('my_network');
