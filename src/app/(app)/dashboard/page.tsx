import { getSessionProfile } from "@/lib/auth";

const upcoming = [
  "Suppliers and reconciliation periods",
  "Excel imports (SOA, PO, DN, invoices)",
  "Reconciliation engine",
  "Payments, credit notes and balances",
  "Discrepancies and refund claims",
  "Dashboard metrics and Excel exports",
];

export default async function DashboardPage() {
  const { profile } = await getSessionProfile();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-slate-600">
          Welcome{profile?.full_name ? `, ${profile.full_name}` : ""}. Phase 1 (foundation) is in
          place: login, roles and settings.
        </p>
      </div>

      <div className="card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Coming in later phases
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          {upcoming.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
