import { NextResponse } from "next/server";
import { isUuid } from "@/lib/forms";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; periodId: string }> }) {
  const { id, periodId } = await params;
  if (!isUuid(id) || !isUuid(periodId)) return new Response("Not found", { status: 404 });
  const url = new URL("/reconciliation/export", request.url);
  url.searchParams.set("supplier", id);
  url.searchParams.set("period", periodId);
  return NextResponse.redirect(url);
}
