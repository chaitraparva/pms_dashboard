# Parva Realty PMS

Super Admin dashboard and Investor portal. The site and its API run on **Vercel**; all data is stored in your **Neon** (PostgreSQL) database. There is no sample data: the first start creates one Super Admin and nothing else.

## Who signs in

- **Super Admin**: email + password. Records every investor and investment, pays returns, bonuses and withdrawals, answers queries, publishes announcements.
- **Investor / IB / Sub-investor**: phone number + password. The Super Admin sets the first password when registering them (Record investment, or approving a request). Anyone can change their password from **Change password** on the sign-in page or under **Profile & Security** (the current password is required; only a salted PBKDF2 hash is stored).
  - **Individual** investors see their own investments, returns, withdrawals, queries and announcements.
  - **IBs** also see **My Sub-Investors**: each sub-investor's details, investments, charts, withdrawals and requests, and the bonus they earn. They can request investments and withdrawals for their sub-investors.
  - **Sub-investors** see only their own data.

## Investments, requests and withdrawals

- **Record investment** (Super Admin): Investor type comes first. *Individual*: choose an existing investor or find / add one by phone. *IB*: choose or register the IB (details fill in); optionally add a sub-investor (name, phone, login password) to record the investment under the IB with a bonus. A payment proof (image or document) is required.
- **Request investment** (portal): for yourself, or (IBs) for a sub-investor. Goes to **Investment requests** for the Super Admin, who sets the ROI and approves it; it then shows in the portal. Proof attachments are optional.
- **Forgot password** (sign-in page): the person enters their phone number (or email) and an optional message. Every active Super Admin, and the support email in Settings, gets an email and a notification linking to the person's page, where **Reset password** sets a new temporary password. The answer on screen is always the same, so it never reveals which numbers have an account; one request per account every 15 minutes.
- **Withdraw** (portal): for yourself, or (IBs) for a sub-investor. *Request withdrawal to my bank account*, *Transfer to my MT5 account*, or *Transfer to IB* (approved by the Super Admin under Withdrawals). Attachments are optional.

## Deploy on Vercel with Neon

1. Push this folder to a new GitHub repository.
2. In Vercel: **Add New → Project**, import the repository. Framework: **Vite** (detected). Do not deploy yet if asked; you can also deploy and redeploy after step 4.
3. In the Vercel project: **Storage → Connect Database → Neon** and choose your Neon database. This adds `DATABASE_URL` for you.
   (Or add it by hand: Neon → your project → **Connect** → copy the pooled connection string → Vercel **Settings → Environment Variables** → `DATABASE_URL`.)
4. In Vercel **Settings → Environment Variables**, add:
   | Name | Value |
   |------|-------|
   | `PMS_SECRET` | a long random text, at least 32 characters (signs the logins; keep it secret, never change it later or everyone is signed out) |
   | `PMS_ADMIN_EMAIL` | the Super Admin's email |
   | `PMS_ADMIN_PASSWORD` | the Super Admin's first password (at least 10 characters) |
   | `PMS_ADMIN_NAME` | the Super Admin's name (optional) |
   | `RESEND_API_KEY` | for **Forgot password** emails to the Super Admin: an API key from [resend.com](https://resend.com) (optional) |
   | `PMS_MAIL_FROM` | the sender, e.g. `Parva PMS <no-reply@parvarealty.ae>` (the domain must be verified in Resend) |
   | `PMS_APP_URL` | the site address for links in emails (optional; the Vercel production domain is used otherwise) |
5. **Deployments → Redeploy** (so the settings are used). Open the site and sign in as Super Admin.
6. Change the Super Admin password under **Profile & Security**. `PMS_ADMIN_EMAIL` / `PMS_ADMIN_PASSWORD` are only used once, on the very first start, while the database is empty.

The tables (`pms_meta`, `pms_tables`, `pms_files`) are created automatically on the first visit.

## Good to know

- Uploaded files (documents, brochures, logo, property photos) are stored in the database, up to **3 MB** each.
- Monthly returns are calculated automatically whenever someone uses the site.
- Back up from Neon (it keeps a restore history; you can also branch the database before big changes).

## Run on your computer

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (Neon), PMS_SECRET and the admin details
npm run dev            # http://localhost:5173
```
