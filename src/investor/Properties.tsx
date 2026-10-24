// "Explore Properties with Parva Realty": the catalog the Super Admin maintains
// with links to the official website. Nothing here moves or reinvests money.
import { api, must } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/useQuery';
import { money } from '../lib/format';
import { Empty, ErrorNote, Loading, Modal, PageHead } from '../ui/kit';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import type { Property } from '../lib/types';
import { isUnlocked } from '../lib/format';
import { isLive, loadInvestments } from './data';

export const loadProperties = async () =>
  must(await api.from('properties').select('*').eq('status', 'published').order('sort_order').order('created_at', { ascending: false })) as Property[];

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export function PropertyGrid({ items, siteUrl, limit }: { items: Property[]; siteUrl: string; limit?: number }) {
  const list = limit ? items.slice(0, limit) : items;
  if (!list.length) {
    return (
      <div className="props">
        <div className="prop">
          <div className="pi"><Icon name="home" /></div>
          <div className="pb"><b>Current listings</b><span className="hint">See the properties currently offered on the official website.</span></div>
          <div className="pf"><a className="btn sm primary" href={siteUrl} target="_blank" rel="noopener noreferrer">View properties on {host(siteUrl)}</a></div>
        </div>
      </div>
    );
  }
  return (
    <div className="props">
      {list.map(p => (
        <div key={p.id} className="prop">
          <div className="pi">{p.image_url ? <img src={p.image_url} alt={p.title} loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="home" />}</div>
          <div className="pb">
            <b>{p.title}</b>
            {(p.location || p.property_type) && <span className="hint">{[p.property_type, p.location].filter(Boolean).join(' · ')}</span>}
            {p.price_text && <span className="pr">{p.price_text}</span>}
            {p.description && <span className="hint" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{p.description}</span>}
          </div>
          <div className="pf"><a className="btn sm primary" href={p.url || siteUrl} target="_blank" rel="noopener noreferrer">View property</a></div>
        </div>
      ))}
    </div>
  );
}

/** Full-width Parva Realty banner: a featured property photo with a link to the official website. */
export function ParvaBanner({ items, siteUrl, unlocked }: { items: Property[]; siteUrl: string; unlocked: number }) {
  const photo = items.find(p => p.image_url)?.image_url;
  return (
    <a className="parva-banner" href={siteUrl} target="_blank" rel="noopener noreferrer" style={photo ? { backgroundImage: `linear-gradient(90deg, rgba(11,24,52,.94) 0%, rgba(11,24,52,.72) 45%, rgba(11,24,52,.15) 100%), url("${photo}")` } : undefined}>
      <span className="pb-tag">PARVA REALTY · DUBAI</span>
      <b>Own premium Dubai real estate</b>
      <span className="pb-sub">{unlocked > 0 ? `Your ${money(unlocked)} of principal is unlocked. Explore ${items.length || ''} curated Parva Realty properties.` : `Explore ${items.length || ''} curated properties from Parva Realty in Dubai.`}</span>
      <span className="btn pb-btn">Visit parvarealty.ae ›</span>
    </a>
  );
}

export function Properties() {
  const { profile, settings } = useAuth();
  const siteUrl = settings?.property_site_url || 'https://parvarealty.ae/';
  const q = useQuery(async () => {
    const [items, inv] = await Promise.all([loadProperties(), loadInvestments(profile!.id)]);
    return { items, unlocked: inv.filter(i => isLive(i) && isUnlocked(i)).reduce((s, i) => s + Number(i.principal), 0) };
  }, [profile?.id]);
  return (
    <>
      <PageHead crumbs={['Explore Properties']} title="Explore Properties with Parva Realty"
        sub="Property details and prices are shown as published by Parva Realty. Open a property to see it on the official website."
        actions={<a className="btn" href={siteUrl} target="_blank" rel="noopener noreferrer">All listings on {host(siteUrl)}</a>} />
      {q.error && <ErrorNote msg={q.error} retry={q.reload} />}
      {q.data && <ParvaBanner items={q.data.items} siteUrl={siteUrl} unlocked={q.data.unlocked} />}
      {q.data && q.data.unlocked > 0 && (
        <div className="note ok">You have <b>{money(q.data.unlocked)}</b> of unlocked principal. Exploring a property does not move or reinvest it; any purchase is a separate agreement with Parva Realty.</div>
      )}
      {q.loading && !q.data ? <Loading /> : q.data ? <div className="card"><div className="card-b"><PropertyGrid items={q.data.items} siteUrl={siteUrl} /></div></div> : <Empty title="Not available" />}
    </>
  );
}

/** Shown once after an investor signs in, so they know Parva Realty properties are open to them. */
export function ParvaWelcome({ onClose }: { onClose: () => void }) {
  const { settings } = useAuth();
  const nav = useNavigate();
  const q = useQuery(loadProperties, []);
  const siteUrl = settings?.property_site_url || 'https://parvarealty.ae/';
  const items = q.data || [];
  const photo = items.find(p => p.image_url)?.image_url;
  return (
    <Modal title="Explore Parva Realty properties" sub="Premium Dubai real estate, curated by Parva Realty." onClose={onClose} wide
      foot={<><button className="btn ghost" onClick={onClose}>Maybe later</button><button className="btn" onClick={() => { onClose(); nav('/portal/properties'); }}>See all {items.length || ''} properties</button><a className="btn primary" href={siteUrl} target="_blank" rel="noopener noreferrer" onClick={onClose}>Visit parvarealty.ae</a></>}>
      <div className="parva-welcome" style={photo ? { backgroundImage: `linear-gradient(0deg, rgba(11,24,52,.85), rgba(11,24,52,.1) 60%), url("${photo}")` } : undefined}>
        <b>{items[0]?.title || 'Parva Realty'}</b><span>{items[0]?.location}{items[0]?.price_text ? ' · ' + items[0].price_text : ''}</span>
      </div>
      <p className="hint" style={{ marginTop: 12 }}>As a Parva investor you can explore these properties at any time from <b>Explore Properties</b> in the menu. Looking is free and never moves your principal.</p>
    </Modal>
  );
}
