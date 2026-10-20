import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./helpers";
import { reconcile, type EngineInput } from "@/lib/reconcile/engine";

let db: PGlite;
const one = async (sql: string, p: unknown[] = []) => (await db.query<any>(sql, p)).rows[0];
let acct: string, sup: string, per: string, batch: string;

const settings = { vatRate: "0.15", amountToleranceAbs: "0.05", amountTolerancePct: "0", qtyTolerance: "0", dateWindowDays: 7, rules: {} };

async function input(): Promise<EngineInput> {
  const q = async (sql: string) => (await db.query<any>(sql)).rows;
  const s = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v));
  return {
    period: { start: "2026-01-01", end: "2026-09-30", reportedOpening: "0", reportedClosing: "13000.00" },
    settings,
    soa: (await q(`select * from public.soa_entries where deleted_at is null`)).map((e) => ({ id: e.id, type: e.entry_type, docNumber: e.doc_number, docDate: s(e.doc_date).slice(0, 10), debit: s(e.debit), credit: s(e.credit), deliveryRef: e.delivery_ref, poRef: e.po_ref })),
    invoices: (await q(`select * from public.invoices where deleted_at is null`)).map((i) => ({ id: i.id, docType: i.doc_type, number: i.invoice_number, date: s(i.invoice_date).slice(0, 10), net: s(i.net_amount), vat: s(i.vat_amount), gross: s(i.gross_amount), vatCalculated: i.vat_calculated, printedGross: null, poRefs: i.po_refs, dnRefs: i.dn_refs, lines: [] })),
    payments: [], pos: [], dns: [], paymentAllocations: [], creditAllocations: [], existingMatches: [], existingLinks: [],
  };
}

beforeAll(async () => {
  db = await makeDb();
  await db.query(`insert into auth.users(email) values ('a@x.test')`);
  acct = (await one(`insert into auth.users(email) values ('b@x.test') returning id`)).id;
  await db.query(`update public.profiles set role='accountant' where id=$1`, [acct]);
  sup = (await one(`insert into public.suppliers(code,name) values ('S','Sup') returning id`)).id;
  per = (await one(`insert into public.reconciliation_periods(supplier_id,period_start,period_end) values ($1,'2026-01-01','2026-09-30') returning id`, [sup])).id;
  batch = (await one(`insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash,status) values ($1,$2,'soa','s','pdf','p','h','committed') returning id`, [sup, per])).id;
  const ib = (await one(`insert into public.import_batches(supplier_id,import_type,file_name,file_kind,storage_path,file_hash,status) values ($1,'invoice','i','pdf','p2','h2','committed') returning id`, [sup])).id;
  const inv = (no: string, gross: number) => db.query(`insert into public.invoices(supplier_id,batch_id,invoice_number,invoice_number_norm,invoice_date,net_amount,vat_amount,gross_amount,source_row,raw) values ($1,$2,$3,$4,'2026-05-04',$5,$6,$7,1,'{}'::jsonb)`, [sup, ib, no, no, (gross / 1.15).toFixed(2), (gross - gross / 1.15).toFixed(2), gross]);
  await inv("I1", 1150); await inv("I2", 2300); await inv("I9", 575);
  const soa = (no: string, amt: number, n: number) => db.query(`insert into public.soa_entries(period_id,supplier_id,batch_id,entry_type,doc_number,doc_number_norm,doc_date,debit,credit,source_row,raw,row_fingerprint) values ($1,$2,$3,'invoice',$4,$4,'2026-05-04',$5,0,$6,'{}'::jsonb,$4)`, [per, sup, batch, no, amt, n]);
  await soa("I1", 1150, 1); await soa("I2", 2400, 2); await soa("I3", 500, 3);
});

describe("engine output is accepted by save_reconciliation_run", () => {
  const save = async (r: ReturnType<typeof reconcile>) =>
    (await asUser(db, acct, () => one(`select public.save_reconciliation_run($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb) r`, [per, JSON.stringify(settings), JSON.stringify({ ...r.summary, waterfall: r.waterfall }), JSON.stringify(r.matches), JSON.stringify(r.links), JSON.stringify(r.findings)]))).r;

  it("stores matches, findings and a summary with the waterfall", async () => {
    const r = reconcile(await input());
    expect(r.matches.map((m) => m.origin)).toEqual(["exact", "exact"]);
    const saved = await save(r);
    expect(saved.matches_added).toBe(2);
    expect(saved.discrepancies_new).toBe(r.findings.length);
    const types = (await db.query<any>(`select type from public.discrepancies order by type`)).rows.map((x) => x.type);
    expect(types).toContain("soa_amount_mismatch");
    expect(types).toContain("soa_without_invoice");
    expect(types).toContain("invoice_missing_from_soa");
    const run = await one(`select summary from public.reconciliation_runs`);
    expect(run.summary.waterfall.internalClosing).toBe("4025.00");
  });

  it("a second identical run does not duplicate anything", async () => {
    const before = (await one(`select count(*)::int n from public.discrepancies`)).n;
    const r = reconcile({ ...(await input()), existingMatches: (await db.query<any>(`select soa_entry_id, invoice_id, payment_id, state from public.matches`)).rows.map((m) => ({ soaEntryId: m.soa_entry_id, invoiceId: m.invoice_id, paymentId: m.payment_id, state: m.state })) });
    expect(r.matches).toHaveLength(0);
    const saved = await save(r);
    expect(saved.discrepancies_new).toBe(0);
    expect((await one(`select count(*)::int n from public.discrepancies`)).n).toBe(before);
    expect((await one(`select count(*)::int n from public.matches`)).n).toBe(2);
  });

  it("an auto-resolved item reopens when a later run finds it again", async () => {
    // Make the missing invoice appear on the statement, so that finding disappears and is auto-resolved.
    await db.query(`insert into public.soa_entries(period_id,supplier_id,batch_id,entry_type,doc_number,doc_number_norm,doc_date,debit,credit,source_row,raw,row_fingerprint) values ($1,$2,$3,'invoice','I9','I9','2026-05-04',575,0,9,'{}'::jsonb,'I9')`, [per, sup, batch]);
    const existing = async () => (await db.query<any>(`select soa_entry_id, invoice_id, payment_id, state from public.matches`)).rows.map((m) => ({ soaEntryId: m.soa_entry_id, invoiceId: m.invoice_id, paymentId: m.payment_id, state: m.state }));
    await save(reconcile({ ...(await input()), existingMatches: await existing() }));
    const gone = await one(`select status from public.discrepancies where type='invoice_missing_from_soa'`);
    expect(gone.status).toBe("resolved");
    // Take it off the statement again.
    await db.query(`update public.soa_entries set deleted_at = now() where doc_number='I9'`);
    await db.query(`update public.matches set state='superseded' where invoice_id is not null and soa_entry_id in (select id from public.soa_entries where doc_number='I9')`);
    await save(reconcile({ ...(await input()), existingMatches: await existing() }));
    const back = await one(`select status from public.discrepancies where type='invoice_missing_from_soa'`);
    expect(back.status).toBe("open");
  });
});
