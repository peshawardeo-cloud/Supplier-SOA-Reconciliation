import { PERIOD_STATUS_LABEL, IMPORT_STATUS_LABEL, type ImportStatus, type PeriodStatus } from "@/lib/types";

const TONE = {
  gray: "bg-slate-100 text-slate-700",
  blue: "bg-blue-50 text-blue-800",
  green: "bg-green-50 text-green-800",
  amber: "bg-amber-50 text-amber-800",
  red: "bg-red-50 text-red-800",
} as const;

export function Pill({ tone = "gray", children }: { tone?: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

const PERIOD_TONE: Record<PeriodStatus, keyof typeof TONE> = {
  draft: "gray",
  in_progress: "blue",
  under_review: "amber",
  completed: "green",
  locked: "gray",
};

export function PeriodStatusPill({ status }: { status: PeriodStatus }) {
  return <Pill tone={PERIOD_TONE[status]}>{PERIOD_STATUS_LABEL[status]}</Pill>;
}

const IMPORT_TONE: Record<ImportStatus, keyof typeof TONE> = {
  uploaded: "gray",
  needs_mapping: "amber",
  staged: "blue",
  committed: "green",
  failed: "red",
  reverted: "gray",
};

export function ImportStatusPill({ status }: { status: ImportStatus }) {
  return <Pill tone={IMPORT_TONE[status]}>{IMPORT_STATUS_LABEL[status]}</Pill>;
}

export function Alert({
  kind,
  children,
}: {
  kind: "error" | "success" | "warning" | "info";
  children: React.ReactNode;
}) {
  const cls = {
    error: "bg-red-50 text-red-700",
    success: "bg-green-50 text-green-700",
    warning: "bg-amber-50 text-amber-800",
    info: "bg-blue-50 text-blue-800",
  }[kind];
  return (
    <p role={kind === "error" ? "alert" : "status"} className={`rounded-md px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className = "",
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="label">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Breadcrumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-sm text-slate-500">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>/</span>}
          {it.href ? (
            <a href={it.href} className="hover:text-slate-800 hover:underline">
              {it.label}
            </a>
          ) : (
            <span className="text-slate-800">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
