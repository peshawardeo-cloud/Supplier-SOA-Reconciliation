# Supplier SOA Reconciliation System

Built so far:

- **Phase 1** - login, user roles, settings, audit log, secure database base
- **Phase 2** - suppliers (add, edit, search), supplier workspaces, reconciliation periods with statuses
- **Phase 3** - supplier statement (SOA) import from **PDF, Excel (.xlsx) or CSV**, with preview, column mapping, validation, duplicate detection, statement-total checks and import history

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
src/lib/import/        PDF / Excel / CSV readers, validation, duplicate staging
src/lib/reconcile/     document-number normalisation (matching engine comes in Phase 5)
tests/                 automated tests
```


## Updating an existing deployment to Phase 2 + 3

1. **Database:** in Supabase open **SQL Editor -> New query**, paste all of `supabase/migrations/0002_suppliers_periods_soa_import.sql` and click **Run**. (Run it once only. `0001` was already run.)
2. **Check storage:** Supabase -> **Storage** should now show a **private** bucket named `imports`. Uploaded statements are kept there as evidence.
3. **Code:** replace the files in your GitHub repository with this version (keep `.env.local` out of Git). Vercel redeploys automatically; no new environment variables are needed.
4. Open the app -> **Suppliers -> Add supplier**.

## Importing a supplier statement

1. **Suppliers -> your supplier -> New reconciliation period** (e.g. the dates the statement covers, or the month you are reconciling).
2. Open the period -> **Import supplier statement (SOA)** -> choose the file.
3. **PDF:** read automatically. **Excel/CSV:** you match the columns once; it is remembered for that supplier.
4. **Review:** check *Statement totals check* (the figures printed on the statement against what was read). Fix or skip errors, decide on duplicates, then **Import**.
5. Imported entries cannot be edited. A wrong import can be reverted by an administrator (with a reason); history is kept.

## Things to know

- Text-based PDFs only. A scanned or photographed PDF has no text to read; ask the supplier for the original PDF or Excel file.
- Old `.xls` files are not supported; open in Excel and **Save As .xlsx** (or CSV).
- The PDF reader currently understands the layout used by Saudi Vetonit (SAVETO) statements. Another supplier's PDF layout may need its own reader; Excel/CSV works for any layout through column mapping.
- Periods must be **Draft** or **In progress** to accept imports. Only an administrator can lock a period.

## Automated checks

```bash
npm run typecheck   # types
npm test            # parsing, matching rules, money maths, import pipeline (includes an in-memory PostgreSQL)
npm run test:db     # database security rules: roles, locked periods, duplicate files, revert, audit
```
