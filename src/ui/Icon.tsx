const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5',
  plans: 'M8 8h8M8 12h8M8 16h5',
  invest: 'M3 20h18M6 16V10M11 16V5M16 16v-5M21 16V8',
  roi: 'M4 19l5-6 4 3 7-9M15 7h5v5',
  brochure: 'M4 5h7a2 2 0 012 2v13a2 2 0 00-2-2H4zM20 5h-7a2 2 0 00-2 2v13a2 2 0 012-2h7z',
  txn: 'M7 7h13M17 4l3 3-3 3M17 17H4M7 14l-3 3 3 3',
  announce: 'M4 10v4h3l7 4V6L7 10H4zM18 9a4 4 0 010 6',
  report: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5',
  bell: 'M6 16v-5a6 6 0 1112 0v5l2 2H4zM10 20.5a2 2 0 004 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 10l5-5 5 5M5 20h14',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  collapse: 'M4 4h16v16H4zM9 4v16M15 10l-2 2 2 2',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12l5 5L20 7',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  rank: 'M8 4h8v5a4 4 0 01-8 0zM8 6H5a3 3 0 003 4M16 6h3a3 3 0 01-3 4M12 13v4M8 20h8M9.5 17h5'
};
const EXTRA: Record<string, JSX.Element> = {
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 010 7M18 14.5c2 .6 3.2 2.5 3.5 5.5" /></>,
  plans: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d={P.plans} /></>,
  payout: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  audit: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 018 0v3.5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  building: <><path d="M4 21V8l8-5 8 5v13M9 21v-6h6v6M8 11h.01M12 11h.01M16 11h.01" /></>,
  branch: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M6 8.5v1.5a3 3 0 003 3h6a3 3 0 003-3V8.5M12 13v2.5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>
};

export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={'ic ' + (className || '')} aria-hidden="true">
      {EXTRA[name] ?? <path d={P[name] || ''} />}
    </svg>
  );
}
