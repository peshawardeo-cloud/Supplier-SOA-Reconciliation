import Decimal from "decimal.js";
import { d, round2, toleranceFor, vatFor, withinTolerance } from "@/lib/money";
import { normalizeDocNumber, type DocNumberRules } from "./normalize";

/* =====================================================================
   Reconciliation engine: pure functions, no database access.
   Rules:
   - Document numbers decide a match. Dates, amounts and quantities are only supporting evidence.
   - exact     = normalised numbers are equal (auto-confirmed)
   - suggested = numbers are similar AND at least two supporting facts agree (waits for a person)
   - manual    = made by a person (never produced here)
   - An amount on its own never creates a match or a suggestion.
   ===================================================================== */

export type EngineSettings = {
  vatRate: string;
  amountToleranceAbs: string;
  amountTolerancePct: string;
  qtyTolerance: string;
  dateWindowDays: number;
  rules: DocNumberRules;
};

export type SoaEntryIn = {
  id: string;
  type: "invoice" | "credit_note" | "debit_note" | "payment" | "opening_balance" | "adjustment" | "other";
  docNumber: string;
  docDate: string;
  debit: string;
  credit: string;
  deliveryRef?: string | null;
  poRef?: string | null;
};

export type LineIn = { itemCode?: string | null; qty?: string | null; net?: string | null; unitPrice?: string | null };

export type InvoiceIn = {
  id: string;
  docType: "invoice" | "credit_note";
  number: string;
  date: string;
  net: string;
  vat: string;
  gross: string;
  vatCalculated: boolean;
  printedGross?: string | null;
  poRefs: string[];
  dnRefs: string[];
  lines: LineIn[];
};

export type PaymentIn = { id: string; ref: string; date: string; amount: string; bankRef?: string | null };
export type PoIn = { id: string; number: string; date: string; net?: string | null; lines: LineIn[] };
export type DnIn = { id: string; number: string; date: string; poRefs: string[]; lines: LineIn[] };

export type ExistingMatch = {
  soaEntryId: string;
  invoiceId: string | null;
  paymentId: string | null;
  state: "pending" | "confirmed" | "rejected" | "superseded";
};
export type ExistingLink = {
  invoiceId: string;
  poId: string | null;
  dnId: string | null;
  state: "pending" | "confirmed" | "rejected" | "superseded";
};

export type EngineInput = {
  period: { start: string; end: string; reportedOpening: string | null; reportedClosing: string | null };
  settings: EngineSettings;
  soa: SoaEntryIn[];
  invoices: InvoiceIn[];
  payments: PaymentIn[];
  pos: PoIn[];
  dns: DnIn[];
  paymentAllocations: { paymentId: string; invoiceId: string; amount: string }[];
  creditAllocations: { creditNoteId: string; invoiceId: string; amount: string }[];
  existingMatches: ExistingMatch[];
  existingLinks: ExistingLink[];
};

export type Evidence = { kind: string; detail: string; supports: boolean };

export type MatchOut = {
  soa_entry_id: string;
  invoice_id: string | null;
  payment_id: string | null;
  origin: "exact" | "suggested";
  state: "confirmed" | "pending";
  confidence: number;
  evidence: Evidence[];
};

export type LinkOut = {
  invoice_id: string;
  po_id: string | null;
  dn_id: string | null;
  origin: "exact" | "suggested";
  state: "confirmed" | "pending";
  confidence: number;
  evidence: Evidence[];
};

export type FindingType =
  | "invoice_missing_from_soa"
  | "soa_without_invoice"
  | "soa_amount_mismatch"
  | "soa_payment_without_internal"
  | "payment_not_in_soa"
  | "payment_amount_mismatch"
  | "invoice_no_po"
  | "invoice_no_dn"
  | "po_invoice_amount"
  | "po_invoice_qty"
  | "invoice_qty_vs_delivery"
  | "duplicate_invoice"
  | "vat_mismatch"
  | "balance_difference"
  | "manual_review"
  | "dn_without_invoice"
  | "payment_unallocated"
  | "credit_note_unapplied";

export const FINDING_LABEL: Record<FindingType, string> = {
  invoice_missing_from_soa: "Invoice missing from the statement",
  soa_without_invoice: "Statement entry with no internal invoice",
  soa_amount_mismatch: "Statement and invoice amounts differ",
  soa_payment_without_internal: "Statement payment not in our payments",
  payment_not_in_soa: "Our payment not on the statement",
  payment_amount_mismatch: "Payment amounts differ",
  invoice_no_po: "Invoice without a purchase order",
  invoice_no_dn: "Invoice without a delivery note",
  po_invoice_amount: "Purchase order and invoice amounts differ",
  po_invoice_qty: "Invoiced quantity exceeds the purchase order",
  invoice_qty_vs_delivery: "Invoiced quantity exceeds what was delivered",
  duplicate_invoice: "Potential duplicate invoice",
  vat_mismatch: "VAT does not match the rate",
  balance_difference: "Supplier balance differs from ours",
  manual_review: "Needs manual review",
  dn_without_invoice: "Delivery note without an invoice",
  payment_unallocated: "Payment not fully applied to invoices",
  credit_note_unapplied: "Credit note not fully applied",
};

export type Finding = {
  type: FindingType;
  fingerprint: string;
  soa_entry_id: string | null;
  invoice_id: string | null;
  payment_id: string | null;
  po_id: string | null;
  dn_id: string | null;
  ref_text: string;
  expected_amount: string | null;
  actual_amount: string | null;
  explanation: string;
  calculation: { steps: { label: string; value: string }[]; result?: string } | null;
};

export type Waterfall = {
  reportedOpening: string;
  reportedClosing: string | null;
  internalClosing: string;
  difference: string | null;
  buckets: { key: string; label: string; amount: string; count: number }[];
  unexplained: string | null;
  notes: string[];
};

export type EngineResult = {
  matches: MatchOut[];
  links: LinkOut[];
  findings: Finding[];
  waterfall: Waterfall;
  summary: Record<string, number | string | null>;
};

/* ---------------- helpers ---------------- */

const soaSigned = (e: SoaEntryIn): Decimal => d(e.debit).minus(d(e.credit)); // + increases what we owe
/** Positive amount of the statement line in its own direction. */
const soaAmount = (e: SoaEntryIn): Decimal =>
  e.type === "credit_note" || e.type === "payment" ? d(e.credit).minus(d(e.debit)) : d(e.debit).minus(d(e.credit));

const daysBetween = (a: string, b: string): number =>
  Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000));

/** Optimal-string-alignment distance (counts a swap of two neighbours as one change). */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[m][n];
}

/** Why two different normalised numbers might be the same document, or null if they are not similar. */
export function numberSimilarity(a: string, b: string): string | null {
  if (!a || !b) return null;
  if (a === b) return "numbers are equal";
  const digits = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
  const da = digits(a), db = digits(b);
  if (da.length >= 4 && da === db) return "same digits, different prefix or zero padding";
  if (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1) return "numbers differ by one character";
  return null;
}

/** A longer reference that ends with a shorter one, e.g. CRSAJCDCPRO200196 and 200196. */
export function suffixRelated(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.endsWith(short);
}

const money = (v: Decimal.Value): string => round2(v).toFixed(2);
const qtyStr = (v: Decimal.Value): string => d(v).toDecimalPlaces(3).toString();

function step(label: string, value: Decimal.Value | string) {
  return { label, value: typeof value === "string" ? value : money(value) };
}

/* ---------------- the engine ---------------- */

export function reconcile(input: EngineInput): EngineResult {
  const { settings: S, period } = input;
  const norm = (s: string) => normalizeDocNumber(s, S.rules);
  const tolFor = (gross: Decimal.Value) => toleranceFor(gross, S.amountToleranceAbs, S.amountTolerancePct);

  const soa = input.soa.filter((e) => e.type !== "opening_balance");
  const soaNorm = new Map(soa.map((e) => [e.id, norm(e.docNumber)]));
  const invNorm = new Map(input.invoices.map((i) => [i.id, norm(i.number)]));
  const payNorm = new Map(input.payments.map((p) => [p.id, norm(p.ref)]));
  const payBankNorm = new Map(input.payments.map((p) => [p.id, p.bankRef ? norm(p.bankRef) : ""]));

  const invById = new Map(input.invoices.map((i) => [i.id, i]));
  const payById = new Map(input.payments.map((p) => [p.id, p]));
  const poById = new Map(input.pos.map((p) => [p.id, p]));
  const dnById = new Map(input.dns.map((x) => [x.id, x]));
  const soaById = new Map(soa.map((e) => [e.id, e]));

  const pairKey = (m: { soaEntryId: string; invoiceId: string | null; paymentId: string | null }) =>
    `${m.soaEntryId}|${m.invoiceId ?? m.paymentId}`;
  const rejectedPairs = new Set(input.existingMatches.filter((m) => m.state === "rejected").map(pairKey));
  const linkKey = (l: { invoiceId: string; poId: string | null; dnId: string | null }) => `${l.invoiceId}|${l.poId ?? ""}|${l.dnId ?? ""}`;
  const rejectedLinks = new Set(input.existingLinks.filter((l) => l.state === "rejected").map(linkKey));

  /* ---------- 1. statement lines against invoices and payments ---------- */

  // Confirmed state carried over from earlier runs / manual matches.
  const soaConfirmed = new Map<string, string>(); // soa id -> invoice or payment id
  const targetConfirmed = new Set<string>();
  for (const m of input.existingMatches) {
    if (m.state !== "confirmed") continue;
    const t = m.invoiceId ?? m.paymentId;
    if (!t) continue;
    soaConfirmed.set(m.soaEntryId, t);
    targetConfirmed.add(t);
  }

  const matches: MatchOut[] = [];

  // exact: invoices / credit notes
  const invoiceTypeOf = (e: SoaEntryIn): "invoice" | "credit_note" | null =>
    e.type === "invoice" || e.type === "debit_note" ? "invoice" : e.type === "credit_note" ? "credit_note" : null;

  const invoicesByNorm = new Map<string, InvoiceIn[]>();
  for (const i of input.invoices) {
    const k = `${i.docType}|${invNorm.get(i.id)}`;
    invoicesByNorm.set(k, [...(invoicesByNorm.get(k) ?? []), i]);
  }

  for (const e of soa) {
    if (soaConfirmed.has(e.id)) continue;
    const t = invoiceTypeOf(e);
    if (!t || e.type === "debit_note") continue;
    const cands = (invoicesByNorm.get(`${t}|${soaNorm.get(e.id)}`) ?? []).filter((i) => !targetConfirmed.has(i.id));
    if (cands.length !== 1) continue; // none, or ambiguous (left for a person)
    const inv = cands[0];
    soaConfirmed.set(e.id, inv.id);
    targetConfirmed.add(inv.id);
    matches.push({
      soa_entry_id: e.id, invoice_id: inv.id, payment_id: null, origin: "exact", state: "confirmed", confidence: 100,
      evidence: [{ kind: "document_number", detail: `Statement ${e.docNumber} = invoice ${inv.number} (normalised: ${soaNorm.get(e.id)})`, supports: true }],
    });
  }

  // exact: payments (our payment reference or bank reference equals the statement document number)
  for (const e of soa) {
    if (e.type !== "payment" || soaConfirmed.has(e.id)) continue;
    const n = soaNorm.get(e.id)!;
    const cands = input.payments.filter((p) => !targetConfirmed.has(p.id) && (payNorm.get(p.id) === n || (payBankNorm.get(p.id) && payBankNorm.get(p.id) === n)));
    const unique = cands.length === 1 ? cands : cands.filter((p) => daysBetween(p.date, e.docDate) <= S.dateWindowDays);
    if (unique.length !== 1) continue;
    const p = unique[0];
    soaConfirmed.set(e.id, p.id);
    targetConfirmed.add(p.id);
    matches.push({
      soa_entry_id: e.id, invoice_id: null, payment_id: p.id, origin: "exact", state: "confirmed", confidence: 100,
      evidence: [{ kind: "document_number", detail: `Statement ${e.docNumber} = payment ${p.ref}`, supports: true }],
    });
  }

  // suggested: similar numbers plus at least two supporting facts
  type Cand = { soaId: string; targetId: string; kind: "invoice" | "payment"; confidence: number; evidence: Evidence[] };
  const cands: Cand[] = [];

  for (const e of soa) {
    if (soaConfirmed.has(e.id)) continue;
    const eNorm = soaNorm.get(e.id)!;
    const eAmt = soaAmount(e);
    const t = invoiceTypeOf(e);

    if (t || e.type === "debit_note") {
      for (const inv of input.invoices) {
        if (targetConfirmed.has(inv.id)) continue;
        if (e.type !== "debit_note" && inv.docType !== t) continue;
        if (rejectedPairs.has(`${e.id}|${inv.id}`)) continue;
        const iNorm = invNorm.get(inv.id)!;

        let reason = numberSimilarity(eNorm, iNorm);
        let base = reason ? 50 : 0;
        const delivery = e.deliveryRef ? norm(e.deliveryRef) : "";
        if (!reason && delivery && (delivery === iNorm || inv.dnRefs.some((r) => norm(r) === delivery))) {
          reason = "the statement's delivery reference equals this invoice's number or delivery note";
          base = 45;
        }
        if (!reason) continue;

        const ev: Evidence[] = [{ kind: "document_number", detail: `Statement ${e.docNumber} vs invoice ${inv.number}: ${reason}`, supports: false }];
        let supports = 0;
        let conf = base;
        if (withinTolerance(eAmt, inv.gross, tolFor(inv.gross))) { supports++; conf += 20; ev.push({ kind: "amount", detail: `Amounts agree within tolerance (${money(eAmt)} vs ${money(inv.gross)})`, supports: true }); }
        else ev.push({ kind: "amount", detail: `Amounts differ (${money(eAmt)} vs ${money(inv.gross)})`, supports: false });
        const dd = daysBetween(e.docDate, inv.date);
        if (dd <= S.dateWindowDays) { supports++; conf += 10; ev.push({ kind: "date", detail: `Dates are ${dd} day(s) apart`, supports: true }); }
        else ev.push({ kind: "date", detail: `Dates are ${dd} days apart`, supports: false });
        if (e.poRef && inv.poRefs.some((r) => norm(r) === norm(e.poRef!) || suffixRelated(norm(r), norm(e.poRef!)))) {
          supports++; conf += 15; ev.push({ kind: "po", detail: `Both refer to PO ${e.poRef}`, supports: true });
        }
        if (supports < 2) continue;
        cands.push({ soaId: e.id, targetId: inv.id, kind: "invoice", confidence: Math.min(conf, 95), evidence: ev });
      }
    } else if (e.type === "payment") {
      for (const p of input.payments) {
        if (targetConfirmed.has(p.id) || rejectedPairs.has(`${e.id}|${p.id}`)) continue;
        const reason = numberSimilarity(eNorm, payNorm.get(p.id)!) ?? (payBankNorm.get(p.id) ? numberSimilarity(eNorm, payBankNorm.get(p.id)!) : null);
        if (!reason) continue;
        const ev: Evidence[] = [{ kind: "document_number", detail: `Statement ${e.docNumber} vs payment ${p.ref}: ${reason}`, supports: false }];
        let supports = 0, conf = 50;
        if (withinTolerance(eAmt, p.amount, tolFor(p.amount))) { supports++; conf += 25; ev.push({ kind: "amount", detail: `Amounts agree (${money(eAmt)} vs ${money(p.amount)})`, supports: true }); }
        const dd = daysBetween(e.docDate, p.date);
        if (dd <= S.dateWindowDays) { supports++; conf += 15; ev.push({ kind: "date", detail: `Dates are ${dd} day(s) apart`, supports: true }); }
        if (supports < 2) continue;
        cands.push({ soaId: e.id, targetId: p.id, kind: "payment", confidence: Math.min(conf, 95), evidence: ev });
      }
    }
  }

  // Each statement line and each document gets at most one suggestion, highest confidence first.
  cands.sort((a, b) => b.confidence - a.confidence || (a.soaId + a.targetId).localeCompare(b.soaId + b.targetId));
  const usedSoa = new Set<string>(), usedTarget = new Set<string>();
  for (const c of cands) {
    if (usedSoa.has(c.soaId) || usedTarget.has(c.targetId)) continue;
    usedSoa.add(c.soaId);
    usedTarget.add(c.targetId);
    matches.push({
      soa_entry_id: c.soaId,
      invoice_id: c.kind === "invoice" ? c.targetId : null,
      payment_id: c.kind === "payment" ? c.targetId : null,
      origin: "suggested", state: "pending", confidence: c.confidence, evidence: c.evidence,
    });
  }

  const pendingSoa = new Set(matches.filter((m) => m.state === "pending").map((m) => m.soa_entry_id));
  const pendingTarget = new Set(matches.filter((m) => m.state === "pending").map((m) => (m.invoice_id ?? m.payment_id)!));
  // Existing pending suggestions from earlier runs that the database keeps are still "pending" for reporting.
  for (const m of input.existingMatches) if (m.state === "pending") { pendingSoa.add(m.soaEntryId); pendingTarget.add((m.invoiceId ?? m.paymentId)!); }

  /* ---------- 2. invoices against POs and delivery notes ---------- */

  const links: LinkOut[] = [];
  const confirmedLinks = input.existingLinks.filter((l) => l.state === "confirmed");
  const hasLink = new Set(confirmedLinks.map(linkKey));
  const poNorm = new Map(input.pos.map((p) => [p.id, norm(p.number)]));
  const dnNorm = new Map(input.dns.map((x) => [x.id, norm(x.number)]));

  for (const inv of input.invoices) {
    if (inv.docType !== "invoice") continue;
    for (const raw of inv.poRefs) {
      const r = norm(raw);
      for (const po of input.pos) {
        const pn = poNorm.get(po.id)!;
        const k = linkKey({ invoiceId: inv.id, poId: po.id, dnId: null });
        if (hasLink.has(k) || rejectedLinks.has(k)) continue;
        if (r === pn) {
          links.push({ invoice_id: inv.id, po_id: po.id, dn_id: null, origin: "exact", state: "confirmed", confidence: 100,
            evidence: [{ kind: "po_number", detail: `Invoice ${inv.number} quotes PO ${raw}`, supports: true }] });
          hasLink.add(k);
        } else if (suffixRelated(r, pn)) {
          links.push({ invoice_id: inv.id, po_id: po.id, dn_id: null, origin: "suggested", state: "pending", confidence: 70,
            evidence: [{ kind: "po_number", detail: `Invoice reference ${raw} ends with / contains PO ${po.number}`, supports: false }] });
          hasLink.add(k);
        }
      }
    }
    for (const raw of inv.dnRefs) {
      const r = norm(raw);
      for (const dn of input.dns) {
        const dnn = dnNorm.get(dn.id)!;
        const k = linkKey({ invoiceId: inv.id, poId: null, dnId: dn.id });
        if (hasLink.has(k) || rejectedLinks.has(k)) continue;
        if (r === dnn) {
          links.push({ invoice_id: inv.id, po_id: null, dn_id: dn.id, origin: "exact", state: "confirmed", confidence: 100,
            evidence: [{ kind: "dn_number", detail: `Invoice ${inv.number} quotes delivery note ${raw}`, supports: true }] });
          hasLink.add(k);
        } else if (numberSimilarity(r, dnn)) {
          const sharesPo = dn.poRefs.some((p) => inv.poRefs.some((q) => norm(p) === norm(q) || suffixRelated(norm(p), norm(q))));
          if (sharesPo) {
            links.push({ invoice_id: inv.id, po_id: null, dn_id: dn.id, origin: "suggested", state: "pending", confidence: 65,
              evidence: [
                { kind: "dn_number", detail: `Invoice reference ${raw} is similar to delivery note ${dn.number}`, supports: false },
                { kind: "po", detail: "Both refer to the same purchase order", supports: true },
              ] });
            hasLink.add(k);
          }
        }
      }
    }
  }

  // Resolve effective links (confirmed existing + new exact) for the checks below.
  const effPo = new Map<string, Set<string>>(); // invoice -> confirmed po ids
  const effDn = new Map<string, Set<string>>();
  const anyPo = new Set<string>(), anyDn = new Set<string>(); // confirmed or pending
  const add = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v));
  for (const l of [...confirmedLinks.map((x) => ({ invoice_id: x.invoiceId, po_id: x.poId, dn_id: x.dnId, state: "confirmed" })), ...links]) {
    if (l.state === "confirmed") { if (l.po_id) add(effPo, l.invoice_id, l.po_id); if (l.dn_id) add(effDn, l.invoice_id, l.dn_id); }
    if (l.po_id) anyPo.add(l.invoice_id);
    if (l.dn_id) anyDn.add(l.invoice_id);
  }
  for (const l of input.existingLinks) if (l.state === "pending") { if (l.poId) anyPo.add(l.invoiceId); if (l.dnId) anyDn.add(l.invoiceId); }

  /* ---------- 3. findings ---------- */

  const findings: Finding[] = [];
  const push = (f: Omit<Finding, "soa_entry_id" | "invoice_id" | "payment_id" | "po_id" | "dn_id"> & Partial<Pick<Finding, "soa_entry_id" | "invoice_id" | "payment_id" | "po_id" | "dn_id">>) =>
    findings.push({ soa_entry_id: null, invoice_id: null, payment_id: null, po_id: null, dn_id: null, ...f });

  const matchedSoa = new Map<string, string>(soaConfirmed); // soa -> target (confirmed incl. new exact)
  const targetToSoa = new Map<string, string>();
  for (const [s, t] of matchedSoa) targetToSoa.set(t, s);
  const inScope = (date: string) => date <= period.end;

  // 3a. invoices missing from the SOA / SOA entries without an invoice
  for (const inv of input.invoices) {
    if (!inScope(inv.date) || targetToSoa.has(inv.id) || pendingTarget.has(inv.id)) continue;
    const label = inv.docType === "credit_note" ? "Credit note" : "Invoice";
    push({
      type: "invoice_missing_from_soa", fingerprint: `${inv.docType}:${invNorm.get(inv.id)}`, invoice_id: inv.id,
      ref_text: `${label} ${inv.number}`, expected_amount: null, actual_amount: money(inv.gross),
      explanation: `${label} ${inv.number} (${inv.date}) is in our records for ${money(inv.gross)} but is not on the supplier's statement.`,
      calculation: { steps: [step("Gross amount in our records", inv.gross), step("Amount on the statement", "0.00")], result: money(inv.gross) },
    });
  }
  for (const e of soa) {
    const t = invoiceTypeOf(e);
    if (!t || matchedSoa.has(e.id) || pendingSoa.has(e.id)) continue;
    push({
      type: "soa_without_invoice", fingerprint: `${e.type}:${soaNorm.get(e.id)}`, soa_entry_id: e.id,
      ref_text: `${e.type === "credit_note" ? "Credit note" : "Invoice"} ${e.docNumber}`, expected_amount: null, actual_amount: money(soaAmount(e)),
      explanation: `The statement lists ${e.docNumber} (${e.docDate}) for ${money(soaAmount(e))} but we have no matching ${t === "credit_note" ? "credit note" : "invoice"}.`,
      calculation: { steps: [step("Amount on the statement", soaAmount(e)), step("Amount in our records", "0.00")], result: money(soaAmount(e)) },
    });
  }

  // 3b. matched pairs: amounts, VAT
  for (const [sid, tid] of matchedSoa) {
    const e = soaById.get(sid);
    if (!e) continue;
    const inv = invById.get(tid);
    if (inv) {
      const diff = soaAmount(e).minus(inv.gross);
      if (!withinTolerance(soaAmount(e), inv.gross, tolFor(inv.gross))) {
        push({
          type: "soa_amount_mismatch", fingerprint: `${inv.docType}:${invNorm.get(inv.id)}`, soa_entry_id: e.id, invoice_id: inv.id,
          ref_text: `${inv.docType === "credit_note" ? "Credit note" : "Invoice"} ${inv.number}`,
          expected_amount: money(inv.gross), actual_amount: money(soaAmount(e)),
          explanation: `The statement shows ${money(soaAmount(e))} for ${e.docNumber}, our invoice is ${money(inv.gross)} (statement is ${diff.gt(0) ? "higher" : "lower"} by ${money(diff.abs())}).`,
          calculation: { steps: [step("Statement amount", soaAmount(e)), step("Our gross amount", inv.gross), step("Difference (statement - ours)", diff), step("Allowed tolerance", tolFor(inv.gross))], result: money(diff) },
        });
      }
    }
    const p = payById.get(tid);
    if (p && !withinTolerance(soaAmount(e), p.amount, tolFor(p.amount))) {
      const diff = soaAmount(e).minus(p.amount);
      push({
        type: "payment_amount_mismatch", fingerprint: `pay:${payNorm.get(p.id)}`, soa_entry_id: e.id, payment_id: p.id, ref_text: `Payment ${p.ref}`,
        expected_amount: money(p.amount), actual_amount: money(soaAmount(e)),
        explanation: `The statement credits ${money(soaAmount(e))} for ${e.docNumber}; our payment ${p.ref} is ${money(p.amount)}.`,
        calculation: { steps: [step("Statement payment", soaAmount(e)), step("Our payment", p.amount), step("Difference", diff)], result: money(diff) },
      });
    }
  }

  for (const inv of input.invoices) {
    if (!inScope(inv.date)) continue;
    const expectedVat = vatFor(inv.net, S.vatRate);
    if (!inv.vatCalculated && !withinTolerance(inv.vat, expectedVat, tolFor(inv.vat))) {
      push({
        type: "vat_mismatch", fingerprint: `${inv.docType}:${invNorm.get(inv.id)}`, invoice_id: inv.id, ref_text: `Invoice ${inv.number}`,
        expected_amount: money(expectedVat), actual_amount: money(inv.vat),
        explanation: `VAT on ${inv.number} is ${money(inv.vat)} but ${(Number(S.vatRate) * 100).toFixed(2).replace(/\.00$/, "")}% of net ${money(inv.net)} is ${money(expectedVat)}.`,
        calculation: { steps: [step("Net amount", inv.net), step(`VAT rate`, `${(Number(S.vatRate) * 100).toFixed(2)}%`), step("Expected VAT", expectedVat), step("VAT on the invoice", inv.vat), step("Difference", d(inv.vat).minus(expectedVat))], result: money(d(inv.vat).minus(expectedVat)) },
      });
    }
    if (inv.printedGross != null && !withinTolerance(inv.printedGross, inv.gross, tolFor(inv.gross))) {
      push({
        type: "manual_review", fingerprint: `printed:${invNorm.get(inv.id)}`, invoice_id: inv.id, ref_text: `Invoice ${inv.number}`,
        expected_amount: money(inv.printedGross), actual_amount: money(inv.gross),
        explanation: `The total printed on invoice ${inv.number} (${money(inv.printedGross)}) differs from the sum of the lines that were read (${money(inv.gross)}). A line may have been missed.`,
        calculation: { steps: [step("Printed total", inv.printedGross), step("Sum of lines", inv.gross)] },
      });
    }
  }

  // 3c. payments
  for (const e of soa) {
    if (e.type !== "payment" || matchedSoa.has(e.id) || pendingSoa.has(e.id)) continue;
    push({
      type: "soa_payment_without_internal", fingerprint: `pay:${soaNorm.get(e.id)}`, soa_entry_id: e.id, ref_text: `Payment ${e.docNumber}`,
      expected_amount: "0.00", actual_amount: money(soaAmount(e)),
      explanation: `The statement shows a payment ${e.docNumber} of ${money(soaAmount(e))} (${e.docDate}) that is not in our payment records.`,
      calculation: { steps: [step("Payment on statement", soaAmount(e)), step("Payment in our records", "0.00")], result: money(soaAmount(e)) },
    });
  }
  for (const p of input.payments) {
    if (!inScope(p.date) || targetToSoa.has(p.id) || pendingTarget.has(p.id)) continue;
    push({
      type: "payment_not_in_soa", fingerprint: `pay:${payNorm.get(p.id)}:${p.date}:${money(p.amount)}`, payment_id: p.id, ref_text: `Payment ${p.ref}`,
      expected_amount: money(p.amount), actual_amount: "0.00",
      explanation: `Our payment ${p.ref} of ${money(p.amount)} (${p.date}) does not appear on the supplier's statement.`,
      calculation: { steps: [step("Our payment", p.amount), step("On the statement", "0.00")], result: money(p.amount) },
    });
  }

  // 3d. statement lines that need a person
  for (const e of soa) {
    if (["adjustment", "other", "debit_note"].includes(e.type)) {
      push({
        type: "manual_review", fingerprint: `soa:${e.type}:${soaNorm.get(e.id)}`, soa_entry_id: e.id, ref_text: `${e.type.replace("_", " ")} ${e.docNumber}`,
        expected_amount: null, actual_amount: money(soaSigned(e)),
        explanation: `The statement contains a ${e.type.replace("_", " ")} (${e.docNumber}, ${money(soaSigned(e))}) that cannot be matched automatically.`,
        calculation: null,
      });
    }
  }
  for (const m of matches.filter((x) => x.state === "pending")) {
    const e = soaById.get(m.soa_entry_id)!;
    const target = m.invoice_id ? invById.get(m.invoice_id)?.number : payById.get(m.payment_id!)?.ref;
    push({
      type: "manual_review", fingerprint: `suggest:${soaNorm.get(e.id)}:${m.invoice_id ?? m.payment_id}`, soa_entry_id: e.id,
      invoice_id: m.invoice_id, payment_id: m.payment_id, ref_text: `${e.docNumber} ↔ ${target}`,
      expected_amount: null, actual_amount: money(soaAmount(e)),
      explanation: `Statement ${e.docNumber} may be our ${target} (confidence ${m.confidence}%). Confirm or reject this suggested match.`,
      calculation: null,
    });
  }

  // 3e. PO / DN presence and comparisons
  const invoicesOnly = input.invoices.filter((i) => i.docType === "invoice" && inScope(i.date));
  for (const inv of invoicesOnly) {
    if (!anyPo.has(inv.id)) {
      push({
        type: "invoice_no_po", fingerprint: invNorm.get(inv.id)!, invoice_id: inv.id, ref_text: `Invoice ${inv.number}`,
        expected_amount: null, actual_amount: money(inv.gross),
        explanation: inv.poRefs.length
          ? `Invoice ${inv.number} quotes PO ${inv.poRefs.join(", ")} but no matching purchase order was imported.`
          : `Invoice ${inv.number} does not quote a purchase order and none is linked.`,
        calculation: null,
      });
    }
    if (!anyDn.has(inv.id)) {
      push({
        type: "invoice_no_dn", fingerprint: invNorm.get(inv.id)!, invoice_id: inv.id, ref_text: `Invoice ${inv.number}`,
        expected_amount: null, actual_amount: money(inv.gross),
        explanation: inv.dnRefs.length
          ? `Invoice ${inv.number} quotes delivery note ${inv.dnRefs.join(", ")} but none was imported.`
          : `Invoice ${inv.number} has no delivery note linked.`,
        calculation: null,
      });
    }
  }

  // PO versus invoices (confirmed links only)
  const invByPo = new Map<string, InvoiceIn[]>();
  for (const [invId, pos] of effPo) {
    const inv = invById.get(invId);
    if (!inv || inv.docType !== "invoice") continue;
    for (const poId of pos) invByPo.set(poId, [...(invByPo.get(poId) ?? []), inv]);
  }
  for (const [poId, invs] of invByPo) {
    const po = poById.get(poId);
    if (!po) continue;
    const poItems = new Map<string, { qty: Decimal; unit: Decimal | null }>();
    for (const l of po.lines) {
      const k = l.itemCode ? norm(l.itemCode) : "";
      if (!k) continue;
      const cur = poItems.get(k) ?? { qty: d(0), unit: null };
      poItems.set(k, { qty: cur.qty.plus(d(l.qty)), unit: l.unitPrice != null ? d(l.unitPrice) : cur.unit });
    }
    const invoicedQty = new Map<string, Decimal>();
    for (const inv of invs) {
      const single = (effPo.get(inv.id)?.size ?? 0) === 1;
      if (!single) continue; // an invoice covering several POs cannot be split by item reliably
      for (const l of inv.lines) {
        const k = l.itemCode ? norm(l.itemCode) : "";
        const item = poItems.get(k);
        if (!k || !item || l.qty == null) continue;
        invoicedQty.set(k, (invoicedQty.get(k) ?? d(0)).plus(d(l.qty)));
        if (item.unit && d(l.qty).gt(0) && l.net != null) {
          const expected = round2(d(l.qty).mul(item.unit));
          if (!withinTolerance(l.net, expected, tolFor(expected))) {
            const diff = d(l.net).minus(expected);
            push({
              type: "po_invoice_amount", fingerprint: `${invNorm.get(inv.id)}:${poNorm.get(poId)}:${k}`, invoice_id: inv.id, po_id: poId,
              ref_text: `Invoice ${inv.number} / PO ${po.number} / item ${l.itemCode}`, expected_amount: money(expected), actual_amount: money(l.net),
              explanation: `Item ${l.itemCode} on invoice ${inv.number} is charged ${money(l.net)} for ${qtyStr(l.qty)}; at the PO price (${d(item.unit).toFixed(2)}) it should be ${money(expected)}.`,
              calculation: { steps: [step("Invoiced quantity", qtyStr(l.qty)), step("PO unit price", d(item.unit).toFixed(2)), step("Expected net", expected), step("Invoiced net", l.net), step("Difference", diff)], result: money(diff) },
            });
          }
        }
      }
    }
    for (const [k, qty] of invoicedQty) {
      const ordered = poItems.get(k)!.qty;
      if (qty.minus(ordered).gt(d(S.qtyTolerance))) {
        const inv = invs[0];
        push({
          type: "po_invoice_qty", fingerprint: `${poNorm.get(poId)}:${k}`, po_id: poId, invoice_id: inv.id,
          ref_text: `PO ${po.number} / item ${k}`, expected_amount: null, actual_amount: null,
          explanation: `Invoices linked to PO ${po.number} bill ${qtyStr(qty)} of item ${k}, but only ${qtyStr(ordered)} was ordered.`,
          calculation: { steps: [step("Ordered quantity", qtyStr(ordered)), step("Invoiced quantity (all linked invoices)", qtyStr(qty)), step("Excess", qtyStr(qty.minus(ordered)))] },
        });
      }
    }
    if (po.net != null) {
      const total = invs.reduce((a, i) => a.plus(i.net), d(0));
      if (total.minus(po.net).gt(tolFor(po.net))) {
        push({
          type: "po_invoice_amount", fingerprint: `${poNorm.get(poId)}:total`, po_id: poId, invoice_id: invs[0].id, ref_text: `PO ${po.number}`,
          expected_amount: money(po.net), actual_amount: money(total),
          explanation: `Invoices linked to PO ${po.number} total ${money(total)} net, which is more than the PO value of ${money(po.net)}.`,
          calculation: { steps: [step("PO net value", po.net), step("Sum of linked invoices (net)", total), step("Excess", total.minus(po.net))], result: money(total.minus(po.net)) },
        });
      }
    }
  }

  // Invoice quantity versus delivered quantity
  for (const inv of invoicesOnly) {
    const dns = [...(effDn.get(inv.id) ?? [])].map((id) => dnById.get(id)).filter(Boolean) as DnIn[];
    if (!dns.length) continue;
    const delivered = new Map<string, Decimal>();
    for (const dn of dns) for (const l of dn.lines) {
      const k = l.itemCode ? norm(l.itemCode) : "";
      if (k) delivered.set(k, (delivered.get(k) ?? d(0)).plus(d(l.qty)));
    }
    if (!delivered.size) continue;
    for (const l of inv.lines) {
      const k = l.itemCode ? norm(l.itemCode) : "";
      if (!k || l.qty == null) continue;
      const got = delivered.get(k) ?? d(0);
      if (d(l.qty).minus(got).gt(d(S.qtyTolerance))) {
        push({
          type: "invoice_qty_vs_delivery", fingerprint: `${invNorm.get(inv.id)}:${k}`, invoice_id: inv.id, dn_id: dns[0].id,
          ref_text: `Invoice ${inv.number} / DN ${dns.map((x) => x.number).join(", ")} / item ${l.itemCode}`, expected_amount: null, actual_amount: null,
          explanation: `Invoice ${inv.number} bills ${qtyStr(l.qty)} of ${l.itemCode}; the linked delivery notes show ${qtyStr(got)}.`,
          calculation: { steps: [step("Delivered quantity", qtyStr(got)), step("Invoiced quantity", qtyStr(l.qty)), step("Excess", qtyStr(d(l.qty).minus(got)))] },
        });
      }
    }
  }

  // Delivery notes nobody invoiced
  const dnInvoiced = new Set<string>();
  for (const l of [...confirmedLinks, ...input.existingLinks.filter((x) => x.state === "pending")]) if (l.dnId) dnInvoiced.add(l.dnId);
  for (const l of links) if (l.dn_id) dnInvoiced.add(l.dn_id);
  for (const dn of input.dns) {
    if (!inScope(dn.date) || dnInvoiced.has(dn.id)) continue;
    push({
      type: "dn_without_invoice", fingerprint: dnNorm.get(dn.id)!, dn_id: dn.id, ref_text: `Delivery note ${dn.number}`,
      expected_amount: null, actual_amount: null,
      explanation: `Delivery note ${dn.number} (${dn.date}) is not linked to any invoice.`, calculation: null,
    });
  }

  // Possible duplicate invoices
  const real = input.invoices.filter((i) => i.docType === "invoice");
  for (let a = 0; a < real.length; a++) for (let b = a + 1; b < real.length; b++) {
    const x = real[a], y = real[b];
    if (invNorm.get(x.id) === invNorm.get(y.id)) continue;
    if (!d(x.gross).eq(y.gross)) continue;
    const samePo = x.poRefs.length > 0 && x.poRefs.some((r) => y.poRefs.map(norm).includes(norm(r)));
    const closeNumber = !!numberSimilarity(invNorm.get(x.id)!, invNorm.get(y.id)!);
    const dd = daysBetween(x.date, y.date);
    if (!(closeNumber || (samePo && dd <= S.dateWindowDays))) continue;
    const [first, second] = [x, y].sort((p, q) => invNorm.get(p.id)!.localeCompare(invNorm.get(q.id)!));
    push({
      type: "duplicate_invoice", fingerprint: `${invNorm.get(first.id)}|${invNorm.get(second.id)}`, invoice_id: second.id,
      ref_text: `Invoices ${first.number} and ${second.number}`, expected_amount: money(first.gross), actual_amount: money(second.gross),
      explanation: `Invoices ${first.number} and ${second.number} have the same amount (${money(first.gross)})${closeNumber ? " and very similar numbers" : ` and the same PO within ${dd} day(s)`}. One may be a duplicate.`,
      calculation: { steps: [step(`${first.number} gross`, first.gross), step(`${second.number} gross`, second.gross), step("Days apart", String(dd))] },
    });
  }
  // The same document twice on the statement (only possible when a duplicate was knowingly imported)
  const seenSoa = new Map<string, SoaEntryIn>();
  for (const e of soa) {
    if (!["invoice", "credit_note"].includes(e.type)) continue;
    const k = `${e.type}:${soaNorm.get(e.id)}`;
    const prev = seenSoa.get(k);
    if (prev) {
      push({
        type: "duplicate_invoice", fingerprint: `soa:${k}`, soa_entry_id: e.id, ref_text: `Statement ${e.docNumber} (listed twice)`,
        expected_amount: money(soaAmount(prev)), actual_amount: money(soaAmount(e)),
        explanation: `${e.docNumber} appears more than once on the statement (${money(soaAmount(prev))} and ${money(soaAmount(e))}).`, calculation: null,
      });
    } else seenSoa.set(k, e);
  }

  // Payments and credit notes not fully applied to invoices
  const payAlloc = new Map<string, Decimal>();
  for (const a of input.paymentAllocations) payAlloc.set(a.paymentId, (payAlloc.get(a.paymentId) ?? d(0)).plus(a.amount));
  const crAlloc = new Map<string, Decimal>();
  for (const a of input.creditAllocations) crAlloc.set(a.creditNoteId, (crAlloc.get(a.creditNoteId) ?? d(0)).plus(a.amount));
  const refundCandidates: { kind: string; ref: string; amount: string }[] = [];
  for (const p of input.payments) {
    if (!inScope(p.date)) continue;
    const left = d(p.amount).minus(payAlloc.get(p.id) ?? 0);
    if (left.gt(tolFor(p.amount))) {
      push({
        type: "payment_unallocated", fingerprint: `${payNorm.get(p.id)}:${p.date}:${money(p.amount)}`, payment_id: p.id, ref_text: `Payment ${p.ref}`,
        expected_amount: money(p.amount), actual_amount: money(payAlloc.get(p.id) ?? 0),
        explanation: `Payment ${p.ref} (${money(p.amount)}) has ${money(left)} not yet applied to any invoice.`,
        calculation: { steps: [step("Payment", p.amount), step("Applied to invoices", payAlloc.get(p.id) ?? 0), step("Not applied", left)], result: money(left) },
      });
      refundCandidates.push({ kind: "payment", ref: p.ref, amount: money(left) });
    }
  }
  for (const c of input.invoices.filter((i) => i.docType === "credit_note" && inScope(i.date))) {
    const left = d(c.gross).minus(crAlloc.get(c.id) ?? 0);
    if (left.gt(tolFor(c.gross))) {
      push({
        type: "credit_note_unapplied", fingerprint: invNorm.get(c.id)!, invoice_id: c.id, ref_text: `Credit note ${c.number}`,
        expected_amount: money(c.gross), actual_amount: money(crAlloc.get(c.id) ?? 0),
        explanation: `Credit note ${c.number} (${money(c.gross)}) has ${money(left)} not yet applied to invoices.`,
        calculation: { steps: [step("Credit note", c.gross), step("Applied", crAlloc.get(c.id) ?? 0), step("Not applied", left)], result: money(left) },
      });
      refundCandidates.push({ kind: "credit_note", ref: c.number, amount: money(left) });
    }
  }

  /* ---------- 4. balance comparison (waterfall) ---------- */

  const opening = d(period.reportedOpening ?? 0);
  const invSigned = (i: InvoiceIn) => (i.docType === "credit_note" ? d(i.gross).neg() : d(i.gross));

  const internalInvoices = input.invoices.filter((i) => inScope(i.date) || targetToSoa.has(i.id));
  const internalPayments = input.payments.filter((p) => inScope(p.date) || targetToSoa.has(p.id));
  const internalClosing = opening
    .plus(internalInvoices.reduce((a, i) => a.plus(invSigned(i)), d(0)))
    .minus(internalPayments.reduce((a, p) => a.plus(p.amount), d(0)));

  type Bucket = { key: string; label: string; amount: Decimal; count: number };
  const B: Record<string, Bucket> = {
    amountDiff: { key: "amount_diff", label: "Amount differences on matched invoices and credit notes", amount: d(0), count: 0 },
    soaOnly: { key: "soa_only", label: "On the statement, not in our invoices", amount: d(0), count: 0 },
    internalOnly: { key: "internal_only", label: "In our invoices, not on the statement", amount: d(0), count: 0 },
    payAmount: { key: "payment_amount", label: "Amount differences on matched payments", amount: d(0), count: 0 },
    soaPayOnly: { key: "soa_payment_only", label: "Payments on the statement, not in our payments", amount: d(0), count: 0 },
    internalPayOnly: { key: "internal_payment_only", label: "Our payments, not on the statement", amount: d(0), count: 0 },
    other: { key: "other_entries", label: "Statement adjustments and other entries", amount: d(0), count: 0 },
    pending: { key: "pending_suggestions", label: "Suggested matches not yet confirmed (shown as unmatched until confirmed)", amount: d(0), count: 0 },
  };
  let reportedFromEntries = opening;
  for (const e of soa) {
    const signed = soaSigned(e);
    reportedFromEntries = reportedFromEntries.plus(signed);
    const t = matchedSoa.get(e.id);
    if (e.type === "invoice" || e.type === "credit_note") {
      if (t) {
        const inv = invById.get(t);
        if (inv) { const diff = signed.minus(invSigned(inv)); if (!diff.isZero()) { B.amountDiff.amount = B.amountDiff.amount.plus(diff); B.amountDiff.count++; } }
      } else { B.soaOnly.amount = B.soaOnly.amount.plus(signed); B.soaOnly.count++; if (pendingSoa.has(e.id)) B.pending.count++; }
    } else if (e.type === "payment") {
      if (t) {
        const p = payById.get(t);
        if (p) { const diff = signed.plus(p.amount); if (!diff.isZero()) { B.payAmount.amount = B.payAmount.amount.plus(diff); B.payAmount.count++; } }
      } else { B.soaPayOnly.amount = B.soaPayOnly.amount.plus(signed); B.soaPayOnly.count++; }
    } else { B.other.amount = B.other.amount.plus(signed); B.other.count++; }
  }
  for (const i of internalInvoices) if (!targetToSoa.has(i.id)) { B.internalOnly.amount = B.internalOnly.amount.minus(invSigned(i)); B.internalOnly.count++; }
  for (const p of internalPayments) if (!targetToSoa.has(p.id)) { B.internalPayOnly.amount = B.internalPayOnly.amount.plus(p.amount); B.internalPayOnly.count++; }
  B.pending.amount = d(0); // informational only: already counted in the buckets above

  const reportedClosing = period.reportedClosing != null ? d(period.reportedClosing) : null;
  const difference = reportedClosing ? reportedClosing.minus(internalClosing) : null;
  const buckets = Object.values(B).filter((b) => b.count > 0 || !b.amount.isZero());
  const explained = Object.values(B).filter((b) => b.key !== "pending_suggestions").reduce((a, b) => a.plus(b.amount), d(0));
  const unexplained = difference ? difference.minus(explained) : null;

  const notes: string[] = [];
  notes.push("Difference = supplier-reported closing balance - our calculated closing balance. Each line below explains part of it.");
  notes.push(`Our closing = opening ${money(opening)} + invoices - credit notes - payments dated up to ${period.end} (plus anything matched to this statement).`);
  if (unexplained && !unexplained.abs().lte(S.amountToleranceAbs)) {
    notes.push("The unexplained part is the gap between the statement's own printed closing balance and the sum of its lines. Check the statement control totals on the import review page.");
  }
  if (difference && difference.abs().gt(tolFor(difference))) {
    push({
      type: "balance_difference", fingerprint: "closing", ref_text: `Closing balance at ${period.end}`,
      expected_amount: money(internalClosing), actual_amount: money(reportedClosing!),
      explanation: `The supplier reports ${money(reportedClosing!)} but our records give ${money(internalClosing)} (difference ${money(difference)}).`,
      calculation: {
        steps: [
          step("Supplier-reported closing", reportedClosing!), step("Our calculated closing", internalClosing), step("Difference", difference),
          ...Object.values(B).filter((b) => b.key !== "pending_suggestions" && !b.amount.isZero()).map((b) => step(b.label, b.amount)),
          step("Unexplained", unexplained!),
        ],
        result: money(difference),
      },
    });
  }

  const waterfall: Waterfall = {
    reportedOpening: money(opening),
    reportedClosing: reportedClosing ? money(reportedClosing) : null,
    internalClosing: money(internalClosing),
    difference: difference ? money(difference) : null,
    buckets: buckets.map((b) => ({ key: b.key, label: b.label, amount: money(b.amount), count: b.count })),
    unexplained: unexplained ? money(unexplained) : null,
    notes,
  };

  const count = (t: FindingType) => findings.filter((f) => f.type === t).length;
  const summary: EngineResult["summary"] = {
    soa_entries: soa.length,
    exact_matches: matches.filter((m) => m.origin === "exact").length,
    suggested_matches: matches.filter((m) => m.origin === "suggested").length,
    previously_confirmed: input.existingMatches.filter((m) => m.state === "confirmed").length,
    findings: findings.length,
    invoice_missing_from_soa: count("invoice_missing_from_soa"),
    soa_without_invoice: count("soa_without_invoice"),
    reported_closing: waterfall.reportedClosing,
    internal_closing: waterfall.internalClosing,
    difference: waterfall.difference,
    refund_candidates: refundCandidates.length,
  };

  return { matches, links, findings, waterfall, summary };
}
