"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const updateUserSchema = z.object({
  id: z.string().uuid(),
  full_name: z.string().trim().max(120),
  role: z.enum(["admin", "accountant", "viewer"]),
  is_active: z.boolean(),
});

export async function updateUser(formData: FormData) {
  const me = await requireRole(["admin"]);

  const parsed = updateUserSchema.safeParse({
    id: formData.get("id"),
    full_name: formData.get("full_name") ?? "",
    role: formData.get("role"),
    is_active: formData.get("is_active") === "on",
  });
  if (!parsed.success) {
    redirect("/users?error=" + encodeURIComponent("Invalid user details."));
  }

  const v = parsed.data;
  if (v.id === me.id && (v.role !== "admin" || !v.is_active)) {
    redirect(
      "/users?error=" +
        encodeURIComponent("You cannot remove your own admin access. Ask another admin."),
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ full_name: v.full_name || null, role: v.role, is_active: v.is_active })
    .eq("id", v.id);

  if (error) {
    redirect("/users?error=" + encodeURIComponent("Could not update user."));
  }

  revalidatePath("/users");
  redirect("/users?saved=1");
}
