import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPdfLines } from "@/lib/import/pdf";
import { buildStagingRows } from "@/lib/import/staging";
import { compareSoaControl, parseSoaLines } from "@/lib/import/soa-text";
import { asUser, makeDb } from "./helpers";

// Fictional statement (same layout as a real supplier PDF).
const FIXTURE = [
  "A.USER Example Building Materials Co.(EXMPL) 08/10/2026 10:02:16",
  "Date From: 01/01/2026 Date To: 30/09/2026",
  "05/01/2026 70001 0 Hand Held Cash Order 9001RVSF0000011 5,000.00 BK1234 / O2N",
  "06/01/2026 70001 1000001RI Invoice 3000001 11,500.00",
  "07/01/2026 70001 1000002RI Invoice 3000002 2,300.50",
  "09/01/2026 70001 90001RM Credit Memo 3000002 1,150.25-",
  "10/01/2026 70001 90002RM Credit Memo .02-",
  "12,650.23 5,000.00",
  "GRANDPARENT: 70001 EXAMPLE JV 4 1 7,650.23 7,650.23",
];

/** Run lines through parse -> stage -> database commit, and compare with the statement's own closing balance. */
async function runPipeline(lines: string[]) {
  const parsed = parseSoaLines(lines);
  const db = await makeDb();
  const admin = (await db.query<{ id: string }>(`insert into auth.users(email) values ('a@x.test') returning id`)).rows[0].id;

  return asUser(db, admin, async () => {
    const sup = (await db.query<{ id: string }>(`insert into public.suppliers(code,name,account_ref) values ('EXMPL','Example Building Materials','70001') returning id`)).rows[0].id;
    const per = (
      await db.query<{ id: string }>(
        `insert into public.reconciliation_periods(supplier_id,period_start,period_end,status) values ($1,'2026-01-01','2026-09-30','in_progress') returning id`,
        [sup],
      )
    ).rows[0].id;
    const batch = (
      await db.query<{ id: string }>(
        `insert into public.import_batches(supplier_id,period_id,import_type,file_name,file_kind,storage_path,file_hash,status) values ($1,$2,'soa','x.pdf','pdf','p','h','staged') returning id`,
        [sup, per],
      )
    ).rows[0].id;

    const { records, counts } = buildStagingRows(parsed.rows, {
      rules: {},
      supplier: { account_ref: "70001", currency: "SAR" },
      period: { start: "2026-01-01", end: "2026-09-30" },
      existing: new Map(),
    });
    for (const r of records) {
      await db.query(
        `insert into public.import_staging_rows(batch_id,row_number,raw,mapped,status,issues,duplicate_of) values ($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7)`,
        [batch, r.row_number, JSON.stringify(r.raw), JSON.stringify(r.mapped), r.status, JSON.stringify(r.issues), r.duplicate_of],
      );
    }
    const result = (await db.query<{ r: { imported: number; skipped_duplicates: number } }>(`select public.commit_import_batch($1) r`, [batch])).rows[0].r;
    const totals = (await db.query<{ bal: string; n: number }>(`select (sum(debit)-sum(credit))::text bal, count(*)::int n from public.soa_entries where deleted_at is null`)).rows[0];
    return { parsed, counts, result, totals };
  });
}

describe("statement lines -> staging -> database commit", () => {
  it("stores every row in the shape the commit function expects and reproduces the printed closing balance", async () => {
    const { parsed, counts, result, totals } = await runPipeline(FIXTURE);
    expect(counts).toEqual({ valid: 5, errors: 0, duplicates: 0 });
    expect(result.imported).toBe(5);
    expect(Number(totals.bal)).toBe(Number(parsed.control.closingBalance));
    expect(compareSoaControl(parsed.control, parsed.rows).every((c) => c.ok)).toBe(true);
  }, 60000);

  // Optional: point REAL_SOA_PDF at a real statement to prove the whole chain on it. Not part of the normal run.
  const real = process.env.REAL_SOA_PDF;
  (real ? it : it.skip)("real statement PDF reproduces the printed closing balance in the database", async () => {
    const lines = await extractPdfLines(new Uint8Array(readFileSync(real!)));
    const { parsed, counts, result, totals } = await runPipeline(lines);
    console.log("REAL", JSON.stringify({ counts, result, db: totals, printed: parsed.control.closingBalance }));
    expect(counts.errors).toBe(0);
    expect(counts.duplicates).toBe(0);
    expect(Number(totals.bal)).toBe(Number(parsed.control.closingBalance));
    expect(compareSoaControl(parsed.control, parsed.rows).every((c) => c.ok)).toBe(true);
  }, 120000);
});
