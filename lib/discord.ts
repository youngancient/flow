import "server-only";

/**
 * Fire-and-forget post to the team's Discord error channel via the bot API
 * (not an incoming webhook) — the bot must already be invited to the
 * server with permission to send messages in DISCORD_CHANNEL_ID. Fires
 * only on failure, never blocks the pipeline — a Discord outage must
 * never fail the pipeline itself. See artifact/design.md, "Notifications".
 */
export function postPipelineError(params: {
  requestId: string;
  stage: string;
  error: string;
}): void {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;
  const discordApiBaseUrl = process.env.DISCORD_API_BASE_URL;
  if (!botToken || !channelId || !discordApiBaseUrl) return;

  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    // Never throw out of a fire-and-forget alert path — a misconfigured
    // env var must not be able to suppress the alert it's trying to send.
    console.error("postPipelineError: Missing APP_URL env var, skipping Discord alert");
    return;
  }

  fetch(`${discordApiBaseUrl}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: [
        `**Pipeline failure**`,
        `stage: \`${params.stage}\``,
        `request: ${appUrl}/requests/${params.requestId}`,
        `error: ${params.error}`,
      ].join("\n"),
    }),
  })
    .then(async (res) => {
      if (!res.ok) {
        console.error("Discord bot message post failed:", res.status, await res.text());
      }
    })
    .catch((err) => {
      console.error("Discord bot message post failed:", err);
    });
}
