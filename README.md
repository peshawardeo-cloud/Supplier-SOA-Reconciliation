# Supplier SOA Reconciliation System

Phase 1 (foundation): login, user roles, settings, audit log, and the secure database base.

## What you need (one-time)

1. A **GitHub** account (stores the code)
2. A **Supabase** account (database + login). Use the Pro plan for real company data: it includes daily backups.
3. A **Vercel** account (hosting). Use the Pro plan for commercial use.
4. **Node.js 20 or newer** on your computer (only needed to test locally): https://nodejs.org

## Step 1: Create the database

1. In Supabase, click **New project**. Choose a strong database password and save it in your password manager.
2. Open **SQL Editor → New query**, paste the whole contents of `supabase/migrations/0001_foundation.sql`, and click **Run**. It should say "Success".
3. Go to **Authentication → Providers → Email** and **turn OFF "Allow new users to sign up"**. This is important: only you should be able to add users.
4. Go to **Authentication → Users → Add user → Create new user**. Enter your email and a strong password, and tick "Auto Confirm User". **The first user created automatically becomes the administrator.**
5. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.

## Step 2: Run it on your computer (optional but recommended)

```bash
npm install
cp .env.example .env.local      # then open .env.local and paste the two values from Step 1
npm run dev
```

Open http://localhost:3000 and sign in with the user you created.

Run the automated checks any time with `npm run typecheck` and `npm test`.

## Step 3: Put it online

1. Upload this folder to a new **private** GitHub repository.
2. In Vercel: **Add New → Project**, pick the repository.
3. Under **Environment Variables**, add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (same values as `.env.local`).
4. Click **Deploy**. In Supabase, **Authentication → URL Configuration**, set the Site URL to your Vercel address.

## Adding colleagues

1. Supabase → **Authentication → Users → Add user** (they start as *viewer*).
2. In the app open **Users** and set their role:
   - **Viewer**: read and export only
   - **Accountant**: import, match, manage discrepancies (from Phase 3 onward)
   - **Admin**: also settings and users

## Security notes

- Never put the `service_role` key in frontend code or share it. It is not needed in Phase 1.
- Never commit `.env.local` (already git-ignored).
- The database refuses all access unless a security policy allows it; the app also checks your role on the server.
- The last active administrator cannot be removed or deactivated.
- Changes to settings and users are recorded in `audit_log` (visible to admins in the Supabase table editor).

## Project layout (so far)

```
supabase/migrations/   database setup (run in order)
src/app/(auth)/        login
src/app/(app)/         dashboard, settings, users
src/lib/               supabase clients, auth/role checks, money helpers
tests/                 automated tests
```
