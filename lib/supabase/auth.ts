import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
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

/** Returns the current session's email, or throws — for use inside Server Actions/Route Handlers, which need a catchable error to turn into an { ok: false } result, not a hard navigation. */
export async function requireSessionEmail(): Promise<string> {
  const user = await getSessionUser();
  if (!user?.email) {
    throw new Error("Unauthorized: no active session");
  }
  return user.email;
}

/**
 * True when the current session belongs to a manager — set manually per
 * account via `raw_app_meta_data.role` on the Supabase auth user (there is
 * no dashboard field for this; it's set with a SQL update against
 * auth.users, see artifact/design.md). app_metadata is only writable with
 * the service-role key, never by the user themselves, so this can't be
 * self-granted the way user_metadata could be.
 */
export async function isManager(): Promise<boolean> {
  const user = await getSessionUser();
  return user?.app_metadata?.role === "manager";
}

/** Throws unless the current session is a manager — for Server Actions/Route Handlers. */
export async function requireManager(): Promise<string> {
  const user = await getSessionUser();
  if (!user?.email) {
    throw new Error("Unauthorized: no active session");
  }
  if (user.app_metadata?.role !== "manager") {
    throw new Error("Unauthorized: manager role required");
  }
  return user.email;
}

/**
 * Page-only counterpart to requireSessionEmail: redirects to /login instead
 * of throwing, so visiting a protected page while logged out lands on the
 * login screen instead of Next.js's generic error boundary. Never use this
 * from a Server Action or Route Handler — redirect() there would abort the
 * action/response in a way callers don't expect; use requireSessionEmail /
 * requireApiAuth instead, which let the caller decide what to return.
 */
export async function requireSessionEmailOrRedirect(): Promise<string> {
  const user = await getSessionUser();
  if (!user?.email) {
    redirect("/login");
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
