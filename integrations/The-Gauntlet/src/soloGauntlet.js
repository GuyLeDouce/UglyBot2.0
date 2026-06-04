// src/soloGauntlet.js
// Solo-mode Gauntlet controller: commands, buttons, and ephemeral game flow.

const {
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require("discord.js");

const {
  TOKEN,
  CLIENT_ID,
  GUILD_IDS,
  AUTHORIZED_ADMINS,
  torontoDateStr,
  currentMonthStr,
  nextTorontoMidnight,
  withScore,
} = require("./utils");

const { Store } = require("./db");
const {
  miniGameLorePool,
  miniGameFateDescriptions,
  pointFlavors,
  pickMiniGame,
  pickRiddle,
} = require("./gameData");

// ?? Group mode command + handler
const {
  groupGauntletCommand,
  handleGroupInteractionCreate,
} = require("./groupGauntlet");

const {
  runSurvival,
  buildPodiumImage,
  getSurvivalRunLifeStatus,
  getSurvivalShareData,
  postSurvivalFinalSummaryTest,
  SURVIVAL_SHARE_DISCORD_CHANNEL_ID,
  handlePublicReviveCommand,
} = require("./survival");
const { SURVIVAL_ERAS, getSurvivalEraDefinition } = require("./survivalEras");
const { rewardCharmAmount, logCharmReward, DRIP_LOG_CHANNEL_ID } = require("./drip");
const { imageStore } = require("./imageStore");
const { survivalStore } = require("./survivalStore");
const SURVIVAL_SHARE_REWARD_AMOUNT = 150;
const SURVIVAL_SHARE_LOOKBACK_MS = 15 * 60_000;
const SURVIVAL_IMAGE_SUBMISSION_URL =
  "https://imagesubmit-production.up.railway.app/";
const URL_PATTERN = /https?:\/\/\S+/i;

// --------------------------------------------
// Small helpers
// --------------------------------------------
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function buildDisplayNameMap(client, guildId, userIds) {
  const map = new Map();
  const unique = Array.from(new Set(userIds || [])).filter(Boolean);
  if (!unique.length) return map;

  let guild = null;
  if (guildId) {
    try {
      guild = await client.guilds.fetch(guildId);
    } catch {
      guild = null;
    }
  }

  if (guild) {
    try {
      const members = await guild.members.fetch({ user: unique });
      for (const [id, member] of members) {
        const name =
          member.nickname ||
          member.user.displayName ||
          member.user.globalName ||
          member.user.username ||
          `User-${id}`;
        map.set(id, name);
      }
    } catch {
      for (const id of unique) {
        if (map.has(id)) continue;
        try {
          const member = await guild.members.fetch(id);
          const name =
            member.nickname ||
            member.user.displayName ||
            member.user.globalName ||
            member.user.username ||
            `User-${id}`;
          map.set(id, name);
        } catch {}
      }
    }
  }

  for (const id of unique) {
    if (map.has(id)) continue;
    try {
      const user = await client.users.fetch(id);
      const name =
        user.displayName || user.globalName || user.username || `User-${id}`;
      map.set(id, name);
    } catch {
      map.set(id, `User-${id}`);
    }
  }

  return map;
}

// --------------------------------------------
// Survival lobby state (single instance)
// --------------------------------------------
let survivalLobby = null;
let survivalStandardSettings = null;
const survivalConfigSessions = new Map();
const SURVIVAL_BASE_POOL_INCREMENT = 50;
const SURVIVAL_REPLAY_DELAY_MS = 10_000;
const DEFAULT_SURVIVAL_ROLE_ID = "1389076094245671002";

const SURVIVAL_TYPE_LABELS = {
  team_start: "Team Start",
  timed: "Timed",
};

const SURVIVAL_ERA_LABELS = Object.fromEntries(
  Object.entries(SURVIVAL_ERAS).map(([key, era]) => [key, era.label])
);
const SURVIVAL_SPECIAL_IMAGE_TAGS = {
  revive_success: "!revive Success",
  revive_failed: "!revive Failed",
};
const SURVIVAL_IMAGE_TAG_LABELS = {
  ...SURVIVAL_ERA_LABELS,
  ...SURVIVAL_SPECIAL_IMAGE_TAGS,
};

function normalizeSurvivalImageTag(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = raw.trim();
  const lowered = normalized.toLowerCase();

  if (
    lowered === "revive_success" ||
    lowered === "!revive success" ||
    lowered === "revive success"
  ) {
    return "revive_success";
  }
  if (
    lowered === "revive_failed" ||
    lowered === "!revive failed" ||
    lowered === "revive failed"
  ) {
    return "revive_failed";
  }

  const directKey = Object.keys(SURVIVAL_ERAS).find(
    (key) => key.toLowerCase() === lowered
  );
  if (directKey) return directKey;

  return (
    Object.entries(SURVIVAL_ERA_LABELS).find(
      ([, label]) => label.toLowerCase() === lowered
    )?.[0] || null
  );
}

function parseSurvivalImageEraInput(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: true, eraKeys: null, label: "standard" };
  }

  const tokens = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!tokens.length) {
    return { ok: true, eraKeys: null, label: "standard" };
  }

  const normalized = [];
  const seen = new Set();

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (["standard", "all", "any", "default"].includes(lowered)) {
      continue;
    }

    const matchedKey = normalizeSurvivalImageTag(token);

    if (!matchedKey) {
      return {
        ok: false,
        reason: `Unknown era: ${token}`,
      };
    }

    if (!seen.has(matchedKey)) {
      seen.add(matchedKey);
      normalized.push(matchedKey);
    }
  }

  if (!normalized.length) {
    return { ok: true, eraKeys: null, label: "standard" };
  }

  return {
    ok: true,
    eraKeys: normalized,
    label: normalized.map((key) => SURVIVAL_IMAGE_TAG_LABELS[key] || key).join(", "),
  };
}

function parseLeaderboardMonthInput(raw, fallbackMonth) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: true, month: fallbackMonth };
  }
  const month = raw.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return {
      ok: false,
      reason: "Month must use `YYYY-MM` format (example: 2026-04).",
    };
  }
  return { ok: true, month };
}

function formatSurvivalMultiplier(value) {
  const n = Number(value || 1);
  if (!Number.isFinite(n)) return "1x";
  return `${parseFloat(n.toFixed(2))}x`;
}

function normalizeSurvivalPingRoleIds(raw) {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(",")
    : raw == null
    ? []
    : [String(raw)];
  const ids = [];
  const seen = new Set();

  for (const value of values) {
    const matches = String(value || "").match(/\d{6,}/g) || [];
    for (const id of matches) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  return ids;
}

function formatSurvivalPingRoles(roleIds) {
  const normalized = normalizeSurvivalPingRoleIds(roleIds);
  return normalized.length
    ? normalized.map((id) => `<@&${id}>`).join(" ")
    : "@everyone";
}

async function resolveSurvivalPingRoleInput(guild, rawInput) {
  if (rawInput === null || rawInput === undefined) {
    return { ok: true, roleIds: null };
  }

  const input = String(rawInput).trim();
  if (!input) {
    return { ok: true, roleIds: [] };
  }

  const lowered = input.toLowerCase();
  if (["everyone", "@everyone", "all", "default", "none"].includes(lowered)) {
    return { ok: true, roleIds: [] };
  }

  const directIds = normalizeSurvivalPingRoleIds(input);
  if (directIds.length) {
    return { ok: true, roleIds: directIds };
  }

  let roleCollection = guild?.roles?.cache;
  if (!roleCollection?.size && guild?.roles?.fetch) {
    try {
      roleCollection = await guild.roles.fetch();
    } catch {
      roleCollection = guild?.roles?.cache || null;
    }
  }

  if (!roleCollection?.size) {
    return {
      ok: false,
      reason: "Couldn't load server roles for `ping_role`.",
    };
  }

  const names = input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const resolved = [];
  const seen = new Set();

  for (const name of names) {
    const normalizedName = name.replace(/^@/, "").trim().toLowerCase();
    const role = roleCollection.find(
      (entry) => entry?.name?.trim().toLowerCase() === normalizedName
    );

    if (!role?.id) {
      return {
        ok: false,
        reason:
          `Unknown ping role: \`${name}\`. Use @everyone, a role mention, a role ID, or an exact role name.`,
      };
    }

    if (!seen.has(role.id)) {
      seen.add(role.id);
      resolved.push(role.id);
    }
  }

  return { ok: true, roleIds: resolved };
}

function buildSurvivalPingRoleSelectRow(roleIds) {
  const normalized = normalizeSurvivalPingRoleIds(roleIds).slice(0, 25);
  return new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId("survive:config:ping-roles:select")
      .setPlaceholder("Select role(s) to ping")
      .setMinValues(1)
      .setMaxValues(Math.min(5, Math.max(1, normalized.length || 5)))
      .setDefaultRoles(...normalized)
  );
}

function normalizeSurvivalSettings(raw = {}) {
  const type = raw?.type === "timed" ? "timed" : "team_start";
  const hasPingRoleIds =
    raw && (Object.prototype.hasOwnProperty.call(raw, "ping_role_ids") ||
    Object.prototype.hasOwnProperty.call(raw, "ping_roles"));
  const requestedEraKey =
    typeof raw?.era_key === "string" && raw.era_key.trim()
      ? raw.era_key.trim()
      : null;
  const requestedEraLabel =
    typeof raw?.era === "string" && raw.era.trim() ? raw.era.trim() : null;
  const matchedEraByLabel = requestedEraLabel
    ? Object.entries(SURVIVAL_ERA_LABELS).find(
        ([, label]) => label.toLowerCase() === requestedEraLabel.toLowerCase()
      )?.[0]
    : null;
  const eraKey = SURVIVAL_ERAS[requestedEraKey]
    ? requestedEraKey
    : matchedEraByLabel || "day_one";
  const eraDefinition = getSurvivalEraDefinition(eraKey);
  const timeMinutes = Math.max(1, Number(raw?.time_minutes || raw?.minutes || 5) || 5);
  const bonusRequiredPlayers = Math.max(
    1,
    Number(raw?.bonus_required_players || raw?.bonus_required || 10) || 10
  );
  const rawBonusMultiplier =
    raw?.bonus_multiplier === null || raw?.bonus_multiplier === undefined
      ? 1.5
      : Number(raw.bonus_multiplier);
  const bonusMultiplier =
    Number.isFinite(rawBonusMultiplier) && rawBonusMultiplier >= 1
      ? Number(rawBonusMultiplier.toFixed(2))
      : 1.5;
  const bonusPrize = String(raw?.bonus_prize || "").trim().slice(0, 300);

  return {
    type,
    era_key: eraKey,
    era: eraDefinition.label,
    time_minutes: timeMinutes,
    ping_role_ids: normalizeSurvivalPingRoleIds(
      hasPingRoleIds ? raw?.ping_role_ids ?? raw?.ping_roles : DEFAULT_SURVIVAL_ROLE_ID
    ),
    creator_chaos: Boolean(raw?.creator_chaos),
    revives_enabled:
      raw?.revives_enabled === null || raw?.revives_enabled === undefined
        ? true
        : Boolean(raw?.revives_enabled),
    bonus_active: Boolean(raw?.bonus_active),
    bonus_required_players: bonusRequiredPlayers,
    bonus_multiplier: bonusMultiplier,
    bonus_prize: bonusPrize || null,
    replay: Boolean(raw?.replay),
    pool_increment:
      Math.max(1, Number(raw?.pool_increment || SURVIVAL_BASE_POOL_INCREMENT) || 1) ||
      SURVIVAL_BASE_POOL_INCREMENT,
  };
}

function cloneSurvivalSettings(settings) {
  return normalizeSurvivalSettings(settings);
}

function formatSurvivalBonusPrize(settings) {
  return settings?.bonus_prize || "None";
}

async function getSurvivalStandardSettings(forceRefresh = false) {
  if (!forceRefresh && survivalStandardSettings) {
    return cloneSurvivalSettings(survivalStandardSettings);
  }

  try {
    const saved = await Store.getSurvivalSettings();
    survivalStandardSettings = normalizeSurvivalSettings(saved || {});
  } catch {
    survivalStandardSettings = normalizeSurvivalSettings();
  }

  return cloneSurvivalSettings(survivalStandardSettings);
}

async function saveSurvivalStandardSettings(settings) {
  const normalized = normalizeSurvivalSettings(settings);
  survivalStandardSettings = normalized;
  await Store.upsertSurvivalSettings(normalized);
  return cloneSurvivalSettings(normalized);
}

function buildSurvivalMenuEmbed(standardSettings, note = null) {
  const settings = normalizeSurvivalSettings(standardSettings);
  const lines = [
    "Use this hidden panel to start a Survival lobby or change the saved standard setup.",
    "",
    `Active lobby: **${survivalLobby ? "Yes" : "No"}**`,
    `Standard Type: **${SURVIVAL_TYPE_LABELS[settings.type]}**`,
    `Standard Era: **${settings.era}**`,
    `Standard Ping Roles: **${formatSurvivalPingRoles(settings.ping_role_ids)}**`,
    `Standard Creator Chaos: **${settings.creator_chaos ? "On" : "Off"}**`,
    `Standard Revives: **${settings.revives_enabled ? "On" : "Off"}**`,
    `Standard Bonus: **${
      settings.bonus_active
        ? `${formatSurvivalMultiplier(settings.bonus_multiplier)} at ${settings.bonus_required_players}+ players`
        : "Off"
    }**`,
    `Standard Bonus Prize: **${
      settings.bonus_active ? formatSurvivalBonusPrize(settings) : "N/A"
    }**`,
    `Standard Replay: **${settings.replay ? "Yes" : "No"}**`,
  ];

  if (note) {
    lines.push("", note);
  }

  return new EmbedBuilder()
    .setTitle("Squig Survival - Hidden Menu")
    .setDescription(lines.join("\n"))
    .setColor(0x9b59b6);
}

function buildSurvivalMenuComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("survive:menu:play-standard")
        .setLabel("Play Standard")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("survive:menu:play-custom")
        .setLabel("Play Custom")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("survive:menu:set-standard")
        .setLabel("Set Standard")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildSurvivalSettingsEmbed(mode, settings, note = null, options = {}) {
  const cfg = normalizeSurvivalSettings(settings);
  const lines = [
    `Mode: **${mode === "standard" ? "Set Standard" : "Play Custom"}**`,
    "",
    `Pool Per Player: **+${cfg.pool_increment} $CHARM**`,
    `Type: **${SURVIVAL_TYPE_LABELS[cfg.type]}**`,
    `Era: **${cfg.era}**`,
    `Ping Roles: **${formatSurvivalPingRoles(cfg.ping_role_ids)}**`,
    `Time: **${cfg.type === "timed" ? `${cfg.time_minutes} minute(s)` : "N/A (Team Start)" }**`,
    `Creator Chaos: **${cfg.creator_chaos ? "Y" : "N"}**`,
    `Revives: **${cfg.revives_enabled ? "Y" : "N"}**`,
    `Bonus Active: **${cfg.bonus_active ? "Y" : "N"}**`,
    `Bonus Rq'd: **${cfg.bonus_active ? cfg.bonus_required_players : "N/A"}**`,
    `Bonus Multiplier: **${
      cfg.bonus_active ? formatSurvivalMultiplier(cfg.bonus_multiplier) : "N/A"
    }**`,
    `Bonus Prize: **${cfg.bonus_active ? formatSurvivalBonusPrize(cfg) : "N/A"}**`,
    `Replay: **${cfg.replay ? "Y" : "N"}**`,
  ];

  if (options.selectingPingRoles) {
    lines.push(
      "",
      "Role picker open below. Select roles from the server list or use the @everyone button."
    );
  }

  if (note) {
    lines.push("", note);
  }

  return new EmbedBuilder()
    .setTitle("Squig Survival - Game Settings")
    .setDescription(lines.join("\n"))
    .setColor(0x3498db);
}

function buildSurvivalSettingsComponents(mode, settings, options = {}) {
  const cfg = normalizeSurvivalSettings(settings);
  const presetMultipliers = [1.5, 2, 2.5];

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("survive:config:pool")
        .setLabel("Pool")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("survive:config:type")
        .setLabel("Type")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("survive:config:era")
        .setLabel("Era")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("survive:config:ping-roles")
        .setLabel("Ping Role")
        .setStyle(options.selectingPingRoles ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("survive:config:time")
        .setLabel("Time")
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("survive:config:creator-chaos")
        .setLabel("Creator Chaos")
        .setStyle(cfg.creator_chaos ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("survive:config:revives")
        .setLabel("Revives")
        .setStyle(cfg.revives_enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("survive:config:bonus-active")
        .setLabel("Bonus Active")
        .setStyle(cfg.bonus_active ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("survive:config:bonus-req")
        .setLabel("Bonus Rq'd")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!cfg.bonus_active),
      new ButtonBuilder()
        .setCustomId("survive:config:replay")
        .setLabel("Replay")
        .setStyle(cfg.replay ? ButtonStyle.Success : ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      ...presetMultipliers.map((value) =>
        new ButtonBuilder()
          .setCustomId(`survive:config:bonus-mult:${value}`)
          .setLabel(`${value}x`)
          .setStyle(
            cfg.bonus_active && cfg.bonus_multiplier === value
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          )
          .setDisabled(!cfg.bonus_active)
      ),
      new ButtonBuilder()
        .setCustomId("survive:config:bonus-mult:custom")
        .setLabel("Custom")
        .setStyle(
          cfg.bonus_active && !presetMultipliers.includes(cfg.bonus_multiplier)
            ? ButtonStyle.Success
            : ButtonStyle.Secondary
        )
        .setDisabled(!cfg.bonus_active)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("survive:config:save")
        .setLabel(mode === "standard" ? "Save Standard" : "Start Custom")
        .setStyle(ButtonStyle.Success),
      ...(options.selectingPingRoles
        ? [
            new ButtonBuilder()
              .setCustomId("survive:config:ping-roles:everyone")
              .setLabel("@everyone")
              .setStyle(
                cfg.ping_role_ids.length ? ButtonStyle.Secondary : ButtonStyle.Success
              ),
          ]
        : []),
      new ButtonBuilder()
        .setCustomId("survive:config:cancel")
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];

  if (options.selectingPingRoles) {
    rows.splice(
      1,
      0,
      buildSurvivalPingRoleSelectRow(cfg.ping_role_ids)
    );
  }

  return rows;
}

function buildSurvivalLobbyAnnouncement(settings, isReplay = false) {
  const cfg = normalizeSurvivalSettings(settings);
  const pingPrefix = formatSurvivalPingRoles(cfg.ping_role_ids);
  const parts = [
    `${pingPrefix !== "None" ? `${pingPrefix} ` : ""}${
      isReplay ? "Squig Survival replay lobby is open!" : "Squig Survival is open!"
    }`,
    "Click **Join** on the panel above to hop in.",
  ];

  if (cfg.bonus_active) {
    parts.push(
      `Bonus is live at **${cfg.bonus_required_players}+** players for **${formatSurvivalMultiplier(
        cfg.bonus_multiplier
      )}** total prize pool.`
    );
    if (cfg.bonus_prize) {
      parts.push(`Bonus prize: **${formatSurvivalBonusPrize(cfg)}**.`);
    }
  }

  return parts.join(" ");
}

async function persistSurvivalLobby(lobby) {
  try {
    await Store.upsertSurvivalLobby(lobby);
  } catch {}
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function buildSurvivalSetupParagraph(cfg, countdownMs, options = {}) {
  const countdownLabel = options.countdownLabel || "Auto-start";
  const noCountdownLabel =
    options.noCountdownLabel || "The game starts when staff open it.";
  const timingText =
    cfg.type === "timed"
      ? ` The timed round lasts **${cfg.time_minutes} minute(s)**.`
      : "";
  const bonusText = cfg.bonus_active
    ? `Bonus mode is active, so hitting **${cfg.bonus_required_players}+** players boosts the total prize pool to **${formatSurvivalMultiplier(
        cfg.bonus_multiplier
      )}**`
    : "Bonus mode is off";
  const bonusPrizeText =
    cfg.bonus_active && cfg.bonus_prize
      ? ` and unlocks bonus prize **${formatSurvivalBonusPrize(cfg)}**`
      : "";
  const countdownText =
    typeof countdownMs === "number"
      ? `${countdownLabel} is **${formatCountdown(countdownMs)}**`
      : noCountdownLabel;
  const creatorChaosText = cfg.creator_chaos
    ? "Creator Chaos is **ON**, which means there is only **1 elimination per image**"
    : "Creator Chaos is **OFF**";

  return `${countdownText}. This lobby is set to the **${cfg.era}** era, with **+${cfg.pool_increment} $CHARM per Squig** added to the prize pool.${timingText} ${creatorChaosText}, and **!revive** is **${cfg.revives_enabled ? "ON" : "OFF"}**. ${bonusText}${bonusPrizeText}.`;
}

function buildSurvivalLobbyEmbed(settings, count, countdownMs) {
  const cfg = normalizeSurvivalSettings(settings);
  if (cfg.era_key === "movie_theater") {
    const lines = [
      "The Ugly Theater is open. Grab a seat, keep your head down, and try to survive the screening long enough to get paid.",
      "",
      buildSurvivalSetupParagraph(cfg, countdownMs, {
        countdownLabel: "Game start",
        noCountdownLabel: "The screening starts when staff open the theater",
      }),
      "",
      `Right now there ${count === 1 ? "is" : "are"} **${count}** Squig${
        count === 1 ? "" : "s"
      } in the audience. Click **Join** before security starts watching the aisles.`,
    ];

    return new EmbedBuilder()
      .setTitle("Squig Survival - Lobby Open")
      .setImage("https://i.imgur.com/GFyykAa.png")
      .setDescription(lines.join("\n"))
      .setColor(0xc0392b);
  }

  if (cfg.era_key === "airport") {
    const lines = [
      "The terminal is packed, the departure board keeps changing, and every Squig is trying to make it home before the airport decides otherwise.",
      "",
      buildSurvivalSetupParagraph(cfg, countdownMs, {
        countdownLabel: "Boarding begins in",
        noCountdownLabel: "Boarding begins when staff open the gate",
      }),
      "",
      `Right now there ${count === 1 ? "is" : "are"} **${count}** Squig${
        count === 1 ? "" : "s"
      } at the gate. Click **Join** before the first delay ruins everything.`,
    ];

    return new EmbedBuilder()
      .setTitle("Squig Survival - Terminal Open")
      .setImage("https://i.imgur.com/jrWVQbv.png")
      .setDescription(lines.join("\n"))
      .setColor(0x2980b9);
  }

  if (cfg.era_key === "zombie_apocalypse") {
    const lines = [
      "The outbreak is spreading and the Squigs are gearing up to survive. Barricades are going up, supplies are getting snatched, and nobody plans to get dragged into the undead crowd without a fight.",
      "",
      buildSurvivalSetupParagraph(cfg, countdownMs, {
        countdownLabel: "Containment begins in",
        noCountdownLabel: "Containment begins when staff seal the safehouse",
      }),
      "",
      `Right now there ${count === 1 ? "is" : "are"} **${count}** Squig${
        count === 1 ? "" : "s"
      } in the safehouse. Click **Join** and gear up before the barricades break and the infection comes through the walls.`,
    ];

    return new EmbedBuilder()
      .setTitle("Squig Survival - Infection Detected")
      .setImage("https://i.imgur.com/ZWUTauD.png")
      .setDescription(lines.join("\n"))
      .setColor(0x27ae60);
  }

  const lines = [
    "Squig Survival is open. Step through the portal and see how long your Squig can make it on Earth before the story turns on you.",
    "",
    buildSurvivalSetupParagraph(cfg, countdownMs, {
      countdownLabel: "Auto-start",
      noCountdownLabel: "The round starts when staff run **/survivestart**",
    }),
    "",
    `Right now there ${count === 1 ? "is" : "are"} **${count}** Squig${
      count === 1 ? "" : "s"
    } in the lobby. Click **Join** before the portal snaps shut.`,
  ];

  return new EmbedBuilder()
    .setTitle("Squig Survival - Lobby Open")
    .setImage("https://i.imgur.com/DGLFFyh.jpeg")
    .setDescription(lines.join("\n"))
    .setColor(0x9b59b6);
}

function clearSurvivalLobby() {
  if (survivalLobby?.collector) {
    try {
      survivalLobby.collector.stop("cleared");
    } catch {}
  }
  if (survivalLobby?.countdownInterval) {
    clearInterval(survivalLobby.countdownInterval);
  }
  if (survivalLobby?.countdownTimers?.length) {
    survivalLobby.countdownTimers.forEach((t) => clearTimeout(t));
  }
  survivalLobby = null;
  try {
    Store.clearSurvivalLobby().catch(() => {});
  } catch {}
}

function buildLobbyJumpButton(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  const url = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Back to Lobby")
      .setURL(url)
  );
}

async function openSurvivalLobby(channel, createdBy, settings, options = {}) {
  if (survivalLobby) {
    return {
      ok: false,
      reason:
        "A /survive lobby is already active. Use /survivestart to begin or end/cancel it.",
    };
  }

  if (!channel) {
    return { ok: false, reason: "Can't find channel for this command." };
  }

  const cfg = normalizeSurvivalSettings(settings);
  const countdownEnd =
    cfg.type === "timed" ? Date.now() + cfg.time_minutes * 60_000 : null;
  const joinEmbed = buildSurvivalLobbyEmbed(
    cfg,
    0,
    countdownEnd ? countdownEnd - Date.now() : undefined
  );

  const joinRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("survive:join")
      .setLabel("Join")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("survive:leave")
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("survive:list")
      .setLabel("Players Joined")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("survive:stats")
      .setLabel("My Stats")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("survive:info")
      .setLabel("Info")
      .setStyle(ButtonStyle.Secondary)
  );
  const submitImagesRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Submit Images")
      .setURL(SURVIVAL_IMAGE_SUBMISSION_URL)
  );

  const joinMessage = await channel.send({
    embeds: [joinEmbed],
    components: [joinRow, submitImagesRow],
  });

  try {
    await channel.send(
      buildSurvivalLobbyAnnouncement(cfg, Boolean(options?.isReplay))
    );
  } catch {}

  survivalLobby = {
    created_by: createdBy || null,
    created_at: new Date().toISOString(),
    joined: new Set(),
    game_status: "lobby",
    channel_id: channel.id,
    guild_id: channel.guildId,
    join_message_id: joinMessage.id,
    join_message: joinMessage,
    era: cfg.era,
    pool_increment: cfg.pool_increment,
    countdown_end: countdownEnd,
    countdownInterval: null,
    countdownTimers: [],
    collector: null,
    settings: cfg,
  };

  await persistSurvivalLobby(survivalLobby);
  setupSurvivalCountdown(survivalLobby, channel);

  return { ok: true, lobby: survivalLobby };
}

function setupSurvivalCountdown(lobby, channel) {
  if (!lobby?.countdown_end) return;
  const totalMs = lobby.countdown_end - Date.now();
  if (totalMs <= 0) {
    setTimeout(() => {
      if (!survivalLobby || survivalLobby.game_status !== "lobby") return;
      startSurvivalFromLobby(null, survivalLobby);
    }, 250);
    return;
  }

  const totalSec = Math.max(1, Math.floor(totalMs / 1000));
  const finalPingSec = totalSec / 3 < 30 ? 10 : 30;
  const pingTimes = [
    Math.floor((totalSec * 2) / 3),
    Math.floor(totalSec / 3),
    finalPingSec,
  ];
  const uniquePingTimes = Array.from(new Set(pingTimes))
    .filter((s) => s > 0 && s < totalSec)
    .sort((a, b) => b - a);

  const jumpRow = buildLobbyJumpButton(
    lobby.guild_id,
    lobby.channel_id,
    lobby.join_message_id
  );

  uniquePingTimes.forEach((remainingSec) => {
    const delayMs = Math.max(0, (totalSec - remainingSec) * 1000);
    const t = setTimeout(async () => {
      if (!survivalLobby || survivalLobby.game_status !== "lobby") return;
      const pingPrefix = formatSurvivalPingRoles(
        lobby.settings?.ping_role_ids || []
      );
      const msg = `${
        pingPrefix !== "None" ? `${pingPrefix} ` : ""
      }⏳ Squig Survival starts in **${formatCountdown(remainingSec * 1000)}**.`;
      try {
        await channel.send(
          jumpRow ? { content: msg, components: [jumpRow] } : { content: msg }
        );
      } catch {}
    }, delayMs);
    lobby.countdownTimers.push(t);
  });

  const autoStartTimer = setTimeout(async () => {
    if (!survivalLobby || survivalLobby.game_status !== "lobby") return;
    await startSurvivalFromLobby(null, survivalLobby);
  }, totalMs);
  lobby.countdownTimers.push(autoStartTimer);

  lobby.countdownInterval = setInterval(async () => {
    if (!survivalLobby || survivalLobby.game_status !== "lobby") return;
    const remaining = lobby.countdown_end - Date.now();
    if (remaining <= 0) return;
    try {
      const updated = buildSurvivalLobbyEmbed(
        lobby.settings || { era: lobby.era, pool_increment: lobby.pool_increment },
        lobby.joined.size,
        remaining
      );
      await lobby.join_message.edit({ embeds: [updated] });
    } catch {}
  }, 15_000);
}

async function initSurvivalLobby(client) {
  try {
    const saved = await Store.getSurvivalLobby();
    if (!saved || saved.game_status !== "lobby") {
      if (saved) {
        await Store.clearSurvivalLobby();
      }
      return;
    }

    const channel = await client.channels.fetch(saved.channel_id).catch(() => null);
    if (!channel) {
      await Store.clearSurvivalLobby();
      return;
    }

    const joinMessage = await channel.messages
      .fetch(saved.join_message_id)
      .catch(() => null);
    if (!joinMessage) {
      await Store.clearSurvivalLobby();
      return;
    }

    let joinedIds = saved.joined_ids || [];
    if (typeof joinedIds === "string") {
      try {
        joinedIds = JSON.parse(joinedIds);
      } catch {
        joinedIds = [];
      }
    }

    const countdownEnd = saved.countdown_end
      ? new Date(saved.countdown_end).getTime()
      : null;

    survivalLobby = {
      created_by: saved.created_by,
      created_at: saved.created_at,
      joined: new Set(Array.isArray(joinedIds) ? joinedIds : []),
      game_status: "lobby",
      channel_id: saved.channel_id,
      guild_id: saved.guild_id,
      join_message_id: saved.join_message_id,
      join_message: joinMessage,
      era: saved.era,
      pool_increment: saved.pool_increment || SURVIVAL_BASE_POOL_INCREMENT,
      countdown_end: countdownEnd,
      countdownInterval: null,
      countdownTimers: [],
      collector: null,
      settings: normalizeSurvivalSettings(
        saved.settings || {
          era: saved.era,
          pool_increment: saved.pool_increment || SURVIVAL_BASE_POOL_INCREMENT,
          type: countdownEnd ? "timed" : "team_start",
        }
      ),
    };

    const remaining = countdownEnd ? countdownEnd - Date.now() : undefined;
    const updated = buildSurvivalLobbyEmbed(
      survivalLobby.settings,
      survivalLobby.joined.size,
      remaining
    );
    await joinMessage.edit({ embeds: [updated] });

    setupSurvivalCountdown(survivalLobby, channel);
  } catch {}
}

async function startSurvivalFromLobby(interaction, lobby) {
  if (!lobby || lobby.game_status !== "lobby") return;
  lobby.game_status = "running";
  try {
    Store.clearSurvivalLobby().catch(() => {});
  } catch {}
  if (lobby.collector) {
    try {
      lobby.collector.stop("start");
    } catch {}
  }
  if (lobby.countdownInterval) {
    clearInterval(lobby.countdownInterval);
    lobby.countdownInterval = null;
  }
  if (lobby.countdownTimers?.length) {
    lobby.countdownTimers.forEach((t) => clearTimeout(t));
    lobby.countdownTimers = [];
  }

  const players = Array.from(lobby.joined || []);
  const settings = normalizeSurvivalSettings(
    lobby.settings || {
      era: lobby.era,
      pool_increment: lobby.pool_increment || SURVIVAL_BASE_POOL_INCREMENT,
      type: lobby.countdown_end ? "timed" : "team_start",
    }
  );
  const shouldReplay = Boolean(settings.replay);
  const replaySettings = cloneSurvivalSettings({
    ...settings,
    replay: false,
  });
  const replayCreatedBy = lobby.created_by;
  const channel =
    interaction?.client?.channels?.cache?.get(lobby.channel_id) ||
    lobby?.join_message?.channel ||
    interaction?.channel;

  if (!channel) {
    clearSurvivalLobby();
    if (interaction) {
      return interaction.reply({
        content: "❌ Can't find the Survival lobby channel.",
        flags: 64,
      });
    }
    return;
  }

  if (players.length === 0) {
    clearSurvivalLobby();
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Squig Survival - Cancelled")
          .setDescription(
            "No Squigs stepped through the portal. The universe shrugs and goes back to scrolling X."
          )
          .setColor(0xe74c3c),
      ],
    });
    if (interaction) {
      return interaction.reply({
        content: "No players joined. Lobby cancelled.",
        flags: 64,
      });
    }
    return;
  }

  if (interaction) {
    await interaction.reply({
      content: "Squig Survival starting.",
      flags: 64,
    });
  }
  await channel.send("Game starting now.");

  const startEmbed =
    settings.era_key === "movie_theater"
      ? new EmbedBuilder()
          .setTitle("Squig Survival - The Movie is starting")
          .setDescription(
            [
              "Take your seats and enjoy the show.",
              `Security is watching all **${players.length}** of you in the theater.`,
              "Looks like a rowdy bunch we have in here, lets see who stays for the whole show.",
            ].join("\n")
          )
          .setImage("https://i.imgur.com/2TPjlR1.png")
          .setColor(0xe67e22)
      : settings.era_key === "airport"
      ? new EmbedBuilder()
          .setTitle("Squig Survival - Final Boarding Begins")
          .setDescription(
            [
              "The departure board flickers and the terminal starts lying to everyone at once.",
              `All **${players.length}** of you are trying to get home before delays, gate changes, and pure airport cruelty take over.`,
              "Keep moving. Miss the flight, miss the game.",
            ].join("\n")
          )
          .setColor(0x3498db)
      : settings.era_key === "zombie_apocalypse"
      ? new EmbedBuilder()
          .setTitle("Squig Survival - Game Starting!")
          .setDescription(
            [
              "The safehouse is full, the shelves are running bare, and staying put is no longer an option.",
              `It's time for **${players.length} Squigs** to step outside and face the undead.`,
            ].join("\n")
          )
          .setImage("https://i.imgur.com/TZupWKD.png")
          .setColor(0x27ae60)
      : new EmbedBuilder()
          .setTitle("Squig Survival - Game Starting!")
          .setDescription(
            [
              `The portal snaps shut. **${players.length} Squigs** are now loose on Earth.`,
              "Sit back and watch who survives the chaos...",
            ].join("\n")
          )
          .setImage("http://gifs.squigs.io/gifs/v-bullish-fly.gif")
          .setColor(0x2ecc71);

  await channel.send({ embeds: [startEmbed] });

  try {
    await runSurvival(channel, players, settings);
  } finally {
    clearSurvivalLobby();
  }

  if (shouldReplay) {
    const replayTimer = setTimeout(async () => {
      const result = await openSurvivalLobby(
        channel,
        replayCreatedBy,
        replaySettings,
        { isReplay: true }
      );
      if (!result.ok) {
        try {
          await channel.send(
            "Replay lobby did not reopen because another Squig Survival lobby is already active."
          );
        } catch {}
      }
    }, SURVIVAL_REPLAY_DELAY_MS);
    if (replayTimer?.unref) replayTimer.unref();
  }
}


async function sendEphemeral(interaction, payload) {
  const { noExpire, ...rest } = payload;
  let msg;

  const base = { ...rest, flags: 64 }; // 64 = EPHEMERAL

  if (interaction.deferred || interaction.replied) {
    // followUp *does* return a Message
    msg = await interaction.followUp(base);
  } else {
    // reply returns void ? fetchReply to get the Message
    await interaction.reply(base);
    msg = await interaction.fetchReply();
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
  const msg = await sendEphemeral(interaction, { embeds: [embed], components });
  const picked = await msg
    .awaitMessageComponent({ componentType: ComponentType.Button, time: timeMs })
    .catch(() => null);

  try {
    const rows = (components || []).map((row) =>
      new ActionRowBuilder().addComponents(
        row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
      )
    );
    await msg.edit({ components: rows });
  } catch {}

  return picked;
}

// --------------------------------------------
// MINI-GAME / RIDDLE RUNNERS (ephemeral, solo)
// --------------------------------------------
async function runMiniGameEphemeral(interaction, player, usedMini) {
  const selected = pickMiniGame(usedMini);

  const embed = withScore(
    new EmbedBuilder()
      .setTitle(selected.title)
      .setDescription(
        `${selected.lore}\n\n_${rand(
          miniGameFateDescriptions
        )}_\n\n⏳ You have **30 seconds** to choose.`
      )
      .setColor(0xff33cc),
    player
  );
  if (selected.image) embed.setImage(selected.image);

  const row = new ActionRowBuilder().addComponents(
    selected.buttons.map((label, i) =>
      new ButtonBuilder()
        .setCustomId(`mg:${Date.now()}:${i}`)
        .setLabel(label)
        .setStyle(
          [ButtonStyle.Primary, ButtonStyle.Danger, ButtonStyle.Secondary, ButtonStyle.Success][
            i % 4
          ]
        )
    )
  );

  const click = await ephemeralPrompt(interaction, embed, [row], 30_000);
  if (!click) {
    await sendEphemeral(interaction, { content: "⏳ Time’s up — no choice, no change." });
    return;
  }

  const delta = rand([-2, -1, 1, 2]);
  player.points += delta;

  const flavorList = pointFlavors[delta > 0 ? `+${delta}` : `${delta}`] || [];
  const flavor = flavorList.length ? rand(flavorList) : "";

  await click.reply({
    content: `You chose **${click.component.label}** — **${
      delta > 0 ? "+" : ""
    }${delta}**. ${flavor}\n**New total:** ${player.points}`,
    flags: 64,
  });
}

async function runRiddleEphemeral(interaction, player, usedRiddle) {
  const r = pickRiddle(usedRiddle);
  if (!r) {
    await sendEphemeral(interaction, { content: "⚠️ No riddles left. Skipping." });
    return;
  }

  const difficultyLabel =
    r.difficulty === 1
      ? "EASY"
      : r.difficulty === 2
      ? "MEDIUM"
      : r.difficulty === 3
      ? "HARD"
      : "SQUIG SPECIAL";

  const embed = withScore(
    new EmbedBuilder()
      .setTitle("🧩 RIDDLE TIME")
      .setDescription(
        `_${r.riddle}_\n\n🧠 Difficulty: **${difficultyLabel}** — Worth **+${r.difficulty}**.\n⏳ You have **30 seconds**.`
      )
      .setColor(0xff66cc),
    player
  );

  const answerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("riddle:answer").setLabel("Answer").setStyle(ButtonStyle.Primary)
  );

  const riddleMsg = await sendEphemeral(interaction, {
    embeds: [embed],
    components: [answerRow],
    noExpire: true,
  });

  const totalWindowMs = 30_000;
  const endAt = Date.now() + totalWindowMs;

  let buttonClick = null;
  try {
    buttonClick = await riddleMsg.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: totalWindowMs,
      filter: (i) =>
        i.customId === "riddle:answer" && i.user.id === interaction.user.id,
    });
  } catch {
    /* timeout */
  }

  try {
    const disabled = new ActionRowBuilder().addComponents(
      answerRow.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
    );
    await riddleMsg.edit({ components: [disabled] });
  } catch {}

  if (!buttonClick) {
    await sendEphemeral(interaction, {
      content: `⏳ Time’s up! Correct answer: **${r.answers[0]}**.`,
    });
    setTimeout(async () => {
      try {
        await riddleMsg.delete();
      } catch {}
    }, 1_000);
    return;
  }

  const remaining = Math.max(1_000, endAt - Date.now());

  // Modal with riddle shown as placeholder
  const modal = new ModalBuilder().setCustomId("riddle:modal").setTitle("Riddle Answer");

  // Discord placeholder max ~100 chars – truncate if needed
  const displayRiddle = r.riddle.length > 100 ? r.riddle.slice(0, 97) + "..." : r.riddle;

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("riddle:input")
        .setLabel("Your answer")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(displayRiddle) // riddle reminder
    )
  );

  try {
    await buttonClick.showModal(modal);
  } catch {
    /* ignore */
  }

  let submit = null;
  try {
    submit = await buttonClick.awaitModalSubmit({
      time: remaining,
      filter: (i) =>
        i.customId === "riddle:modal" && i.user.id === interaction.user.id,
    });
  } catch {
    /* timeout */
  }

  if (!submit) {
    await sendEphemeral(interaction, {
      content: `⏳ No answer submitted. Correct: **${r.answers[0]}**.`,
    });
    setTimeout(async () => {
      try {
        await riddleMsg.delete();
      } catch {}
    }, 1_000);
    return;
  }

  const ans = submit.fields.getTextInputValue("riddle:input").trim().toLowerCase();
  const correct = r.answers.map((a) => a.toLowerCase()).includes(ans);

  try {
    if (correct) {
      player.points += r.difficulty;
      await submit.reply({
        content: `✅ Correct! **+${r.difficulty}**. **Current total:** ${player.points}`,
        flags: 64,
      });
    } else {
      await submit.reply({
        content: `❌ Not quite. Correct: **${r.answers[0]}**.\n**Current total:** ${player.points}`,
        flags: 64,
      });
    }
  } catch {
    await sendEphemeral(interaction, {
      content: correct
        ? `✅ Correct! **+${r.difficulty}**. **Current total:** ${player.points}`
        : `❌ Not quite. Correct: **${r.answers[0]}**.\n**Current total:** ${player.points}`,
    });
  }

  setTimeout(async () => {
    try {
      await riddleMsg.delete();
    } catch {}
  }, 1_000);
}

async function runLabyrinthEphemeral(interaction, player) {
  const title = "🧭 The Labyrinth of Wrong Turns";
  const dirPairs = [
    ["Left", "Right"],
    ["Up", "Down"],
    ["Left", "Down"],
    ["Right", "Up"],
  ];
  const correctPath = Array.from({ length: 4 }, (_, i) =>
    rand(dirPairs[i % dirPairs.length])
  );

  await sendEphemeral(interaction, {
    embeds: [
      withScore(
        new EmbedBuilder()
          .setTitle(title)
          .setDescription(
            "Find the exact **4-step** path.\n➕ Each step **+1**, 🗝️ escape **+2**.\n⏳ **60s** total."
          )
          .setColor(0x7f00ff)
          .setImage("https://i.imgur.com/MA1CdEC.jpeg"),
        player
      ),
    ],
  });

  let step = 0,
    earned = 0,
    alive = true;
  const deadline = Date.now() + 60_000;

  while (alive && step < 4) {
    const pair = dirPairs[step % dirPairs.length];
    const row = new ActionRowBuilder().addComponents(
      pair.map((d, i) =>
        new ButtonBuilder()
          .setCustomId(`lab:${step}:${i}`)
          .setLabel(d)
          .setStyle(ButtonStyle.Primary)
      )
    );

    const msg = await sendEphemeral(interaction, {
      content: `Labyrinth step **${step + 1}** — choose:`,
      components: [row],
    });

    const timeLeft = Math.max(0, deadline - Date.now());

    const click = await msg
      .awaitMessageComponent({
        componentType: ComponentType.Button,
        time: timeLeft,
      })
      .catch(() => null);

    try {
      await msg.edit({
        components: [
          new ActionRowBuilder().addComponents(
            row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
          ),
        ],
      });
    } catch {}

    if (!click) {
      alive = false;
      break;
    }

    const label = click.component.label;
    if (label === correctPath[step]) {
      earned += 1;
      step += 1;
      await click.reply({ content: "✅ Correct step!", flags: 64 });
    } else {
      alive = false;
      await click.reply({ content: "❌ Dead end!", flags: 64 });
    }
  }

  if (step === 4) {
    earned += 2;
    await sendEphemeral(interaction, { content: `🗝️ You escaped! **+${earned}**` });
  } else if (earned > 0) {
    await sendEphemeral(interaction, {
      content: `✅ You managed **${earned}** step${earned === 1 ? "" : "s"}.`,
    });
  } else {
    await sendEphemeral(interaction, {
      content: "☠️ Lost at the first turn. **0**.",
    });
  }

  player.points += earned;
}

async function runRouletteEphemeral(interaction, player) {
  const embed = withScore(
    new EmbedBuilder()
      .setTitle("🎲 Squig Roulette")
      .setDescription(
        "Pick **1–6**. Roll at end. Match = **+2**, else **0**. **30s**."
      )
      .setColor(0x7f00ff)
      .setImage("https://i.imgur.com/BolGW1m.png"),
    player
  );

  const row1 = new ActionRowBuilder().addComponents(
    [1, 2, 3].map((n) =>
      new ButtonBuilder()
        .setCustomId(`rou:${n}`)
        .setLabel(String(n))
        .setStyle(ButtonStyle.Secondary)
    )
  );
  const row2 = new ActionRowBuilder().addComponents(
    [4, 5, 6].map((n) =>
      new ButtonBuilder()
        .setCustomId(`rou:${n}`)
        .setLabel(String(n))
        .setStyle(ButtonStyle.Secondary)
    )
  );

  const msg = await sendEphemeral(interaction, {
    embeds: [embed],
    components: [row1, row2],
  });

  const click = await msg
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
    })
    .catch(() => null);

  try {
    const disable = (row) =>
      new ActionRowBuilder().addComponents(
        row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
      );
    await msg.edit({ components: [disable(row1), disable(row2)] });
  } catch {}

  if (!click) {
    await sendEphemeral(interaction, {
      content: "⏳ No pick. The die rolls away.",
    });
    return;
  }

  const pickNum = Number(click.component.label);
  const rolled = 1 + Math.floor(Math.random() * 6);

  if (pickNum === rolled) {
    player.points += 2;
    await click.reply({
      content: `🎲 You picked **${pickNum}**. Rolled **${rolled}**. **+2**.`,
      flags: 64,
    });
  } else {
    await click.reply({
      content: `You picked **${pickNum}**. Rolled **${rolled}**. No match.`,
      flags: 64,
    });
  }
}

async function runRiskItEphemeral(interaction, player) {
  const embed = withScore(
    new EmbedBuilder()
      .setTitle("🪙 Risk It")
      .setDescription("Risk **All**, **Half**, **Quarter**, or **None**. **20s**.")
      .setColor(0xffaa00)
      .setImage("https://i.imgur.com/GHztzMk.png"),
    player
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("risk:all")
      .setLabel("Risk All")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("risk:half")
      .setLabel("Risk Half")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("risk:quarter")
      .setLabel("Risk Quarter")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("risk:none")
      .setLabel("No Risk")
      .setStyle(ButtonStyle.Success)
  );

  const msg = await sendEphemeral(interaction, {
    embeds: [embed],
    components: [row],
  });

  const click = await msg
    .awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 20_000,
    })
    .catch(() => null);

  try {
    await msg.edit({
      components: [
        new ActionRowBuilder().addComponents(
          row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
        ),
      ],
    });
  } catch {}

  if (!click) {
    await sendEphemeral(interaction, {
      content: "⏳ No decision — charm moves on.",
    });
    return;
  }

  const pts = Math.floor(player.points || 0);
  if (click.customId === "risk:none" || pts <= 0) {
    await click.reply({
      content: pts <= 0 ? "You have no points to risk." : "Sitting out.",
      flags: 64,
    });
    return;
  }

  let stake = 0;
  let label = "";

  if (click.customId === "risk:all") {
    stake = pts;
    label = "Risk All";
  }
  if (click.customId === "risk:half") {
    stake = Math.max(1, Math.floor(pts / 2));
    label = "Risk Half";
  }
  if (click.customId === "risk:quarter") {
    stake = Math.max(1, Math.floor(pts / 4));
    label = "Risk Quarter";
  }

  const outcomes = [
    { mult: -1, label: "💀 Lost it all" },
    { mult: 0, label: "😐 Broke even" },
    { mult: 0.5, label: "✨ Won 1.5×" },
    { mult: 1, label: "💰 Doubled" },
  ];

  const out = rand(outcomes);
  const delta = out.mult === -1 ? -stake : Math.round(stake * out.mult);
  player.points += delta;

  await click.reply({
    content: `${label} — ${out.label}. **${
      delta > 0 ? "+" : ""
    }${delta}**. New total: **${player.points}**`,
    flags: 64,
  });
}

// --------------------------------------------
// SOLO ORCHESTRATOR (Decision Gauntlet)
// --------------------------------------------
const GAUNTLET_DECISION_TIMEOUT_MS = 60_000;
const GAUNTLET_REVEAL_DELAY_MS = 900;
const GAUNTLET_RESULT_DISPLAY_MS = 1_400;
const GAUNTLET_RESTART_MESSAGE_MS = 2_200;
const GAUNTLET_COMPLETION_BONUS = 500;
const DECISION_GAUNTLET_PAYOUT_CHANNEL_ID = "1477463175665287410";
const DAILY_GAUNTLET_ITEM_KIT = {
  peek: 1,
  shield: 1,
  greed: 1,
  anchor: 1,
};
const GAUNTLET_ITEM_DEFS = {
  peek: {
    label: "Peek",
    description: "Reveals the safe choice for the current room.",
  },
  shield: {
    label: "Shield",
    description: "Blocks one fatal choice and clears the room.",
  },
  greed: {
    label: "Greed",
    description: "Doubles this room's reward, but a wrong choice ends the run.",
  },
  anchor: {
    label: "Anchor",
    description: "If this room kills you, restart from this room instead of Room 1.",
  },
};

const GAUNTLET_ROLE_LIFE_TIERS = [
  {
    lives: 3,
    roles: [
      "1404477669344542742",
    ],
  },
  {
    lives: 2,
    roles: [
      "1493998083824947240",
      "1290595729802530878",
    ],
  },
  {
    lives: 1,
    roles: [
      "1493997923632152697",
    ],
  },
];

const DECISION_GAUNTLET_ROUNDS = [
  {
    roundIndex: 1,
    passChance: 0.95,
    reward: 10,
    image: "https://i.imgur.com/X1ZMmnA.jpeg",
    text: [
      "Two identical doors. No markings. No sound behind them.",
      "One leads forward.",
      "The other ends everything before it even begins.",
      "",
      "Choose a door. InSquignito is waiting.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 2,
    passChance: 0.85,
    reward: 20,
    image: "https://i.imgur.com/4VqCQxL.jpeg",
    text: [
      "The glass bridge hums beneath his feet.",
      "One panel is reinforced.",
      "The other was never meant to hold weight.",
      "",
      "He can’t stay in the middle forever.",
      "Choose the next step.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 3,
    passChance: 0.75,
    reward: 30,
    image: "https://i.imgur.com/kYV5AF9.jpeg",
    text: [
      "Cold stone. Iron bars. Two levers.",
      "One unlocks the cell.",
      "The other seals it permanently.",
      "",
      "Pull one. Quickly.",
    ].join("\n"),
    buttons: ["A", "B"],
  },
  {
    roundIndex: 4,
    passChance: 0.65,
    reward: 40,
    image: "https://i.imgur.com/Emp2Z0z.jpeg",
    text: [
      "The air burns. The room is filling fast.",
      "Two masks hang on the wall.",
      "One filters the poison.",
      "One feeds it straight in.",
      "",
      "Choose before he collapses.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 5,
    passChance: 0.55,
    reward: 50,
    image: "https://i.imgur.com/lfTtRbB.jpeg",
    text: [
      "A hallway splits in two - perfectly mirrored.",
      "One path leads forward.",
      "The other folds reality inside out.",
      "",
      "Choose a reflection.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 6,
    passChance: 0.45,
    reward: 60,
    image: "https://i.imgur.com/6K0D77j.jpeg",
    text: [
      "Two identical glasses. Clear liquid.",
      "One is water.",
      "One is not.",
      "",
      "He must drink.",
      "Choose wisely.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 7,
    passChance: 0.4,
    reward: 70,
    image: "https://i.imgur.com/y9fAmwP.jpeg",
    text: [
      "A rock island in the center of a massive gorge.",
      "Two ropes stretch across the void.",
      "One will hold.",
      "One will snap.",
      "",
      "There is no third option.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 8,
    passChance: 0.3,
    reward: 80,
    image: "https://i.imgur.com/JhDG1UH.jpeg",
    text: [
      "An ancient tunnel splits into two dark passages.",
      "A faint breeze drifts from one side.",
      "The other smells... wrong.",
      "",
      "Choose the path.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 9,
    passChance: 0.15,
    reward: 90,
    image: "https://i.imgur.com/ng229d4.jpeg",
    text: [
      "Two rusted elevator doors.",
      "One creaks open just slightly.",
      "The other stands still and silent.",
      "",
      "One rises.",
      "One falls.",
      "",
      "Step inside.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
  {
    roundIndex: 10,
    passChance: 0.09,
    reward: 100,
    image: "https://i.imgur.com/5pI2xSt.jpeg",
    text: [
      "The arena falls silent.",
      "A spotlight locks onto InSquignito.",
      "Two glowing platforms stand before him.",
      "One is the podium.",
      "The other is a coffin dressed in light.",
      "",
      "The countdown begins.",
    ].join("\n"),
    buttons: ["Left", "Right"],
  },
];

const DECISION_GAUNTLET_RESTART_TEXT = [
  "He chose.",
  "",
  "DEAD.",
  "",
  "But not finished.",
  "",
  "InSquignito gets another chance...",
  "Returning to Room 1.",
].join("\n");

const DECISION_GAUNTLET_FAIL_END_TEXT = (amount) =>
  [
    "DEAD.",
    "",
    "No more chances.",
    "No more doors.",
    "",
    "InSquignito falls back into the void.",
    "The unbanked stack is lost.",
    "",
    `You walk away with ${amount} $CHARM.`,
    "",
    "Tomorrow, perhaps.",
  ].join("\n");

const DECISION_GAUNTLET_WIN_END_TEXT = [
  "ALIVE.",
  "",
  "The correct platform rises.",
  "The spotlight intensifies.",
  "The arena trembles.",
  "",
  "You have completed The Gauntlet.",
  "",
  "550 $CHARM earned",
  "+500 Completion Bonus",
  "",
  "Total: 1050 $CHARM",
  "",
  "Go brag. You earned it.",
].join("\n");

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getGauntletRoleIds(member) {
  if (!member?.roles) return [];
  if (Array.isArray(member.roles)) return member.roles.map((id) => String(id));
  if (Array.isArray(member.roles.cache)) {
    return member.roles.cache.map((role) => String(role.id));
  }
  if (typeof member.roles.cache?.keys === "function") {
    return Array.from(member.roles.cache.keys()).map((id) => String(id));
  }
  return [];
}

function getDecisionGauntletLives(member) {
  const roleIds = new Set(getGauntletRoleIds(member));
  for (const tier of GAUNTLET_ROLE_LIFE_TIERS) {
    if (tier.roles.some((roleId) => roleIds.has(roleId))) {
      return tier.lives;
    }
  }
  return 1;
}

function makeRunId(userId) {
  return `${userId}:${Date.now()}:${Math.floor(Math.random() * 100000)}`;
}

function getDecisionRound(roundIndex) {
  return DECISION_GAUNTLET_ROUNDS.find((round) => round.roundIndex === roundIndex);
}

function rerollSafeIndex() {
  return Math.floor(Math.random() * 2);
}

function getGreedLabel(greedLevel) {
  if (greedLevel >= 5) return "Voidbound";
  if (greedLevel >= 4) return "Unhinged";
  if (greedLevel >= 3) return "Reckless";
  if (greedLevel >= 2) return "Hungry";
  if (greedLevel >= 1) return "Tempted";
  return "Cautious";
}

function increaseGreedLevel(state) {
  state.greedLevel += 1;
  state.maxGreedLevel = Math.max(state.maxGreedLevel || 0, state.greedLevel);
}

function getRoundReward(state, round) {
  return round.reward * (state.greedActive ? 2 : 1);
}

function formatItemInventory(inventory = {}) {
  return Object.keys(GAUNTLET_ITEM_DEFS)
    .map((key) => `${GAUNTLET_ITEM_DEFS[key].label} x${Math.max(0, Number(inventory[key] || 0) || 0)}`)
    .join(" | ");
}

function formatActiveItems(state) {
  const active = [];
  if (state.peekedSafeIndex !== null && state.peekedSafeIndex !== undefined) {
    const round = getDecisionRound(state.roundIndex);
    active.push(`Peek: ${round.buttons[state.peekedSafeIndex]} is safe`);
  }
  if (state.shieldActive) active.push("Shield armed");
  if (state.greedActive) active.push("Greed armed");
  if (state.anchorActive) active.push("Anchor armed");
  return active.length ? active.join(" | ") : "None";
}

function buildDecisionComponents(state) {
  const round = getDecisionRound(state.roundIndex);
  const inventory = state.itemInventory || {};

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gauntlet:pick:${state.runId}:0`)
        .setLabel(round.buttons[0])
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`gauntlet:pick:${state.runId}:1`)
        .setLabel(round.buttons[1])
        .setStyle(ButtonStyle.Primary)
    ),
  ];

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gauntlet:item:${state.runId}:peek`)
        .setLabel(`Peek (${inventory.peek || 0})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Boolean(state.peekedSafeIndex !== null && state.peekedSafeIndex !== undefined) || (inventory.peek || 0) <= 0),
      new ButtonBuilder()
        .setCustomId(`gauntlet:item:${state.runId}:shield`)
        .setLabel(`Shield (${inventory.shield || 0})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Boolean(state.shieldActive) || (inventory.shield || 0) <= 0),
      new ButtonBuilder()
        .setCustomId(`gauntlet:item:${state.runId}:greed`)
        .setLabel(`Greed (${inventory.greed || 0})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Boolean(state.greedActive) || (inventory.greed || 0) <= 0),
      new ButtonBuilder()
        .setCustomId(`gauntlet:item:${state.runId}:anchor`)
        .setLabel(`Anchor (${inventory.anchor || 0})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Boolean(state.anchorActive) || (inventory.anchor || 0) <= 0)
    )
  );

  return rows;
}

function buildDecisionRoundPayload(state, note = null) {
  const round = getDecisionRound(state.roundIndex);
  const embed = new EmbedBuilder()
    .setTitle(`Decision Gauntlet - Round ${state.roundIndex}/10`)
    .setDescription(
      [
        note,
        round.text,
        "",
        `Room Reward: **${getRoundReward(state, round)} $CHARM**${state.greedActive ? " (Greed doubled)" : ""}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .setColor(0xc0392b)
    .setImage(round.image)
    .setFooter({
      text: [
        "Room Rule: one choice is safe; one choice is fatal",
        `Lives Remaining: ${"❤️".repeat(Math.max(0, state.livesRemaining)) || "None"}`,
        `Greed Level: ${state.greedLevel} (${getGreedLabel(state.greedLevel)})`,
        `Unbanked Stack at Risk: ${state.charmEarnedThisRun} $CHARM`,
        `Items: ${formatItemInventory(state.itemInventory)}`,
        `Active: ${formatActiveItems(state)}`,
      ].join("\n"),
    });

  return {
    content: null,
    embeds: [embed],
    components: buildDecisionComponents(state),
  };
}

function buildPostRoundDecisionPayload(state, round, earnedOverride = null) {
  const earned =
    earnedOverride === null ? getRoundReward(state, round) : earnedOverride;
  const embed = new EmbedBuilder()
    .setTitle(`Round ${round.roundIndex} Cleared`)
    .setDescription(
      [
        `InSquignito survived and stacked **${earned} $CHARM**.`,
        `Current stack: **${state.charmEarnedThisRun} $CHARM**`,
        "",
        "Choose whether to keep pushing or end the run now.",
        "Continuing raises your Greed Level.",
      ].join("\n")
    )
    .setColor(0x27ae60)
    .setImage(round.image)
    .setFooter({
      text: [
        "Cash out to secure the current stack",
        `Lives Remaining: ${"❤️".repeat(Math.max(0, state.livesRemaining)) || "None"}`,
        `Greed Level: ${state.greedLevel} (${getGreedLabel(state.greedLevel)})`,
        `Unbanked Stack at Risk: ${state.charmEarnedThisRun} $CHARM`,
      ].join("\n"),
    });

  return {
    content: null,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gauntlet:continue:${state.runId}`)
          .setLabel("Continue")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`gauntlet:cashout:${state.runId}`)
          .setLabel("Cash Out")
          .setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

function buildCashOutConfirmPayload(state) {
  const embed = new EmbedBuilder()
    .setTitle("End This Run?")
    .setDescription(
      [
        "You still have lives remaining. Are you sure you want to cash out and end this run?",
        "",
        `Secured Reward: **${state.charmEarnedThisRun} $CHARM**`,
      ].join("\n")
    )
    .setColor(0xf39c12)
    .setFooter({
      text: [
        `Lives Remaining: ${"❤️".repeat(Math.max(0, state.livesRemaining)) || "None"}`,
        `Cash Out Reward: ${state.charmEarnedThisRun} $CHARM`,
      ].join("\n"),
    });

  return {
    content: null,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`gauntlet:cashout:confirm:${state.runId}`)
          .setLabel("Confirm Cash Out")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`gauntlet:cashout:resume:${state.runId}`)
          .setLabel("Continue Playing")
          .setStyle(ButtonStyle.Success)
      ),
    ],
  };
}

function buildDecisionRevealPayload(round, content) {
  return {
    content,
    embeds: [
      new EmbedBuilder()
        .setColor(0xc0392b)
        .setImage(round.image),
    ],
    components: [],
  };
}

async function waitForDecisionButton(message, expectedIds, userId) {
  try {
    return await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: GAUNTLET_DECISION_TIMEOUT_MS,
      filter: (i) =>
        expectedIds.includes(i.customId) && String(i.user?.id || "") === String(userId || ""),
    });
  } catch {
    return null;
  }
}

function getDecisionItemIds(state) {
  return Object.keys(GAUNTLET_ITEM_DEFS).map(
    (key) => `gauntlet:item:${state.runId}:${key}`
  );
}

function getGreedItemRewards(maxGreedLevel) {
  const rewards = {};
  if (maxGreedLevel >= 2) rewards.peek = 1;
  if (maxGreedLevel >= 3) rewards.greed = 1;
  if (maxGreedLevel >= 4) rewards.anchor = 1;
  if (maxGreedLevel >= 5) rewards.shield = 1;
  return rewards;
}

function formatItemGrants(grants = {}) {
  return Object.entries(grants)
    .filter(([, quantity]) => quantity > 0)
    .map(([key, quantity]) => `${GAUNTLET_ITEM_DEFS[key]?.label || key} x${quantity}`)
    .join(", ");
}

async function useDecisionItem(state, itemKey) {
  const def = GAUNTLET_ITEM_DEFS[itemKey];
  if (!def) {
    return "That item does not exist.";
  }

  if (
    (itemKey === "peek" && state.peekedSafeIndex !== null && state.peekedSafeIndex !== undefined) ||
    (itemKey === "shield" && state.shieldActive) ||
    (itemKey === "greed" && state.greedActive) ||
    (itemKey === "anchor" && state.anchorActive)
  ) {
    return `${def.label} is already active.`;
  }

  if ((state.itemInventory?.[itemKey] || 0) <= 0) {
    return `You do not have any ${def.label} items.`;
  }

  const consumed = await Store.consumeGauntletItem(state.userId, itemKey);
  if (!consumed) {
    state.itemInventory = await Store.getGauntletItemInventory(state.userId);
    return `You do not have any ${def.label} items left.`;
  }

  state.itemInventory[itemKey] = Math.max(
    0,
    Number(state.itemInventory[itemKey] || 0) - 1
  );

  if (itemKey === "peek") {
    state.peekedSafeIndex = state.safeIndexForAttempt;
    const round = getDecisionRound(state.roundIndex);
    return `Peek used. **${round.buttons[state.peekedSafeIndex]}** is safe.`;
  }
  if (itemKey === "shield") {
    state.shieldActive = true;
    return "Shield armed. The next fatal choice will be blocked.";
  }
  if (itemKey === "greed") {
    state.greedActive = true;
    return "Greed armed. This room pays double, but a wrong choice ends the run.";
  }
  if (itemKey === "anchor") {
    state.anchorActive = true;
    return "Anchor armed. If this room kills you, you restart from this room.";
  }

  return `${def.label} used.`;
}

async function logDecisionGauntletPayout(client, payload) {
  const targetChannelId =
    DECISION_GAUNTLET_PAYOUT_CHANNEL_ID || DRIP_LOG_CHANNEL_ID || payload.channelId;
  if (!client || !targetChannelId) return false;

  try {
    const channel = await client.channels.fetch(targetChannelId);
    if (!channel?.send) return false;

    const embed = new EmbedBuilder()
      .setTitle("Decision Gauntlet Payout")
      .addFields(
        { name: "User", value: `<@${payload.userId}>`, inline: true },
        { name: "Final Round", value: String(payload.finalRound), inline: true },
        { name: "Amount Awarded", value: `${payload.amount} $CHARM`, inline: true },
        { name: "Result Type", value: payload.resultType, inline: true },
        { name: "DRIP Status", value: payload.dripStatus, inline: true }
      )
      .setColor(payload.dripStatus === "Success" ? 0x2ecc71 : 0xe74c3c)
      .setTimestamp();

    if (payload.note) {
      embed.setDescription(payload.note);
    }

    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    console.error("[GAUNTLET] Failed to log Decision Gauntlet payout:", err?.message || err);
    return false;
  }
}

async function editDecisionGauntletReply(interaction, payload) {
  await interaction.editReply(payload);
  try {
    return await interaction.fetchReply();
  } catch {
    return null;
  }
}

async function finalizeDecisionGauntletRun(
  interaction,
  state,
  { resultType, finalRound, bonus = 0, payoutAmount = null, finalText, finalImage = null }
) {
  const resolvedPayout = Math.max(
    0,
    payoutAmount === null ? state.charmEarnedThisRun + bonus : Number(payoutAmount) || 0
  );
  if (state.isEnding) return resolvedPayout;
  state.isEnding = true;

  const playerName =
    interaction.user.username || interaction.user.globalName || "Player";
  let dripStatus = resolvedPayout > 0 ? "Failure" : "Skipped (0 payout)";
  let payoutOk = resolvedPayout <= 0;
  let payoutReason = null;

  try {
    if (resolvedPayout > 0) {
      const reward = await rewardCharmAmount({
        userId: interaction.user.id,
        username: playerName,
        amount: resolvedPayout,
        source: "gauntlet-solo",
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        metadata: {
          score: resolvedPayout,
          resultType,
          finalRound,
        },
        logClient: interaction.client,
        logReason: `Decision Gauntlet ${resultType}`,
      });

      if (reward?.ok) {
        payoutOk = true;
        dripStatus = "Success";
        await logCharmReward(interaction.client, {
          userId: interaction.user.id,
          amount: reward.amount,
          score: resolvedPayout,
          source: "gauntlet-solo",
          channelId: interaction.channelId,
          reason: `Decision Gauntlet ${resultType}`,
        });
      } else {
        payoutReason = reward?.reason || reward?.error?.message || "DRIP payout failed";
        dripStatus = "Failure";
      }
    }
  } catch (err) {
    payoutReason = err?.message || String(err);
    dripStatus = "Failure";
    console.error("[GAUNTLET] Decision Gauntlet payout failed:", err);
  }

  try {
    await Store.insertRun(interaction.user.id, playerName, currentMonthStr(), resolvedPayout, {
      resultType,
      finalRound,
      maxGreedLevel: state.maxGreedLevel || 0,
    });
  } catch (err) {
    console.error("[GAUNTLET] Failed to store Decision Gauntlet run:", err?.message || err);
  }

  const itemRewards = getGreedItemRewards(state.maxGreedLevel || 0);
  const itemRewardText = formatItemGrants(itemRewards);
  if (itemRewardText) {
    try {
      await Store.addGauntletItems(interaction.user.id, itemRewards);
    } catch (err) {
      console.error("[GAUNTLET] Failed to grant Greed rewards:", err?.message || err);
    }
  }

  try {
    await updateAllLeaderboards(interaction.client, currentMonthStr());
  } catch {}

  try {
    await logDecisionGauntletPayout(interaction.client, {
      userId: interaction.user.id,
      channelId: interaction.channelId,
      finalRound,
      amount: resolvedPayout,
      resultType,
      dripStatus,
      note: payoutReason,
    });
  } catch {}

  const finalEmbed = new EmbedBuilder()
    .setTitle("Decision Gauntlet Complete")
    .setDescription(
      [
        finalText,
        "",
        `Final Round: **${finalRound}**`,
        `Final Award: **${resolvedPayout} $CHARM**`,
        `Max Greed Level: **${state.maxGreedLevel || 0} (${getGreedLabel(state.maxGreedLevel || 0)})**`,
        itemRewardText ? `Item Rewards: **${itemRewardText}**` : null,
        `DRIP Status: **${dripStatus}**`,
      ].filter(Boolean).join("\n")
    )
    .setColor(payoutOk ? 0x2ecc71 : 0xe74c3c);

  if (finalImage) {
    finalEmbed.setImage(finalImage);
  }

  if (payoutReason) {
    finalEmbed.setFooter({ text: payoutReason });
  }

  try {
    await interaction.editReply({
      content: null,
      embeds: [finalEmbed],
      components: [],
    });
  } catch {}

  return resolvedPayout;
}

async function runSoloGauntletEphemeral(interaction) {
  await Store.grantDailyGauntletItemKit(
    interaction.user.id,
    torontoDateStr(),
    DAILY_GAUNTLET_ITEM_KIT
  );
  const itemInventory = await Store.getGauntletItemInventory(interaction.user.id);

  const state = {
    runId: makeRunId(interaction.user.id),
    userId: interaction.user.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    roundIndex: 1,
    livesRemaining: getDecisionGauntletLives(interaction.member),
    charmEarnedThisRun: 0,
    roundsClearedThisRun: 0,
    greedLevel: 0,
    maxGreedLevel: 0,
    itemInventory,
    peekedSafeIndex: null,
    shieldActive: false,
    greedActive: false,
    anchorActive: false,
    safeIndexForAttempt: rerollSafeIndex(),
    isEnding: false,
  };

  await interaction.editReply(buildDecisionRoundPayload(state));
  let message = await interaction.fetchReply();
  state.messageId = message.id;

  while (!state.isEnding) {
    const round = getDecisionRound(state.roundIndex);
    const choiceIds = [
      `gauntlet:pick:${state.runId}:0`,
      `gauntlet:pick:${state.runId}:1`,
    ];
    const itemIds = getDecisionItemIds(state);

    const pick = await waitForDecisionButton(message, [...choiceIds, ...itemIds], state.userId);
    if (!pick) {
      return finalizeDecisionGauntletRun(interaction, state, {
        resultType: "Cash Out",
        finalRound: state.roundsClearedThisRun,
        finalText: "Time expired. Your current stack was cashed out automatically.",
        finalImage: round.image,
      });
    }

    await pick.deferUpdate();

    if (pick.customId.startsWith(`gauntlet:item:${state.runId}:`)) {
      const itemKey = pick.customId.split(":").pop();
      const note = await useDecisionItem(state, itemKey);
      message =
        (await editDecisionGauntletReply(
          interaction,
          buildDecisionRoundPayload(state, note)
        )) || message;
      continue;
    }

    const choiceIndex = Number(pick.customId.split(":").pop());
    let survived = choiceIndex === state.safeIndexForAttempt;
    const rewardEarned = getRoundReward(state, round);
    const shieldSavedThisRoom = !survived && state.shieldActive && !state.greedActive;
    if (shieldSavedThisRoom) {
      survived = true;
    }

    await waitMs(GAUNTLET_REVEAL_DELAY_MS);

    message =
      (await editDecisionGauntletReply(
        interaction,
        buildDecisionRevealPayload(round, "You chose. Now InSquignito is...")
      )) || message;
    await waitMs(GAUNTLET_REVEAL_DELAY_MS);

    message =
      (await editDecisionGauntletReply(
        interaction,
        buildDecisionRevealPayload(
          round,
          shieldSavedThisRoom
            ? `DEAD.\n\nBut the Shield cracked open and dragged InSquignito through.\n\n+${rewardEarned} $CHARM.`
            : survived
            ? "ALIVE"
            : "DEAD"
        )
      )) || message;
    await waitMs(GAUNTLET_RESULT_DISPLAY_MS);

    if (!survived) {
      if (state.greedActive) {
        state.greedActive = false;
        return finalizeDecisionGauntletRun(interaction, state, {
          resultType: "Greed Collapse",
          finalRound: state.roundIndex,
          payoutAmount: 0,
          finalText: [
            "DEAD.",
            "",
            "Greed took the wheel.",
            "The unbanked stack is lost.",
            "",
            "You walk away with 0 $CHARM.",
          ].join("\n"),
          finalImage: round.image,
        });
      }

      state.livesRemaining -= 1;

      if (state.livesRemaining <= 0) {
        return finalizeDecisionGauntletRun(interaction, state, {
          resultType: "Out of Lives",
          finalRound: state.roundIndex,
          payoutAmount: 0,
          finalText: DECISION_GAUNTLET_FAIL_END_TEXT(0),
          finalImage: round.image,
        });
      }

      const anchored = state.anchorActive;
      state.anchorActive = false;
      state.greedActive = false;
      state.peekedSafeIndex = null;
      state.roundIndex = anchored ? state.roundIndex : 1;
      state.charmEarnedThisRun = 0;
      state.roundsClearedThisRun = anchored ? Math.max(0, state.roundIndex - 1) : 0;
      state.safeIndexForAttempt = rerollSafeIndex();

      message =
        (await editDecisionGauntletReply(
          interaction,
          buildDecisionRevealPayload(
            round,
            anchored
              ? [
                  "He chose.",
                  "",
                  "DEAD.",
                  "",
                  "The Anchor catches.",
                  "",
                  `Returning to Room ${state.roundIndex}.`,
                ].join("\n")
              : DECISION_GAUNTLET_RESTART_TEXT
          )
        )) || message;
      await waitMs(GAUNTLET_RESTART_MESSAGE_MS);
      message =
        (await editDecisionGauntletReply(
          interaction,
          buildDecisionRoundPayload(state)
        )) || message;
      continue;
    }

    state.charmEarnedThisRun += rewardEarned;
    state.roundsClearedThisRun = state.roundIndex;
    if (shieldSavedThisRoom) state.shieldActive = false;
    state.anchorActive = false;
    state.greedActive = false;
    state.peekedSafeIndex = null;

    if (state.roundIndex === DECISION_GAUNTLET_ROUNDS.length) {
      return finalizeDecisionGauntletRun(interaction, state, {
        resultType: "Completion",
        finalRound: 10,
        bonus: GAUNTLET_COMPLETION_BONUS,
        finalText: DECISION_GAUNTLET_WIN_END_TEXT,
        finalImage: round.image,
      });
    }

    message =
      (await editDecisionGauntletReply(
        interaction,
        buildPostRoundDecisionPayload(state, round, rewardEarned)
      )) || message;

    const decisionIds = [
      `gauntlet:continue:${state.runId}`,
      `gauntlet:cashout:${state.runId}`,
    ];
    const decision = await waitForDecisionButton(message, decisionIds, state.userId);
    if (!decision) {
      return finalizeDecisionGauntletRun(interaction, state, {
        resultType: "Cash Out",
        finalRound: state.roundsClearedThisRun,
        finalText: "Time expired. Your current stack was cashed out automatically.",
        finalImage: round.image,
      });
    }

    await decision.deferUpdate();

    if (decision.customId === `gauntlet:cashout:${state.runId}`) {
      if (state.livesRemaining > 0) {
        message =
          (await editDecisionGauntletReply(
            interaction,
            buildCashOutConfirmPayload(state)
          )) || message;
        const confirmIds = [
          `gauntlet:cashout:confirm:${state.runId}`,
          `gauntlet:cashout:resume:${state.runId}`,
        ];
        const confirm = await waitForDecisionButton(message, confirmIds, state.userId);
        if (!confirm) {
          return finalizeDecisionGauntletRun(interaction, state, {
            resultType: "Cash Out",
            finalRound: state.roundsClearedThisRun,
            finalText: "Time expired. Your current stack was cashed out automatically.",
            finalImage: round.image,
          });
        }

        await confirm.deferUpdate();

        if (confirm.customId === `gauntlet:cashout:confirm:${state.runId}`) {
          return finalizeDecisionGauntletRun(interaction, state, {
            resultType: "Cash Out",
            finalRound: state.roundsClearedThisRun,
            finalText: "You cashed out and ended the run.",
            finalImage: round.image,
          });
        }

        increaseGreedLevel(state);
        state.roundIndex += 1;
        state.safeIndexForAttempt = rerollSafeIndex();
        message =
          (await editDecisionGauntletReply(
            interaction,
            buildDecisionRoundPayload(state)
          )) || message;
        continue;
      } else {
        return finalizeDecisionGauntletRun(interaction, state, {
          resultType: "Cash Out",
          finalRound: state.roundsClearedThisRun,
          finalText: "You cashed out and ended the run.",
          finalImage: round.image,
        });
      }
    }

    increaseGreedLevel(state);
    state.roundIndex += 1;
    state.safeIndexForAttempt = rerollSafeIndex();
    message =
      (await editDecisionGauntletReply(
        interaction,
        buildDecisionRoundPayload(state)
      )) || message;
  }

  return state.charmEarnedThisRun;
}

// --------------------------------------------
// LEADERBOARD
// --------------------------------------------
async function renderLeaderboardEmbed(month) {
  const rows = await Store.getMonthlyTop(month, 10);
  const lines = rows.length
    ? rows
      .map(
        (r, i) =>
          `**#${i + 1}** ${r.username || `<@${r.user_id}>`} — **${r.best} $CHARM**`
      )
        .join("\n")
    : "No runs yet.";

  return new EmbedBuilder()
    .setTitle(`🏆 Leaderboard — ${month}`)
    .setDescription(lines)
    .setFooter({
      text: "Ranked by highest single-run $CHARM payout; ties broken by total monthly $CHARM.",
    })
    .setColor(0x00ccff);
}

async function renderTotalLeaderboardEmbed(month) {
  const rows = await Store.getMonthlyTopByTotal(month, 10);
  const lines = rows.length
    ? rows
      .map(
        (r, i) =>
          `**#${i + 1}** ${r.username || `<@${r.user_id}>`} — **${r.total} $CHARM**`
      )
        .join("\n")
    : "No runs yet.";

  return new EmbedBuilder()
    .setTitle(`🏆 Total Rewards — ${month}`)
    .setDescription(lines)
    .setFooter({
      text: "Ranked by total monthly $CHARM; ties broken by best single-run payout.",
    })
    .setColor(0x00ccff);
}

async function updateAllLeaderboards(client, month) {
  const entries = await Store.getLbMessages(month);
  if (!entries.length) return;

  const embed = await renderLeaderboardEmbed(month);

  for (const e of entries) {
    try {
      const ch = await client.channels.fetch(e.channel_id);
      const msg = await ch.messages.fetch(e.message_id);
      await msg.edit({ embeds: [embed] });
    } catch {}
  }
}

// --------------------------------------------
// COMMAND REGISTRATION (solo + group combined)
// --------------------------------------------
async function registerCommands() {
  const baseCommands = [
    new SlashCommandBuilder()
      .setName("gauntlet")
      .setDescription("Post the Gauntlet Start Panel in this channel (admins only)."),
    new SlashCommandBuilder()
      .setName("gauntletlb")
      .setDescription("Show the monthly leaderboard (best reward per user, totals tie-break).")
      .addStringOption((o) =>
        o
          .setName("month")
          .setDescription("YYYY-MM (default: current)")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("gauntletrecent")
      .setDescription("Show recent runs this month")
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("How many (default 10)")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("gauntletinfo")
      .setDescription("How Decision Gauntlet works (rounds & rules)."),
    new SlashCommandBuilder()
      .setName("mygauntlet")
      .setDescription("Your current-month Decision Gauntlet stats (best, total, plays)."),

    // Squig Survival command
    new SlashCommandBuilder()
      .setName("survive")
      .setDescription("Open a Squig Survival lobby with slash-command settings.")
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Lobby start mode")
          .addChoices(
            { name: "Timed", value: "timed" },
            { name: "Staff", value: "team_start" }
          )
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("era")
          .setDescription("Which Survival era to use")
          .addChoices(
            { name: "Random", value: "random" },
            ...Object.values(SURVIVAL_ERAS).map((era) => ({
              name: era.label,
              value: era.key,
            }))
          )
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("ping_role")
          .setDescription("Type @everyone, a role mention, a role ID, or an exact role name")
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("pool")
          .setDescription("$CHARM added to the prize pool per player")
          .setMinValue(1)
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("time")
          .setDescription("Timed mode duration in minutes")
          .setMinValue(1)
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("creator_chaos")
          .setDescription("Whether Creator Chaos is enabled")
          .addChoices(
            { name: "On", value: "on" },
            { name: "Off", value: "off" }
          )
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("revives")
          .setDescription("Whether !revive is enabled for this game")
          .addChoices(
            { name: "On", value: "on" },
            { name: "Off", value: "off" }
          )
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("bonus")
          .setDescription("Whether the bonus prize pool is active")
          .addChoices(
            { name: "Active", value: "on" },
            { name: "Not Active", value: "off" }
          )
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("bonus_reqd")
          .setDescription("Players needed for the bonus to activate")
          .setMinValue(1)
          .setRequired(false)
      )
      .addNumberOption((o) =>
        o
          .setName("bonus_multiplier")
          .setDescription("Bonus prize pool multiplier")
          .addChoices(
            { name: "1.5x", value: 1.5 },
            { name: "2x", value: 2 },
            { name: "2.5x", value: 2.5 }
          )
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("bonus_prize")
          .setDescription("Optional NFT prize name or link unlocked with the bonus")
          .setMaxLength(300)
          .setRequired(false)
      )
      .addStringOption((o) =>
        o
          .setName("replay")
          .setDescription("Reopen the lobby after the game ends")
          .addChoices(
            { name: "Yes", value: "yes" },
            { name: "No", value: "no" }
          )
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("survivestart")
      .setDescription("Start the active Squig Survival lobby."),
    new SlashCommandBuilder()
      .setName("podiumtest")
      .setDescription("Test the Squig Survival podium art (uses your avatar)."),
    new SlashCommandBuilder()
      .setName("adduser")
      .setDescription("Manually map Discord ID to DRIP user ID (admins only).")
      .addStringOption((o) =>
        o
          .setName("discord_id")
          .setDescription("Discord user ID to override")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("drip_user_id")
          .setDescription("DRIP user/member ID from admin panel for direct fallback payout")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Which DRIP credential type this value represents")
          .addChoices(
            { name: "drip-id", value: "drip-id" },
            { name: "discord-id", value: "discord-id" },
            { name: "username", value: "username" },
            { name: "id", value: "id" },
            { name: "member-id", value: "member-id" },
            { name: "user-id", value: "user-id" }
          )
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("paytest")
      .setDescription("Run a DRIP payout connectivity test (admins only).")
      .addUserOption((o) =>
        o
          .setName("user")
          .setDescription("Optional user to test payout against (default: you)")
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("amount")
          .setDescription("Test payout amount (default: 1)")
          .setMinValue(1)
          .setMaxValue(100000)
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("addimage")
      .setDescription("Add a Squig Survival stage image (admins only).")
      .addStringOption((o) =>
        o
          .setName("url")
          .setDescription("Image URL (https)")
          .setRequired(true)
      )
      .addUserOption((o) =>
        o
          .setName("user")
          .setDescription("Artist to reward when this image is used.")
          .setRequired(true)
      )
      .addStringOption((o) =>
        o
          .setName("era")
          .setDescription("Optional era tag/lock. Era-locked modes only use matching tagged images.")
          .addChoices(
            { name: "standard", value: "standard" },
            ...Object.values(SURVIVAL_ERAS).map((era) => ({
              name: era.label,
              value: era.key,
            }))
          )
          .setRequired(false)
      )
      .addIntegerOption((o) =>
        o
          .setName("points")
          .setDescription("Optional reward amount. Standard: 100")
          .setMinValue(1)
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("survivorboard")
      .setDescription("Top Squig Survival winners for a selected month.")
      .addStringOption((o) =>
        o
          .setName("month")
          .setDescription("Month to view in YYYY-MM format (default: current month)")
          .setRequired(false)
      )
      .addRoleOption((o) =>
        o
          .setName("role")
          .setDescription("Optional role filter for the leaderboard")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("lives")
      .setDescription("Your Squig Survival stats (all-time).")
      .addUserOption((o) =>
        o
          .setName("user")
          .setDescription("Check another Squig's stats")
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("squigshare")
      .setDescription("Post the Squig Survival share embed (admins only)."),
    new SlashCommandBuilder()
      .setName("finaltest")
      .setDescription("Post a test Squig Survival final rewards summary (admins only)."),
  ];

  // Include the group command definition from groupGauntlet.js
  if (groupGauntletCommand) {
    baseCommands.push(groupGauntletCommand);
  }

  const commands = baseCommands.map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  if (GUILD_IDS && GUILD_IDS.length) {
    for (const gid of GUILD_IDS) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(CLIENT_ID, gid),
          { body: commands }
        );
        console.log(`[GAUNTLET:CMD] Registered all commands (solo + group) for guild ${gid}`);
      } catch (err) {
        console.error(
          `[GAUNTLET:CMD] Failed to register commands for guild ${gid}:`,
          err.rawError || err
        );
        continue;
      }
    }
  } else {
    try {
      await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
      );
      console.log("[GAUNTLET:CMD] Registered all commands globally");
    } catch (err) {
      console.error(
        "[GAUNTLET:CMD] Failed to register commands globally:",
        err.rawError || err
      );
    }
  }
}

// --------------------------------------------
// PANEL & ADMIN CHECK
// --------------------------------------------
function startPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("⚔️ The Gauntlet — Decision Gauntlet")
    .setDescription(
      [
        "Click **Start** to enter the Decision Gauntlet alone. Every choice is made in private, and every mistake is yours to carry.",
        "",
        "Beyond the first door, InSquignito waits inside a sequence of brutal rooms built to test instinct and nerve. Each room has one safe choice and one fatal choice. If you still have lives remaining, the Gauntlet drags you back to the beginning and makes you try again.",
        "",
        "After each cleared room, you may press deeper into the dark or cash out what you have managed to keep. Every continue raises your Greed Level. Consumable items can bend a room, but they are gone when used.",
        "",
        "One run per day for most challengers. Every run is recorded. The leaderboard remembers who walked out richest.",
      ].join("\n")
    )
    .setColor(0xaa00ff)
    .setImage("https://i.imgur.com/MKHosuC.png");
}

function buildDecisionGauntletInfoEmbed() {
  return new EmbedBuilder()
    .setTitle("ℹ️ Decision Gauntlet - How It Works")
    .setDescription(
      [
        "Play privately via ephemeral messages. One run per day (Toronto time), except admins who can bypass the cooldown.",
        "",
        "**How it works:**",
        "1. You start with lives based on your highest eligible holder role tier.",
        "2. Clear 10 path-choice rooms in order.",
        "3. Each room has one safe choice and one fatal choice.",
        "4. If you choose wrong and still have lives left, the run restarts at Room 1 and your unbanked stack resets to 0.",
        "5. After every cleared room, choose Continue or Cash Out.",
        "6. Every Continue raises your Greed Level and improves end-of-run item rewards.",
        "7. $CHARM is paid once, only when the run ends.",
        "",
        "**Payouts:**",
        "- Cash Out: current stacked reward",
        "- Out of Lives: 0 $CHARM; the unbanked stack is lost",
        "- Full Clear: current stacked reward + 500 $CHARM bonus",
        "",
        "**Consumable items:**",
        "- Peek: reveal the safe choice for the current room",
        "- Shield: block one fatal choice and clear the room",
        "- Greed: double this room's reward; wrong choice ends the run",
        "- Anchor: if this room kills you, restart from this room instead of Room 1",
        "",
        "Each player receives one of each item per day. Higher Greed Levels can earn extra items at run end.",
        "",
        "**Extra lives by role tier:**",
        "1 Life: Weird",
        "2 Lives: Unhinged and/or Gettin' Ugly",
        "3 Lives: OG Holder",
        "",
        "If you do not have one of those roles, you still get 1 life.",
      ].join("\n")
    )
    .setColor(0x00ccff);
}

function startPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("gauntlet:start")
      .setLabel("Start")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("gauntlet:mystats")
      .setLabel("My Stats")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("gauntlet:leaderboard")
      .setLabel("Leaderboard")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("gauntlet:info")
      .setLabel("Info")
      .setStyle(ButtonStyle.Primary)
  );
}

const SQUIG_SHARE_TWEET_TEXT = [
  "Squig Survival is live in the @SquigsNFT Discord",
  "",
  "The more players that join... the bigger the prizes get.",
  "Pull up, survive the chaos, and see what you can win",
  "",
  "Join us: https://squigs.io/discord",
  "",
  "#SquigsAreWatching",
].join("\n");

function buildTweetIntentUrl(text) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

function buildSquigShareIntentUrl() {
  return buildTweetIntentUrl(SQUIG_SHARE_TWEET_TEXT);
}

function buildSquigShareEmbed() {
  return new EmbedBuilder()
    .setTitle("🚨 HELP GROW SQUIG SURVIVAL 🚨")
    .setDescription(
      [
        "**More players = bigger prizes.**",
        "Simple as that.",
        "",
        "If you've been enjoying the game, help us spread it and bring more people in 🛸",
        "",
        "**Click the button below to copy/pasta a tweet and share it.**",
        "",
        "More players. More chaos. More rewards.",
        "**This helps grow the game for YOU.**",
      ].join("\n")
    )
    .setImage("https://i.imgur.com/puZCGxP.gif")
    .setColor(0x9b59b6);
}

function buildSquigShareRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Copy/Pasta")
      .setStyle(ButtonStyle.Link)
      .setURL(buildSquigShareIntentUrl())
  );
}

function buildSurvivalShareThanksRows(sessionId, shareText) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Open X Composer")
        .setStyle(ButtonStyle.Link)
        .setURL(buildTweetIntentUrl(shareText))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`survive:share:done:${sessionId}`)
        .setLabel("Done")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildSurvivalShareRetryRows(sessionId, shareText) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Open X Composer")
        .setStyle(ButtonStyle.Link)
        .setURL(buildTweetIntentUrl(shareText))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`survive:share:retry:${sessionId}`)
        .setLabel("Try Again")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`survive:share:close:${sessionId}`)
        .setLabel("Close Panel")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildSurvivalShareThanksEmbed() {
  return new EmbedBuilder()
    .setTitle("Thanks for sharing the Ugly!")
    .setDescription(
      [
        "Don't forget save your favorite image above to add to the post!",
        `When you're done, drop the link to your post in <#${SURVIVAL_SHARE_DISCORD_CHANNEL_ID}>`,
      ].join("\n")
    )
    .setColor(0x2ecc71);
}

function messageHasShareableLink(message) {
  if (!message) return false;
  if (URL_PATTERN.test(String(message.content || ""))) return true;
  if (Array.isArray(message.embeds) && message.embeds.some((embed) => embed?.url)) {
    return true;
  }
  return false;
}

async function findRecentSurvivalShareMessage(client, userId) {
  if (!client || !userId || !SURVIVAL_SHARE_DISCORD_CHANNEL_ID) return null;

  try {
    const channel = await client.channels.fetch(SURVIVAL_SHARE_DISCORD_CHANNEL_ID);
    if (!channel?.messages?.fetch) return null;

    const cutoff = Date.now() - SURVIVAL_SHARE_LOOKBACK_MS;
    let before = null;

    for (let page = 0; page < 3; page += 1) {
      const fetched = await channel.messages.fetch(
        before ? { limit: 100, before } : { limit: 100 }
      );
      if (!fetched?.size) break;

      for (const message of fetched.values()) {
        if (message.createdTimestamp < cutoff) {
          return null;
        }
        if (message.author?.id !== userId) continue;
        if (messageHasShareableLink(message)) {
          return {
            channel,
            message,
          };
        }
      }

      before = fetched.last()?.id;
      if (!before) break;
    }
  } catch (err) {
    console.error("[GAUNTLET:SURVIVAL] Share channel lookup failed:", err?.message || err);
  }

  return null;
}

function isAdminUserLocal(interaction) {
  if (AUTHORIZED_ADMINS.includes(interaction.user.id)) return true;
  const member = interaction.member;
  if (!member || !interaction.inGuild()) return false;
  return (
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

// --------------------------------------------
// INTERACTION ROUTER
// --------------------------------------------
async function handleInteractionCreate(interaction) {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      // /groupgauntlet ? group mode
      if (interaction.commandName === "groupgauntlet") {
        await handleGroupInteractionCreate(interaction);
        return;
      }

      // /gauntlet
      if (interaction.commandName === "gauntlet") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can post the Gauntlet panel.",
            flags: 64,
          });
        }
        return interaction.reply({
          embeds: [startPanelEmbed()],
          components: [startPanelRow()],
        });
      }

      // /gauntletlb
      if (interaction.commandName === "gauntletlb") {
        await interaction.deferReply();
        const month = interaction.options.getString("month") || currentMonthStr();
        const embed = await renderLeaderboardEmbed(month);
        await interaction.editReply({ embeds: [embed] });
        let sent;
        try {
          sent = await interaction.fetchReply();
        } catch {}
        if (sent) {
          try {
            await Store.upsertLbMessage(
              interaction.guildId,
              interaction.channelId,
              month,
              sent.id
            );
          } catch {}
        }
        return;
      }

      // /gauntletrecent
      if (interaction.commandName === "gauntletrecent") {
        await interaction.deferReply();
        const month = currentMonthStr();
        const limit = interaction.options.getInteger("limit") || 10;
        const rows = await Store.getRecentRuns(month, limit);

        const lines = rows.length
          ? rows
              .map(
                (r) =>
                  `• <@${r.user_id}> — **${r.score} $CHARM**  _(at ${new Intl.DateTimeFormat(
                    "en-CA",
                    {
                      timeZone: "America/Toronto",
                      month: "short",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    }
                  ).format(new Date(r.finished_at))})_`
              )
              .join("\n")
          : "No recent runs.";

        const embed = new EmbedBuilder()
          .setTitle(`🕒 Recent Decision Gauntlet Runs — ${month}`)
          .setDescription(lines)
          .setColor(0x00ccff);

        return interaction.editReply({ embeds: [embed] });
      }

      // /gauntletinfo
      if (interaction.commandName === "gauntletinfo") {
        await interaction.deferReply({ flags: 64 });
        return interaction.editReply({ embeds: [buildDecisionGauntletInfoEmbed()] });
      }

      // /mygauntlet
      if (interaction.commandName === "mygauntlet") {
        await interaction.deferReply({ flags: 64 });
        const month = currentMonthStr();
        const mine = await Store.getMyMonth(interaction.user.id, month);

        const embed = new EmbedBuilder()
          .setTitle(`🧾 Your Gauntlet — ${month}`)
          .setDescription(
            `**Best:** ${mine.best} $CHARM\n**Total:** ${mine.total} $CHARM\n**Plays:** ${mine.plays}`
          )
          .setColor(0x00ccff);

        return interaction.editReply({ embeds: [embed] });
      }

      // /survive  (Squig Survival mini-game)
      if (interaction.commandName === "survive") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /survive.",
            flags: 64,
          });
        }

        const standardSettings = await getSurvivalStandardSettings();
        const settings = cloneSurvivalSettings(standardSettings);
        const type = interaction.options.getString("type");
        const era = interaction.options.getString("era");
        const pingRoleInput = interaction.options.getString("ping_role");
        const pool = interaction.options.getInteger("pool");
        const time = interaction.options.getInteger("time");
        const creatorChaos = interaction.options.getString("creator_chaos");
        const revives = interaction.options.getString("revives");
        const bonus = interaction.options.getString("bonus");
        const bonusReqd = interaction.options.getInteger("bonus_reqd");
        const bonusMultiplier = interaction.options.getNumber("bonus_multiplier");
        const bonusPrize = interaction.options.getString("bonus_prize");
        const replay = interaction.options.getString("replay");

        if (type) {
          settings.type = type;
        }

        if (era) {
          settings.era_key =
            era === "random" ? rand(Object.keys(SURVIVAL_ERAS)) : era;
        }

        if (pingRoleInput !== null) {
          const resolvedPingRoles = await resolveSurvivalPingRoleInput(
            interaction.guild,
            pingRoleInput
          );
          if (!resolvedPingRoles.ok) {
            return interaction.reply({
              content: `❌ ${resolvedPingRoles.reason}`,
              flags: 64,
            });
          }
          settings.ping_role_ids = resolvedPingRoles.roleIds;
        }

        if (pool !== null) {
          settings.pool_increment = pool;
        }

        if (time !== null) {
          settings.time_minutes = time;
        }

        if (creatorChaos !== null) {
          settings.creator_chaos = creatorChaos === "on";
        }

        if (revives !== null) {
          settings.revives_enabled = revives === "on";
        }

        if (bonus !== null) {
          settings.bonus_active = bonus === "on";
        }

        if (bonusReqd !== null) {
          settings.bonus_required_players = bonusReqd;
        }

        if (bonusMultiplier !== null) {
          settings.bonus_multiplier = bonusMultiplier;
        }

        if (bonusPrize !== null) {
          settings.bonus_prize = bonusPrize;
        }

        if (replay !== null) {
          settings.replay = replay === "yes";
        }

        const cfg = normalizeSurvivalSettings(settings);
        const result = await openSurvivalLobby(
          interaction.channel,
          interaction.user.id,
          cfg
        );

        if (!result.ok) {
          return interaction.reply({
            content: result.reason,
            flags: 64,
          });
        }

        return interaction.reply({
          content:
            "Squig Survival lobby opened.\n" +
            `Pool: **+${cfg.pool_increment} $CHARM per player**\n` +
            `Type: **${SURVIVAL_TYPE_LABELS[cfg.type]}**\n` +
            `Era: **${cfg.era}**\n` +
            `Ping: **${formatSurvivalPingRoles(cfg.ping_role_ids)}**\n` +
            `Time: **${cfg.type === "timed" ? `${cfg.time_minutes} minute(s)` : "N/A (Staff)"}**\n` +
            `Creator Chaos: **${cfg.creator_chaos ? "On" : "Off"}**\n` +
            `Revives: **${cfg.revives_enabled ? "On" : "Off"}**\n` +
            `Bonus: **${cfg.bonus_active ? "Active" : "Not Active"}**\n` +
            `Bonus Req'd: **${cfg.bonus_required_players}**\n` +
            `Bonus Multiplier: **${formatSurvivalMultiplier(cfg.bonus_multiplier)}**\n` +
            `Bonus Prize: **${cfg.bonus_active ? formatSurvivalBonusPrize(cfg) : "N/A"}**\n` +
            `Replay: **${cfg.replay ? "Yes" : "No"}**`,
          flags: 64,
        });
      }

      if (interaction.commandName === "squigshare") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /squigshare.",
            flags: 64,
          });
        }

        await interaction.channel.send({
          embeds: [buildSquigShareEmbed()],
          components: [buildSquigShareRow()],
        });

        return interaction.reply({
          content:
            "Squig Survival share panel posted. The button opens a prefilled Twitter/X post; Discord cannot copy directly to a user's clipboard.",
          flags: 64,
        });
      }

      if (interaction.commandName === "finaltest") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /finaltest.",
            flags: 64,
          });
        }

        await postSurvivalFinalSummaryTest(interaction.channel, interaction.user.id);
        return interaction.reply({
          content: "Squig Survival final rewards summary test posted.",
          flags: 64,
        });
      }

      // /survivestart
      if (interaction.commandName === "survivestart") {
        if (!survivalLobby || survivalLobby.game_status !== "lobby") {
          return interaction.reply({
            content: "No active /survive lobby. Run /survive first.",
            flags: 64,
          });
        }
        await startSurvivalFromLobby(interaction, survivalLobby);
        return;
      }

      // /podiumtest
      if (interaction.commandName === "podiumtest") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /podiumtest.",
            flags: 64,
          });
        }

        await interaction.deferReply();

        const id = interaction.user.id;
        const placements = [id, id, id];
        const podiumBuffer = await buildPodiumImage(
          interaction.client,
          placements,
          interaction.guildId
        );

        if (!podiumBuffer) {
          return interaction.editReply({
            content: "❌ Podium render failed.",
          });
        }

        const attachment = new AttachmentBuilder(podiumBuffer, { name: "podium.png" });
        const embed = new EmbedBuilder()
          .setTitle("Squig Survival - Podium Test")
          .setImage("attachment://podium.png")
          .setColor(0xf1c40f);

        return interaction.editReply({
          embeds: [embed],
          files: [attachment],
        });
      }

      // /adduser
      if (interaction.commandName === "adduser") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /adduser.",
            flags: 64,
          });
        }

        const discordIdRaw = interaction.options.getString("discord_id");
        const dripUserIdRaw = interaction.options.getString("drip_user_id");
        const dripTypeRaw = interaction.options.getString("type");
        const discordId = String(discordIdRaw || "").trim();
        const dripUserId = String(dripUserIdRaw || "").trim();
        const dripCredentialType = String(dripTypeRaw || "drip-id").trim();

        if (!/^\d{5,30}$/.test(discordId)) {
          return interaction.reply({
            content: "❌ `discord_id` must be a valid Discord user ID (digits only).",
            flags: 64,
          });
        }

        if (!dripUserId) {
          return interaction.reply({
            content: "❌ `drip_user_id` is required.",
            flags: 64,
          });
        }

        try {
          await Store.upsertDripUserOverride(
            discordId,
            dripUserId,
            interaction.user.id,
            dripCredentialType
          );
          return interaction.reply({
            content:
              `✅ DRIP override saved.\nDiscord ID: \`${discordId}\`\n` +
              `DRIP credential type: \`${dripCredentialType}\`\n` +
              `DRIP credential value: \`${dripUserId}\`\n` +
              "Future payouts will try normal Discord-linked payout first, then this override.",
            flags: 64,
          });
        } catch (err) {
          return interaction.reply({
            content: `❌ Failed to save override: ${err?.message || err}`,
            flags: 64,
          });
        }
      }

      // /paytest
      if (interaction.commandName === "paytest") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /paytest.",
            flags: 64,
          });
        }

        await interaction.deferReply({ flags: 64 });

        const target = interaction.options.getUser("user") || interaction.user;
        const amount = interaction.options.getInteger("amount") || 1;
        const displayName =
          target.username || target.globalName || `User-${target.id}`;

        try {
          const reward = await rewardCharmAmount({
            userId: target.id,
            username: displayName,
            amount,
            source: "paytest",
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            metadata: {
              runBy: interaction.user.id,
              type: "manual-paytest",
            },
            logClient: interaction.client,
            logReason: `Manual DRIP paytest by ${interaction.user.id}`,
          });

          if (reward?.ok) {
            await logCharmReward(interaction.client, {
              userId: target.id,
              amount: reward.amount,
              score: 0,
              source: "paytest",
              channelId: interaction.channelId,
              reason: `Manual DRIP paytest by <@${interaction.user.id}>`,
            });
            return interaction.editReply({
              content:
                `✅ DRIP paytest succeeded.\nTarget: <@${target.id}>\n` +
                `Amount: **${reward.amount} $CHARM**`,
            });
          }

          const status = reward?.error?.response?.status;
          const reason = reward?.reason || reward?.error?.message || "unknown";
          const hint =
            reason === "no_usable_credential"
              ? "\nTip: use /adduser with `type` + `drip_user_id` matching a real DRIP credential."
              : "";
          return interaction.editReply({
            content:
              `⚠️ DRIP paytest did not complete.\nTarget: <@${target.id}>\n` +
              `Amount attempted: **${amount} $CHARM**\n` +
              `Status: ${status || "n/a"}\nReason: ${reason}${hint}`,
          });
        } catch (err) {
          const status = err?.response?.status;
          const reason = err?.response?.data
            ? JSON.stringify(err.response.data)
            : err?.message || String(err);
          return interaction.editReply({
            content:
              `❌ DRIP paytest failed.\nTarget: <@${target.id}>\n` +
              `Amount attempted: **${amount} $CHARM**\n` +
              `Status: ${status || "n/a"}\nReason: ${reason}`,
          });
        }
      }

      // /addimage
      if (interaction.commandName === "addimage") {
        if (!isAdminUserLocal(interaction)) {
          return interaction.reply({
            content: "⛔ Only admins can use /addimage.",
            flags: 64,
          });
        }

        const imageUrl = interaction.options.getString("url");
        const artist = interaction.options.getUser("user");
        const eraInput = interaction.options.getString("era");
        const points = interaction.options.getInteger("points") || 100;
        const userId = artist.id;

        if (!/^https?:\/\//i.test(imageUrl || "")) {
          return interaction.reply({
            content: "❌ Image URL must start with http:// or https://",
            flags: 64,
          });
        }

        const parsedEra = parseSurvivalImageEraInput(eraInput);
        if (!parsedEra.ok) {
          return interaction.reply({
            content: `❌ ${parsedEra.reason}`,
            flags: 64,
          });
        }

        try {
          const result = await imageStore.addSurvivalImage({
            imageUrl,
            userId,
            eraKeys: parsedEra.eraKeys ? parsedEra.eraKeys.join(",") : null,
            rewardPoints: points,
            addedBy: interaction.user.id,
          });

          if (!result.ok) {
            return interaction.reply({
              content: `❌ Image DB unavailable: ${result.reason || "unknown error"}`,
              flags: 64,
            });
          }

          return interaction.reply({
            content: `✅ Added survival image.\nURL: ${imageUrl}${
              userId ? `\nArtist: <@${userId}>` : ""
            }\nEra Tag: ${parsedEra.label}\nPoints: ${points}`,
          });
        } catch (err) {
          return interaction.reply({
            content: `❌ Failed to add image: ${err?.message || err}`,
            flags: 64,
          });
        }
      }

      // /survivorboard
      if (interaction.commandName === "survivorboard") {
        await interaction.deferReply();
        const fallbackMonth = currentMonthStr();
        const parsedMonth = parseLeaderboardMonthInput(
          interaction.options.getString("month"),
          fallbackMonth
        );
        if (!parsedMonth.ok) {
          return interaction.editReply({ content: `❌ ${parsedMonth.reason}` });
        }

        const selectedMonth = parsedMonth.month;
        const selectedRole = interaction.options.getRole("role");
        const candidateLimit = selectedRole ? 250 : 10;
        let rows = await survivalStore.getMonthlyWinnersTop10(selectedMonth, candidateLimit);

        if (selectedRole) {
          if (!interaction.inGuild() || !interaction.guild) {
            return interaction.editReply({
              content: "❌ Role filtering only works in a server channel.",
            });
          }

          const candidateIds = rows.map((r) => r.user_id);
          const membersById = new Map();

          if (candidateIds.length) {
            try {
              const batch = await interaction.guild.members.fetch({ user: candidateIds });
              for (const [id, member] of batch) membersById.set(id, member);
            } catch {}

            for (const id of candidateIds) {
              if (membersById.has(id)) continue;
              try {
                const member = await interaction.guild.members.fetch(id);
                if (member) membersById.set(id, member);
              } catch {}
            }
          }

          rows = rows
            .filter((r) => membersById.get(r.user_id)?.roles?.cache?.has(selectedRole.id))
            .slice(0, 10);
        }

        const lines = rows.length
          ? rows
              .map((r, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
                return `${medal} <@${r.user_id}> — **${r.firsts}** wins (2nd: ${r.seconds}, 3rd: ${r.thirds}, games: ${r.games})`;
              })
              .join("\n")
          : selectedRole
          ? `No qualifying Squig Survival wins for ${selectedMonth} with role ${selectedRole}.`
          : `No Squig Survival wins yet for ${selectedMonth}.`;

        const embed = new EmbedBuilder()
          .setTitle(
            selectedRole
              ? `🏆 Squig Survival — ${selectedMonth} Winners (${selectedRole.name})`
              : `🏆 Squig Survival — ${selectedMonth} Winners`
          )
          .setDescription(lines)
          .setColor(0xf1c40f);

        return interaction.editReply({ embeds: [embed] });
      }

      // /lives
      if (interaction.commandName === "lives") {
        await interaction.deferReply({ ephemeral: false });
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const stats = await survivalStore.getUserStats(targetUser.id, "all");
        const rank = await survivalStore.getOverallRank(targetUser.id);
        const title = "All Time";
        const lines = [
          `🏅 **Overall Rank:** ${rank ? `#${rank}` : "Unranked"}`,
          `🥇 **1st:** ${stats.firsts}`,
          `🥈 **2nd:** ${stats.seconds}`,
          `🥉 **3rd:** ${stats.thirds}`,
          `🎮 **Games Played:** ${stats.games}`,
          `🔪 **Eliminations:** ${stats.eliminations}`,
          `💀 **Deaths:** ${stats.deaths}`,
          `🖼️ **Images Used:** ${stats.images_used}`,
        ];

        const quips = [
          "The portal knows your name. It just pretends not to.",
          "Your life count is a work of art. Or at least a sketch.",
          "Survival stats powered by snacks and questionable decisions.",
          "Keep going. The Squigs are taking notes.",
          "Numbers don't lie. Squigs do.",
          "You are technically alive on paper.",
        ];

        const header =
          targetUser.id === interaction.user.id ? "" : `<@${targetUser.id}>\n`;
        const embed = new EmbedBuilder()
          .setTitle(`🧬 Squig Lives — ${title}`)
          .setDescription(`${header}${lines.join("\n")}`)
          .setFooter({ text: rand(quips) })
          .setColor(0x9b59b6);

        return interaction.editReply({ embeds: [embed] });
      }
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("survive:modal:")) {
      if (!isAdminUserLocal(interaction)) {
        return interaction.reply({
          content: "⛔ Only admins can use the Squig Survival menu.",
          flags: 64,
        });
      }

      const session = survivalConfigSessions.get(interaction.user.id);
      if (!session) {
        const standardSettings = await getSurvivalStandardSettings();
        return interaction.reply({
          embeds: [
            buildSurvivalMenuEmbed(
              standardSettings,
              "That settings panel expired. Open /survive again or pick a new menu option."
            ),
          ],
          components: buildSurvivalMenuComponents(),
          flags: 64,
        });
      }

      const value = interaction.fields.getTextInputValue("value").trim();
      let note = null;

      if (interaction.customId === "survive:modal:time") {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes < 1) {
          note = "Time must be a whole number of at least 1 minute.";
        } else {
          session.settings.time_minutes = Math.floor(minutes);
        }
      }

      if (interaction.customId === "survive:modal:pool") {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount < 1) {
          note = "Pool per player must be a whole number of at least 1.";
        } else {
          session.settings.pool_increment = Math.floor(amount);
        }
      }

      if (interaction.customId === "survive:modal:bonus-req") {
        const players = Number(value);
        if (!Number.isFinite(players) || players < 1) {
          note = "Bonus required players must be a whole number of at least 1.";
        } else {
          session.settings.bonus_required_players = Math.floor(players);
        }
      }

      if (interaction.customId === "survive:modal:bonus-mult") {
        const multiplier = Number(value);
        if (!Number.isFinite(multiplier) || multiplier < 1) {
          note = "Bonus multiplier must be a number that is at least 1.";
        } else {
          session.settings.bonus_multiplier = Number(multiplier.toFixed(2));
        }
      }

      session.settings = normalizeSurvivalSettings(session.settings);
      survivalConfigSessions.set(interaction.user.id, session);

      return interaction.reply({
        embeds: [
          buildSurvivalSettingsEmbed(
            session.mode,
            session.settings,
            note,
            { selectingPingRoles: Boolean(session.selectingPingRoles) }
          ),
        ],
        components: buildSurvivalSettingsComponents(session.mode, session.settings, {
          selectingPingRoles: Boolean(session.selectingPingRoles),
        }),
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith("survive:menu:")) {
      if (!isAdminUserLocal(interaction)) {
        return interaction.reply({
          content: "⛔ Only admins can use the Squig Survival menu.",
          flags: 64,
        });
      }

      const standardSettings = await getSurvivalStandardSettings();

      if (interaction.customId === "survive:menu:play-standard") {
        const result = await openSurvivalLobby(
          interaction.channel,
          interaction.user.id,
          standardSettings
        );
        return interaction.update({
          embeds: [
            buildSurvivalMenuEmbed(
              standardSettings,
              result.ok ? "Standard lobby opened in this channel." : result.reason
            ),
          ],
          components: buildSurvivalMenuComponents(),
        });
      }

      if (interaction.customId === "survive:menu:play-custom") {
        survivalConfigSessions.set(interaction.user.id, {
          mode: "custom",
          settings: cloneSurvivalSettings(standardSettings),
        });
        const session = survivalConfigSessions.get(interaction.user.id);
        return interaction.update({
          embeds: [
            buildSurvivalSettingsEmbed(session.mode, session.settings, null, {
              selectingPingRoles: Boolean(session.selectingPingRoles),
            }),
          ],
          components: buildSurvivalSettingsComponents(session.mode, session.settings, {
            selectingPingRoles: Boolean(session.selectingPingRoles),
          }),
        });
      }

      if (interaction.customId === "survive:menu:set-standard") {
        survivalConfigSessions.set(interaction.user.id, {
          mode: "standard",
          settings: cloneSurvivalSettings(standardSettings),
        });
        const session = survivalConfigSessions.get(interaction.user.id);
        return interaction.update({
          embeds: [
            buildSurvivalSettingsEmbed(session.mode, session.settings, null, {
              selectingPingRoles: Boolean(session.selectingPingRoles),
            }),
          ],
          components: buildSurvivalSettingsComponents(session.mode, session.settings, {
            selectingPingRoles: Boolean(session.selectingPingRoles),
          }),
        });
      }
    }

    if (
      interaction.isRoleSelectMenu() &&
      interaction.customId === "survive:config:ping-roles:select"
    ) {
      if (!isAdminUserLocal(interaction)) {
        return interaction.reply({
          content: "⛔ Only admins can use the Squig Survival menu.",
          flags: 64,
        });
      }

      const session = survivalConfigSessions.get(interaction.user.id);
      if (!session) {
        const standardSettings = await getSurvivalStandardSettings();
        return interaction.update({
          embeds: [
            buildSurvivalMenuEmbed(
              standardSettings,
              "That settings panel expired. Open /survive again or pick a new menu option."
            ),
          ],
          components: buildSurvivalMenuComponents(),
        });
      }

      session.settings.ping_role_ids = normalizeSurvivalPingRoleIds(
        interaction.values
      );
      session.selectingPingRoles = true;
      session.settings = normalizeSurvivalSettings(session.settings);
      survivalConfigSessions.set(interaction.user.id, session);

      return interaction.update({
        embeds: [
          buildSurvivalSettingsEmbed(session.mode, session.settings, null, {
            selectingPingRoles: true,
          }),
        ],
        components: buildSurvivalSettingsComponents(session.mode, session.settings, {
          selectingPingRoles: true,
        }),
      });
    }

    if (interaction.isButton() && interaction.customId.startsWith("survive:config:")) {
      if (!isAdminUserLocal(interaction)) {
        return interaction.reply({
          content: "⛔ Only admins can use the Squig Survival menu.",
          flags: 64,
        });
      }

      const session = survivalConfigSessions.get(interaction.user.id);
      if (!session) {
        const standardSettings = await getSurvivalStandardSettings();
        return interaction.update({
          embeds: [
            buildSurvivalMenuEmbed(
              standardSettings,
              "That settings panel expired. Open /survive again or pick a new menu option."
            ),
          ],
          components: buildSurvivalMenuComponents(),
        });
      }

      if (interaction.customId === "survive:config:time") {
        const modal = new ModalBuilder()
          .setCustomId("survive:modal:time")
          .setTitle("Set Timed Minutes");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("value")
              .setLabel("Minutes")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(session.settings.time_minutes || 5))
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "survive:config:pool") {
        const modal = new ModalBuilder()
          .setCustomId("survive:modal:pool")
          .setTitle("Set Pool Per Player");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("value")
              .setLabel("$CHARM Added Per Player")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(session.settings.pool_increment || SURVIVAL_BASE_POOL_INCREMENT))
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "survive:config:bonus-req") {
        const modal = new ModalBuilder()
          .setCustomId("survive:modal:bonus-req")
          .setTitle("Set Bonus Player Count");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("value")
              .setLabel("Players Required")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(session.settings.bonus_required_players || 10))
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "survive:config:bonus-mult:custom") {
        const modal = new ModalBuilder()
          .setCustomId("survive:modal:bonus-mult")
          .setTitle("Set Custom Bonus Multiplier");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("value")
              .setLabel("Multiplier")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(String(session.settings.bonus_multiplier || 1.5))
          )
        );
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === "survive:config:save") {
        if (session.mode === "standard") {
          const saved = await saveSurvivalStandardSettings(session.settings);
          survivalConfigSessions.delete(interaction.user.id);
          return interaction.update({
            embeds: [buildSurvivalMenuEmbed(saved, "Standard settings saved.")],
            components: buildSurvivalMenuComponents(),
          });
        }

        const result = await openSurvivalLobby(
          interaction.channel,
          interaction.user.id,
          session.settings
        );

        if (result.ok) {
          survivalConfigSessions.delete(interaction.user.id);
          const standardSettings = await getSurvivalStandardSettings();
          return interaction.update({
            embeds: [buildSurvivalMenuEmbed(standardSettings, "Custom lobby opened in this channel.")],
            components: buildSurvivalMenuComponents(),
          });
        }

        return interaction.update({
          embeds: [
            buildSurvivalSettingsEmbed(session.mode, session.settings, result.reason, {
              selectingPingRoles: Boolean(session.selectingPingRoles),
            }),
          ],
          components: buildSurvivalSettingsComponents(session.mode, session.settings, {
            selectingPingRoles: Boolean(session.selectingPingRoles),
          }),
        });
      }

      if (interaction.customId === "survive:config:cancel") {
        survivalConfigSessions.delete(interaction.user.id);
        const standardSettings = await getSurvivalStandardSettings();
        return interaction.update({
          embeds: [buildSurvivalMenuEmbed(standardSettings)],
          components: buildSurvivalMenuComponents(),
        });
      }

      if (interaction.customId === "survive:config:type") {
        session.settings.type =
          session.settings.type === "timed" ? "team_start" : "timed";
      }

      if (interaction.customId === "survive:config:era") {
        const eraKeys = Object.keys(SURVIVAL_ERAS);
        const currentIndex = Math.max(
          0,
          eraKeys.indexOf(session.settings.era_key)
        );
        session.settings.era_key =
          eraKeys[(currentIndex + 1) % Math.max(1, eraKeys.length)];
      }

      if (interaction.customId === "survive:config:ping-roles") {
        session.selectingPingRoles = !session.selectingPingRoles;
      }

      if (interaction.customId === "survive:config:ping-roles:everyone") {
        session.settings.ping_role_ids = [];
        session.selectingPingRoles = true;
      }

      if (interaction.customId === "survive:config:creator-chaos") {
        session.settings.creator_chaos = !session.settings.creator_chaos;
      }

      if (interaction.customId === "survive:config:revives") {
        session.settings.revives_enabled = !session.settings.revives_enabled;
      }

      if (interaction.customId === "survive:config:bonus-active") {
        session.settings.bonus_active = !session.settings.bonus_active;
      }

      if (interaction.customId === "survive:config:replay") {
        session.settings.replay = !session.settings.replay;
      }

      if (interaction.customId.startsWith("survive:config:bonus-mult:")) {
        const value = interaction.customId.split(":").pop();
        const multiplier = Number(value);
        if (Number.isFinite(multiplier) && multiplier >= 1) {
          session.settings.bonus_multiplier = Number(multiplier.toFixed(2));
        }
      }

      session.settings = normalizeSurvivalSettings(session.settings);
      survivalConfigSessions.set(interaction.user.id, session);

      return interaction.update({
        embeds: [
          buildSurvivalSettingsEmbed(session.mode, session.settings, null, {
            selectingPingRoles: Boolean(session.selectingPingRoles),
          }),
        ],
        components: buildSurvivalSettingsComponents(session.mode, session.settings, {
          selectingPingRoles: Boolean(session.selectingPingRoles),
        }),
      });
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("survive:share:start:")
    ) {
      const sessionId = interaction.customId.replace("survive:share:start:", "");
      const shareData = getSurvivalShareData(sessionId, interaction.user.id);

      if (!shareData) {
        return interaction.reply({
          content: "That share panel expired, or you were not part of that Survival run.",
          flags: 64,
        });
      }

      return interaction.reply({
        content: `Copy-ready post:\n\`\`\`\n${shareData.result.shareText}\n\`\`\``,
        embeds: [buildSurvivalShareThanksEmbed()],
        components: buildSurvivalShareThanksRows(sessionId, shareData.result.shareText),
        flags: 64,
      });
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("survive:share:done:")
    ) {
      const sessionId = interaction.customId.replace("survive:share:done:", "");
      const shareData = getSurvivalShareData(sessionId, interaction.user.id);

      if (!shareData) {
        return interaction.update({
          content: "That share panel expired, or you were not part of that Survival run.",
          embeds: [],
          components: [],
        });
      }

      let rewardNote = "Share panel closed.";

      try {
        const existingClaim = await Store.getSurvivalShareClaim(
          sessionId,
          interaction.user.id
        );

        if (existingClaim) {
          rewardNote = `Share panel closed. You already claimed the ${existingClaim.reward_amount} $CHARM share reward for this post.`;
        } else {
          const recentShare = await findRecentSurvivalShareMessage(
            interaction.client,
            interaction.user.id
          );

          if (recentShare?.message?.id) {
            const createdClaim = await Store.createSurvivalShareClaim(
              sessionId,
              interaction.user.id,
              SURVIVAL_SHARE_REWARD_AMOUNT,
              recentShare.message.id,
              recentShare.channel.id
            );

            if (createdClaim) {
              const reward = await rewardCharmAmount({
                userId: interaction.user.id,
                username:
                  interaction.user.username ||
                  interaction.user.globalName ||
                  `User-${interaction.user.id}`,
                amount: SURVIVAL_SHARE_REWARD_AMOUNT,
                source: "survival-share",
                guildId: interaction.guildId,
                channelId: interaction.channelId,
                metadata: {
                  mode: "survival-share",
                  sessionId,
                  sourceChannelId: recentShare.channel.id,
                  sourceMessageId: recentShare.message.id,
                },
                logClient: interaction.client,
                logReason: "Squig Survival share reward",
              });

              if (reward?.ok) {
                await logCharmReward(interaction.client, {
                  userId: interaction.user.id,
                  amount: SURVIVAL_SHARE_REWARD_AMOUNT,
                  score: 0,
                  source: "survival-share",
                  channelId: interaction.channelId,
                  reason: "Squig Survival share reward",
                });
                try {
                  await interaction.channel?.send(
                    `Thanks for sharing <@${interaction.user.id}>! **+${SURVIVAL_SHARE_REWARD_AMOUNT} $CHARM**`
                  );
                } catch {}
                rewardNote = `Share panel closed. You posted a recent link in <#${SURVIVAL_SHARE_DISCORD_CHANNEL_ID}> and received ${SURVIVAL_SHARE_REWARD_AMOUNT} $CHARM.`;
              } else {
                await Store.deleteSurvivalShareClaim(sessionId, interaction.user.id);
                rewardNote =
                  "Share panel closed. Your recent share was found, but the $CHARM transfer did not complete.";
              }
            } else {
              rewardNote = `Share panel closed. You already claimed the ${SURVIVAL_SHARE_REWARD_AMOUNT} $CHARM share reward for this post.`;
            }
          } else {
            return interaction.update({
              content: `No recent link from you was found in <#${SURVIVAL_SHARE_DISCORD_CHANNEL_ID}> within the last 15 minutes, so no share reward was sent.`,
              embeds: [],
              components: buildSurvivalShareRetryRows(
                sessionId,
                shareData.result.shareText
              ),
            });
          }
        }
      } catch (err) {
        console.error("[GAUNTLET:SURVIVAL] Share reward check failed:", err?.message || err);
        rewardNote =
          "Share panel closed. I could not verify your recent share link, so no reward was sent.";
      }

      return interaction.update({
        content: rewardNote,
        embeds: [],
        components: [],
      });
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("survive:share:retry:")
    ) {
      const sessionId = interaction.customId.replace("survive:share:retry:", "");
      const shareData = getSurvivalShareData(sessionId, interaction.user.id);

      if (!shareData) {
        return interaction.update({
          content: "That share panel expired, or you were not part of that Survival run.",
          embeds: [],
          components: [],
        });
      }

      return interaction.update({
        content: `Copy-ready post:\n\`\`\`\n${shareData.result.shareText}\n\`\`\``,
        embeds: [buildSurvivalShareThanksEmbed()],
        components: buildSurvivalShareThanksRows(sessionId, shareData.result.shareText),
      });
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("survive:share:close:")
    ) {
      return interaction.update({
        content: "Share panel closed.",
        embeds: [],
        components: [],
      });
    }

    // Survival lobby buttons
    if (
      interaction.isButton() &&
      ["survive:join", "survive:leave", "survive:list", "survive:stats", "survive:info"].includes(
        interaction.customId
      )
    ) {
      if (!survivalLobby || survivalLobby.game_status !== "lobby") {
        return interaction.reply({
          content: "No active /survive lobby. Run /survive first.",
          flags: 64,
        });
      }

      const userId = interaction.user.id;
      if (interaction.customId === "survive:join") {
        survivalLobby.joined.add(userId);
        try {
          const remaining = survivalLobby.countdown_end
            ? survivalLobby.countdown_end - Date.now()
            : undefined;
          const updated = buildSurvivalLobbyEmbed(
            survivalLobby.settings,
            survivalLobby.joined.size,
            remaining
          );
          await survivalLobby.join_message.edit({ embeds: [updated] });
        } catch {}
        persistSurvivalLobby(survivalLobby);
        return interaction.reply({
          content: "You joined the Squig Survival lobby.",
          flags: 64,
        });
      }

      if (interaction.customId === "survive:leave") {
        survivalLobby.joined.delete(userId);
        try {
          const remaining = survivalLobby.countdown_end
            ? survivalLobby.countdown_end - Date.now()
            : undefined;
          const updated = buildSurvivalLobbyEmbed(
            survivalLobby.settings,
            survivalLobby.joined.size,
            remaining
          );
          await survivalLobby.join_message.edit({ embeds: [updated] });
        } catch {}
        persistSurvivalLobby(survivalLobby);
        return interaction.reply({
          content: "You left the Squig Survival lobby.",
          flags: 64,
        });
      }

      if (interaction.customId === "survive:list") {
        const ids = Array.from(survivalLobby.joined || []);
        let list = "None";
        if (ids.length) {
          const nameMap = await buildDisplayNameMap(
            interaction.client,
            interaction.guildId,
            ids
          );
          list = ids.map((id) => nameMap.get(id) || `User-${id}`).join("\n");
        }
        return interaction.reply({
          content: `Players joined (${ids.length}):\n${list}`,
          flags: 64,
        });
      }

      if (interaction.customId === "survive:stats") {
        const stats = await survivalStore.getUserStats(interaction.user.id, "all");
        const rank = await survivalStore.getOverallRank(interaction.user.id);
        const lines = [
          `🏅 **Overall Rank:** ${rank ? `#${rank}` : "Unranked"}`,
          `🥇 **1st:** ${stats.firsts}`,
          `🥈 **2nd:** ${stats.seconds}`,
          `🥉 **3rd:** ${stats.thirds}`,
          `🎮 **Games Played:** ${stats.games}`,
          `🔪 **Eliminations:** ${stats.eliminations}`,
          `💀 **Deaths:** ${stats.deaths}`,
          `🖼️ **Images Used:** ${stats.images_used}`,
        ];

        const quips = [
          "The portal knows your name. It just pretends not to.",
          "Your life count is a work of art. Or at least a sketch.",
          "Survival stats powered by snacks and questionable decisions.",
          "Keep going. The Squigs are taking notes.",
          "Numbers don't lie. Squigs do.",
          "You are technically alive on paper.",
        ];

        const embed = new EmbedBuilder()
          .setTitle("🧬 Squig Lives — All Time")
          .setDescription(lines.join("\n"))
          .setFooter({ text: rand(quips) })
          .setColor(0x9b59b6);

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      if (interaction.customId === "survive:info") {
        const lines = [
          "**What is this?**",
          "A chaotic, story-driven Squig Survival run where players get eliminated round by round until one wins — and a rotating gallery of community art is featured. If your image is used in the game, you earn **$CHARM** each time.",
          "",
          "**How to join:**",
          "Hit **Join** in the lobby. Staff starts the game with **/survivestart**.",
          "",
          "**Stats & bragging:**",
          "Press **My Stats** in the lobby for your all-time stats (private).",
          "Use **/lives** to show stats publicly.",
          "",
          "**How to add images:**",
          `Use **SUBMIT IMAGES**: ${SURVIVAL_IMAGE_SUBMISSION_URL}`,
          "Era-locked modes like Movie Theater and Airport only pull images tagged to that era through /addimage.",
          "",
          "**Pro tips:**",
          "- More players = bigger prize pool.",
          "- Revivals happen. Rare, but loud.",
        ];

        const embed = new EmbedBuilder()
          .setTitle("ℹ️ Squig Survival — Info")
          .setDescription(lines.join("\n"))
          .setColor(0x9b59b6);

        return interaction.reply({ embeds: [embed], flags: 64 });
      }
    }

    if (
      interaction.isButton() &&
      interaction.customId.startsWith("survive:alive-check:")
    ) {
      const runKey = interaction.customId.replace("survive:alive-check:", "");
      const status = getSurvivalRunLifeStatus(runKey, interaction.user.id);

      if (!status.ok) {
        return interaction.reply({
          content: "That Survival check expired or the run could not be found.",
          flags: 64,
        });
      }

      if (!status.joined) {
        return interaction.reply({
          content: status.ended
            ? "You were not part of that Squig Survival run."
            : "You are not in this Squig Survival run.",
          flags: 64,
        });
      }

      return interaction.reply({
        content: status.alive
          ? status.ended
            ? "Yes. You finished that Squig Survival run alive."
            : "Yes. You are still alive in this Squig Survival run."
          : status.ended
          ? "No. You were eliminated before that Squig Survival run ended."
          : "No. You have already been eliminated from this Squig Survival run.",
        flags: 64,
      });
    }

    if (interaction.isButton() && interaction.customId === "gauntlet:mystats") {
      const month = currentMonthStr();
      const mine = await Store.getMyMonth(interaction.user.id, month);
      const inventory = await Store.getGauntletItemInventory(interaction.user.id);
      const hasPlays = Number(mine.plays) > 0;
      const bestText = hasPlays ? mine.best : "—";
      const leastText = hasPlays ? mine.least : "—";
      const maxGreed = Math.max(0, Number(mine.max_greed_level || 0) || 0);

      const embed = new EmbedBuilder()
        .setTitle(`🧾 Your Gauntlet — ${month}`)
        .setDescription(
          [
            `🎮 **Games Played:** ${mine.plays}`,
            `🏆 **Best Reward:** ${bestText}${hasPlays ? " $CHARM" : ""}`,
            `🔻 **Lowest Reward:** ${leastText}${hasPlays ? " $CHARM" : ""}`,
            `🧮 **Total Reward:** ${mine.total} $CHARM`,
            `🔥 **Highest Greed:** ${maxGreed} (${getGreedLabel(maxGreed)})`,
            `🧿 **Items:** ${formatItemInventory(inventory)}`,
          ].join("\n")
        )
        .setColor(0x00ccff);

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    if (interaction.isButton() && interaction.customId === "gauntlet:leaderboard") {
      await interaction.deferReply({ flags: 64 });
      const month = currentMonthStr();
      const embed = await renderTotalLeaderboardEmbed(month);
      return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.isButton() && interaction.customId === "gauntlet:info") {
      await interaction.deferReply({ flags: 64 });
      return interaction.editReply({ embeds: [buildDecisionGauntletInfoEmbed()] });
    }

    // Start button
    if (interaction.isButton() && interaction.customId === "gauntlet:start") {
      await interaction.deferReply({ flags: 64 });
      const isAdmin = isAdminUserLocal(interaction);
      const today = torontoDateStr();
      const played = isAdmin
        ? false
        : await Store.hasPlayed(interaction.user.id, today);

      if (played) {
        const when = nextTorontoMidnight();
        return interaction.editReply({
          content: `⏳ You've already played today. Come back after **${when} (Toronto)**.`,
        });
      }

      // Lock the daily play immediately to prevent multiple starts in one day.
      if (!isAdmin) {
        await Store.recordPlay(interaction.user.id, today);
      }

      await interaction.editReply({
        content: "⚔️ Decision Gauntlet is loading...",
      });

      await runSoloGauntletEphemeral(interaction);
      return;
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "❌ Something went wrong.",
            flags: 64,
          });
        } else {
          await interaction.reply({
            content: "❌ Something went wrong.",
            flags: 64,
          });
        }
      } catch {}
    }
  }
}

async function handleMessageCreate(message) {
  try {
    if (!message || message.author?.bot) return;
    const content = String(message.content || "").trim().toLowerCase();
    if (content !== "!revive") return;
    await handlePublicReviveCommand(message);
  } catch (err) {
    console.error("messageCreate error:", err);
  }
}

// --------------------------------------------
// EXPORTS
// --------------------------------------------
module.exports = {
  registerCommands,
  handleInteractionCreate,
  handleMessageCreate,
  initSurvivalLobby,
};
