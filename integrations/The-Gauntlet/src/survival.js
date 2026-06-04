// survival.js
// Core RNG story engine for Squig Survival.

const { randomInt: cryptoRandomInt } = require("crypto");
const {
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { rewardCharmAmount, logCharmReward } = require("./drip");
const { imageStore } = require("./imageStore");
const { survivalStore } = require("./survivalStore");
const {
  SURVIVAL_ERAS,
  getSurvivalEraDefinition,
  getSurvivalReviveFailLore,
  getSurvivalAliveTauntLore,
} = require("./survivalEras");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const REVEAL_DELAY_MS = 2000;
const MILESTONE_PAUSE_MS = 20000;
const SHARED_LOCKED_FIRST_IMAGE = "https://i.imgur.com/jfVffAW.jpeg";
const SURVIVAL_IMAGE_SUBMISSION_URL =
  "https://imagesubmit-production.up.railway.app/";
const REVIVE_SUCCESS_IMAGE_TAG = "revive_success";
const REVIVE_FAILED_IMAGE_TAG = "revive_failed";
const SPECIAL_SURVIVAL_IMAGE_TAGS = new Set([
  REVIVE_SUCCESS_IMAGE_TAG,
  REVIVE_FAILED_IMAGE_TAG,
]);
const SHARED_FALLBACK_STAGE_IMAGES = [
  "https://i.imgur.com/jYNKD3d.jpeg",
  "https://i.imgur.com/8hJ6XEE.jpeg",
  "https://i.imgur.com/yBmAjMh.jpeg",
  "https://i.imgur.com/fiNkaTa.jpeg",
  "https://i.imgur.com/r5Nysp5.jpeg",
  "https://i.imgur.com/oDDwiXk.jpeg",
  "https://i.imgur.com/1NTPdp2.jpeg",
  "https://i.imgur.com/R4wlJ1q.jpeg",
  "https://i.imgur.com/RJwmxm4.jpeg",
  "https://i.imgur.com/atw2YPn.jpeg",
  "https://i.imgur.com/9RY06vL.jpeg",
  "https://i.imgur.com/dnTGhgl.jpeg",
  "https://i.imgur.com/whAJaka.jpeg",
  "https://i.imgur.com/njckQiQ.jpeg",
  "https://i.imgur.com/szOnMxN.jpeg",
  "https://i.imgur.com/K4x6Dgk.jpeg",
  "https://i.imgur.com/Nmc9UPb.jpeg",
  "https://i.imgur.com/bZwvi5J.jpeg",
  "https://i.imgur.com/Tlf4elV.jpeg",
  "https://i.imgur.com/K1BMD1e.jpeg",
  "https://i.imgur.com/eDAkAOV.png",
];

const pick = (arr) => arr[cryptoRandomInt(arr.length)];
const randInt = (min, max) => cryptoRandomInt(min, max + 1);
const chance = (probability) =>
  cryptoRandomInt(1_000_000) < Math.floor(probability * 1_000_000);
const survivalRunStatuses = new Map();
const activeSurvivalRuns = new Map();
const survivalShareSessions = new Map();
const MAX_SURVIVAL_SHARE_SESSIONS = 20;
const SURVIVAL_SHARE_DISCORD_CHANNEL_ID = "1334345680461762671";

function upsertSurvivalRunStatus(runKey, joinedIds, aliveIds, ended = false) {
  if (!runKey) return;
  survivalRunStatuses.set(runKey, {
    joined: new Set(joinedIds || []),
    alive: new Set(aliveIds || []),
    ended,
    updatedAt: Date.now(),
  });

  if (survivalRunStatuses.size > 10) {
    const oldest = [...survivalRunStatuses.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, survivalRunStatuses.size - 10);
    for (const [key] of oldest) {
      survivalRunStatuses.delete(key);
    }
  }
}

function getSurvivalRunLifeStatus(runKey, userId) {
  const status = survivalRunStatuses.get(runKey);
  if (!status) {
    return { ok: false };
  }

  return {
    ok: true,
    joined: status.joined.has(userId),
    alive: status.alive.has(userId),
    ended: Boolean(status.ended),
  };
}

function registerActiveSurvivalRun(run) {
  if (!run?.runKey || !run?.channelId) return;
  activeSurvivalRuns.set(run.channelId, run);
}

function clearActiveSurvivalRun(channelId) {
  if (!channelId) return;
  activeSurvivalRuns.delete(channelId);
}

function trimSurvivalShareSessions() {
  if (survivalShareSessions.size <= MAX_SURVIVAL_SHARE_SESSIONS) return;
  const oldest = [...survivalShareSessions.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, survivalShareSessions.size - MAX_SURVIVAL_SHARE_SESSIONS);
  for (const [key] of oldest) {
    survivalShareSessions.delete(key);
  }
}

function formatPlacementLabel(rank) {
  const placement = Math.max(1, Number(rank) || 1);
  if (placement % 100 >= 11 && placement % 100 <= 13) {
    return `${placement}th`;
  }
  if (placement % 10 === 1) return `${placement}st`;
  if (placement % 10 === 2) return `${placement}nd`;
  if (placement % 10 === 3) return `${placement}rd`;
  return `${placement}th`;
}

function buildSurvivalShareText(result = {}) {
  const placementLabel = formatPlacementLabel(result.placement);
  const payout = Math.max(0, Number(result.payout) || 0);
  const creatorReward = Math.max(0, Number(result.creatorReward) || 0);

  if (payout > 0 && creatorReward > 0) {
    return [
      `I just won ${placementLabel} Place in Squig Survival and won ${payout} $CHARM, plus another ${creatorReward} $CHARM for my in-game creations`,
      "",
      "Join the fun at https://squigs.io/discord",
      "@SquigsNFT #SquigsAreWatching",
    ].join("\n");
  }

  if (payout > 0) {
    return [
      `I just won ${placementLabel} Place in Squig Survival and won ${payout} $CHARM`,
      "",
      "Join the fun at https://squigs.io/discord",
      "@SquigsNFT #SquigsAreWatching",
    ].join("\n");
  }

  if (creatorReward > 0) {
    return [
      `I just got ${placementLabel} Place in Squig Survival and still earned ${creatorReward} $CHARM for my in-game creations`,
      "",
      "Join the fun at https://squigs.io/discord",
      "@SquigsNFT #SquigsAreWatching",
    ].join("\n");
  }

  return [
    `I just got ${placementLabel} Place in Squig Survival and didn't win anything at all`,
    "",
    "Come lose with me in https://squigs.io/discord",
    "@SquigsNFT #SquigsAreWatching",
  ].join("\n");
}

function createSurvivalShareSession({
  gameId,
  placements = [],
  awardedPayouts = {},
  creatorRewardTotals = {},
  imageUrls = [],
} = {}) {
  const orderedPlayers = Array.from(new Set(placements || [])).filter(Boolean);
  if (!orderedPlayers.length) return null;

  const creatorEntries =
    creatorRewardTotals instanceof Map
      ? Array.from(creatorRewardTotals.entries())
      : Object.entries(creatorRewardTotals || {});

  const creatorRewardMap = new Map(
    creatorEntries.map(([userId, amount]) => [String(userId), Math.max(0, Number(amount) || 0)])
  );

  const results = new Map(
    orderedPlayers.map((userId, index) => {
      const result = {
        userId: String(userId),
        placement: index + 1,
        payout: Math.max(0, Number(awardedPayouts?.[userId] || 0)),
        creatorReward: creatorRewardMap.get(String(userId)) || 0,
      };
      return [String(userId), result];
    })
  );

  const sessionId = gameId
    ? `game-${gameId}`
    : `share-${Date.now()}-${cryptoRandomInt(1_000_000)}`;

  survivalShareSessions.set(sessionId, {
    sessionId,
    gameId: gameId || null,
    createdAt: Date.now(),
    imageUrls: Array.from(new Set((imageUrls || []).filter(Boolean))).slice(0, 8),
    results,
  });
  trimSurvivalShareSessions();
  return sessionId;
}

function getSurvivalShareData(sessionId, userId) {
  const session = survivalShareSessions.get(sessionId);
  if (!session || !userId) return null;
  const result = session.results.get(String(userId));
  if (!result) return null;

  return {
    sessionId: session.sessionId,
    gameId: session.gameId,
    imageUrls: session.imageUrls,
    result: {
      ...result,
      shareText: buildSurvivalShareText(result),
    },
  };
}

function formatReviveLore(template, mention) {
  return String(template || "").replace(/{victim}/g, mention);
}

function formatPlayerLore(template, mention) {
  return String(template || "").replace(/{player}/g, mention);
}

function getReviveAttemptCount(run, userId) {
  if (!run?.reviveAttemptsByMilestone || !userId) return 0;
  return run.reviveAttemptsByMilestone.get(userId) || 0;
}

function recordReviveAttempt(run, userId) {
  if (!run?.reviveAttemptsByMilestone || !userId) return 0;
  const nextCount = getReviveAttemptCount(run, userId) + 1;
  run.reviveAttemptsByMilestone.set(userId, nextCount);
  return nextCount;
}

async function handlePublicReviveCommand(message) {
  const channelId = message?.channelId || message?.channel?.id;
  if (!channelId) return false;

  const run = activeSurvivalRuns.get(channelId);
  if (!run || run.ended) return false;

  const userId = message.author.id;
  const mention = `<@${userId}>`;

  if (!run.revivesEnabled) {
    await message.channel.send(
      `${mention} tried to file a resurrection request, but revives are turned **off** for this game. The afterlife put your ticket straight into the shredder. You are still dead.`
    );
    return true;
  }

  if ((run.aliveIds?.length || 0) <= 3) {
    await message.channel.send(
      `${mention} revive is locked once Squig Survival is down to the final **3**. The grave stays closed. You are still dead.`
    );
    return true;
  }

  const reviveAttempts = getReviveAttemptCount(run, userId);

  if (reviveAttempts >= 2) {
    await message.channel.send(
      `${mention} you've used both revive attempts for milestone **${run.currentMilestone || 1}**. The resurrection department is closed for lunch, emotionally unavailable, and ignoring your paperwork. You are still dead.`
    );
    return true;
  }

  recordReviveAttempt(run, userId);

  if (!run.joined.has(userId)) {
    await message.channel.send(
      `${mention} you were not in this Squig Survival game. Mid-game entry costs **100 BTC** 😂`
    );
    return true;
  }

  if (run.aliveSet.has(userId)) {
    const taunts = getSurvivalAliveTauntLore();
    const line = formatPlayerLore(pick(taunts), mention);
    await message.channel.send(line);
    return true;
  }

  const revived = chance(0.08);
  if (revived) {
    for (let i = run.eliminatedIds.length - 1; i >= 0; i -= 1) {
      if (run.eliminatedIds[i] === userId) {
        run.eliminatedIds.splice(i, 1);
      }
    }
    for (let i = run.aliveIds.length - 1; i >= 0; i -= 1) {
      if (run.aliveIds[i] === userId) {
        run.aliveIds.splice(i, 1);
      }
    }
    run.aliveIds.push(userId);
    run.aliveSet = new Set(run.aliveIds);
    upsertSurvivalRunStatus(run.runKey, run.joinedIds, run.aliveIds, false);

    const eraDefinition = getSurvivalEraDefinition(run.eraKey);
    const defaultEraDefinition = getSurvivalEraDefinition("day_one");
    const resurrections = eraDefinition.stories?.resurrections?.length
      ? eraDefinition.stories.resurrections
      : defaultEraDefinition.stories?.resurrections || [];
    const text = formatReviveLore(
      pick(resurrections.length ? resurrections : ["{victim} stumbles back into existence."]),
      mention
    );
    const imageUrl = takeRunImage(
      run,
      "reviveSuccessImagePool",
      "reviveSuccessImageBag"
    );
    const payload = imageUrl
      ? {
          content: `🌟 **RESURRECTION!** ${text}`,
          embeds: [new EmbedBuilder().setColor(0x2ecc71).setImage(imageUrl)],
        }
      : {
          content: `🌟 **RESURRECTION!** ${text}`,
        };
    await message.channel.send(payload);
    await awardSurvivalImageUse(message.channel, run, imageUrl);
    return true;
  }

  const failLore = getSurvivalReviveFailLore(run.eraKey);
  const failText = `${formatPlayerLore(pick(failLore), mention)}\n💀 ${mention} is still dead.`;
  const imageUrl = takeRunImage(
    run,
    "reviveFailedImagePool",
    "reviveFailedImageBag"
  );
  const payload = imageUrl
    ? {
        content: failText,
        embeds: [new EmbedBuilder().setColor(0x95a5a6).setImage(imageUrl)],
      }
    : {
        content: failText,
      };
  await message.channel.send(payload);
  await awardSurvivalImageUse(message.channel, run, imageUrl);
  return true;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

function parseEraKeys(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const keys = raw
    .split(",")
    .map((part) => normalizeSurvivalImageTag(part) || part.trim())
    .filter(Boolean);
  return keys.length ? Array.from(new Set(keys)) : null;
}

function normalizeSurvivalImageTag(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const normalized = raw.trim();
  const lowered = normalized.toLowerCase();

  if (
    lowered === REVIVE_SUCCESS_IMAGE_TAG ||
    lowered === "!revive success" ||
    lowered === "revive success"
  ) {
    return REVIVE_SUCCESS_IMAGE_TAG;
  }
  if (
    lowered === REVIVE_FAILED_IMAGE_TAG ||
    lowered === "!revive failed" ||
    lowered === "revive failed"
  ) {
    return REVIVE_FAILED_IMAGE_TAG;
  }

  const directKey = Object.keys(SURVIVAL_ERAS).find(
    (key) => key.toLowerCase() === lowered
  );
  if (directKey) return directKey;

  return (
    Object.entries(SURVIVAL_ERAS).find(
      ([, era]) => era?.label?.toLowerCase() === lowered
    )?.[0] || null
  );
}

function takeRunImage(run, poolKey, bagKey) {
  if (!run) return null;
  const pool = Array.isArray(run[poolKey]) ? run[poolKey] : [];
  if (!pool.length) return null;
  if (!Array.isArray(run[bagKey]) || !run[bagKey].length) {
    run[bagKey] = shuffle(pool);
  }
  return run[bagKey].shift() || null;
}

async function awardSurvivalImageUse(channel, run, imageUrl) {
  if (!channel || !run || !imageUrl) return;

  if (!Array.isArray(run.usedImageUrls)) {
    run.usedImageUrls = [];
  }
  run.usedImageUrls.push(imageUrl);

  const artReward =
    run.dbRewardMap?.get(imageUrl) || SURVIVAL_ART_REWARDS[imageUrl] || null;
  if (!artReward?.userId) return;

  if (!(run.creatorRewardTotals instanceof Map)) {
    run.creatorRewardTotals = new Map();
  }

  if (run.gameId) {
    await survivalStore.addImageUse(run.gameId, artReward.userId, imageUrl);
  }

  try {
    run.creatorRewardTotals.set(
      artReward.userId,
      (run.creatorRewardTotals.get(artReward.userId) || 0) + artReward.amount
    );
    await channel.send({
      content: `-# 🎨 Art drop! Thanks to <@${artReward.userId}> — your Squig Survival art was used and **+${artReward.amount} $CHARM** was added to your end-of-game creator total.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel("SUBMIT IMAGES")
            .setURL(SURVIVAL_IMAGE_SUBMISSION_URL)
        ),
      ],
    });
  } catch (err) {
    console.error(
      "[GAUNTLET:DRIP] Survival art tally failed:",
      err?.message || err
    );
  }
}

const SURVIVAL_ART_PAYOUT = 100;
const SURVIVAL_ART_REWARDS = {
  "https://i.imgur.com/Tlf4elV.jpeg": {
    userId: "836389642885398530",
    amount: SURVIVAL_ART_PAYOUT,
    reason: "Squig Survival art bonus (image used) — thanks for your creativity!",
  },
  "https://i.imgur.com/K1BMD1e.jpeg": {
    userId: "836389642885398530",
    amount: SURVIVAL_ART_PAYOUT,
    reason: "Squig Survival art bonus (image used) — thanks for your creativity!",
  },
  "https://i.imgur.com/eDAkAOV.png": {
    userId: "833502268137144330",
    amount: SURVIVAL_ART_PAYOUT,
    reason: "Squig Survival art bonus (image used) — thanks for your creativity!",
  },
};

const PODIUM_RINGS = [
  { color: "#d4af37", label: "1st" }, // gold
  { color: "#c0c0c0", label: "2nd" }, // silver
  { color: "#cd7f32", label: "3rd" }, // bronze
];

async function buildPodiumImage(client, placements, guildId) {
  try {
    const topThree = [];
    for (const id of placements || []) {
      if (!topThree.includes(id)) topThree.push(id);
      if (topThree.length >= 3) break;
    }
    if (!topThree.length) return null;

    const width = 900;
    const height = 520;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Background image
    try {
      const bgImg = await loadImage("https://i.imgur.com/xjpLTnF.jpeg");
      ctx.drawImage(bgImg, 0, 0, width, height);
    } catch {
      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, "#1b1f2a");
      bg.addColorStop(1, "#0f1117");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
    }

    // Subtle darken for contrast
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, width, height);

    // Draw avatars
    const avatarSize = 144;
    const podiumY = height - 120;
    const blockW = 200;
    const blockGap = 30;
    const centerX = width / 2;
    const raiseBy = avatarSize / 2;
    const avatarCenters = [
      { x: centerX, y: podiumY - 180 - 20 - raiseBy },
      { x: centerX - blockW - blockGap, y: podiumY - 130 - 10 - raiseBy },
      { x: centerX + blockW + blockGap, y: podiumY - 110 - 10 - raiseBy },
    ];

    let guild = null;
    if (guildId) {
      try {
        guild = await client.guilds.fetch(guildId);
      } catch {
        guild = null;
      }
    }

    for (let i = 0; i < 3; i++) {
      const userId = topThree[i];
      if (!userId) continue;
      let avatarUrl;
      try {
        if (guild) {
          const member = await guild.members.fetch(userId);
          avatarUrl = member.displayAvatarURL({ extension: "png", size: 256 });
        } else {
          const user = await client.users.fetch(userId);
          avatarUrl = user.displayAvatarURL({ extension: "png", size: 256 });
        }
      } catch {
        try {
          const user = await client.users.fetch(userId);
          avatarUrl = user.displayAvatarURL({ extension: "png", size: 256 });
        } catch {
          avatarUrl = null;
        }
      }

      const center = avatarCenters[i];
      const radius = avatarSize / 2;
      const ring = PODIUM_RINGS[i];

      if (avatarUrl) {
        const img = await loadImage(avatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, center.x - radius, center.y - radius, avatarSize, avatarSize);
        ctx.restore();
      } else {
        ctx.fillStyle = "#2b3242";
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Ring
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius + 6, 0, Math.PI * 2);
      ctx.stroke();

      // Rank label
      ctx.fillStyle = ring.color;
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(ring.label, center.x, center.y + radius + 28);
    }

    return canvas.toBuffer("image/png");
  } catch (err) {
    console.error("[GAUNTLET] Podium image failed:", err?.message || err);
    return null;
  }
}

function format(template, victimId, killerId, nameOf) {
  // Victim is always eliminated -> crossed out.
  const victimName = `~~${nameOf(victimId)}~~`;
  const killerName = killerId ? nameOf(killerId) : "another Squig";

  return template
    .replace(/{victim}/g, victimName)
    .replace(/{killer}/g, killerName);
}

/**
 * Run the Squig Survival story.
 * @param {import('discord.js').TextChannel} channel
 * @param {string[]} playerIds - Array of user IDs
 * @param {object} settings
 */
async function runSurvival(channel, playerIds, settings = {}) {
  if (!playerIds || playerIds.length === 0) return;

  const normalizedSettings = {
    era_key: settings?.era_key || "day_one",
    era: settings?.era || null,
    pool_increment: Number(settings?.pool_increment || 50) || 50,
    creator_chaos: Boolean(settings?.creator_chaos),
    bonus_active: Boolean(settings?.bonus_active),
    revives_enabled:
      settings?.revives_enabled === null || settings?.revives_enabled === undefined
        ? true
        : Boolean(settings?.revives_enabled),
    bonus_required_players: Math.max(
      1,
      Number(settings?.bonus_required_players || 0) || 1
    ),
    bonus_multiplier: Math.max(
      1,
      Number(settings?.bonus_multiplier || 1) || 1
    ),
  };
  const defaultEraDefinition = getSurvivalEraDefinition("day_one");
  const eraDefinition = getSurvivalEraDefinition(normalizedSettings.era_key);
  const eraLabel = normalizedSettings.era || eraDefinition.label;
  const creatorChaosActive = Boolean(normalizedSettings.creator_chaos);
  const useEraLockedImagesOnly = Boolean(eraDefinition.useEraLockedImagesOnly);

  let dbImageRows = [];
  try {
    dbImageRows = await imageStore.getSurvivalImages();
  } catch (err) {
    console.error(
      "[GAUNTLET:IMGDB] Failed to load survival images:",
      err?.message || err
    );
  }

  const eligibleDbImageRows = dbImageRows.filter((row) => {
    if (!row?.image_url) return false;
    const eraKeys = parseEraKeys(row.era_keys);
    if (!eraKeys?.length) return !useEraLockedImagesOnly;
    if (eraKeys.some((key) => SPECIAL_SURVIVAL_IMAGE_TAGS.has(key))) return false;
    return eraKeys.includes(normalizedSettings.era_key);
  });
  const reviveSuccessImageRows = dbImageRows.filter((row) =>
    parseEraKeys(row?.era_keys)?.includes(REVIVE_SUCCESS_IMAGE_TAG)
  );
  const reviveFailedImageRows = dbImageRows.filter((row) =>
    parseEraKeys(row?.era_keys)?.includes(REVIVE_FAILED_IMAGE_TAG)
  );

  const dbImageUrls = eligibleDbImageRows.map((r) => r.image_url).filter(Boolean);
  const fallbackStageImages = useEraLockedImagesOnly
    ? []
    : Array.from(new Set(SHARED_FALLBACK_STAGE_IMAGES));
  const mergedStageImages = [...new Set([...fallbackStageImages, ...dbImageUrls])];
  const reviveSuccessImages = reviveSuccessImageRows
    .map((r) => r.image_url)
    .filter(Boolean);
  const reviveFailedImages = reviveFailedImageRows
    .map((r) => r.image_url)
    .filter(Boolean);
  const dbRewardMap = new Map(
    dbImageRows
      .filter((r) => r.image_url && r.user_id)
      .map((r) => [
        r.image_url,
        {
          userId: r.user_id,
          amount:
            Number.isFinite(Number(r.reward_points)) && Number(r.reward_points) > 0
              ? Number(r.reward_points)
              : SURVIVAL_ART_PAYOUT,
          reason: "Squig Survival art bonus (image used) — thanks for your creativity!",
        },
      ])
  );
  const creatorRewardTotals = new Map();
  const usedImageUrls = [];

  const uniquePlayers = Array.from(new Set(playerIds));
  const gameId = await survivalStore.createGame(new Date());
  const runKey = gameId
    ? `game-${gameId}`
    : `run-${Date.now()}-${cryptoRandomInt(1_000_000)}`;
  if (gameId) {
    await Promise.all(
      uniquePlayers.map((id) => survivalStore.recordJoin(gameId, id, new Date()))
    );
  }
  const nameMap = await buildDisplayNameMap(
    channel.client,
    channel.guildId,
    uniquePlayers
  );
  const nameOf = (id) => nameMap.get(id) || `User-${id}`;

  let alive = [...uniquePlayers];
  const eliminated = [];
  upsertSurvivalRunStatus(runKey, uniquePlayers, alive);
  const activeRunState = {
    runKey,
    channelId: channel.id,
    gameId,
    eraKey: normalizedSettings.era_key,
    revivesEnabled: normalizedSettings.revives_enabled,
    joinedIds: uniquePlayers,
    joined: new Set(uniquePlayers),
    aliveIds: alive,
    aliveSet: new Set(alive),
    eliminatedIds: eliminated,
    currentMilestone: 1,
    reviveAttemptsByMilestone: new Map(),
    ended: false,
    creatorRewardTotals,
    usedImageUrls,
    dbRewardMap,
    stageImagePool: mergedStageImages,
    stageImageBag: shuffle(mergedStageImages),
    reviveSuccessImagePool: reviveSuccessImages,
    reviveSuccessImageBag: shuffle(reviveSuccessImages),
    reviveFailedImagePool: reviveFailedImages,
    reviveFailedImageBag: shuffle(reviveFailedImages),
  };
  registerActiveSurvivalRun(activeRunState);

  const eraStories = eraDefinition.stories || {};
  const defaultStories = defaultEraDefinition.stories || {};
  const hidingSpots = eraStories.hidingSpots?.length
    ? eraStories.hidingSpots
    : defaultStories.hidingSpots || [];
  const clumsiness = eraStories.clumsiness?.length
    ? eraStories.clumsiness
    : defaultStories.clumsiness || [];
  const sabotage = eraStories.sabotage?.length
    ? eraStories.sabotage
    : defaultStories.sabotage || [];
  const resurrections = eraStories.resurrections?.length
    ? eraStories.resurrections
    : defaultStories.resurrections || [];
  const loreLines = eraDefinition.loreLines?.length
    ? eraDefinition.loreLines
    : defaultEraDefinition.loreLines || [];
  const milestoneStages = eraDefinition.milestoneStages?.length
    ? eraDefinition.milestoneStages
    : defaultEraDefinition.milestoneStages || [];

  // One player = instant win embed
  if (alive.length === 1) {
    const payouts = calculateSurvivalPayouts(
      uniquePlayers,
      [alive[0]],
      normalizedSettings
    );
    const awardedPayouts = await sendSurvivalPayouts(
      channel,
      payouts,
      [alive[0]],
      uniquePlayers.length,
      normalizedSettings
    );
    const shareSessionId = createSurvivalShareSession({
      gameId,
      placements: [alive[0]],
      awardedPayouts,
      creatorRewardTotals,
      imageUrls: usedImageUrls,
    });
    await sendSurvivalCreatorPayouts(
      channel,
      creatorRewardTotals
    );
    await sendSurvivalRewardsSummary(
      channel,
      [alive[0]],
      awardedPayouts,
      creatorRewardTotals,
      shareSessionId
    );
    clearActiveSurvivalRun(channel.id);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Squig Survival - Default Victory")
          .setDescription(
            `${nameOf(alive[0])} is the only Squig who dared the portal.\nThey survive by technicality... the portal is unimpressed.`
          )
          .setColor(0x2ecc71),
      ],
    });
    return;
  }

  let milestone = 1;

  while (alive.length > 1) {
    const activeRunAtStart = activeSurvivalRuns.get(channel.id);
    if (activeRunAtStart) {
      activeRunAtStart.currentMilestone = milestone;
      activeRunAtStart.reviveAttemptsByMilestone = new Map();
    }
    const lines = [];
    const killsThisRound = creatorChaosActive
      ? 1
      : Math.max(1, Math.floor(alive.length / 3));

    // --- ELIMINATIONS ---
    for (let i = 0; i < killsThisRound && alive.length > 1; i++) {
      const shuffledAlive = shuffle([...alive]);
      const safeCount = cryptoRandomInt(alive.length);
      const vulnerablePlayers = shuffledAlive.slice(safeCount);
      const victimPool = vulnerablePlayers.length
        ? vulnerablePlayers
        : [shuffledAlive[shuffledAlive.length - 1]];
      const victimId = victimPool[cryptoRandomInt(victimPool.length)];
      const victimIndex = alive.indexOf(victimId);
      if (victimIndex === -1) continue;
      alive.splice(victimIndex, 1);
      eliminated.push(victimId);
      const activeRun = activeSurvivalRuns.get(channel.id);
      if (activeRun) {
        activeRun.aliveSet = new Set(alive);
      }
      if (gameId) {
        await survivalStore.addDeath(gameId, victimId, 1);
      }

      const category = cryptoRandomInt(3);
      let text;

      if (category === 0) {
        // Hiding spot
        text = format(pick(hidingSpots), victimId, null, nameOf);
      } else if (category === 1) {
        // Clumsiness
        text = format(pick(clumsiness), victimId, null, nameOf);
      } else {
        // Sabotage - needs a killer if possible
        if (alive.length === 0) {
          text = format(pick(clumsiness), victimId, null, nameOf);
        } else {
          const killerId = alive[cryptoRandomInt(alive.length)];
          text = format(pick(sabotage), victimId, killerId, nameOf);
          if (gameId) {
            await survivalStore.addElimination(gameId, killerId, 1);
          }
        }
      }

      // 💀 Death line
      lines.push(`💀 ${text}`);
    }

    // --- RESURRECTION CHANCE ---
    if (
      eliminated.length > 0 &&
      resurrections.length > 0 &&
      chance(0.18) // ~18% chance per milestone
    ) {
      const revivedIndex = cryptoRandomInt(eliminated.length);
      const revivedId = eliminated.splice(revivedIndex, 1)[0];
      alive.push(revivedId);
      const activeRun = activeSurvivalRuns.get(channel.id);
      if (activeRun) {
        activeRun.aliveSet = new Set(alive);
      }

      const resurrectionTemplate = pick(resurrections);
      // Revived Squig should appear normally (no strikethrough)
      const resurrectionText = resurrectionTemplate.replace(
        /{victim}/g,
        nameOf(revivedId)
      );

      // ✨ Revival line (emphasized)
      lines.push("🌟 **RESURRECTION!**");
      lines.push(`✨ **${resurrectionText}**`);
    }

    // --- LORE-ONLY LINES ---
    const loreCount = creatorChaosActive ? 2 : randInt(2, 3);
    for (let i = 0; i < loreCount; i++) {
      const who = pick(alive.length ? alive : uniquePlayers);
      const lore = pick(loreLines).replace(/{player}/g, nameOf(who));
      const insertAt = randInt(0, lines.length);
      lines.splice(insertAt, 0, lore);
    }

    // Pick the stage for this milestone
    const stageIndex = Math.min(
      milestone - 1,
      milestoneStages.length - 1
    );
    const stage = milestoneStages[stageIndex];

    const embed = new EmbedBuilder()
      .setTitle(`Squig Life - ${stage.title}`)
      .setColor(0x9b59b6);
    const statusRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`survive:alive-check:${runKey}`)
        .setLabel("Am I still alive?")
        .setStyle(ButtonStyle.Secondary)
    );

    let imageUrl = null;
    if (milestone === 1 && !useEraLockedImagesOnly) {
      imageUrl = SHARED_LOCKED_FIRST_IMAGE;
    } else if (activeRunState.stageImagePool.length) {
      imageUrl = takeRunImage(activeRunState, "stageImagePool", "stageImageBag");
    }
    if (imageUrl) {
      embed.setImage(imageUrl);
      await awardSurvivalImageUse(channel, activeRunState, imageUrl);
    }

    const baseDesc = stage.flavor ? `_${stage.flavor}_\n` : "";
    const buildDesc = (count) => {
      if (!lines.length) return baseDesc.trim();
      const slice = lines.slice(0, count).join("\n");
      return `${baseDesc}${slice}`.trim();
    };

    embed.setDescription(buildDesc(0));

    // --- FOOTER: HOW MANY SQUIGS REMAIN ---
    const remainingText = `${alive.length} Squig${
      alive.length === 1 ? "" : "s"
    } Remain`;

    if (eraLabel) {
      embed.setFooter({
        text: `${eraLabel} - ${remainingText}`,
      });
    } else {
      embed.setFooter({
        text: remainingText,
      });
    }

    const msg = await channel.send({ embeds: [embed] });

    if (lines.length > 0) {
      for (let i = 1; i <= lines.length; i++) {
        await sleep(REVEAL_DELAY_MS);
        try {
          embed.setDescription(buildDesc(i));
          await msg.edit({ embeds: [embed] });
        } catch {
          // If edit fails (deleted or perms), just stop revealing.
          break;
        }
      }
    }
    upsertSurvivalRunStatus(runKey, uniquePlayers, alive);
    const activeRun = activeSurvivalRuns.get(channel.id);
    if (activeRun) {
      activeRun.aliveSet = new Set(alive);
    }
    try {
      await msg.edit({ embeds: [embed], components: [statusRow] });
    } catch {}
    milestone += 1;

    // Short breather between milestones
    await sleep(MILESTONE_PAUSE_MS);
  }

  // Winner + standings
  const winnerId = alive[0];
  upsertSurvivalRunStatus(runKey, uniquePlayers, alive, true);
  const activeRun = activeSurvivalRuns.get(channel.id);
  if (activeRun) {
    activeRun.ended = true;
    activeRun.aliveSet = new Set(alive);
  }
  const placements = [winnerId, ...eliminated.reverse()];
  if (gameId) {
    const uniquePlacements = [];
    for (const id of placements) {
      if (!uniquePlacements.includes(id)) uniquePlacements.push(id);
      if (uniquePlacements.length >= 3) break;
    }
    await Promise.all(
      uniquePlacements.map((id, idx) =>
        survivalStore.setPlacement(gameId, id, idx + 1)
      )
    );
  }

  const lbLines = placements.map((id, index) => {
    const rank = index + 1;
    let prefix;
    if (rank === 1) prefix = "🥇 1st";
    else if (rank === 2) prefix = "🥈 2nd";
    else if (rank === 3) prefix = "🥉 3rd";
    else prefix = `${rank}.`;
    return `${prefix} - ${nameOf(id)}`;
  });

  const standingsEmbed = new EmbedBuilder()
    .setTitle("Squig Survival - Final Standings")
    .setDescription(lbLines.join("\n"))
    .setColor(0xf1c40f)
    .setFooter({ text: "Only one Squig ever really makes it..." });

  const podiumBuffer = await buildPodiumImage(
    channel.client,
    placements,
    channel.guildId
  );
  if (podiumBuffer) {
    const podiumAttachment = new AttachmentBuilder(podiumBuffer, {
      name: "podium.png",
    });
    standingsEmbed.setImage("attachment://podium.png");
    await channel.send({
      embeds: [standingsEmbed],
      files: [podiumAttachment],
    });
  } else {
    await channel.send({
      embeds: [standingsEmbed],
    });
  }

  const payouts = calculateSurvivalPayouts(
    uniquePlayers,
    placements,
    normalizedSettings
  );
  const awardedPayouts = await sendSurvivalPayouts(
    channel,
    payouts,
    placements,
    uniquePlayers.length,
    normalizedSettings
  );
  const shareSessionId = createSurvivalShareSession({
    gameId,
    placements,
    awardedPayouts,
    creatorRewardTotals,
    imageUrls: usedImageUrls,
  });
  await sendSurvivalCreatorPayouts(
    channel,
    creatorRewardTotals
  );
  await sendSurvivalRewardsSummary(
    channel,
    placements,
    awardedPayouts,
    creatorRewardTotals,
    shareSessionId
  );
  clearActiveSurvivalRun(channel.id);
}

function resolveSurvivalPrizePool(totalPlayers, settings = {}) {
  const poolIncrement = Math.max(1, Number(settings?.pool_increment || 50) || 50);
  const basePrizePool = poolIncrement * Math.max(0, totalPlayers);
  const bonusActive = Boolean(settings?.bonus_active);
  const bonusRequiredPlayers = Math.max(
    1,
    Number(settings?.bonus_required_players || 0) || 1
  );
  const bonusMultiplier = Math.max(
    1,
    Number(settings?.bonus_multiplier || 1) || 1
  );
  const bonusTriggered = bonusActive && totalPlayers >= bonusRequiredPlayers;
  const finalPrizePool = bonusTriggered
    ? Math.floor(basePrizePool * bonusMultiplier)
    : basePrizePool;

  return {
    poolIncrement,
    basePrizePool,
    bonusActive,
    bonusRequiredPlayers,
    bonusMultiplier,
    bonusTriggered,
    finalPrizePool,
  };
}

function calculateSurvivalPayouts(playerIds, placements, settings = {}) {
  const uniquePlayers = Array.from(new Set(playerIds || []));
  const poolInfo = resolveSurvivalPrizePool(uniquePlayers.length, settings);
  const prizePool = poolInfo.finalPrizePool;

  const uniquePlacements = [];
  for (const id of placements || []) {
    if (!uniquePlacements.includes(id)) uniquePlacements.push(id);
    if (uniquePlacements.length >= 3) break;
  }

  const payouts = {};
  let allocated = 0;

  if (uniquePlayers.length > 5) {
    const shares = [0.5, 0.3, 0.2];
    uniquePlacements.forEach((id, index) => {
      const raw = prizePool * shares[index];
      const amt = Math.floor(raw);
      payouts[id] = amt;
      allocated += amt;
    });

    if (uniquePlacements[0]) {
      const remainder = Math.max(0, prizePool - allocated);
      payouts[uniquePlacements[0]] =
        (payouts[uniquePlacements[0]] || 0) + remainder;
    }
  } else {
    if (uniquePlacements[0]) {
      payouts[uniquePlacements[0]] = prizePool;
    }
  }

  return payouts;
}

async function sendSurvivalPayouts(
  channel,
  payouts,
  placements,
  totalPlayers,
  settings = {}
) {
  try {
    const entries = Object.entries(payouts || {});
    if (!entries.length) return {};
    const poolInfo = resolveSurvivalPrizePool(totalPlayers, settings);
    const awardedPayouts = {};

    for (let index = 0; index < entries.length; index += 1) {
      const [userId, amount] = entries[index];
      if (!amount || amount <= 0) continue;
      const rank = placements ? placements.indexOf(userId) + 1 : 0;
      const rankLabel =
        rank === 1 ? "1st place" : rank === 2 ? "2nd place" : rank === 3 ? "3rd place" : "placement";
      const reward = await rewardCharmAmount({
        userId,
        username: `Player-${userId}`,
        amount,
        source: "survival",
        guildId: channel.guildId,
        channelId: channel.id,
        metadata: {
          mode: "survival",
          placement: rank || undefined,
          totalPlayers,
        },
        logClient: channel.client,
        logReason: `Squig Survival ${rankLabel}`,
      });
      if (reward?.ok) {
        awardedPayouts[userId] = amount;
        await logCharmReward(channel.client, {
          userId,
          amount,
          score: 0,
          source: "survival",
          channelId: channel.id,
          reason: `Squig Survival ${rankLabel} (pool ${poolInfo.finalPrizePool})`,
        });
      }
    }
    return awardedPayouts;
  } catch (err) {
    console.error("[GAUNTLET:DRIP] Survival payouts failed:", err?.message || err);
    return {};
  }
}

async function sendSurvivalRewardsSummary(
  channel,
  placements,
  awardedPayouts = {},
  creatorRewardTotals = {},
  shareSessionId = null
) {
  try {
    const labels = ["1st Place", "2nd Place", "3rd Place"];
    const uniquePlacements = [];
    for (const id of placements || []) {
      if (!id || uniquePlacements.includes(id)) continue;
      uniquePlacements.push(id);
      if (uniquePlacements.length >= 3) break;
    }

    const topLines = uniquePlacements
      .map((userId, index) => {
        const amount = Number(awardedPayouts?.[userId] || 0);
        const payoutSuffix = amount > 0 ? ` - ${amount} $CHARM` : "";
        return `${labels[index]} - <@${userId}>${payoutSuffix}`;
      })
      .filter(Boolean);

    const creatorEntries =
      creatorRewardTotals instanceof Map
        ? Array.from(creatorRewardTotals.entries())
        : Object.entries(creatorRewardTotals || {});

    const creatorLines = creatorEntries
      .filter(([, amount]) => Number(amount) > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([userId, amount]) => `<@${userId}> - ${amount} $CHARM earned this game`);

    if (!topLines.length && !creatorLines.length) return;

    const lines = [];
    if (topLines.length) {
      lines.push("**Top Survivors:**");
      lines.push(...topLines);
    }
    if (creatorLines.length) {
      if (lines.length) lines.push("");
      lines.push("**Content Creators:**");
      lines.push(...creatorLines);
    }

    const shareRows = shareSessionId
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`survive:share:start:${shareSessionId}`)
              .setLabel("Share Your Win (or Loss)")
              .setStyle(ButtonStyle.Secondary)
          ),
        ]
      : [];

    await channel.send({
      content: lines.join("\n"),
      components: shareRows,
    });
  } catch (err) {
    console.error(
      "[GAUNTLET:DRIP] Failed to send survival rewards summary:",
      err?.message || err
    );
  }
}

async function sendSurvivalCreatorPayouts(channel, creatorRewardTotals = new Map()) {
  try {
    const entries = Array.from(creatorRewardTotals.entries()).filter(
      ([, amount]) => Number(amount) > 0
    );
    if (!entries.length) return {};

    const awardedCreatorPayouts = {};
    for (let index = 0; index < entries.length; index += 1) {
      const [userId, amount] = entries[index];
      const reward = await rewardCharmAmount({
        userId,
        username: `Artist-${userId}`,
        amount,
        source: "survival-art",
        guildId: channel.guildId,
        channelId: channel.id,
        metadata: { mode: "survival-art-total" },
        logClient: channel.client,
        logReason: "Squig Survival art creator total",
      });
      if (reward?.ok) {
        awardedCreatorPayouts[userId] = amount;
        await logCharmReward(channel.client, {
          userId,
          amount,
          score: 0,
          source: "survival-art",
          channelId: channel.id,
          reason: "Squig Survival art creator total",
        });
      }
    }
    return awardedCreatorPayouts;
  } catch (err) {
    console.error(
      "[GAUNTLET:DRIP] Survival creator payouts failed:",
      err?.message || err
    );
    return {};
  }
}

async function postSurvivalFinalSummaryTest(channel, userId) {
  if (!channel || !userId) return false;

  const awardedPayouts = { [userId]: 500 };
  const creatorRewardTotals = new Map([[userId, 125]]);
  const shareSessionId = createSurvivalShareSession({
    gameId: null,
    placements: [userId],
    awardedPayouts,
    creatorRewardTotals,
    imageUrls: [],
  });

  await sendSurvivalRewardsSummary(
    channel,
    [userId],
    awardedPayouts,
    creatorRewardTotals,
    shareSessionId
  );
  return true;
}

module.exports = {
  runSurvival,
  calculateSurvivalPayouts,
  buildPodiumImage,
  getSurvivalRunLifeStatus,
  getSurvivalShareData,
  postSurvivalFinalSummaryTest,
  SURVIVAL_SHARE_DISCORD_CHANNEL_ID,
  handlePublicReviveCommand,
};
