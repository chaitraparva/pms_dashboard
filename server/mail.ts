// Sends email through Resend (https://resend.com), using its HTTP API (no extra package needed).
// Set RESEND_API_KEY and PMS_MAIL_FROM in Vercel → Settings → Environment Variables.
// Without them nothing is sent; the Super Admin still gets the in-app notification.

export interface Mail { to: string[]; subject: string; text: string; html: string }

const env = (k: string) => (process.env[k] || '').trim();

/** The site's address for links in emails: PMS_APP_URL, or the Vercel production domain. */
export function appUrl(): string {
  const u = env('PMS_APP_URL') || (env('VERCEL_PROJECT_PRODUCTION_URL') ? 'https://' + env('VERCEL_PROJECT_PRODUCTION_URL') : '');
  return u.replace(/\/+$/, '');
}

export async function sendMail(m: Mail): Promise<boolean> {
  const key = env('RESEND_API_KEY'), from = env('PMS_MAIL_FROM');
  if (!m.to.length) return false;
  if (!key || !from) { console.warn('Email not sent: add RESEND_API_KEY and PMS_MAIL_FROM in Vercel to send emails.'); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text, html: m.html })
    });
    if (!r.ok) { console.error('Email failed', r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('Email failed', e); return false; }
}
