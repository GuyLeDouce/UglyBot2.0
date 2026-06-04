import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionType,
  ModalBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

import { CONFIG } from './config.js';
import { q } from './db.js';
import { parseDurationToMs, formatDiscordTs } from './util_time.js';
import { dripAwardByDiscordId, dripFindMemberByDiscordId } from './drip.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
  partials: ['CHANNEL']
});

/* ───────────────────────────────────────────── */
/* IDs / Custom IDs                              */
/* ───────────────────────────────────────────── */

const CUSTOM = {
  submit: (trialId) => `exp_submit:${trialId}`,
  completions: (trialId) => `exp_completions:${trialId}`,
  howto: () => 'openlabs_howto',

  addImage: (submissionId, reviewMessageId) => `sub_add_image:${submissionId}:${reviewMessageId}`,
  approveShare: (submissionId) => `sub_approve_share:${submissionId}`,
  approveNoShare: (submissionId) => `sub_approve_noshare:${submissionId}`,
  reject: (submissionId) => `sub_reject:${submissionId}`,
  logChannelSelect: (action, submissionId) => `log_channel_select:${action}:${submissionId}`,
  logConfirm: (action, submissionId, channelId) => `log_confirm:${action}:${submissionId}:${channelId || 'default'}`
};

const EPHEMERAL = 64;

/* ───────────────────────────────────────────── */
/* Helpers                                       */
/* ───────────────────────────────────────────── */

function isAdmin(member) {
  // Either server admin permission OR explicit ADMIN_USER_IDS list if you want
  if (member?.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  if (CONFIG.adminUserIds?.length) return CONFIG.adminUserIds.includes(member.user.id);
  return false;
}

function looksLikeUrl(s) {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildLogChannelPrompt(action, submissionId, selectedChannelId = null) {
  const label =
    action === 'approve_share'
      ? 'Confirm Approve (Share Proof)'
      : action === 'approve_noshare'
        ? 'Confirm Approve (No Proof)'
        : 'Next: Enter Reason';

  const content = selectedChannelId
    ? `Log channel selected: <#${selectedChannelId}>`
    : `Choose a log channel (optional). Default is <#${CONFIG.generalChatChannelId}>.`;

  return {
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(CUSTOM.logChannelSelect(action, submissionId))
          .setPlaceholder('Select a channel (optional)')
          .addChannelTypes(ChannelType.GuildText)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CUSTOM.logConfirm(action, submissionId, selectedChannelId))
          .setLabel(label)
          .setStyle(ButtonStyle.Primary)
      )
    ]
  };
}

function buildHowToEmbed() {
  return new EmbedBuilder()
    .setTitle('🧪 Open Labs — How it Works')
    .setDescription(
      [
        `**1)** New experiments drop in <#${CONFIG.liveTrialsChannelId}>.`,
        `**2)** Click **Submit Entry** and send your proof link (optional) + description.`,
        `**3)** The team reviews in the private lab channel.`,
        `**4)** If approved, we post your win in <#${CONFIG.generalChatChannelId}> and you receive **$CHARM**.`,
        '',
        '✅ One submission per experiment. If declined, you can re-submit (as long as it’s still live).',
        `📸 Optional: After submitting, click the **🔴 Attach Image** button and reply to the bot in <#${CONFIG.imageSubmitChannelId}>.`
      ].join('\n')
    );
}

function buildLiveExperimentEmbed(exp) {
  const rewardLine = exp.reward_amount
    ? `**Reward:** ${exp.reward_amount} $CHARM`
    : '**Reward:** (not set)';

  const linkLine = exp.link_url ? `Link: ${exp.link_url}` : null;

  const e = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(exp.name)
    .setDescription(
      [
        exp.description,
        ...(linkLine ? [linkLine] : []),
        '',
        rewardLine,
        `**Ends:** ${formatDiscordTs(exp.ends_at)}`
      ].join('\n')
    );

  if (exp.category) e.setFooter({ text: exp.category });

  if (exp.image_url) e.setImage(exp.image_url);
  return e;
}

function buildClosedExperimentEmbed(exp) {
  const rewardLine = exp.reward_amount
    ? `**Reward:** ${exp.reward_amount} $CHARM`
    : '**Reward:** (not set)';

  const e = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(exp.name)
    .setDescription(
      [
        '🚫 **This experiment is no longer available.**',
        '',
        exp.description,
        '',
        rewardLine,
        `**Ended:** ${formatDiscordTs(exp.ends_at)}`
      ].join('\n')
    );

  if (exp.category) e.setFooter({ text: exp.category });

  if (exp.image_url) e.setImage(exp.image_url);
  return e;
}

function liveButtons(trialId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM.submit(trialId))
      .setLabel('Submit Entry')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(CUSTOM.howto())
      .setLabel('How it Works')
      .setStyle(ButtonStyle.Secondary)
  );
}

function pastButtons(trialId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM.completions(trialId))
      .setLabel('Show Completions')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(CUSTOM.howto())
      .setLabel('How it Works')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildReviewEmbed({ trial, sub, userTag }) {
  const e = new EmbedBuilder()
    .setTitle('📥 New Experiment Submission')
    .addFields(
      { name: 'Experiment', value: `**${trial.name}** (ID: ${trial.id})` },
      ...(trial.category ? [{ name: 'Category', value: trial.category, inline: true }] : []),
      { name: 'User', value: `${userTag} (${sub.user_id})` },
      { name: 'Proof', value: sub.proof_url || '_(none)_', inline: false },
      { name: 'Description', value: sub.description || '_(none)_', inline: false }
    )
    .setFooter({ text: `Submission ID: ${sub.id}` })
    .setTimestamp(new Date(sub.created_at));

  if (sub.attachment_url) e.setImage(sub.attachment_url);
  return e;
}

/* ───────────────────────────────────────────── */
/* Slash Commands                                */
/* ───────────────────────────────────────────── */

const commands = [
  new SlashCommandBuilder()
    .setName('addtask')
    .setDescription('Create a new Open Labs experiment (team only)')
    .addStringOption(o => o.setName('name').setDescription('Experiment name').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Experiment description').setRequired(true))
    .addIntegerOption(o => o.setName('charm').setDescription('$CHARM reward per approved submission').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration like 6h, 1d, 2d6h').setRequired(true))
    .addStringOption(o => o.setName('link').setDescription('Optional link').setRequired(false))
    .addStringOption(o => o.setName('category')
      .setDescription('Optional category')
      .addChoices(
        { name: 'Creative Trial', value: 'Creative Trial' },
        { name: 'Engagement Trial', value: 'Engagement Trial' },
        { name: 'Participation Trial', value: 'Participation Trial' }
      )
      .setRequired(false))
    .addAttachmentOption(o => o.setName('image').setDescription('Optional image').setRequired(false))
  ,
  new SlashCommandBuilder()
    .setName('topscientists')
    .setDescription('Show top experiment completers (team only)')
    .addStringOption(o => o
      .setName('period')
      .setDescription('Time period')
      .addChoices(
        { name: 'Week', value: 'week' },
        { name: 'Month', value: 'month' },
        { name: 'All Time', value: 'all' }
      )
      .setRequired(false))
    .addStringOption(o => o
      .setName('metric')
      .setDescription('Ranking metric')
      .addChoices(
        { name: 'Most Experiments Completed', value: 'count' },
        { name: 'Most $CHARM Earned', value: 'charm' }
      )
      .setRequired(false))
    .addIntegerOption(o => o
      .setName('limit')
      .setDescription('Max results (1-50)')
      .setRequired(false))
].map(c => c.toJSON());

async function registerCommands(clientId) {
  if (!clientId) throw new Error('Missing Discord application id');
  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  await rest.put(
    Routes.applicationGuildCommands(clientId, CONFIG.guildId),
    { body: commands }
  );
  console.log('✅ Guild commands registered');
}

/* ───────────────────────────────────────────── */
/* /addtask                                      */
/* ───────────────────────────────────────────── */

async function handleAddTask(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '🚫 Team only.', flags: EPHEMERAL });
  }

  const name = interaction.options.getString('name', true);
  const description = interaction.options.getString('description', true);
  const charm = interaction.options.getInteger('charm', true);
  const durationStr = interaction.options.getString('duration', true);
  const linkRaw = interaction.options.getString('link', false);
  const linkUrl = linkRaw?.trim() || null;
  const category = interaction.options.getString('category', false);
  const image = interaction.options.getAttachment('image', false);

  const ms = parseDurationToMs(durationStr);
  if (!ms) {
    return interaction.reply({
      content: '⚠️ Duration invalid. Try `6h`, `1d`, `2d6h`, `30m`.',
      flags: EPHEMERAL
    });
  }

  if (charm <= 0) {
    return interaction.reply({ content: '⚠️ $CHARM reward must be > 0.', flags: EPHEMERAL });
  }

  if (linkUrl && !looksLikeUrl(linkUrl)) {
    return interaction.reply({ content: '⚠️ Link must be a valid http(s) URL.', flags: EPHEMERAL });
  }

  const endsAt = new Date(Date.now() + ms);
  const imageUrl = image?.url ?? null;

  // IMPORTANT: your DB currently has points_min/points_max NOT NULL.
  // Even though points are “gone”, we must satisfy schema constraints.
  // We store them as 0/0 and do not use them.
  const insertRes = await q(
    `INSERT INTO trials
      (guild_id, name, description, category, points, points_min, points_max, image_url, created_at, ends_at, status,
       live_channel_id, live_message_id, reward_currency_id, reward_amount)
     VALUES
      ($1,$2,$3,$4,0,0,0,$5,NOW(),$6,'LIVE',$7,'PENDING',$8,$9)
     RETURNING *`,
    [
      CONFIG.guildId,
      name,
      description,
      category,
      imageUrl,
      endsAt.toISOString(),
      CONFIG.liveTrialsChannelId,
      CONFIG.dripCurrencyId,
      charm
    ]
  );

  const exp = insertRes.rows[0];
  exp.ends_at = new Date(exp.ends_at);
  exp.link_url = linkUrl;

  const liveChannel = await client.channels.fetch(CONFIG.liveTrialsChannelId);
  if (!liveChannel || liveChannel.type !== ChannelType.GuildText) {
    return interaction.reply({ content: '❌ live-trials channel not found.', flags: EPHEMERAL });
  }

  // Post the experiment embed
  const msg = await liveChannel.send({
    content: 'NEW TRIAL IS LIVE @everyone',
    embeds: [buildLiveExperimentEmbed(exp)],
    components: [liveButtons(exp.id)]
  });

  await q(`UPDATE trials SET live_message_id=$1 WHERE id=$2`, [msg.id, exp.id]);

  return interaction.reply({ content: '✅ Experiment posted.', flags: EPHEMERAL });
}

/* ───────────────────────────────────────────── */
/* Submitting                                    */
/* ───────────────────────────────────────────── */

async function handleSubmitButton(interaction, trialId) {
  const tRes = await q(`SELECT * FROM trials WHERE id=$1 AND guild_id=$2`, [trialId, CONFIG.guildId]);
  if (tRes.rowCount === 0) return interaction.reply({ content: '❌ Experiment not found.', flags: EPHEMERAL });

  const trial = tRes.rows[0];
  const now = Date.now();
  const endsAt = new Date(trial.ends_at).getTime();

  if (trial.status !== 'LIVE' || now >= endsAt) {
    return interaction.reply({ content: '🚫 This experiment is no longer available.', flags: EPHEMERAL });
  }

  // Block if PENDING or APPROVED exists; allow resubmit if REJECTED
  const sRes = await q(
    `SELECT status FROM submissions WHERE trial_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [trialId, interaction.user.id]
  );

  if (sRes.rowCount > 0) {
    const status = sRes.rows[0].status;
    if (status === 'PENDING') return interaction.reply({ content: '⏳ You already have a pending submission.', flags: EPHEMERAL });
    if (status === 'APPROVED') return interaction.reply({ content: '✅ You already completed this experiment.', flags: EPHEMERAL });
  }

  const modal = new ModalBuilder()
    .setCustomId(`modal_submit:${trialId}`)
    .setTitle('Submit Experiment');

  const proof = new TextInputBuilder()
    .setCustomId('proof_url')
    .setLabel('Proof link (optional) — image after submit')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('https://... (optional)');

  const desc = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Short description (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(proof),
    new ActionRowBuilder().addComponents(desc)
  );

  return interaction.showModal(modal);
}

async function handleSubmitModal(interaction, trialId) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const proofUrlRaw = interaction.fields.getTextInputValue('proof_url')?.trim();
  const proofUrl = proofUrlRaw ? proofUrlRaw : null;
  const description = interaction.fields.getTextInputValue('description')?.trim() || null;

  if (proofUrl && !looksLikeUrl(proofUrl)) {
    return interaction.editReply({ content: '⚠️ Proof link must be a valid http(s) URL.' });
  }

  const tRes = await q(`SELECT * FROM trials WHERE id=$1 AND guild_id=$2`, [trialId, CONFIG.guildId]);
  if (tRes.rowCount === 0) return interaction.editReply({ content: '❌ Experiment not found.' });

  const trial = tRes.rows[0];
  const now = Date.now();
  const endsAt = new Date(trial.ends_at).getTime();

  if (trial.status !== 'LIVE' || now >= endsAt) {
    return interaction.editReply({ content: '🚫 This experiment is no longer available.' });
  }

  // Same lock rule
  const sRes = await q(
    `SELECT status FROM submissions WHERE trial_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [trialId, interaction.user.id]
  );

  if (sRes.rowCount > 0) {
    const status = sRes.rows[0].status;
    if (status === 'PENDING') return interaction.editReply({ content: '⏳ You already have a pending submission.' });
    if (status === 'APPROVED') return interaction.editReply({ content: '✅ You already completed this experiment.' });
  }

  // 1) Insert submission
  const ins = await q(
    `INSERT INTO submissions (trial_id, guild_id, user_id, proof_url, description, status, payout_status)
     VALUES ($1,$2,$3,$4,$5,'PENDING','NOT_SENT')
     RETURNING *`,
    [trialId, CONFIG.guildId, interaction.user.id, proofUrl, description]
  );

  const sub = ins.rows[0];

  // 2) Immediately post to review channel (critical path!)
  const submissionsChannel = await client.channels.fetch(CONFIG.submissionsChannelId);
  if (!submissionsChannel || submissionsChannel.type !== ChannelType.GuildText) {
    return interaction.editReply({ content: '❌ Submissions channel misconfigured.' });
  }

  const reviewButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(CUSTOM.approveShare(sub.id)).setLabel('✅ Approve (Share Proof)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CUSTOM.approveNoShare(sub.id)).setLabel('✅ Approve (No Proof)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(CUSTOM.reject(sub.id)).setLabel('❌ Decline').setStyle(ButtonStyle.Danger)
  );

  const reviewMsg = await submissionsChannel.send({
    embeds: [buildReviewEmbed({ trial, sub, userTag: `<@${interaction.user.id}>` })],
    components: [reviewButtons]
  });

  await q(`UPDATE submissions SET review_message_id=$1 WHERE id=$2`, [reviewMsg.id, sub.id]);

  // 3) Reply to user (include optional image button)
  await interaction.editReply({
    content:
      `✅ Submitted. The team will review it.\n` +
      `📸 Optional: click the **🔴 Attach Image** button and reply to the bot in <#${CONFIG.imageSubmitChannelId}>.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CUSTOM.addImage(sub.id, reviewMsg.id))
          .setLabel('🖼️ Attach Image')
          .setStyle(ButtonStyle.Danger)
      )
    ]
  });
}

async function attachSubmissionImage(submissionId, reviewMessageId, imageUrl) {
  if (!imageUrl) return false;
  await q(`UPDATE submissions SET attachment_url=$1 WHERE id=$2`, [imageUrl, submissionId]);

  const submissionsChannel = await client.channels.fetch(CONFIG.submissionsChannelId);
  if (!submissionsChannel || submissionsChannel.type !== ChannelType.GuildText) return true;

  const reviewMsg = await submissionsChannel.messages.fetch(reviewMessageId).catch(() => null);
  if (!reviewMsg) return true;

  const current = reviewMsg.embeds?.[0];
  if (!current) return true;

  const updated = EmbedBuilder.from(current).setImage(imageUrl);
  await reviewMsg.edit({ embeds: [updated] });
  return true;
}

async function promptOptionalImageInChannel(interaction, submissionId, reviewMessageId) {
  try {
    const imageChannel = await client.channels.fetch(CONFIG.imageSubmitChannelId);
    if (!imageChannel || imageChannel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: '❌ Image submit channel misconfigured.', flags: EPHEMERAL });
      return;
    }

    await interaction.reply({
      content: `📸 Please reply to my message in <#${CONFIG.imageSubmitChannelId}> with an image within 5 minutes.`,
      flags: EPHEMERAL
    });

    const promptMsg = await imageChannel.send(
      `📸 <@${interaction.user.id}> please reply to this message with your image (within 5 minutes).`
    );

    const collected = await imageChannel.awaitMessages({
      filter: (m) => m.author?.id === interaction.user.id && m.attachments?.size > 0,
      max: 1,
      time: 5 * 60 * 1000
    });

    const msg = collected.first();
    if (!msg) {
      await promptMsg.delete().catch(() => {});
      return;
    }

    const att = msg.attachments?.first?.();
    const imageUrl = att?.url || att?.proxyURL || null;
    if (!imageUrl) return;

    await attachSubmissionImage(submissionId, reviewMessageId, imageUrl);

    // Do not delete the user's image message. Deleting it invalidates the CDN URL,
    // which makes attached images appear "broken" later in embeds.
    await promptMsg.delete().catch(() => {});
    await interaction.followUp({ content: '✅ Image attached to your submission.', flags: EPHEMERAL });
  } catch {
    // ignore in-channel failures
  }
}
/* ───────────────────────────────────────────── */
/* Approval / Decline                            */
/* ───────────────────────────────────────────── */

async function approveSubmission(interaction, submissionId, shareProof, logChannelId = null) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '🚫 Team only.', flags: EPHEMERAL });
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: EPHEMERAL });
  }

  const res = await q(
    `SELECT s.*, t.name AS trial_name, t.reward_amount AS reward_amount
     FROM submissions s
     JOIN trials t ON t.id = s.trial_id
     WHERE s.id=$1 AND s.guild_id=$2`,
    [submissionId, CONFIG.guildId]
  );

  if (res.rowCount === 0) return interaction.editReply({ content: '❌ Submission not found.' });

  const s = res.rows[0];
  if (s.status !== 'PENDING') return interaction.editReply({ content: `⚠️ Already ${s.status}.` });

  // 1) Mark approved in DB first
  await q(
    `UPDATE submissions
     SET status='APPROVED', reviewed_at=NOW(), reviewed_by=$1
     WHERE id=$2`,
    [interaction.user.id, submissionId]
  );

  // 2) Try DRIP payout
  let payoutOk = false;
  let payoutErr = null;
  try {
    const member = await dripFindMemberByDiscordId(s.user_id);
    if (!member) {
      throw new Error('NOT_IN_REALM');
    }

    const awardRes = await dripAwardByDiscordId({
      discordUserId: s.user_id,
      amount: Number(s.reward_amount)
    });

    payoutOk = true;
    await q(
      `UPDATE submissions
       SET drip_id=$1, payout_status='SENT', payout_tx_id=$2, payout_error=NULL
       WHERE id=$3`,
      [null, awardRes?.data?.id ? String(awardRes.data.id) : null, submissionId]
    );
  } catch (e) {
    payoutErr = String(e?.message || e);
    await q(
      `UPDATE submissions
       SET payout_status='FAILED', payout_error=$1
       WHERE id=$2`,
      [payoutErr, submissionId]
    );
  }

  // 3) Public post in results channel (general-chat or override)
  const targetChannelId = logChannelId || CONFIG.generalChatChannelId;
  const resultsChannel = await client.channels.fetch(targetChannelId);

  const base = `🧪 <@${s.user_id}> completed **${s.trial_name}** and earned **${s.reward_amount} $CHARM**.`;
  const proofLine = (shareProof && s.proof_url) ? `\nProof: ${s.proof_url}` : '';
  const descLine = (shareProof && s.description) ? `\nDescription: ${s.description}` : '';
  const hasImage = shareProof && s.attachment_url;
  const imgLine = hasImage ? `\nImage attached.` : '';

  const payoutLine = payoutOk
    ? `\n✅ $CHARM sent via DRIP.`
    : `\n⚠️ $CHARM payout failed — user may not be linked in DRIP.`;

  if (resultsChannel && resultsChannel.type === ChannelType.GuildText) {
    if (!shareProof) {
      const payoutInline = payoutOk
        ? '✅ $CHARM sent via DRIP.'
        : '⚠️ $CHARM payout failed — user may not be linked in DRIP.';
      await resultsChannel.send({
        content: `${base} ${payoutInline}`
      });
    } else {
      const embeds = [];
      if (hasImage) embeds.push(new EmbedBuilder().setImage(s.attachment_url));

      await resultsChannel.send({
        content: `${base}${proofLine}${descLine}${imgLine}${payoutLine}`,
        embeds
      });
    }
  }

  // 4) Update review message to remove buttons
  const submissionsChannel = await client.channels.fetch(CONFIG.submissionsChannelId);
  if (submissionsChannel && submissionsChannel.type === ChannelType.GuildText && s.review_message_id) {
    const reviewMsg = await submissionsChannel.messages.fetch(s.review_message_id).catch(() => null);
    if (reviewMsg) {
      await reviewMsg.edit({
        content: `✅ Approved by <@${interaction.user.id}> (${shareProof ? 'proof shared' : 'no proof'})`,
        embeds: reviewMsg.embeds,
        components: []
      });
    }
  }
  await interaction.editReply({
    content: payoutOk
      ? '✅ Approval complete.'
      : `⚠️ Approved, but payout failed. Error: ${payoutErr || 'unknown'}`
  });

  // 5) DM user result
  try {
    if (payoutOk) {
      await client.users.send(
        s.user_id,
        `✅ Approved! You earned ${s.reward_amount} $CHARM for **${s.trial_name}**.`
      );
    } else {
      // Your requested message style
      const reason =
        payoutErr === 'NOT_IN_REALM'
          ? `We couldn't send your $CHARM yet because your Discord isn't found in our DRIP realm.`
          : `We couldn't send your $CHARM yet due to a DRIP error: ${payoutErr || 'unknown'}.`;

      await client.users.send(
        s.user_id,
        `✅ Your submission for **${s.trial_name}** was approved.\n\n` +
          `${reason}\n` +
          `Please join DRIP in <#${CONFIG.dripJoinChannelId || CONFIG.generalChatChannelId}> and then message a team member to retry your payout.`
      );
    }
  } catch {
    // ignore DM failures
  }
}

async function rejectSubmission(interaction, submissionId, logChannelId = null) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '🚫 Team only.', flags: EPHEMERAL });

  const modal = new ModalBuilder()
    .setCustomId(`modal_reject:${submissionId}:${logChannelId || 'default'}`)
    .setTitle('Decline Submission');

  const reason = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Reason (required)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(reason));
  return interaction.showModal(modal);
}

async function handleRejectModal(interaction, submissionId, logChannelId = null) {
  if (!isAdmin(interaction.member)) return interaction.reply({ content: '🚫 Team only.', flags: EPHEMERAL });
  await interaction.deferReply({ flags: EPHEMERAL });

  const reason = interaction.fields.getTextInputValue('reason')?.trim();
  if (!reason) return interaction.editReply({ content: '⚠️ Reason required.' });

  const res = await q(
    `SELECT s.*, t.name AS trial_name
     FROM submissions s
     JOIN trials t ON t.id=s.trial_id
     WHERE s.id=$1 AND s.guild_id=$2`,
    [submissionId, CONFIG.guildId]
  );
  if (res.rowCount === 0) return interaction.editReply({ content: '❌ Submission not found.' });

  const s = res.rows[0];
  if (s.status !== 'PENDING') return interaction.editReply({ content: `⚠️ Already ${s.status}.` });

  await q(
    `UPDATE submissions
     SET status='REJECTED', reviewed_at=NOW(), reviewed_by=$1, reject_reason=$2
     WHERE id=$3`,
    [interaction.user.id, reason, submissionId]
  );

  const submissionsChannel = await client.channels.fetch(CONFIG.submissionsChannelId);
  if (submissionsChannel && submissionsChannel.type === ChannelType.GuildText && s.review_message_id) {
    const reviewMsg = await submissionsChannel.messages.fetch(s.review_message_id).catch(() => null);
    if (reviewMsg) {
      await reviewMsg.edit({
        content: `❌ Declined by <@${interaction.user.id}> — reason sent to user`,
        embeds: reviewMsg.embeds,
        components: []
      });
    }
  }

  const targetChannelId = logChannelId || CONFIG.generalChatChannelId;
  const logChannel = await client.channels.fetch(targetChannelId);
  if (logChannel && logChannel.type === ChannelType.GuildText) {
    await logChannel.send({
      content: `❌ <@${s.user_id}>'s submission for **${s.trial_name}** was declined.`
    });
  }

  await interaction.editReply({ content: '❌ Decline complete.' });

  try {
    await client.users.send(
      s.user_id,
      `❌ Your submission for **${s.trial_name}** was declined.\nReason: ${reason}\n\nYou can re-submit if it’s still live.`
    );
  } catch {}
}

/* ───────────────────────────────────────────── */
/* Completions (Past channel button)             */
/* ───────────────────────────────────────────── */

async function handleCompletions(interaction, trialId) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const res = await q(
    `SELECT user_id, reviewed_at
     FROM submissions
     WHERE guild_id=$1 AND trial_id=$2 AND status='APPROVED'
     ORDER BY reviewed_at ASC
     LIMIT 50`,
    [CONFIG.guildId, trialId]
  );

  if (res.rowCount === 0) {
    return interaction.editReply({ content: 'No approved completions for this experiment yet.' });
  }

  const lines = res.rows.map((r, i) => `**${i + 1}.** <@${r.user_id}>`);
  const e = new EmbedBuilder()
    .setTitle('✅ Experiment Completions')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Showing up to 50 completions' });

  return interaction.editReply({ embeds: [e] });
}

async function handleTopScientists(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: '🚫 Team only.', flags: EPHEMERAL });
  }

  await interaction.deferReply({ flags: EPHEMERAL });

  const period = interaction.options.getString('period', false) || 'week';
  const metric = interaction.options.getString('metric', false) || 'count';
  const limitRaw = interaction.options.getInteger('limit', false) || 10;
  const limit = Math.min(50, Math.max(1, limitRaw));

  let wherePeriod = '';
  const params = [CONFIG.guildId];

  if (period === 'week') {
    wherePeriod = `
      AND (s.reviewed_at AT TIME ZONE $2::text) >= date_trunc('week', (now() AT TIME ZONE $2::text))
      AND (s.reviewed_at AT TIME ZONE $2::text) < date_trunc('week', (now() AT TIME ZONE $2::text)) + interval '1 week'
    `;
    params.push(CONFIG.timezone);
  } else if (period === 'month') {
    wherePeriod = `
      AND (s.reviewed_at AT TIME ZONE $2::text) >= date_trunc('month', (now() AT TIME ZONE $2::text))
      AND (s.reviewed_at AT TIME ZONE $2::text) < date_trunc('month', (now() AT TIME ZONE $2::text)) + interval '1 month'
    `;
    params.push(CONFIG.timezone);
  } else if (period === 'all') {
    wherePeriod = '';
  } else {
    return interaction.editReply({ content: '⚠️ Invalid period. Use week, month, or all.' });
  }

  params.push(limit);
  const limitParam = params.length;

  const orderBy =
    metric === 'charm'
      ? 'total_charm DESC, approvals DESC'
      : 'approvals DESC, total_charm DESC';

  const res = await q(
    `SELECT s.user_id,
            COUNT(*)::int AS approvals,
            COALESCE(SUM(t.reward_amount), 0)::int AS total_charm
     FROM submissions s
     JOIN trials t ON t.id = s.trial_id
     WHERE s.guild_id=$1 AND s.status='APPROVED' ${wherePeriod}
     GROUP BY s.user_id
     ORDER BY ${orderBy}
     LIMIT $${limitParam}`,
    params
  );

  if (res.rowCount === 0) {
    const label = period === 'all' ? 'all time' : `this ${period}`;
    return interaction.editReply({ content: `No approved completions for ${label}.` });
  }

  const label = period === 'all' ? 'All Time' : period === 'week' ? 'This Week' : 'This Month';
  const lines = res.rows.map((r, i) => {
    const metricPart = metric === 'charm'
      ? `**${r.total_charm} $CHARM**`
      : `**${r.approvals}**`;
    const suffix = metric === 'charm'
      ? ` (${r.approvals} completed)`
      : ` (${r.total_charm} $CHARM)`;
    return `**${i + 1}.** <@${r.user_id}> — ${metricPart}${suffix}`;
  });

  const e = new EmbedBuilder()
    .setTitle(`🧪 Top Scientists — ${label}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Showing top ${res.rowCount}` });

  return interaction.editReply({ embeds: [e] });
}

/* ───────────────────────────────────────────── */
/* Expiry Tick (move LIVE -> PAST)               */
/* ───────────────────────────────────────────── */

async function expiryTick() {
  const nowIso = new Date().toISOString();

  const res = await q(
    `SELECT * FROM trials
     WHERE guild_id=$1 AND status='LIVE' AND ends_at <= $2
     ORDER BY ends_at ASC
     LIMIT 25`,
    [CONFIG.guildId, nowIso]
  );

  if (res.rowCount === 0) return;

  const pastChannel = await client.channels.fetch(CONFIG.pastTrialsChannelId);
  const liveChannel = await client.channels.fetch(CONFIG.liveTrialsChannelId);

  for (const t of res.rows) {
    const exp = { ...t, ends_at: new Date(t.ends_at) };

    // Mark as PAST
    await q(`UPDATE trials SET status='PAST' WHERE id=$1`, [exp.id]);

    // Delete from live channel so it "disappears"
    try {
      if (liveChannel && liveChannel.type === ChannelType.GuildText) {
        const liveMsg = await liveChannel.messages.fetch(exp.live_message_id);
        await liveMsg.delete().catch(() => {});
      }
    } catch {}

    // Post to past channel (closed embed + completions button)
    try {
      if (pastChannel && pastChannel.type === ChannelType.GuildText) {
        const pastMsg = await pastChannel.send({
          embeds: [buildClosedExperimentEmbed(exp)],
          components: [pastButtons(exp.id)]
        });

        await q(
          `UPDATE trials SET past_channel_id=$1, past_message_id=$2 WHERE id=$3`,
          [CONFIG.pastTrialsChannelId, pastMsg.id, exp.id]
        );
      }
    } catch {}
  }
}

/* ───────────────────────────────────────────── */
/* Events                                       */
/* ───────────────────────────────────────────── */

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands(client.user.id);

  setInterval(() => {
    expiryTick().catch(err => console.error('Expiry tick error:', err));
  }, CONFIG.expiryTickMs);

  console.log('✅ Expiry tick started');
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'addtask') return await handleAddTask(interaction);
      if (interaction.commandName === 'topscientists') return await handleTopScientists(interaction);
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === CUSTOM.howto()) {
        return await interaction.reply({ embeds: [buildHowToEmbed()], flags: EPHEMERAL });
      }

      if (id.startsWith('exp_submit:')) {
        const trialId = Number(id.split(':')[1]);
        return await handleSubmitButton(interaction, trialId);
      }

      if (id.startsWith('exp_completions:')) {
        const trialId = Number(id.split(':')[1]);
        return await handleCompletions(interaction, trialId);
      }

      if (id.startsWith('sub_approve_share:')) {
        const submissionId = Number(id.split(':')[1]);
        const prompt = buildLogChannelPrompt('approve_share', submissionId);
        return await interaction.reply({ ...prompt, flags: EPHEMERAL });
      }

      if (id.startsWith('sub_approve_noshare:')) {
        const submissionId = Number(id.split(':')[1]);
        const prompt = buildLogChannelPrompt('approve_noshare', submissionId);
        return await interaction.reply({ ...prompt, flags: EPHEMERAL });
      }

      if (id.startsWith('sub_reject:')) {
        const submissionId = Number(id.split(':')[1]);
        const prompt = buildLogChannelPrompt('decline', submissionId);
        return await interaction.reply({ ...prompt, flags: EPHEMERAL });
      }

      if (id.startsWith('sub_add_image:')) {
        const parts = id.split(':');
        const submissionId = Number(parts[1]);
        const reviewMessageId = parts[2];
        return await promptOptionalImageInChannel(interaction, submissionId, reviewMessageId);
      }

      if (id.startsWith('log_confirm:')) {
        const parts = id.split(':');
        const action = parts[1];
        const submissionId = Number(parts[2]);
        const channelId = parts[3] === 'default' ? null : parts[3];

        if (action === 'approve_share') return await approveSubmission(interaction, submissionId, true, channelId);
        if (action === 'approve_noshare') return await approveSubmission(interaction, submissionId, false, channelId);
        if (action === 'decline') return await rejectSubmission(interaction, submissionId, channelId);
      }

      return;
    }

    if (interaction.isChannelSelectMenu()) {
      const id = interaction.customId;
      if (id.startsWith('log_channel_select:')) {
        const parts = id.split(':');
        const action = parts[1];
        const submissionId = Number(parts[2]);
        const selectedChannelId = interaction.values?.[0] || null;
        const prompt = buildLogChannelPrompt(action, submissionId, selectedChannelId);
        return await interaction.update(prompt);
      }
    }

    // Modals
    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId.startsWith('modal_submit:')) {
        const trialId = Number(interaction.customId.split(':')[1]);
        return await handleSubmitModal(interaction, trialId);
      }

      if (interaction.customId.startsWith('modal_reject:')) {
        const parts = interaction.customId.split(':');
        const submissionId = Number(parts[1]);
        const channelId = parts[2] === 'default' ? null : parts[2];
        return await handleRejectModal(interaction, submissionId, channelId);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '⚠️ Something went wrong. Check bot logs.', flags: EPHEMERAL });
      } else {
        await interaction.reply({ content: '⚠️ Something went wrong. Check bot logs.', flags: EPHEMERAL });
      }
    } catch {}
  }
});

client.login(CONFIG.token);
