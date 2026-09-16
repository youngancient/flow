import "server-only";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Anon-key client for use inside Server Components, Server Actions, and
 * Route Handlers — session/login/logout only, never application data (see
 * artifact/design.md, "Authentication"). Reads/writes the session cookie via
 * next/headers, so it must be awaited before use.
 */
export async function createServerAuthClient() {
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options ?? {});
          }
        } catch {
          // Called from a Server Component that can't set cookies (e.g. a
          // page render, not an action) — the proxy refreshes the session
          // instead, so this is safe to ignore.
        }
      },
    },
  });
}

/** Returns the current session's user, or null if not logged in. */
export async function getSessionUser() {
  const supabase = await createServerAuthClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** Returns the current session's email, or throws — for use inside actions/routes that require auth. */
export async function requireSessionEmail(): Promise<string> {
  const user = await getSessionUser();
  if (!user?.email) {
    throw new Error("Unauthorized: no active session");
  }
  return user.email;
}

/**
 * Auth for the curl-testable Route Handlers used to produce the
 * testing-evidence table (artifact/design.md flagged this as an open
 * decision — resolved here): accept either a real session cookie (normal
 * browser use) or a static bearer token in TESTING_API_TOKEN (curl/CI use).
 * Returns the acting email, or null if neither check passes.
 */
export async function requireApiAuth(request: Request): Promise<string | null> {
  const testingToken = process.env.TESTING_API_TOKEN;
  const authHeader = request.headers.get("authorization");
  if (testingToken && authHeader === `Bearer ${testingToken}`) {
    return "api-test@local";
  }

  const user = await getSessionUser();
  return user?.email ?? null;
}
