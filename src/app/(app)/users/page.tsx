import { requireRole, type Profile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { updateUser } from "./actions";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const me = await requireRole(["admin"]);
  const { error, saved } = await searchParams;

  const supabase = await createClient();
  const { data: users } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, is_active")
    .order("email")
    .returns<Profile[]>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-sm text-slate-600">
          Add people in Supabase (Authentication → Users → Add user), then set their role here.
          Viewers can read; accountants can import and reconcile; admins manage settings and users.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          User updated.
        </p>
      )}

      <div className="space-y-3">
        {(users ?? []).map((u) => (
          <form
            key={u.id}
            action={updateUser}
            className="card grid items-end gap-3 sm:grid-cols-[1fr_1fr_9rem_auto_auto]"
          >
            <input type="hidden" name="id" value={u.id} />
            <div>
              <span className="label">Email</span>
              <p className="truncate py-2 text-sm">
                {u.email}
                {u.id === me.id && <span className="ml-2 text-xs text-slate-500">(you)</span>}
              </p>
            </div>
            <div>
              <label htmlFor={`name-${u.id}`} className="label">
                Name
              </label>
              <input
                id={`name-${u.id}`}
                name="full_name"
                defaultValue={u.full_name ?? ""}
                className="input"
              />
            </div>
            <div>
              <label htmlFor={`role-${u.id}`} className="label">
                Role
              </label>
              <select id={`role-${u.id}`} name="role" defaultValue={u.role} className="input">
                <option value="admin">Admin</option>
                <option value="accountant">Accountant</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            <label className="flex items-center gap-2 py-2 text-sm">
              <input
                type="checkbox"
                name="is_active"
                defaultChecked={u.is_active}
                className="h-4 w-4 rounded border-slate-300"
              />
              Active
            </label>
            <button type="submit" className="btn">
              Save
            </button>
          </form>
        ))}
      </div>
    </div>
  );
}
