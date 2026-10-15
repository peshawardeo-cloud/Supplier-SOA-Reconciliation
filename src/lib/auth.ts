import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "admin" | "accountant" | "viewer";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: Role;
  is_active: boolean;
};

export async function getSessionProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, is_active")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  return { user, profile };
}

/** Use at the top of server actions and pages. Redirects if the user lacks the role. */
export async function requireRole(allowed: Role[]): Promise<Profile> {
  const { user, profile } = await getSessionProfile();
  if (!user) redirect("/login");
  if (!profile || !profile.is_active || !allowed.includes(profile.role)) {
    redirect("/dashboard");
  }
  return profile;
}
