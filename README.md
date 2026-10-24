# Parva Realty PMS

Super Admin dashboard and Investor portal. The site and its API run on **Vercel**; all data is stored in your **Neon** (PostgreSQL) database. There is no sample data: the first start creates one Super Admin and nothing else.

## Who signs in

- **Super Admin**: email + password. Records every investor and investment, pays returns, bonuses and withdrawals, answers queries, publishes announcements.
- **Investor**: phone number + password. Gets a login when the Super Admin records them. Sees their own investments and returns, the people under them and their bonus, withdrawals, queries and announcements.

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
