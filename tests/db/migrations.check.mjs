import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
const P = fileURLToPath(new URL("../../supabase/migrations/", import.meta.url));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + extra)); };

await db.exec(`
 create role anon nologin; create role authenticated nologin;
 create schema auth;
 create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
 create schema storage;
 create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
 create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);
 alter table storage.objects enable row level security;
 grant usage on schema auth, public, storage to anon, authenticated;
 grant select on auth.users to authenticated;
`);
await db.exec(readFileSync(P + "0001_foundation.sql", "utf8"));
await db.exec(readFileSync(P + "0002_suppliers_periods_soa_import.sql", "utf8"));
await db.exec(readFileSync(P + "0003_documents_matching_discrepancies.sql", "utf8"));
ok("migrations 0001+0002+0003 apply cleanly", true);

const admin = (await db.query(`insert into auth.users(email) values ('admin@x.test') returning id`)).rows[0].id;
const acct  = (await db.query(`insert into auth.users(email) values ('acct@x.test') returning id`)).rows[0].id;
const view  = (await db.query(`insert into auth.users(email) values ('view@x.test') returning id`)).rows[0].id;
await db.query(`update public.profiles set role='accountant' where id=$1`, [acct]);
const roles = (await db.query(`select email, role from public.profiles order by email`)).rows.map(r => r.email + ":" + r.role).join(",");
ok("first user is admin, others viewer then set", roles === "acct@x.test:accountant,admin@x.test:admin,view@x.test:viewer", roles);

async function as(user, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','${user}',false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec(`reset role;`); }
}
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return String(e.message); } };

// viewer cannot create suppliers but can read
let err = await as(view, () => fails(() => db.query(`insert into public.suppliers(code,name) values ('V1','Nope')`)));
ok("viewer cannot insert supplier (RLS)", err && /row-level security/i.test(err), err);

const sup = await as(acct, async () => (await db.query(`insert into public.suppliers(code,name,account_ref) values ('SAVETO','Saudi Vetonit Co.', '38609') returning id`)).rows[0].id);
ok("accountant can insert supplier", !!sup);
err = await as(acct, () => fails(() => db.query(`insert into public.suppliers(code,name) values ('saveto','Dup code')`)));
ok("supplier code unique (case-insensitive)", err && /duplicate key/i.test(err), err);
const vcount = await as(view, async () => (await db.query(`select count(*)::int n from public.suppliers`)).rows[0].n);
ok("viewer can read suppliers", vcount === 1, vcount);

const per = await as(acct, async () => (await db.query(`insert into public.reconciliation_periods(supplier_id,period_start,period_end) values ($1,'2026-09-01','2026-09-30') returning id`, [sup])).rows[0].id);
err = await as(acct, () => fails(() => db.query(`insert into public.reconciliation_periods(supplier_id,period_start,period_end) values ($1,'2026-09-30','2026-09-01')`, [sup])));
ok("period end before start rejected", err && /period_dates_ok/.test(err), err);
err = await as(acct, () => fails(() => db.query(`insert into public.reconciliation_periods(supplier_id,period_start,period_end) values ($1,'2026-09-01','2026-09-30')`, [sup])));
ok("duplicate period rejected", err && /duplicate key/i.test(err), err);

// --- import batch + staging, then atomic commit ---
const batch = await as(acct, async () => (await db.query(`insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash,status) values ($1,$2,'soa','a.pdf','pdf','p/a.pdf','HASH1','staged') returning id`, [sup, per])).rows[0].id);
err = await as(acct, () => fails(() => db.query(`insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash) values ($1,$2,'soa','a2.pdf','pdf','p/a2.pdf','HASH1')`, [sup, per])));
ok("same file hash blocked", err && /duplicate key/i.test(err), err);

const mapped = (n, type, no, debit, credit) => JSON.stringify({ entry_type: type, doc_number: no, doc_number_norm: no, doc_date: "2026-09-05", debit, credit, row_fingerprint: "fp" + n });
await as(acct, async () => {
  const ins = (n, st, m, dec) => db.query(`insert into public.import_staging_rows(batch_id,row_number,raw,mapped,status,user_decision) values ($1,$2,'{}'::jsonb,$3::jsonb,$4,$5)`, [batch, n, m, st, dec]);
  await ins(1, "valid", mapped(1, "invoice", "INV1", "100.00", "0.00"));
  await ins(2, "valid", mapped(2, "payment", "PAY1", "0.00", "40.00"));
  await ins(3, "duplicate", mapped(3, "invoice", "INV1", "100.00", "0.00"), null);
  await ins(4, "duplicate", mapped(4, "invoice", "INV1", "100.00", "0.00"), "import");
  await ins(5, "error", mapped(5, "invoice", "BAD", "1.00", "0.00"));
});
let res = await as(view, () => fails(() => db.query(`select public.commit_import_batch($1)`, [batch])));
ok("viewer cannot commit", res && /permission/i.test(res), res);
const c = await as(acct, async () => (await db.query(`select public.commit_import_batch($1) r`, [batch])).rows[0].r);
ok("commit imports valid + forced duplicate, skips undecided dupe and error", c.imported === 3 && c.skipped_duplicates === 1, JSON.stringify(c));
const bal = (await db.query(`select sum(debit)-sum(credit) b, count(*)::int n from public.soa_entries where deleted_at is null`)).rows[0];
ok("imported amounts correct (100+100-40=160)", Number(bal.b) === 160 && bal.n === 3, JSON.stringify(bal));
err = await as(acct, () => fails(() => db.query(`select public.commit_import_batch($1)`, [batch])));
ok("cannot commit the same batch twice", err && /not ready/i.test(err), err);

// --- immutability ---
const upd = await as(acct, () => fails(() => db.query(`update public.soa_entries set debit = 1 returning id`)));
ok("accountant cannot update imported entries (no privilege)", upd && /permission denied/i.test(upd), upd);
err = await fails(() => db.query(`update public.soa_entries set debit = 1`));
ok("even a superuser cannot edit amounts (trigger)", err && /cannot be edited/i.test(err), err);
const del = await as(acct, async () => { try { return (await db.query(`delete from public.soa_entries returning id`)).rows.length; } catch (e) { return "denied"; } });
ok("accountant cannot delete entries", del === 0 || del === "denied", del);

// --- second batch with same doc number in same period -> unique index blocks non-forced duplicates ---
const b2 = await as(acct, async () => (await db.query(`insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash,status) values ($1,$2,'soa','b.pdf','pdf','p/b.pdf','HASH2','staged') returning id`, [sup, per])).rows[0].id);
await as(acct, () => db.query(`insert into public.import_staging_rows(batch_id,row_number,raw,mapped,status) values ($1,1,'{}'::jsonb,$2::jsonb,'valid')`, [b2, mapped(9, "invoice", "INV1", "100.00", "0.00")]));
err = await as(acct, () => fails(() => db.query(`select public.commit_import_batch($1)`, [b2])));
ok("unique index blocks re-importing a document already in the period", err && /duplicate key/i.test(err), err);

// --- period locking ---
err = await as(acct, () => fails(() => db.query(`update public.reconciliation_periods set status='locked' where id=$1`, [per])));
ok("accountant cannot lock a period", err && /administrator/i.test(err), err);
await as(admin, () => db.query(`update public.reconciliation_periods set status='locked' where id=$1`, [per]));
err = await as(acct, () => fails(() => db.query(`update public.reconciliation_periods set notes='x' where id=$1`, [per])));
ok("locked period cannot be edited by accountant", err && /locked/i.test(err), err);
await as(admin, () => db.query(`update public.reconciliation_periods set status='under_review' where id=$1`, [per]));
err = await as(acct, () => fails(() => db.query(`select public.commit_import_batch($1)`, [b2])));
ok("period under review blocks imports", err && /not open/i.test(err), err);
await as(acct, () => db.query(`update public.reconciliation_periods set status='in_progress' where id=$1`, [per]));

// --- revert ---
err = await as(acct, () => fails(() => db.query(`select public.revert_import_batch($1,'oops')`, [batch])));
ok("accountant cannot revert", err && /administrator/i.test(err), err);
err = await as(admin, () => fails(() => db.query(`select public.revert_import_batch($1,'')`, [batch])));
ok("revert needs a reason", err && /reason/i.test(err), err);
await as(admin, () => db.query(`select public.revert_import_batch($1,'wrong file')`, [batch]));
const after = (await db.query(`select (select count(*)::int from public.soa_entries where deleted_at is null) live, (select count(*)::int from public.soa_entries) total, (select status from public.import_batches where id=$1) st`, [batch])).rows[0];
ok("revert soft-deletes entries, keeps history", after.live === 0 && after.total === 3 && after.st === "reverted", JSON.stringify(after));
const retry = await as(acct, () => fails(() => db.query(`insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash) values ($1,$2,'soa','a.pdf','pdf','p/a3.pdf','HASH1')`, [sup, per])));
ok("reverted file can be uploaded again", retry === null, retry);

// --- settings / audit ---
const setRows = await as(acct, async () => (await db.query(`update public.app_settings set vat_rate=0.2 returning id`)).rows.length);
ok("accountant cannot change settings", setRows === 0, setRows);
const aud = (await db.query(`select count(*)::int n from public.audit_log where table_name in ('suppliers','soa_entries','import_batches')`)).rows[0].n;
ok("audit log recorded changes", aud > 5, aud);
const auditRead = await as(acct, async () => (await db.query(`select count(*)::int n from public.audit_log`)).rows[0].n);
ok("non-admin cannot read audit log", auditRead === 0, auditRead);

// --- period summary + mapping templates ---
const sumRows = await as(acct, async () => (await db.query(`select * from public.soa_period_summary($1)`, [per])).rows);
ok("period summary function works under RLS", Array.isArray(sumRows));
const tpl = await as(acct, () => fails(() => db.query(`insert into public.import_mapping_templates(supplier_id,import_type,mapping) values ($1,'soa','{}'::jsonb)`, [sup])));
ok("accountant can save a mapping template", tpl === null, tpl);
const tpl2 = await as(view, () => fails(() => db.query(`insert into public.import_mapping_templates(supplier_id,import_type,mapping) values ($1,'dn','{}'::jsonb)`, [sup])));
ok("viewer cannot save a mapping template", tpl2 && /row-level security/i.test(tpl2), tpl2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

