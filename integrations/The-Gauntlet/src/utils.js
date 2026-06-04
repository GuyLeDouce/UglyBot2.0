// src/utils.js
// Shared helpers: env, time, random, ephemerals, admin check

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
} = require("discord.js");

// ========= ENV & CONSTANTS =========

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const GUILD_IDS = (process.env.GUILD_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Default to false to avoid destructive resets unless explicitly enabled.
const GAUNTLET_RESET =
  (process.env.GAUNTLET_RESET || "false").toLowerCase() === "true";

const AUTHORIZED_ADMINS = (
  process.env.GAUNTLET_ADMINS ||
  "826581856400179210,1288107772248064044"
)
  .split(",")
  .map((s) => s.trim());

const GAUNTLET_PLAY_REWARD = Math.max(
  0,
  Number(process.env.GAUNTLET_PLAY_REWARD || "50")
);

// ========= DB SSL HELPER =========

function getSSL(connectionString = null) {
  const hasConnectionString =
    Boolean(connectionString) ||
    Boolean(process.env.DATABASE_URL) ||
    Boolean(process.env.GAUNTLET_DATABASE_URL) ||
    Boolean(process.env.DATABASE_PUBLIC_URL) ||
    Boolean(process.env.POSTGRES_PUBLIC_URL) ||
    Boolean(process.env.DATABASE_URL_IMAGE) ||
    Boolean(process.env.DATABASE_URL_SURVIVAL) ||
    Boolean(process.env.DATABASUE_URL_SURVIVAL);
  if (!hasConnectionString) return undefined;
  return process.env.PGSSL === "false"
    ? false
    : { rejectUnauthorized: false };
}

// ========= BASIC UTILITIES =========

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

function torontoDateStr(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function currentMonthStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  return `${y}-${m}`;
}

function nextTorontoMidnight() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
  // Approximate next midnight Toronto local for display
  const next = new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(next);
}

// Optional, currently unused but kept from original:
function getMonsterImageUrl() {
  const tokenId = Math.floor(Math.random() * 126) + 1;
  return `https://ipfs.io/ipfs/bafybeicydaui66527mumvml5ushq5ngloqklh6rh7hv3oki2ieo6q25ns4/${tokenId}.webp`;
}

function withScore(embed, player) {
  try {
    return embed.setFooter({
      text: `Current score: ${player.points}`,
    });
  } catch {
    return embed;
  }
}

// ========= EPHEMERAL HELPERS =========

async function sendEphemeral(interaction, payload) {
  const { noExpire, ...rest } = payload;
  let msg;

  // use flags: 64 (ephemeral)
  const base = { ...rest, flags: 64, fetchReply: true };

  if (interaction.deferred || interaction.replied) {
    msg = await interaction.followUp(base);
  } else {
    msg = await interaction.reply(base);
  }

  if (!noExpire) {
    setTimeout(async () => {
      try {
        await msg.delete();
      } catch {}
    }, 60_000);
  }

  return msg;
}

async function ephemeralPrompt(interaction, embed, components, timeMs) {
  const msg = await sendEphemeral(interaction, {
    embeds: [embed],
    components,
  });

  const replyMsg = msg instanceof Promise ? await msg : msg;

  const picked = await replyMsg
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      time: timeMs,
    })
    .catch(() => null);

  try {
    const rows = (components || []).map((row) =>
      new ActionRowBuilder().addComponents(
        row.components.map((b) =>
          ButtonBuilder.from(b).setDisabled(true)
        )
      )
    );
    await replyMsg.edit({ components: rows });
  } catch {}

  return picked;
}

// ========= ADMIN CHECK =========

function isAdminUser(interaction) {
  if (AUTHORIZED_ADMINS.includes(interaction.user.id)) return true;

  const member = interaction.member;
  if (!member || !interaction.inGuild()) return false;

  return (
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

// ========= EXPORTS =========

module.exports = {
  TOKEN,
  CLIENT_ID,
  GUILD_IDS,
  GAUNTLET_RESET,
  AUTHORIZED_ADMINS,
  GAUNTLET_PLAY_REWARD,
  getSSL,
  wait,
  rand,
  torontoDateStr,
  currentMonthStr,
  nextTorontoMidnight,
  getMonsterImageUrl,
  withScore,
  sendEphemeral,
  ephemeralPrompt,
  isAdminUser,
};
