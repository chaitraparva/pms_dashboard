import { Route, Routes, useNavigate } from 'react-router-dom';
import { Shell, NavItem } from '../shell/Shell';
import { api } from '../lib/api';
import { useQuery } from '../lib/useQuery';
import { ProfileSecurity } from '../pages/ProfileSecurity';
import { Notifications } from '../pages/Notifications';
import { Overview } from './Overview';
import { Investors, InvestorDetail } from './Investors';
import { Plans, PlanDetail } from './Plans';
import { Investments, InvestmentDetail } from './Investments';
import { Accruals } from './Accruals';
import { Payouts } from './Payouts';
import { Branches, BranchDetail } from './Branches';
import { Brochures } from './Brochures';
import { Properties } from './Properties';
import { Transactions } from './Transactions';
import { Announcements } from './Announcements';
import { Reports } from './Reports';
import { Audit } from './Audit';
import { Settings } from './Settings';
import { Search } from './Search';
import { Ranking } from './Ranking';
import { Bonuses } from './Bonuses';
import { IBs } from './IBs';
import { Withdrawals } from './Withdrawals';
import { Queries } from './Queries';
import { SubTabs } from '../ui/kit';

export default function AdminApp() {
  const nav = useNavigate();
  const counts = useQuery(async () => {
    const [p, w, qy] = await Promise.all([
      api.from('payouts').select('id', { count: 'exact', head: true }).in('status', ['approved', 'processing', 'failed']),
      api.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      api.from('queries').select('id', { count: 'exact', head: true }).eq('status', 'open')
    ]);
    return { payouts: p.count || 0, withdrawals: w.count || 0, queries: qy.count || 0 };
  }, []);
  const items: NavItem[] = [
    { group: 'Dashboard' }, { to: '/admin', label: 'Overview', icon: 'home', also: ['/admin/branches', '/admin/ranking'] },
    { group: 'Manage' }, { to: '/admin/investors', label: 'Investors', icon: 'users', count: counts.data?.payouts, also: ['/admin/investments', '/admin/payouts'] },
    { to: '/admin/ibs', label: 'Network', icon: 'users' },
    { to: '/admin/bonuses', label: 'Bonus', icon: 'roi' },
    { to: '/admin/withdrawals', label: 'Withdrawals', icon: 'payout', count: counts.data?.withdrawals },
    { to: '/admin/queries', label: 'Queries', icon: 'announce', count: counts.data?.queries },
    { to: '/admin/announcements', label: 'Updates', icon: 'announce', also: ['/admin/brochures'] },
    { to: '/admin/properties', label: 'Parva Properties', icon: 'building' },
    { to: '/admin/settings', label: 'Settings', icon: 'settings' }
  ];
  const peopleTabs = <SubTabs tabs={[{ to: '/admin/investors', label: 'Investors' }, { to: '/admin/investments', label: 'Investments' }, { to: '/admin/payouts', label: 'Payouts', count: counts.data?.payouts }]} />;
  const updateTabs = <SubTabs tabs={[{ to: '/admin/announcements', label: 'Announcements' }, { to: '/admin/brochures', label: 'Brochures' }]} />;
  return (
    <Routes>
      <Route element={<Shell base="/admin" roleLabel="Super Admin" nav={items} searchPh="Search investors, investments, transactions" onSearch={q => nav('/admin/search?q=' + encodeURIComponent(q))} />}>
        <Route index element={<Overview />} />
        <Route path="investors" element={<>{peopleTabs}<Investors /></>} />
        <Route path="investors/:code" element={<InvestorDetail />} />
        <Route path="plans" element={<Plans />} />
        <Route path="plans/:code" element={<PlanDetail />} />
        <Route path="investments" element={<>{peopleTabs}<Investments /></>} />
        <Route path="investments/:code" element={<InvestmentDetail />} />
        <Route path="accruals" element={<Accruals />} />
        <Route path="bonuses" element={<Bonuses />} />
        <Route path="ibs" element={<IBs />} />
        <Route path="withdrawals" element={<Withdrawals />} />
        <Route path="queries" element={<Queries />} />
        <Route path="payouts" element={<>{peopleTabs}<Payouts /></>} />
        <Route path="branches" element={<Branches />} />
        <Route path="ranking" element={<Ranking />} />
        <Route path="branches/:code" element={<BranchDetail />} />
        <Route path="brochures" element={<>{updateTabs}<Brochures /></>} />
        <Route path="properties" element={<Properties />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="announcements" element={<>{updateTabs}<Announcements /></>} />
        <Route path="reports" element={<Reports />} />
        <Route path="audit" element={<Audit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="search" element={<Search />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="profile" element={<ProfileSecurity />} />
        <Route path="*" element={<Overview />} />
      </Route>
    </Routes>
  );
}
