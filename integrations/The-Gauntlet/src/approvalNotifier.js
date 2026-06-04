const { EmbedBuilder } = require("discord.js");
const { imageStore } = require("./imageStore");

const SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID =
  process.env.SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID || "1334884237727240267";

function log(...args) {
  console.log("[GAUNTLET:APPROVALS]", ...args);
}

function buildApprovalMessage(notification) {
  const promptText =
    typeof notification.prompt_text === "string"
      ? notification.prompt_text.trim()
      : "";
  const descriptionLines = [
    `Creator: <@${notification.discord_user_id}> (${notification.discord_username})`,
    `Era: \`${notification.era_key}\``,
    `Reward: **${notification.reward_points} $CHARM**`,
  ];
  if (promptText) {
    descriptionLines.push(`Prompt: ${promptText}`);
  }

  const embed = new EmbedBuilder()
    .setTitle("Squig Survival image approved")
    .setColor(0x2ecc71)
    .setDescription(descriptionLines.join("\n"));

  if (notification.image_url) {
    embed.setImage(notification.image_url);
  }

  return { content: "✅ **Squig Survival image approved**", embeds: [embed] };
}

async function processApprovalNotifications(client) {
  if (!client || !SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID) return;

  while (true) {
    const notification = await imageStore.claimNextApprovalNotification();
    if (!notification) return;

    try {
      const channel = await client.channels.fetch(
        SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID
      );
      if (!channel || !channel.send) {
        throw new Error("Approval channel is not accessible.");
      }

      const sent = await channel.send(buildApprovalMessage(notification));
      await imageStore.markApprovalNotificationPosted(
        notification.id,
        sent?.id || null
      );
    } catch (err) {
      await imageStore.markApprovalNotificationFailed(
        notification.id,
        err?.message || err
      );
      log(
        `Approval notification ${notification.id} failed:`,
        err?.message || err
      );
      return;
    }
  }
}

function startApprovalNotificationLoop(client) {
  if (!client || !SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID) return null;

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processApprovalNotifications(client);
    } catch (err) {
      log("Approval notification loop failed:", err?.message || err);
    } finally {
      running = false;
    }
  };

  run().catch(() => {});
  const intervalMs = Math.max(
    5_000,
    Number(process.env.SURVIVAL_IMAGE_APPROVAL_POLL_MS || "15000")
  );
  const timer = setInterval(run, intervalMs);
  if (timer.unref) timer.unref();
  log(
    `Approval notification loop active for channel ${SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID} every ${intervalMs}ms.`
  );
  return timer;
}

module.exports = {
  SURVIVAL_IMAGE_APPROVAL_CHANNEL_ID,
  processApprovalNotifications,
  startApprovalNotificationLoop,
};
