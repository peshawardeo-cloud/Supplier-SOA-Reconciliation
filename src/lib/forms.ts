/** Collect the plain-text fields of a submitted form (files are ignored). */
export function formToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** A message that is safe and useful to show the user. Anything else is logged and replaced. */
export class UserError extends Error {}

export function userMessage(e: unknown, fallback = "Something went wrong. Please try again."): string {
  if (e instanceof UserError) return e.message;
  console.error(e);
  return fallback;
}

export function withParams(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Make a user-supplied search string safe to put inside a PostgREST `or(...)` filter. */
export function safeSearch(q: string | undefined): string {
  return (q ?? "").replace(/[,()%*\\:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
