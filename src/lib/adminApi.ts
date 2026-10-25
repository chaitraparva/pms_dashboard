import { friendly } from './api';
import { call } from './api';

export interface NewUser {
  email: string;
  full_name: string;
  role: 'investor' | 'super_admin';
  /** password: the administrator sets a temporary password now and shares it with the person. */
  mode: 'invite' | 'password';
  password?: string;
  phone?: string;
  city?: string;
  address?: string;
  id_number_masked?: string;
  bank_name?: string;
  bank_account_masked?: string;
  bank_ifsc?: string;
  /** Investors: the admin who brought them in (gets the admin bonus). Defaults to the admin creating the account. */
  introduced_by?: string | null;
}

/** Creates a login with a temporary password (only a salted hash is stored). */
export async function createUser(u: NewUser): Promise<{ id: string; code: string }> {
  try { return await call('fn', { name: 'createAccount', args: { ...u } }); } catch (e) { throw new Error(friendly((e as Error).message)); }
}

/** Sets a new temporary password for an existing user. */
export async function resetUserPassword(userId: string, password: string): Promise<boolean> {
  try { await call('fn', { name: 'adminResetPassword', args: { userId, password } }); return true; } catch (e) { throw new Error(friendly((e as Error).message)); }
}

/** Sets a person's password, or creates their login (phone number + password) if they have none. */
export async function setInvestorLogin(userId: string, password: string): Promise<boolean> {
  try { await call('fn', { name: 'adminSetLogin', args: { userId, password } }); return true; } catch (e) { throw new Error(friendly((e as Error).message)); }
}

export interface NewIB { full_name?: string; phone: string; password: string; email?: string; city?: string; branch_id?: string | null; person_id?: string }
/** Creates an IB login (phone number + password), or gives an existing person an IB login. */
export async function createIbLogin(u: NewIB): Promise<{ id: string; code: string }> {
  try { return await call('fn', { name: 'createIB', args: { ...u } }); } catch (e) { throw new Error(friendly((e as Error).message)); }
}

/** Record investment: Individual (chosen, or found / added by phone with a login) or IB (with an optional sub-investor). A proof is required. */
export async function recordInvestmentFull(a: Record<string, unknown>): Promise<{ id: string | null; code: string | null; investor: string; investor_id: string; is_new: boolean; ib: string | null; more: { id: string; code: string }[] }> {
  try { return await call('fn', { name: 'adminRecordInvestment', args: { ...a } }); } catch (e) { throw new Error(friendly((e as Error).message)); }
}

/** Approves an investment request from the portal: the investment is recorded as with Record investment. */
export async function approveInvestmentRequest(a: Record<string, unknown>): Promise<{ id: string; code: string; investor: string }> {
  try { return await call('fn', { name: 'adminApproveInvestmentRequest', args: { ...a } }); } catch (e) { throw new Error(friendly((e as Error).message)); }
}
