import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { Nav, type NavItem } from "@/components/nav";
import { signOut } from "../(auth)/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, profile } = await getSessionProfile();
  if (!user) redirect("/login");

  if (!profile || !profile.is_active) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="card max-w-sm space-y-4 text-center">
          <h1 className="text-lg font-semibold">Access not enabled</h1>
          <p className="text-sm text-slate-600">
            Your account is signed in but is not active. Please ask an administrator to enable it.
          </p>
          <form action={signOut}>
            <button className="btn-secondary w-full">Sign out</button>
          </form>
        </div>
      </main>
    );
  }

  const items: NavItem[] = [{ href: "/dashboard", label: "Dashboard" }];
  if (profile.role === "admin") {
    items.push({ href: "/settings", label: "Settings" }, { href: "/users", label: "Users" });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between sm:justify-start sm:gap-6">
            <span className="text-base font-semibold">SOA Reconciliation</span>
            <form action={signOut} className="sm:hidden">
              <button className="text-sm text-slate-600 underline">Sign out</button>
            </form>
          </div>
          <Nav items={items} />
          <div className="hidden items-center gap-3 sm:flex">
            <span className="text-sm text-slate-600">
              {profile.full_name ?? profile.email} · {profile.role}
            </span>
            <form action={signOut}>
              <button className="btn-secondary">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
