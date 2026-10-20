# Backup and restore plan

## What holds your data
- **Supabase database** – all records, audit log, decisions.
- **Supabase Storage bucket `imports`** – the original uploaded files (evidence).
- The code is in GitHub; it contains no data and no secrets.

## Backups (set up once)
1. Use a Supabase **Pro** project: daily backups are included (Project → Database → Backups). Turn on **Point-in-Time Recovery** if you want to restore to any minute.
2. **Monthly export** (also covers Storage, which the daily backups do not): on a computer with the Supabase CLI:
   - `supabase db dump --db-url "<connection string>" -f backup-YYYY-MM.sql`
   - Download the `imports` bucket from Storage (Storage → imports → select all → Download) or sync it with the CLI.
   - Keep both in a company-controlled location, not on a personal laptop.
3. After every period is completed, export the reconciliation results to Excel (Dashboard → Export) and keep it with the statement.

## Restore
- *Wrong import or accidental change:* no restore needed. Revert the import (administrator) and import again; every action is in the audit log.
- *Restore from Supabase backup:* Project → Database → Backups → Restore (or PITR to a chosen time). Test on a copy first.
- *Rebuild from a dump:* create a new Supabase project, run `0001`, `0002`, `0003` migrations, then load the dump data; re-upload the `imports` bucket; update the two environment variables in Vercel.

## Test the restore
Once a quarter restore the latest dump into a scratch Supabase project and open the dashboard. A backup that has never been restored is not yet a backup.

## Accidental-deletion protection
Normal users cannot delete rows in any financial table (no DELETE permission exists for them). Documents are soft-deleted only through an administrator revert with a reason; periods can be locked.
