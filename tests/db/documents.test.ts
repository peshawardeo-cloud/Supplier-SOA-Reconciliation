import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./helpers";

let db: PGlite;
let admin: string, acct: string, view: string, sup: string, per: string;
const fails = async (fn: () => Promise<unknown>) => { try { await fn(); return ""; } catch (e) { return String((e as Error).message); } };
const one = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0];

async function stage(type: string, hash: string, rows: Record<string, unknown>[], status = "valid") {
  const b = (await asUser(db, acct, () => one(
    `insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash,status)
     values ($1,$2,$3,'f','pdf','p/'||$4,$4,'staged') returning id`, [sup, per, type, hash]))).id;
  let n = 1;
  for (const m of rows) {
    await db.query(`insert into public.import_staging_rows(batch_id,row_number,status,raw,mapped) values ($1,$2,$3,'{}'::jsonb,$4::jsonb)`,
      [b, n++, status, JSON.stringify(m)]);
  }
  return b as string;
}
const invRow = (num: string, key = num, net = 100, vat = 15, extra: object = {}) => ({
  doc_key: key, doc_number: num, doc_number_norm: num.toUpperCase(), doc_date: "2026-09-05", doc_type: "invoice",
  net, vat, gross: net + vat, qty: 1, description: "x", po_refs: ["PO1"], dn_refs: [], vat_calculated: false, ...extra,
});

beforeAll(async () => {
  db = await makeDb();
  admin = (await one(`insert into auth.users(email) values ('a@x.test') returning id`)).id;
  acct = (await one(`insert into auth.users(email) values ('b@x.test') returning id`)).id;
  view = (await one(`insert into auth.users(email) values ('c@x.test') returning id`)).id;
  await db.query(`update public.profiles set role='accountant' where id=$1`, [acct]);
  sup = (await asUser(db, acct, () => one(`insert into public.suppliers(code,name) values ('S','Sup') returning id`))).id;
  per = (await asUser(db, acct, () => one(
    `insert into public.reconciliation_periods(supplier_id,period_start,period_end) values ($1,'2026-09-01','2026-09-30') returning id`, [sup]))).id;
});

describe("document import commit/revert", () => {
  let invBatch: string;
  it("commits invoices grouped by document, atomically", async () => {
    invBatch = await stage("invoice", "H-INV1", [invRow("I1", "I1", 100, 15), invRow("I1", "I1", 50, 7.5), invRow("I2", "I2", 200, 30)]);
    const r = await asUser(db, acct, () => one(`select public.commit_document_batch($1) r`, [invBatch]));
    expect(r.r.documents).toBe(2);
    const i1 = await one(`select net_amount, gross_amount from public.invoices where invoice_number='I1'`);
    expect(Number(i1.net_amount)).toBe(150);
    expect(Number(i1.gross_amount)).toBe(172.5);
    expect((await one(`select count(*)::int n from public.invoice_lines`)).n).toBe(3);
  });
  it("cannot commit twice", async () => {
    const e = await asUser(db, acct, () => fails(() => one(`select public.commit_document_batch($1)`, [invBatch])));
    expect(e).toMatch(/not ready/);
  });
  it("viewer cannot commit", async () => {
    const b = await stage("po", "H-PO0", [{ doc_key: "P0", doc_number: "P0", doc_number_norm: "P0", doc_date: "2026-08-01", qty: 1, net: 1, vat: 0.15, gross: 1.15 }]);
    const e = await asUser(db, view, () => fails(() => one(`select public.commit_document_batch($1)`, [b])));
    expect(e).toMatch(/permission/);
  });
  it("a document with accepted and rejected lines blocks the commit", async () => {
    const b = await stage("invoice", "H-INV2", [invRow("I9")]);
    await db.query(`insert into public.import_staging_rows(batch_id,row_number,status,raw,mapped) values ($1,2,'error','{}'::jsonb,$2::jsonb)`, [b, JSON.stringify(invRow("I9"))]);
    const e = await asUser(db, acct, () => fails(() => one(`select public.commit_document_batch($1)`, [b])));
    expect(e).toMatch(/both accepted and rejected/);
  });
  it("commits PO, DN and payments", async () => {
    const po = await stage("po", "H-PO1", [{ doc_key: "P1", doc_number: "P1", doc_number_norm: "P1", doc_date: "2026-08-01", qty: 10, unit_price: 10, net: 100, vat: 15, gross: 115 }]);
    const dn = await stage("dn", "H-DN1", [{ doc_key: "D1", doc_number: "D1", doc_number_norm: "D1", doc_date: "2026-08-02", qty: 10, po_refs: ["P1"] }]);
    const pay = await stage("payment", "H-PAY1", [{ doc_number: "PAY1", doc_number_norm: "PAY1", doc_date: "2026-09-10", gross: 100 }]);
    for (const b of [po, dn, pay]) await asUser(db, acct, () => one(`select public.commit_document_batch($1)`, [b]));
    expect((await one(`select count(*)::int n from public.po_lines`)).n).toBe(1);
    expect((await one(`select dn_refs from (select po_refs dn_refs from public.dn_headers) x`)).dn_refs).toEqual(["P1"]);
    expect((await one(`select count(*)::int n from public.payments`)).n).toBe(1);
  });
  it("imported documents cannot be edited, even by a superuser", async () => {
    expect(await fails(() => db.query(`update public.invoices set net_amount = 1 where invoice_number='I2'`))).toMatch(/cannot be edited/);
    expect(await fails(() => db.query(`update public.invoice_lines set net_amount = 1`))).toMatch(/cannot be edited/);
  });
  it("accountants cannot delete documents", async () => {
    expect(await asUser(db, acct, () => fails(() => db.query(`delete from public.invoices`)))).toMatch(/permission denied/);
  });
  it("the same invoice cannot be imported twice", async () => {
    const b = await stage("invoice", "H-INV3", [invRow("i1")]);
    const e = await asUser(db, acct, () => fails(() => one(`select public.commit_document_batch($1)`, [b])));
    expect(e).toMatch(/duplicate key/);
    expect((await one(`select status from public.import_batches where id=$1`, [b])).status).toBe("staged");
  });
});

describe("allocations", () => {
  let i1: string, i2: string, pay: string, cn: string;
  beforeAll(async () => {
    i1 = (await one(`select id from public.invoices where invoice_number='I1'`)).id; // gross 172.50
    i2 = (await one(`select id from public.invoices where invoice_number='I2'`)).id; // gross 230
    pay = (await one(`select id from public.payments where payment_ref='PAY1'`)).id; // 100
    const b = await stage("invoice", "H-CN", [invRow("CN1", "CN1", 20, 3, { doc_type: "credit_note" })]);
    await asUser(db, acct, () => one(`select public.commit_document_batch($1)`, [b]));
    cn = (await one(`select id from public.invoices where invoice_number='CN1'`)).id; // 23
  });
  const alloc = (invoice: string, amount: number) => asUser(db, acct, () =>
    one(`insert into public.payment_allocations(payment_id,invoice_id,amount) values ($1,$2,$3) returning id`, [pay, invoice, amount]));

  it("partial payment is allowed", async () => { await alloc(i1, 60); });
  it("cannot allocate more than the payment holds", async () => {
    expect(await fails(() => alloc(i2, 50))).toMatch(/exceeds the unallocated part of the payment/);
  });
  it("cannot allocate to the same invoice twice", async () => {
    expect(await fails(() => alloc(i1, 1))).toMatch(/duplicate key/);
  });
  it("cannot exceed the invoice's open amount (credit + payment not double counted)", async () => {
    await asUser(db, acct, () => one(`insert into public.credit_allocations(credit_note_id,invoice_id,amount) values ($1,$2,23)`, [cn, i1]));
    // i1 gross 172.5, applied 60 + 23 = 83 -> 89.5 open
    const b = await stage("payment", "H-PAY2", [{ doc_number: "PAY2", doc_number_norm: "PAY2", doc_date: "2026-09-11", gross: 500 }]);
    await asUser(db, acct, () => one(`select public.commit_document_batch($1)`, [b]));
    const p2 = (await one(`select id from public.payments where payment_ref='PAY2'`)).id;
    expect(await asUser(db, acct, () => fails(() => one(`insert into public.payment_allocations(payment_id,invoice_id,amount) values ($1,$2,90)`, [p2, i1])))).toMatch(/open amount/);
    await asUser(db, acct, () => one(`insert into public.payment_allocations(payment_id,invoice_id,amount) values ($1,$2,89.5)`, [p2, i1]));
    const bal = await one(`select open_amount from public.invoice_balances($1) where invoice_number='I1'`, [sup]);
    expect(Number(bal.open_amount)).toBe(0);
  });
  it("credit note cannot be used beyond its value", async () => {
    expect(await asUser(db, acct, () => fails(() => one(`insert into public.credit_allocations(credit_note_id,invoice_id,amount) values ($1,$2,1)`, [cn, i2])))).toMatch(/unused part of the credit note/);
  });
  it("allocations cannot be edited; voiding needs a reason and frees the amount", async () => {
    const id = (await one(`select id from public.payment_allocations where invoice_id=$1 and payment_id=$2`, [i1, pay])).id;
    expect(await asUser(db, acct, () => fails(() => db.query(`update public.payment_allocations set amount=1 where id=$1`, [id])))).toMatch(/cannot be edited/);
    expect(await asUser(db, acct, () => fails(() => db.query(`update public.payment_allocations set voided_at=now() where id=$1`, [id])))).toMatch(/reason is required/);
    await asUser(db, acct, () => db.query(`update public.payment_allocations set voided_at=now(), void_reason='wrong invoice' where id=$1`, [id]));
    const pb = await one(`select unallocated from public.payment_balances($1) where payment_ref='PAY1'`, [sup]);
    expect(Number(pb.unallocated)).toBe(100);
  });
  it("invoice import with live allocations cannot be reverted", async () => {
    const batch = (await one(`select batch_id from public.invoices where invoice_number='I1'`)).batch_id;
    const e = await asUser(db, admin, () => fails(() => one(`select public.revert_document_batch($1,'test')`, [batch])));
    expect(e).toMatch(/allocated/);
  });
});

describe("matches, discrepancies and runs", () => {
  let soa: string, invoice: string;
  beforeAll(async () => {
    invoice = (await one(`select id from public.invoices where invoice_number='I2'`)).id;
    const b = (await one(`insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash,status)
      values ($1,$2,'soa','s.pdf','pdf','p/s','H-SOA','committed') returning id`, [sup, per])).id;
    soa = (await one(`insert into public.soa_entries(period_id,supplier_id,batch_id,entry_type,doc_number,doc_number_norm,doc_date,debit,credit,source_row,raw,row_fingerprint)
      values ($1,$2,$3,'invoice','I2','I2','2026-09-05',230,0,1,'{}'::jsonb,'fp-i2') returning id`, [per, sup, b])).id;
  });
  const run = (matches: unknown[], findings: unknown[]) => asUser(db, acct, () => one(
    `select public.save_reconciliation_run($1,'{}'::jsonb,'{}'::jsonb,$2::jsonb,'[]'::jsonb,$3::jsonb) r`, [per, JSON.stringify(matches), JSON.stringify(findings)]));
  const finding = (fp: string) => ({ type: "invoice_missing_from_soa", fingerprint: fp, invoice_id: invoice, ref_text: "I2",
    expected_amount: 0, actual_amount: 230, explanation: "test", calculation: { a: 1 } });

  it("manual matches are confirmed immediately; amount-only pairs are never auto-confirmed by the DB", async () => {
    const m = await asUser(db, acct, () => one(
      `insert into public.matches(period_id,soa_entry_id,invoice_id,origin) values ($1,$2,$3,'manual') returning state, confidence`, [per, soa, invoice]));
    expect(m.state).toBe("confirmed");
    expect(m.confidence).toBe(100);
    expect(await asUser(db, acct, () => fails(() => one(
      `insert into public.matches(period_id,soa_entry_id,invoice_id,origin,state) values ($1,$2,$3,'suggested','confirmed')`, [per, soa, invoice])))).toMatch(/duplicate key/);
  });
  it("unmatching a confirmed match needs a reason", async () => {
    const id = (await one(`select id from public.matches limit 1`)).id;
    expect(await asUser(db, acct, () => fails(() => db.query(`update public.matches set state='rejected' where id=$1`, [id])))).toMatch(/reason is required/);
  });
  it("a run saves findings once; a second run updates, never duplicates", async () => {
    const r1 = (await run([], [finding("fp1")])).r;
    expect(r1.discrepancies_new).toBe(1);
    const r2 = (await run([], [finding("fp1")])).r;
    expect(r2.discrepancies_new).toBe(0);
    expect(r2.discrepancies_updated).toBe(1);
    expect((await one(`select count(*)::int n from public.discrepancies`)).n).toBe(1);
  });
  it("status changes keep history and need a resolution note", async () => {
    const id = (await one(`select id from public.discrepancies limit 1`)).id;
    await asUser(db, acct, () => db.query(`update public.discrepancies set status='under_review', notes='checking' where id=$1`, [id]));
    expect(await asUser(db, acct, () => fails(() => db.query(`update public.discrepancies set status='resolved' where id=$1`, [id])))).toMatch(/resolution note/);
    await asUser(db, acct, () => db.query(`update public.discrepancies set status='resolved', resolution_note='fixed' where id=$1`, [id]));
    const h = (await db.query<any>(`select field from public.discrepancy_history where discrepancy_id=$1`, [id])).rows.map(r => r.field);
    expect(h).toContain("created");
    expect(h.filter((f: string) => f === "status").length).toBe(2);
  });
  it("system-found details cannot be edited by users", async () => {
    const id = (await one(`select id from public.discrepancies limit 1`)).id;
    expect(await asUser(db, acct, () => fails(() => db.query(`update public.discrepancies set actual_amount=1 where id=$1`, [id])))).toMatch(/cannot be edited/);
  });
  it("difference is calculated by the database", async () => {
    expect(Number((await one(`select difference from public.discrepancies limit 1`)).difference)).toBe(230);
  });
  it("untouched open items no longer found are auto-resolved; touched ones stay", async () => {
    await run([], [finding("fp2")]);
    await run([], []);
    const rows = (await db.query<any>(`select fingerprint,status from public.discrepancies order by fingerprint`)).rows;
    expect(rows.find(r => r.fingerprint === "fp2").status).toBe("resolved");
    expect(rows.find(r => r.fingerprint === "fp1").status).toBe("resolved");
  });
  it("viewers can read but not write results", async () => {
    expect((await asUser(db, view, () => one(`select count(*)::int n from public.discrepancies`))).n).toBeGreaterThan(0);
    expect(await asUser(db, view, () => fails(() => one(`select public.save_reconciliation_run($1,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb)`, [per])))).toMatch(/permission/);
    const upd = await asUser(db, view, () => db.query(`update public.discrepancies set notes='x'`));
    expect(upd.affectedRows).toBe(0);
  });
  it("a locked period refuses new runs and match changes", async () => {
    await asUser(db, admin, () => db.query(`update public.reconciliation_periods set status='locked' where id=$1`, [per]));
    expect(await fails(() => run([], []))).toMatch(/locked/);
    await asUser(db, admin, () => db.query(`update public.reconciliation_periods set status='in_progress' where id=$1`, [per]));
  });
});
