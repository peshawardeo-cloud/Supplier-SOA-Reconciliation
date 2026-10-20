import { getSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { addSheet, newWorkbook, workbookResponse } from "@/lib/excel";
import { DISC_COLS, loadDiscrepancyRows, parseDiscFilters } from "@/lib/export-data";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const { profile } = await getSessionProfile();
  if (!profile || !profile.is_active) return new Response("Not allowed", { status: 403 });
  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const rows = await loadDiscrepancyRows(supabase, parseDiscFilters(sp));
  const wb = newWorkbook();
  addSheet(wb, "Discrepancies", DISC_COLS, rows);
  return workbookResponse(wb, `discrepancies-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
