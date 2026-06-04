// src/groupGauntlet.js
// Live multi-player Gauntlet (classic style) with /groupgauntlet [minutes]
//
// - Runs fully in-channel (no Postgres writes)
// - Join window with buttons
// - Mini-games, riddles, Trust/Doubt, Roulette, Risk It
// - Final podium at the end

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");

const {
  wait,
  isAdminUser,
} = require("./utils");

const {
  miniGameLorePool,
  miniGameFateDescriptions,
  pickMiniGame,
  pickRiddle,
  riddles,
} = require("./gameData");
const { rewardCharm, logCharmReward } = require("./drip");

// 👉 Exported Slash command definition for unified registration
const groupGauntletCommand = new SlashCommandBuilder()
  .setName("groupgauntlet")
  .setDescription("Start a live multi-player Gauntlet in this channel.")
  .addIntegerOption((o) =>
    o
      .setName("minutes")
      .setDescription("Join window in minutes (default: 2)")
      .setRequired(false)
  );

// --------------------------------------------
// Helpers & State
// --------------------------------------------

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

// channelId -> game state
const activeGames = new Map();

/**
 * Create a fresh group game state.
 */
function createGroupGame(channel, hostId) {
  return {
    hostId,
    channelId: channel.id,
    guildId: channel.guildId,
    players: new Map(), // userId -> { id, username, points }
    usedMini: new Set(),
    usedRiddle: new Set(),
    running: false,
  };
}

// --------------------------------------------
// JOIN PHASE
// --------------------------------------------

async function handleGroupGauntletCommand(interaction) {
  if (!isAdminUser(interaction)) {
    await interaction.reply({
      content: "⛔ Only admins can start a Group Gauntlet.",
      flags: 64,
    });
    return true;
  }

  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({
      content: "❌ Can't find channel for this command.",
      flags: 64,
    });
    return true;
  }

  if (activeGames.has(channel.id)) {
    await interaction.reply({
      content: "⚠️ A Group Gauntlet is already running in this channel.",
      flags: 64,
    });
    return true;
  }

  const rawMinutes = interaction.options.getInteger("minutes");
  const minutes = rawMinutes && rawMinutes > 0 ? rawMinutes : 2;

  const game = createGroupGame(channel, interaction.user.id);
  activeGames.set(channel.id, game);

  const embed = new EmbedBuilder()
    .setTitle("⚔️ The Gauntlet — Group Edition")
    .setDescription(
      [
        `Hosted by: <@${interaction.user.id}>`,
        "",
        `Click **Join** to enter this run. You have **${minutes} minute${
          minutes === 1 ? "" : "s"
        }**.`,
        "",
        "The charm will drag everyone through:",
        "- Mini-games with Squig lore",
        "- Public riddles",
        "- Trust or Doubt",
        "- Squig Roulette",
        "- Risk It",
        "",
        "At the end, a **final podium** is revealed. Good luck.",
      ].join("\n")
    )
    .setColor(0xaa00ff);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("gg:join")
      .setLabel("Join")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("gg:leave")
      .setLabel("Leave")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("gg:startnow")
      .setLabel("Start Now")
      .setStyle(ButtonStyle.Primary)
  );

  const joinMessage = await interaction.reply({
    embeds: [embed],
    components: [row],
    fetchReply: true,
  });

  const collector = joinMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: minutes * 60_000,
  });

  collector.on("collect", async (btn) => {
    const userId = btn.user.id;

    if (btn.customId === "gg:join") {
      if (!game.players.has(userId)) {
        const username =
          btn.user.globalName || btn.user.username || `Player-${userId}`;
        game.players.set(userId, { id: userId, username, points: 0 });
      }
      await btn.reply({
        content: "✅ You joined the Gauntlet.",
        flags: 64,
      });
    } else if (btn.customId === "gg:leave") {
      if (game.players.has(userId)) {
        game.players.delete(userId);
      }
      await btn.reply({
        content: "👋 You left this Gauntlet run.",
        flags: 64,
      });
    } else if (btn.customId === "gg:startnow") {
      // Only host or admin can start early
      if (userId !== game.hostId && !isAdminUser(btn)) {
        await btn.reply({
          content: "⛔ Only the host/admin can start early.",
          flags: 64,
        });
        return;
      }
      await btn.reply({
        content: "🎬 Starting the Gauntlet now...",
        flags: 64,
      });
      collector.stop("startnow");
    }
  });

  collector.on("end", async () => {
    try {
      await joinMessage.edit({ components: [] });
    } catch {}

    if (!game.players.size) {
      activeGames.delete(channel.id);
      await channel.send("😴 No players joined. The charm loses interest.");
      return;
    }

    // Lock and run the game
    game.running = true;
    const list = Array.from(game.players.values())
      .map((p) => `<@${p.id}>`)
      .join(", ");

    await channel.send(
      [
        "🧱 **The Gauntlet begins.**",
        `Players: ${list}`,
        "",
        "Keep your eyes on this channel. Rounds will move quickly.",
      ].join("\n")
    );

    try {
      await runGroupGame(channel, game);
    } catch (err) {
      console.error("Group game error:", err);
      await channel.send("❌ Something broke inside the portal. Game aborted.");
    } finally {
      activeGames.delete(channel.id);
    }
  });

  return true;
}

// --------------------------------------------
// ROUND HELPERS — SEQUENTIAL (no overlap)
// --------------------------------------------

function runMiniGameRound(channel, game, roundNumber) {
  return new Promise(async (resolve) => {
    const mini = pickMiniGame(game.usedMini);
    const fate = rand(miniGameFateDescriptions);

    const embed = new EmbedBuilder()
      .setTitle(`🌪️ ROUND ${roundNumber} — ${mini.title}`)
      .setDescription(
        [
          mini.lore,
          "",
          `_${fate}_`,
          "",
          "Click a button to lock in your choice.",
          "⏳ You have **30 seconds**.",
        ].join("\n")
      )
      .setColor(0xff33cc);

    if (mini.image) embed.setImage(mini.image);

    const row = new ActionRowBuilder().addComponents(
      mini.buttons.map((label, i) =>
        new ButtonBuilder()
          .setCustomId(`gg:mini:${mini.index}:${i}`)
          .setLabel(label)
          .setStyle(
            [ButtonStyle.Primary, ButtonStyle.Danger, ButtonStyle.Secondary, ButtonStyle.Success][
              i % 4
            ]
          )
      )
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const picks = new Map(); // userId -> button index

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 30_000,
    });

    collector.on("collect", async (btn) => {
      const userId = btn.user.id;
      if (!game.players.has(userId)) {
        await btn.reply({
          content: "You’re not in this Gauntlet run.",
          flags: 64,
        });
        return;
      }
      if (picks.has(userId)) {
        await btn.reply({
          content: "You already picked. Sit tight.",
          flags: 64,
        });
        return;
      }
      const parts = btn.customId.split(":");
      const idx = Number(parts[3] || 0);
      picks.set(userId, idx);
      await btn.reply({
        content: `Locked in **${btn.component.label}**.`,
        flags: 64,
      });
    });

    collector.on("end", async () => {
      try {
        await msg.edit({
          components: [
            new ActionRowBuilder().addComponents(
              row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
            ),
          ],
        });
      } catch {}

      const winningIndex = Math.floor(Math.random() * mini.buttons.length);
      const winningLabel = mini.buttons[winningIndex];

      const winners = [];
      for (const [userId, choiceIdx] of picks.entries()) {
        const player = game.players.get(userId);
        if (!player) continue;
        if (choiceIdx === winningIndex) {
          player.points += 2;
          winners.push(player);
        }
      }

      const resultLines = [];
      if (winners.length) {
        resultLines.push(
          `🎉 The charm favors **${winningLabel}**.\nWinners (+2): ${winners
            .map((w) => `<@${w.id}> (**${w.points}**)`)
            .join(", ")}`
        );
      } else {
        resultLines.push(
          `👻 The charm favors **${winningLabel}**, but no one chose it. No points.`
        );
      }

      await channel.send(resultLines.join("\n"));
      await sendScoreboard(channel, game);
      resolve();
    });
  });
}

function runRiddleRound(channel, game, roundLabel) {
  return new Promise(async (resolve) => {
    const r = pickRiddle(riddles, game.usedRiddle);
    if (!r) {
      await channel.send("⚠️ No riddles left. Skipping.");
      return resolve();
    }

    const difficultyLabel =
      r.difficulty === 1
        ? "EASY"
        : r.difficulty === 2
        ? "MEDIUM"
        : r.difficulty === 3
        ? "HARD"
        : "SQUIG SPECIAL";

    const embed = new EmbedBuilder()
      .setTitle(`🧩 MID-ROUND RIDDLE (${roundLabel})`)
      .setDescription(
        [
          r.riddle,
          "",
          `🧠 Difficulty: **${difficultyLabel}** — Worth **+${r.difficulty}**.`,
          "Type your answer in chat (spelling doesn’t have to be perfect).",
          "⏳ You have **30 seconds**.",
        ].join("\n")
      )
      .setColor(0xff66cc);

    await channel.send({ embeds: [embed] });

    const correctSet = new Set();
    const filter = (m) => game.players.has(m.author.id);

    const collector = channel.createMessageCollector({
      filter,
      time: 30_000,
    });

    collector.on("collect", (m) => {
      const userId = m.author.id;
      if (!game.players.has(userId)) return;

      const normalized = m.content.trim().toLowerCase();
      const isCorrect = r.answers
        .map((a) => a.toLowerCase())
        .includes(normalized);

      if (isCorrect && !correctSet.has(userId)) {
        correctSet.add(userId);
        const player = game.players.get(userId);
        player.points += r.difficulty;
        channel
          .send(
            `🧩 <@${userId}> answered correctly and gained **+${r.difficulty}** (total: **${player.points}**).`
          )
          .catch(() => {});
      }
    });

    collector.on("end", async () => {
      const count = correctSet.size;
      await channel.send(
        [
          `✅ Riddle completed. **${count}** player(s) answered correctly and gained **+${r.difficulty}**.`,
          `🧩 The correct answer was: **${r.answers[0]}**.`,
        ].join("\n")
      );
      await sendScoreboard(channel, game);
      resolve();
    });
  });
}

function runTrustDoubtRound(channel, game, roundNumber) {
  return new Promise(async (resolve) => {
    const embed = new EmbedBuilder()
      .setTitle(`🤝 ROUND ${roundNumber} — Trust or Doubt`)
      .setDescription(
        [
          "Players click **Trust** or **Doubt**.",
          "",
          "If majority choose **Trust**, they gain **+1** —",
          "👉 _unless the Squig lies this round, then Trusters **-1** instead._",
          "Everyone else: 0.",
          "",
          "⏳ You have **30 seconds**.",
        ].join("\n")
      )
      .setColor(0x00bcd4);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("gg:trust")
        .setLabel("Trust")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("gg:doubt")
        .setLabel("Doubt")
        .setStyle(ButtonStyle.Danger)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const picks = new Map(); // userId -> "trust" | "doubt"

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 30_000,
    });

    collector.on("collect", async (btn) => {
      const userId = btn.user.id;
      if (!game.players.has(userId)) {
        await btn.reply({ content: "You’re not in this run.", flags: 64 });
        return;
      }
      if (picks.has(userId)) {
        await btn.reply({
          content: "Choice already locked.",
          flags: 64,
        });
        return;
      }

      const choice = btn.customId === "gg:trust" ? "trust" : "doubt";
      picks.set(userId, choice);

      await btn.reply({
        content: `You chose **${choice.toUpperCase()}**.`,
        flags: 64,
      });
    });

    collector.on("end", async () => {
      try {
        await msg.edit({
          components: [
            new ActionRowBuilder().addComponents(
              row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
            ),
          ],
        });
      } catch {}

      const trusters = [];
      const doubters = [];
      for (const [userId, choice] of picks.entries()) {
        if (choice === "trust") trusters.push(userId);
        else doubters.push(userId);
      }

      const majority =
        trusters.length > doubters.length
          ? "trust"
          : doubters.length > trusters.length
          ? "doubt"
          : "none";

      const liar = Math.random() < 0.3; // 30% chance the Squig lies

      let outcomeText = "";
      if (majority === "trust") {
        if (liar) {
          for (const uid of trusters) {
            const p = game.players.get(uid);
            if (!p) continue;
            p.points -= 1;
          }
          outcomeText =
            "Majority chose **Trust**. Squig lied. Trusters **-1**. Doubters 0.";
        } else {
          for (const uid of trusters) {
            const p = game.players.get(uid);
            if (!p) continue;
            p.points += 1;
          }
          outcomeText =
            "Majority chose **Trust**. Squig told the truth. Trusters **+1**. Doubters 0.";
        }
      } else if (majority === "doubt") {
        if (liar) {
          for (const uid of doubters) {
            const p = game.players.get(uid);
            if (!p) continue;
            p.points += 1;
          }
          outcomeText =
            "Majority chose **Doubt**. Squig lied about lying. Doubters **+1**.";
        } else {
          outcomeText =
            "Majority chose **Doubt**. Squig shrugs. No one gains anything.";
        }
      } else {
        outcomeText = "No clear majority. The charm refuses to pick sides.";
      }

      const trustList = trusters.map((id) => `<@${id}>`).join(", ") || "None";
      const doubtList = doubters.map((id) => `<@${id}>`).join(", ") || "None";

      await channel.send(
        [
          "**Trust or Doubt — Results**",
          `Trusters (${trusters.length}): ${trustList}`,
          `Doubters (${doubters.length}): ${doubtList}`,
          "",
          outcomeText,
        ].join("\n")
      );

      await sendScoreboard(channel, game);
      resolve();
    });
  });
}

function runRouletteRound(channel, game, roundNumber) {
  return new Promise(async (resolve) => {
    const embed = new EmbedBuilder()
      .setTitle(`🎲 ROUND ${roundNumber} — Squig Roulette`)
      .setDescription(
        [
          "Pick a number **1–6**.",
          "Roll happens at the end.",
          "Match = **+2 points**, else **0**.",
          "",
          "⏳ You have **30 seconds**.",
        ].join("\n")
      )
      .setColor(0x7f00ff);

    const row1 = new ActionRowBuilder().addComponents(
      [1, 2, 3].map((n) =>
        new ButtonBuilder()
          .setCustomId(`gg:rou:${n}`)
          .setLabel(String(n))
          .setStyle(ButtonStyle.Secondary)
      )
    );
    const row2 = new ActionRowBuilder().addComponents(
      [4, 5, 6].map((n) =>
        new ButtonBuilder()
          .setCustomId(`gg:rou:${n}`)
          .setLabel(String(n))
          .setStyle(ButtonStyle.Secondary)
      )
    );

    const msg = await channel.send({
      embeds: [embed],
      components: [row1, row2],
    });

    const picks = new Map(); // userId -> number

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 30_000,
    });

    collector.on("collect", async (btn) => {
      const uid = btn.user.id;
      if (!game.players.has(uid)) {
        await btn.reply({ content: "Not in this run.", flags: 64 });
        return;
      }
      if (picks.has(uid)) {
        await btn.reply({ content: "Pick already locked.", flags: 64 });
        return;
      }
      const parts = btn.customId.split(":");
      const val = Number(parts[2]);
      picks.set(uid, val);
      await btn.reply({
        content: `You picked **${val}**.`,
        flags: 64,
      });
    });

    collector.on("end", async () => {
      const disable = (row) =>
        new ActionRowBuilder().addComponents(
          row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
        );
      try {
        await msg.edit({ components: [disable(row1), disable(row2)] });
      } catch {}

      const rolled = 1 + Math.floor(Math.random() * 6);
      const winners = [];

      for (const [uid, num] of picks.entries()) {
        const p = game.players.get(uid);
        if (!p) continue;
        if (num === rolled) {
          p.points += 2;
          winners.push(uid);
        }
      }

      const winList = winners.map((id) => `<@${id}>`).join(", ") || "None";

      await channel.send(
        [
          `🎲 Rolled a **${rolled}**.`,
          winners.length
            ? `Winners (+2): ${winList}`
            : "No one guessed correctly.",
        ].join("\n")
      );

      await sendScoreboard(channel, game);
      resolve();
    });
  });
}

function runRiskItRound(channel, game) {
  return new Promise(async (resolve) => {
    const embed = new EmbedBuilder()
      .setTitle("🪙 RISK IT — The Charm Tempts You")
      .setDescription(
        [
          "Between rounds, the static parts... and a Squig grins.",
          "Risk your points for a shot at more — or lose them to the void.",
          "",
          "• **Risk All** — stake everything",
          "• **Risk Half** — stake half your current points",
          "• **Risk Quarter** — stake a quarter (min 1)",
          "• **No Risk** — sit out and watch the chaos",
          "",
          "⏳ You have **20 seconds**.",
        ].join("\n")
      )
      .setColor(0xffaa00);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("gg:risk:all")
        .setLabel("Risk All")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("gg:risk:half")
        .setLabel("Risk Half")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("gg:risk:quarter")
        .setLabel("Risk Quarter")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("gg:risk:none")
        .setLabel("No Risk")
        .setStyle(ButtonStyle.Success)
    );

    const msg = await channel.send({ embeds: [embed], components: [row] });

    const picks = new Map(); // uid -> choice

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 20_000,
    });

    collector.on("collect", async (btn) => {
      const uid = btn.user.id;
      if (!game.players.has(uid)) {
        await btn.reply({ content: "Not in this run.", flags: 64 });
        return;
      }
      if (picks.has(uid)) {
        await btn.reply({
          content: "Choice already locked.",
          flags: 64,
        });
        return;
      }
      const choice = btn.customId.split(":")[2]; // all, half, quarter, none
      picks.set(uid, choice);
      await btn.reply({
        content: `You chose **${choice.toUpperCase()}**.`,
        flags: 64,
      });
    });

    collector.on("end", async () => {
      try {
        await msg.edit({
          components: [
            new ActionRowBuilder().addComponents(
              row.components.map((b) => ButtonBuilder.from(b).setDisabled(true))
            ),
          ],
        });
      } catch {}

      const outcomes = [
        { mult: -1, label: "💀 Lost it all" },
        { mult: 0, label: "😐 Broke even" },
        { mult: 0.5, label: "✨ Won 1.5×" },
        { mult: 1, label: "💰 Doubled" },
      ];

      const lines = ["**Risk It — Results**"];

      for (const [uid, choice] of picks.entries()) {
        const p = game.players.get(uid);
        if (!p) continue;

        const pts = Math.floor(p.points || 0);
        if (choice === "none" || pts <= 0) {
          lines.push(`• <@${uid}> • No Risk (total stays **${p.points}**)`);
          continue;
        }

        let stake = 0;
        if (choice === "all") stake = pts;
        if (choice === "half") stake = Math.max(1, Math.floor(pts / 2));
        if (choice === "quarter") stake = Math.max(1, Math.floor(pts / 4));

        const outcome = rand(outcomes);
        const delta = outcome.mult === -1 ? -stake : Math.round(stake * outcome.mult);
        p.points += delta;

        const prettyDelta = delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`;

        lines.push(
          `• <@${uid}> • ${choice.toUpperCase()} (staked ${stake}) → ${outcome.label} • **${prettyDelta}** • new total: **${p.points}**`
        );
      }

      await channel.send(lines.join("\n"));
      await sendScoreboard(channel, game);
      resolve();
    });
  });
}

// --------------------------------------------
// SCOREBOARD / PODIUM
// --------------------------------------------

function sortPlayers(game) {
  return Array.from(game.players.values()).sort(
    (a, b) => b.points - a.points || a.username.localeCompare(b.username)
  );
}

async function sendScoreboard(channel, game) {
  const sorted = sortPlayers(game);
  const desc = sorted
    .map((p, i) => `**#${i + 1}** ${p.username} — **${p.points}**`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("📊 Current Gauntlet Leaderboard")
    .setDescription(desc || "No scores yet.")
    .setColor(0x00ccff);

  await channel.send({ embeds: [embed] });
}

async function sendFinalPodium(channel, game) {
  const sorted = sortPlayers(game);
  if (!sorted.length) {
    await channel.send("No scores to show.");
    return;
  }

  const first = sorted[0];
  const second = sorted[1];
  const third = sorted[2];

  const lines = [];
  lines.push("👁️‍🗨️ **THE FINAL PODIUM** 👁️‍🗨️");
  lines.push("The charm acknowledges those who rose above...");
  lines.push("");
  lines.push(`👥 ${sorted.length} players participated in this Gauntlet.`);
  lines.push("");

  if (first) {
    lines.push("💰 **Champion of the Charm**");
    lines.push(`🥇 <@${first.id}> — **${first.points}** points`);
    lines.push("");
  }
  if (second) {
    lines.push("🌑 **Scarred But Standing**");
    lines.push(`🥈 <@${second.id}> — **${second.points}** points`);
    lines.push("");
  }
  if (third) {
    lines.push("🕳️ **Last One Dragged from the Void**");
    lines.push(`🥉 <@${third.id}> — **${third.points}** points`);
    lines.push("");
  }

  await channel.send(lines.join("\n"));
}

// --------------------------------------------
// FULL GAME FLOW (classic run)
// --------------------------------------------

async function runGroupGame(channel, game) {
  const gap = 3_000; // short breathing space between phases

  // ROUND 1: Mini + Riddle
  await runMiniGameRound(channel, game, 1);
  await wait(gap);
  await runRiddleRound(channel, game, "Round 1");
  await wait(gap);

  // ROUND 2: Trust or Doubt
  await runTrustDoubtRound(channel, game, 2);
  await wait(gap);

  // ROUND 3: Mini + Riddle
  await runMiniGameRound(channel, game, 3);
  await wait(gap);
  await runRiddleRound(channel, game, "Round 3");
  await wait(gap);

  // ROUND 4: Squig Roulette
  await runRouletteRound(channel, game, 4);
  await wait(gap);

  // ROUND 5: Mini + Riddle
  await runMiniGameRound(channel, game, 5);
  await wait(gap);
  await runRiddleRound(channel, game, "Round 5");
  await wait(gap);

  // MID: Risk It
  await runRiskItRound(channel, game);
  await wait(gap);

  // ROUND 6: Final Riddle Push
  await runRiddleRound(channel, game, "Final Stretch");
  await wait(gap);

  await sendFinalPodium(channel, game);
  try {
    const players = Array.from(game.players.values());
    await Promise.all(
      players.map(async (p) => {
        const reward = await rewardCharm({
          userId: p.id,
          username: p.username,
          score: p.points,
          source: "group",
          guildId: channel.guildId,
          channelId: channel.id,
          logClient: channel.client,
          logReason: "Group Gauntlet",
        });
        if (reward?.ok) {
          await logCharmReward(channel.client, {
            userId: p.id,
            amount: reward.amount,
            score: p.points,
            source: "group",
            channelId: channel.id,
            reason: `Group Gauntlet (score ${p.points})`,
          });
        }
      })
    );
  } catch {}
  await channel.send("📯 Maybe enough reactions will encourage another game…");
}

// --------------------------------------------
// INTERACTION HANDLER
// --------------------------------------------

async function handleGroupInteractionCreate(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "groupgauntlet") {
        await handleGroupGauntletCommand(interaction);
        return true;
      }
    }

    // Buttons and collectors are owned by the round functions themselves.
    return false;
  } catch (err) {
    console.error("GroupGauntlet interaction error:", err);
    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "❌ Something went wrong with Group Gauntlet.",
            flags: 64,
          });
        } else {
          await interaction.reply({
            content: "❌ Something went wrong with Group Gauntlet.",
            flags: 64,
          });
        }
      } catch {}
    }
    return true;
  }
}

// --------------------------------------------
// EXPORTS
// --------------------------------------------

module.exports = {
  groupGauntletCommand,
  handleGroupInteractionCreate,
};

