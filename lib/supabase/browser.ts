import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client for the login form — the only place this app talks to
 * Supabase from the client, and only for auth, never data. Split into its
 * own file (no next/headers import) so Client Components can import it
 * without pulling server-only code into the client bundle.
 */
export function createBrowserAuthClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
