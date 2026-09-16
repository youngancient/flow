import "server-only";

const DISCORD_API = "https://discord.com/api/v10";

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
  if (!botToken || !channelId) return;

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
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
