// Squig Scavenger Hunt Bot — Buttons + No-Repeat Traits + Public Image Posts + Admin Restriction
// + Minted-Only Filter + Runtime Config + Reset Leaderboard + Optional Creative Name
//
// - Wheel is NOT type-scoped (flat list from JSON or minted-only set)
// - Button -> modal (Token ID + Creative Name [optional])
// - Always posts NFT image with: "{user} guessed Squig [TOKEN ID]" (valid or invalid)
// - No trait repeats until all used (persisted in Postgres)
// - Speed points: 25 / 15 / 10. Creative Name (host award): +25
// - /hunt config (show, filter on/off, wheel preset/file, rebuild, resetcycle)
// - /hunt resetleaderboard (wipes scores)
// - Admin commands restricted to 3 user IDs
//
// Env (.env):
// DISCORD_TOKEN=...
// CLIENT_ID=...
// GUILD_ID=...                 # optional; guild-scope if set, else global
// ALCHEMY_API_KEY=...
// SQUIGS_CONTRACT=0x9bf567ddf41b425264626d1b8b2c7f7c660b1c42
// TRAIT_WHEEL_FILE=./data/squigs_trait_wheel_popular.json
// FILTER_TO_MINTED=1           # default minted-only (can be changed via /hunt config)
// RESET_TRAIT_CYCLE=0          # set 1 once to TRUNCATE on boot (or use /hunt config resetcycle)
// DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT
// PGSSLMODE=require            # recommended on Railway

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const fetch = require('node-fetch'); // v2.x
const fs = require('fs');

// ---- Admin restriction ----
const ALLOWED_USERS = new Set([
  '902917038832513074',
  '826581856400179210',
  '1288107772248064044',
]);
function checkAllowed(interaction) {
  if (!ALLOWED_USERS.has(interaction.user.id)) {
    interaction.reply({ flags: 64, content: '⛔ You are not authorized to run this command.' });
    return false;
  }
  return true;
}

// ---- Config ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const SQUIGS_CONTRACT = (process.env.SQUIGS_CONTRACT || '').toLowerCase();
const DEFAULT_WHEEL_FILE = process.env.TRAIT_WHEEL_FILE || './data/squigs_trait_wheel_popular.json';
const DEFAULT_FILTER_TO_MINTED = !!(process.env.FILTER_TO_MINTED && process.env.FILTER_TO_MINTED !== '0');

if (!DISCORD_TOKEN || !CLIENT_ID || !ALCHEMY_API_KEY || !SQUIGS_CONTRACT) {
  console.error('[CONFIG] Missing required env vars.');
}

// ---- Wheel loading ----
function loadWheelFromFile(path) {
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) throw new Error('Wheel JSON empty or not an array');
    return arr;
  } catch (e) {
    console.warn(`[WHEEL] Failed to load ${path}:`, e.message);
    return null;
  }
}
// initial fallback (runtime will override via DB settings)
let TRAIT_WHEEL = loadWheelFromFile(DEFAULT_WHEEL_FILE) || ['Zombie', 'Malformed', 'Giant Ears'];

// ---- DB ----
const { Pool } = require('pg');
const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  undefined;

const needSSL =
  process.env.PGSSLMODE?.toLowerCase() === 'require' ||
  process.env.NODE_ENV === 'production' ||
  !!process.env.RAILWAY_ENVIRONMENT;

const pool = connectionString
  ? new Pool({ connectionString, ssl: needSSL ? { rejectUnauthorized: false } : false })
  : new Pool({
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      ssl: needSSL ? { rejectUnauthorized: false } : false,
    });

pool.on('error', (err) => console.error('[DB] Unexpected error on idle client:', err));
(function verifyDbEnv() {
  const hasConnStr = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL);
  const hasPieces = !!(process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE);
  if (!hasConnStr && !hasPieces) {
    console.error('[DB CONFIG] No Postgres env vars found. Add DATABASE_URL (preferred) or PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT.');
  } else {
    console.log('[DB CONFIG] Using', hasConnStr ? 'connection string' : 'discrete PG* variables');
  }
})();

async function bootstrapDb() {
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scavenger_scores (
      user_id TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scavenger_rounds (
      id SERIAL PRIMARY KEY,
      channel_id TEXT NOT NULL,
      trait TEXT NOT NULL,
      is_open BOOLEAN NOT NULL DEFAULT TRUE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scavenger_submissions (
      id SERIAL PRIMARY KEY,
      round_id INTEGER REFERENCES scavenger_rounds(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      creative_name TEXT,
      is_valid BOOLEAN DEFAULT FALSE,
      valid_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(round_id, user_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scavenger_trait_cycle (
      trait TEXT PRIMARY KEY,
      used BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scavenger_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ---- Settings helpers ----
async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM scavenger_settings WHERE key=$1', [key]);
  if (!rows.length) return fallback;
  return rows[0].value;
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO scavenger_settings(key,value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, value]
  );
}
async function ensureDefaultSettings() {
  if ((await getSetting('wheel_file', null)) == null) {
    await setSetting('wheel_file', DEFAULT_WHEEL_FILE);
  }
  if ((await getSetting('filter_to_minted', null)) == null) {
    await setSetting('filter_to_minted', DEFAULT_FILTER_TO_MINTED ? '1' : '0');
  }
}

// ---- Trait cycle helpers ----
async function seedTraitCycleWithList(traits) {
  if (!Array.isArray(traits) || traits.length === 0) {
    console.warn('[Trait Cycle] Provided trait list is empty; using fallback.');
    traits = ['Zombie', 'Malformed', 'Giant Ears'];
  }
  const existing = await pool.query('SELECT trait FROM scavenger_trait_cycle');
  const have = new Set(existing.rows.map(r => r.trait.toLowerCase()));
  const toAdd = traits.filter(t => !have.has(t.toLowerCase()));
  for (const t of toAdd) {
    await pool.query(
      'INSERT INTO scavenger_trait_cycle(trait, used) VALUES ($1, FALSE) ON CONFLICT (trait) DO NOTHING',
      [t]
    );
  }
}
async function truncateTraitCycle() {
  await pool.query('TRUNCATE scavenger_trait_cycle;');
}
async function pickUnusedTrait() {
  const { rows } = await pool.query('SELECT trait FROM scavenger_trait_cycle WHERE used=FALSE');
  let pick;
  if (rows.length === 0) {
    await pool.query('UPDATE scavenger_trait_cycle SET used=FALSE');
    const all = await pool.query('SELECT trait FROM scavenger_trait_cycle');
    const idx = Math.floor(Math.random() * all.rows.length);
    pick = all.rows[idx].trait;
  } else {
    const idx = Math.floor(Math.random() * rows.length);
    pick = rows[idx].trait;
  }
  await pool.query('UPDATE scavenger_trait_cycle SET used=TRUE WHERE trait=$1', [pick]);
  return pick;
}

// ---- Points & Leaderboard ----
async function addPoints(userId, pts) {
  await pool.query(
    `INSERT INTO scavenger_scores(user_id, points) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET points = scavenger_scores.points + EXCLUDED.points`,
    [userId, pts]
  );
}
async function getPoints(userId) {
  const { rows } = await pool.query('SELECT points FROM scavenger_scores WHERE user_id=$1', [userId]);
  return rows[0]?.points || 0;
}
async function getLeaderboard(limit = 10) {
  const { rows } = await pool.query(
    'SELECT user_id, points FROM scavenger_scores ORDER BY points DESC NULLS LAST LIMIT $1',
    [limit]
  );
  return rows;
}

// ---- Rounds & Submissions ----
async function openRound(channelId, trait, durationSec) {
  const { rows } = await pool.query(
    `INSERT INTO scavenger_rounds(channel_id, trait, is_open, ends_at)
     VALUES ($1, $2, TRUE, NOW() + ($3 || ' seconds')::interval) RETURNING *`,
    [channelId, trait, durationSec]
  );
  return rows[0];
}
async function closeRound(roundId) {
  await pool.query('UPDATE scavenger_rounds SET is_open=FALSE WHERE id=$1', [roundId]);
}
async function getOpenRound(channelId) {
  const { rows } = await pool.query(
    'SELECT * FROM scavenger_rounds WHERE channel_id=$1 AND is_open=TRUE ORDER BY id DESC LIMIT 1',
    [channelId]
  );
  return rows[0] || null;
}
async function saveSubmission(roundId, userId, tokenId, creativeName, isValid, validReason) {
  const { rows } = await pool.query(
    `INSERT INTO scavenger_submissions(round_id, user_id, token_id, creative_name, is_valid, valid_reason)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (round_id, user_id)
     DO UPDATE SET token_id=EXCLUDED.token_id, creative_name=EXCLUDED.creative_name, is_valid=EXCLUDED.is_valid, valid_reason=EXCLUDED.valid_reason
     RETURNING *`,
    [roundId, userId, tokenId, creativeName, isValid, validReason]
  );
  return rows[0];
}
async function getValidSubmissionsInOrder(roundId) {
  const { rows } = await pool.query(
    'SELECT * FROM scavenger_submissions WHERE round_id=$1 AND is_valid=TRUE ORDER BY created_at ASC',
    [roundId]
  );
  return rows;
}
async function awardSpeedPointsIfNeeded(roundId) {
  const subs = await getValidSubmissionsInOrder(roundId);
  const awards = [25, 15, 10];
  const awarded = [];
  for (let i = 0; i < Math.min(3, subs.length); i++) {
    const s = subs[i];
    await addPoints(s.user_id, awards[i]);
    awarded.push({ userId: s.user_id, points: awards[i], tokenId: s.token_id, creativeName: s.creative_name });
  }
  return awarded;
}

// ---- NFT helpers ----
async function fetchNFT(tokenId) {
  try {
    const base = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}/getNFTMetadata`;
    const url = `${base}?contractAddress=${SQUIGS_CONTRACT}&tokenId=${encodeURIComponent(tokenId)}&refreshCache=false`;
    const res = await fetch(url);
    if (!res.ok) return { error: `Alchemy HTTP ${res.status}` };
    return await res.json();
  } catch (e) { return { error: e.message }; }
}
function getImageFromMeta(meta, tokenId) {
  const media = meta?.media;
  if (Array.isArray(media) && media.length) {
    const m = media.find(x => x.gateway) || media[0];
    if (m?.gateway) return m.gateway;
    if (m?.raw) return m.raw;
  }
  const url = meta?.metadata?.image || meta?.rawMetadata?.image;
  if (typeof url === 'string' && url.length) {
    return url.startsWith('ipfs://') ? url.replace('ipfs://', 'https://ipfs.io/ipfs/') : url;
  }
  return `https://assets.bueno.art/images/a49527dc-149c-4cbc-9038-d4b0d1dbf0b2/default/${tokenId}`;
}
async function tokenHasTrait(tokenId, targetTrait) {
  const meta = await fetchNFT(tokenId);
  if (meta.error) return { ok: false, reason: meta.error, imageUrl: null };

  const imageUrl = getImageFromMeta(meta, tokenId); // always compute image
  const attrs = meta?.metadata?.attributes || meta?.rawMetadata?.attributes || [];
  if (!Array.isArray(attrs)) return { ok: false, reason: 'No attributes', imageUrl };

  const match = attrs.some(a => (a?.value ?? '').toString().trim().toLowerCase() === targetTrait.toLowerCase());
  if (!match) return { ok: false, reason: 'Trait not found on token', imageUrl };

  return { ok: true, imageUrl };
}

// ---- Minted-trait filter (Alchemy) ----
async function fetchAllMintedTraitValues() {
  const base = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}/getNFTsForCollection`;
  const params = new URLSearchParams({ contractAddress: SQUIGS_CONTRACT, withMetadata: 'true' });

  const mintedValues = new Set();
  let startToken = undefined;
  let page = 0;

  while (true) {
    const url = `${base}?${params.toString()}${startToken ? `&startToken=${encodeURIComponent(startToken)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Alchemy getNFTsForCollection HTTP ${res.status}`);
    const data = await res.json();

    const nfts = data?.nfts || [];
    for (const nft of nfts) {
      const attrs = nft?.metadata?.attributes || [];
      if (Array.isArray(attrs)) {
        for (const a of attrs) {
          const val = (a?.value ?? '').toString().trim();
          if (val) mintedValues.add(val.toLowerCase());
        }
      }
    }

    page += 1;
    if (data?.nextToken) startToken = data.nextToken; else break;
    if (page > 500) break; // guardrail
  }

  return mintedValues;
}

// Build wheel: if minted filter ON -> use minted values directly; else use wheel file.
async function buildAllowedTraitWheel() {
  const filterMinted = (await getSetting('filter_to_minted', DEFAULT_FILTER_TO_MINTED ? '1' : '0')) === '1';

  if (filterMinted) {
    try {
      console.log('[Minted Filter] Fetching minted tokens to determine available traits...');
      const mintedSetLower = await fetchAllMintedTraitValues();
      const traits = Array.from(mintedSetLower).map(v => v.trim());
      console.log(`[Minted Filter] Using ${traits.length} minted trait values.`);
      return traits;
    } catch (e) {
      console.warn('[Minted Filter] Failed to filter by minted traits:', e.message);
    }
  }

  // fallback to wheel file
  const wheelFile = await getSetting('wheel_file', DEFAULT_WHEEL_FILE);
  const base = loadWheelFromFile(wheelFile) || TRAIT_WHEEL;

  const seen = new Set();
  const uniq = [];
  for (const t of base) {
    const key = t.toLowerCase().trim();
    if (!seen.has(key)) { seen.add(key); uniq.push(t); }
  }
  return uniq;
}

// ---- UX helper for optional creative name ----
function guessDescription(creativeName, trait, isMatch) {
  const status = isMatch ? `matches **${trait}**` : `does **NOT** match **${trait}**`;
  return creativeName && creativeName.trim().length ? `*${creativeName.trim()}* — ${status}` : status;
}

// ---- Discord client & commands ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('hunt')
    .setDescription('Scavenger Hunt admin & info')
    .addSubcommand(sc => sc
      .setName('start')
      .setDescription('Start a new hunt round')
      .addIntegerOption(o => o.setName('duration').setDescription('Round duration in seconds (default 120)'))
    )
    .addSubcommand(sc => sc
      .setName('end')
      .setDescription('End the current round')
    )
    .addSubcommand(sc => sc
      .setName('leaderboard')
      .setDescription('Show the leaderboard')
    )
    .addSubcommand(sc => sc
      .setName('points')
      .setDescription('Show points for a user')
      .addUserOption(o => o.setName('user').setDescription('User (optional)'))
    )
    .addSubcommand(sc => sc
      .setName('awardcreative')
      .setDescription('Award Best Creative Name')
      .addUserOption(o => o.setName('user').setDescription('Winner').setRequired(true))
      .addIntegerOption(o => o.setName('points').setDescription('Points to award (default 25)'))
    )
    .addSubcommand(sc => sc
      .setName('resetleaderboard')
      .setDescription('Reset all player scores to 0 (irreversible)')
      .addStringOption(o => o.setName('confirm').setDescription('Type YES to confirm').setRequired(true))
    )
    // --- CONFIG GROUP (admins) ---
    .addSubcommandGroup(g =>
      g.setName('config')
       .setDescription('Configure hunt settings (admins)')
       .addSubcommand(sc => sc.setName('show').setDescription('Show current config'))
       .addSubcommand(sc => sc
         .setName('filter')
         .setDescription('Toggle minted-only filter')
         .addStringOption(o => o.setName('minted').setDescription('on/off').setRequired(true)
           .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
       )
       .addSubcommand(sc => sc
         .setName('wheel_preset')
         .setDescription('Switch wheel to a preset JSON')
         .addStringOption(o => o.setName('preset').setDescription('popular or all').setRequired(true)
           .addChoices({ name: 'popular', value: 'popular' }, { name: 'all', value: 'all' }))
       )
       .addSubcommand(sc => sc
         .setName('wheel_file')
         .setDescription('Use a custom wheel file path')
         .addStringOption(o => o.setName('path').setDescription('e.g. ./data/squigs_trait_wheel_popular.json').setRequired(true))
       )
       .addSubcommand(sc => sc.setName('rebuild').setDescription('Rebuild the trait cycle from current settings'))
       .addSubcommand(sc => sc.setName('resetcycle').setDescription('TRUNCATE the trait cycle table (then /hunt config rebuild)'))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✓ Guild slash commands registered');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✓ Global slash commands registered');
  }
}

// Use clientReady to be v15-safe
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await bootstrapDb();
  await ensureDefaultSettings();

  if (process.env.RESET_TRAIT_CYCLE === '1') {
    console.warn('[Trait Cycle] RESET_TRAIT_CYCLE=1 → Truncating scavenger_trait_cycle...');
    await truncateTraitCycle();
  }

  const allowedWheel = await buildAllowedTraitWheel();
  await seedTraitCycleWithList(allowedWheel);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // --- Button -> open modal (players) ---
    if (interaction.isButton() && interaction.customId === 'hunt_submit_btn') {
      const open = await getOpenRound(interaction.channelId);
      if (!open) return interaction.reply({ flags: 64, content: 'There is no open round right now.' });

      const modal = new ModalBuilder().setCustomId('hunt_submit_modal').setTitle('Submit Your Squig Guess');
      const tokenInput = new TextInputBuilder().setCustomId('token_id').setLabel('Token ID').setStyle(TextInputStyle.Short).setRequired(true);
      const nameInput = new TextInputBuilder()
        .setCustomId('creative_name')
        .setLabel('Creative Squig Card Name (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false); // OPTIONAL now
      modal.addComponents(new ActionRowBuilder().addComponents(tokenInput), new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    // --- Modal submit -> validate & always post image ---
    if (interaction.isModalSubmit() && interaction.customId === 'hunt_submit_modal') {
      const tokenId = interaction.fields.getTextInputValue('token_id').trim();
      const creativeNameRaw = interaction.fields.getTextInputValue('creative_name');
      const creativeName = (creativeNameRaw || '').trim() || null; // store null if blank

      const open = await getOpenRound(interaction.channelId);
      if (!open) return interaction.reply({ flags: 64, content: 'There is no open round right now.' });

      await interaction.deferReply({ flags: 64 });
      const check = await tokenHasTrait(tokenId, open.trait);

      if (!check.ok) {
        await saveSubmission(open.id, interaction.user.id, tokenId, creativeName, false, check.reason);
        await interaction.editReply(`❌ Invalid submission: ${check.reason}`);
        if (check.imageUrl) {
          const embed = new EmbedBuilder()
            .setTitle(`${interaction.user.username} guessed Squig ${tokenId}`)
            .setDescription(guessDescription(creativeName, open.trait, false))
            .setImage(check.imageUrl)
            .setFooter({ text: `Round #${open.id}` })
            .setTimestamp(new Date());
          await interaction.channel.send({ content: `${interaction.user} guessed Squig ${tokenId}`, embeds: [embed] });
        } else {
          await interaction.channel.send({ content: `${interaction.user} guessed Squig ${tokenId}` });
        }
        return;
      }

      await saveSubmission(open.id, interaction.user.id, tokenId, creativeName, true, 'OK');
      const ordered = await getValidSubmissionsInOrder(open.id);
      const place = ordered.findIndex(s => s.user_id === interaction.user.id) + 1;
      const placeText =
        place === 1 ? '🥇 You are currently **1st**!' :
        place === 2 ? '🥈 You are currently **2nd**!' :
        place === 3 ? '🥉 You are currently **3rd**!' :
        `You are #${place}.`;
      await interaction.editReply(`✅ Valid! Token **${tokenId}** has the trait **${open.trait}**. ${placeText}`);

      const embed = new EmbedBuilder()
        .setTitle(`${interaction.user.username} guessed Squig ${tokenId}`)
        .setDescription(guessDescription(creativeName, open.trait, true))
        .setImage(check.imageUrl)
        .setFooter({ text: `Round #${open.id}` })
        .setTimestamp(new Date());
      await interaction.channel.send({ content: `${interaction.user} guessed Squig ${tokenId}`, embeds: [embed] });
    }

    if (!interaction.isChatInputCommand()) return;

    // --- /hunt commands ---
    if (interaction.commandName === 'hunt') {
      const subGroup = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      // CONFIG (admins)
// CONFIG (admins)
if (subGroup === 'config') {
  if (!checkAllowed(interaction)) return;

  if (sub === 'show') {
    const wheelFile = await getSetting('wheel_file', DEFAULT_WHEEL_FILE);
    const filter = (await getSetting('filter_to_minted', DEFAULT_FILTER_TO_MINTED ? '1' : '0')) === '1';
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder().setTitle('⚙️ Hunt Config').addFields(
        { name: 'Wheel File', value: wheelFile, inline: false },
        { name: 'Minted-only Filter', value: filter ? 'ON' : 'OFF', inline: true }
      )]
    });
  }

  if (sub === 'filter') { // ✅ FIXED HERE
    await interaction.deferReply({ ephemeral: true });
    const choice = interaction.options.getString('minted', true); // on|off
    const val = choice === 'on' ? '1' : '0';
    await setSetting('filter_to_minted', val);
    await truncateTraitCycle();
    const allowed = await buildAllowedTraitWheel();
    await seedTraitCycleWithList(allowed);
    return interaction.editReply(`✅ Minted-only filter set to **${choice.toUpperCase()}** and trait cycle rebuilt (${allowed.length} traits).`);
  }

  if (sub === 'wheel_preset') {
    await interaction.deferReply({ ephemeral: true });
    const preset = interaction.options.getString('preset', true); // popular|all
    const path = preset === 'popular' ? './data/squigs_trait_wheel_popular.json' : './data/squigs_trait_wheel_all.json';
    const test = loadWheelFromFile(path);
    if (!test) return interaction.editReply(`❌ Could not load wheel file: ${path}`);
    await setSetting('wheel_file', path);
    await truncateTraitCycle();
    const allowed = await buildAllowedTraitWheel();
    await seedTraitCycleWithList(allowed);
    return interaction.editReply(`✅ Wheel switched to **${preset}** (${path}). Rebuilt cycle with ${allowed.length} traits.`);
  }

  if (sub === 'wheel_file') {
    await interaction.deferReply({ ephemeral: true });
    const path = interaction.options.getString('path', true);
    const test = loadWheelFromFile(path);
    if (!test) return interaction.editReply(`❌ Could not load wheel file: ${path}`);
    await setSetting('wheel_file', path);
    await truncateTraitCycle();
    const allowed = await buildAllowedTraitWheel();
    await seedTraitCycleWithList(allowed);
    return interaction.editReply(`✅ Wheel file set to **${path}**. Rebuilt cycle with ${allowed.length} traits.`);
  }

  if (sub === 'rebuild') {
    await interaction.deferReply({ ephemeral: true });
    await truncateTraitCycle();
    const allowed = await buildAllowedTraitWheel();
    await seedTraitCycleWithList(allowed);
    return interaction.editReply(`🔁 Rebuilt trait cycle with **${allowed.length}** traits.`);
  }

  if (sub === 'resetcycle') {
    await interaction.deferReply({ ephemeral: true });
    await truncateTraitCycle();
    return interaction.editReply('🧹 Trait cycle table truncated. Run **/hunt config rebuild** next.');
  }

  return;
}


      // Admin lock for main subs
      if (!checkAllowed(interaction)) return;

      if (sub === 'resetleaderboard') {
        const ok = (interaction.options.getString('confirm', true) || '').trim().toUpperCase() === 'YES';
        if (!ok) return interaction.reply({ flags: 64, content: '❌ Type **YES** in the confirm field to reset the leaderboard.' });
        await pool.query('TRUNCATE scavenger_scores;');
        return interaction.reply({ content: '🧹 Leaderboard has been **reset**. GLHF!' });
      }

      if (sub === 'start') {
        const duration = interaction.options.getInteger('duration') || 120;
        const open = await getOpenRound(interaction.channelId);
        if (open) {
          return interaction.reply({ flags: 64, content: 'There is already an open round in this channel. Use /hunt end to close it first.' });
        }

        const trait = await pickUnusedTrait();
        const round = await openRound(interaction.channelId, trait, duration);

        const embed = new EmbedBuilder()
          .setTitle('🌀 Squig Scavenger Hunt — New Round!')
          .setDescription(`**Target Trait:** **${trait}**`)
          .addFields(
            { name: 'Scoring', value: '🥇 Fastest valid: **25**\n🥈 Second: **15**\n🥉 Third: **10**\n🎨 Best Creative Name (host awarded): **25**' },
            { name: 'How to play', value: 'Find a Squig with this trait on the marketplace or in your wallet. Press **Submit Guess** and enter the Token ID (name optional).' },
            { name: 'Timer', value: `${duration} seconds` }
          )
          .setFooter({ text: `Round #${round.id}` })
          .setTimestamp(new Date());

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('hunt_submit_btn').setLabel('Submit Guess').setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({ content: `🎯 The wheel lands on **${trait}**!`, embeds: [embed], components: [row] });

        setTimeout(async () => {
          const stillOpen = await getOpenRound(interaction.channelId);
          if (!stillOpen || stillOpen.id !== round.id) return;

          await closeRound(round.id);
          const awards = await awardSpeedPointsIfNeeded(round.id);
          const lines = awards.map((a, i) => `${i + 1}. <@${a.userId}> +${a.points} pts (Token ${a.tokenId}${a.creativeName ? ` — *${a.creativeName}*` : ''})`);
          await interaction.followUp({
            content:
              `⏰ Time! Round **#${round.id}** closed.\n` +
              `**Speed Awards:**\n` +
              `${lines.join('\n') || 'No valid entries this round.'}\n\n` +
              `Hosts: award **Best Creative Name** with /hunt awardcreative.`
          });
        }, duration * 1000);
      }

      if (sub === 'end') {
        const open = await getOpenRound(interaction.channelId);
        if (!open) return interaction.reply({ flags: 64, content: 'No open round in this channel.' });

        await closeRound(open.id);
        const awards = await awardSpeedPointsIfNeeded(open.id);
        const lines = awards.map((a, i) => `${i + 1}. <@${a.userId}> +${a.points} pts (Token ${a.tokenId}${a.creativeName ? ` — *${a.creativeName}*` : ''})`);
        await interaction.reply({
          content:
            `🛑 Round **#${open.id}** manually closed.\n` +
            `**Speed Awards:**\n` +
            `${lines.join('\n') || 'No valid entries this round.'}`
        });
      }

      if (sub === 'leaderboard') {
        const top = await getLeaderboard(10);
        if (!top.length) return interaction.reply('No scores yet. Play a round!');
        const text = top.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.points} pts`).join('\n');
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🏆 Scavenger Hunt Leaderboard').setDescription(text)] });
      }

      if (sub === 'points') {
        const user = interaction.options.getUser('user') || interaction.user;
        const pts = await getPoints(user.id);
        return interaction.reply({ content: `**${user.username}** has **${pts}** points.` });
      }

      if (sub === 'awardcreative') {
        const user = interaction.options.getUser('user');
        const pts = interaction.options.getInteger('points') || 25;
        await addPoints(user.id, pts);
        return interaction.reply({ content: `🎨 Awarded **${pts}** points to **${user.username}** for Best Creative Name!` });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ flags: 64, content: 'Unexpected error. Please try again.' }); } catch {}
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
