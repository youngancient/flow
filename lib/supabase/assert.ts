import "server-only";

/**
 * The Supabase JS client never rejects on a database error — a failed
 * insert/update/upsert/delete resolves normally with `{ error }` set instead
 * of throwing. Every write in this codebase used to ignore that field, so a
 * failure (bad constraint, RLS denial, whatever) looked identical to success:
 * no exception, no pipeline_log entry, no way to tell anything went wrong.
 * That's exactly how a real channel_outputs upsert failed silently three
 * times in a row — cost charged, "success" logged, zero rows written.
 *
 * Wrap every write in this so a database error becomes a thrown Error like
 * any other failure, and flows into the same try/catch → pipeline_log →
 * Discord path everything else already uses.
 */
export async function assertOk<T extends { error: { message: string } | null }>(
  promise: PromiseLike<T>,
  context: string
): Promise<T> {
  const result = await promise;
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result;
}
