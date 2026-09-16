"use server";

import { redirect } from "next/navigation";
import { createServerAuthClient } from "@/lib/supabase/auth";

export async function signOut(): Promise<void> {
  const supabase = await createServerAuthClient();
  await supabase.auth.signOut();
  redirect("/login");
}
