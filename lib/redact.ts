import "server-only";

const SECRET_KEY_PATTERNS = [/api[_-]?key/i, /secret/i, /password/i, /token/i, /authorization/i];

const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "FIRECRAWL_API_KEY",
  "VOYAGE_API_KEY",
  "BREVO_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DISCORD_BOT_TOKEN",
  "CRON_SECRET",
  "TESTING_API_TOKEN",
];

/** The actual configured secret values, read fresh (not cached) so a rotated key is picked up immediately. */
function knownSecretValues(): string[] {
  return SECRET_ENV_VARS.map((name) => process.env[name]).filter((v): v is string => Boolean(v && v.length >= 8));
}

/**
 * Strips likely secret values from anything about to be written into
 * pipeline_log, so a leaked log line can't leak a credential. Applied
 * before every persisted log entry (artifact/design.md, "Failure
 * visibility & security"). Two layers: structural (redact a whole field
 * whose *key* looks secret-shaped) and content-based (redact the actual
 * configured secret value if it appears verbatim inside any string, e.g. a
 * thrown SDK error message that happened to echo an API key) — the first
 * alone misses a leaked value sitting inside an unrelated-looking field
 * like `error`.
 */
export function redact<T>(value: T): T {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactSecretsInString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as T;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERNS.some((p) => p.test(key))) {
        out[key] = "[redacted]";
      } else {
        out[key] = redact(val);
      }
    }
    return out as T;
  }

  return value;
}

function redactSecretsInString(text: string): string {
  let result = text;
  for (const secret of knownSecretValues()) {
    if (result.includes(secret)) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}
