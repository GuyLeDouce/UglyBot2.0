/* eslint-disable no-console */
// UglyBot2 - unified runtime for:
// - UglyBot
// - The Gauntlet
// - Squig Trials
// - Squigs Scavenger Hunt
// - Squig Scope
//
// This file intentionally keeps the older bot folders intact and loads their
// handlers into one Discord client. It also captures legacy slash registrations
// so one combined command payload is published instead of each bot replacing
// the previous bot's commands.

try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { Pool } = require('pg');

const ROOT = __dirname;
const LEGACY = {
  uglybot: path.join(ROOT, 'integrations', 'UglyBot'),
  gauntlet: path.join(ROOT, 'integrations', 'The-Gauntlet'),
  trials: path.join(ROOT, 'integrations', 'Squig-Trials-v2'),
  scavenger: path.join(ROOT, 'integrations', 'Squigs-Scavenger-Hunt'),
  scope: path.join(ROOT, 'integrations', 'SquigScope'),
};

const EPHEMERAL = 64;
const FEATURE_FLAGS = {
  uglybot: envBool('UGLYBOT2_ENABLE_UGLYBOT', true),
  gauntlet: envBool('UGLYBOT2_ENABLE_GAUNTLET', true),
  trials: envBool('UGLYBOT2_ENABLE_TRIALS', true),
  scavenger: envBool('UGLYBOT2_ENABLE_SCAVENGER', true),
  scope: envBool('UGLYBOT2_ENABLE_SCOPE', true),
};

aliasEnv('DISCORD_TOKEN', ['DISCORD_BOT_TOKEN', 'BOT_TOKEN']);
aliasEnv('DISCORD_BOT_TOKEN', ['DISCORD_TOKEN', 'BOT_TOKEN']);
aliasEnv('BOT_TOKEN', ['DISCORD_TOKEN', 'DISCORD_BOT_TOKEN']);
aliasEnv('DISCORD_CLIENT_ID', ['CLIENT_ID', 'APPLICATION_ID']);
aliasEnv('CLIENT_ID', ['DISCORD_CLIENT_ID', 'APPLICATION_ID']);
aliasEnv('ALCHEMY_KEY', ['ALCHEMY_API_KEY']);
aliasEnv('ALCHEMY_API_KEY', ['ALCHEMY_KEY']);
aliasEnv('DEFAULT_ADMIN_USER', ['UGLYBOT2_ADMIN_USER_IDS', 'ADMIN_USER_IDS', 'GAUNTLET_ADMINS']);
aliasEnv('ADMIN_USER_IDS', ['UGLYBOT2_ADMIN_USER_IDS', 'DEFAULT_ADMIN_USER', 'GAUNTLET_ADMINS']);
aliasEnv('GAUNTLET_ADMINS', ['UGLYBOT2_ADMIN_USER_IDS', 'ADMIN_USER_IDS', 'DEFAULT_ADMIN_USER']);

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || process.env.BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || process.env.APPLICATION_ID;
const GUILD_IDS = parseList(process.env.UGLYBOT2_GUILD_IDS || process.env.GUILD_IDS || process.env.GUILD_ID);
const DATABASE_URL = process.env.UGLYBOT2_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
const PGSSL = String(process.env.PGSSL ?? 'true').toLowerCase() !== 'false';

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN, DISCORD_BOT_TOKEN, or BOT_TOKEN.');
if (!CLIENT_ID) throw new Error('Missing DISCORD_CLIENT_ID, CLIENT_ID, or APPLICATION_ID.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const capturedCommands = new Map();
const bootErrors = [];
let pool = null;

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function aliasEnv(target, sources) {
  if (process.env[target]) return;
  for (const source of sources) {
    if (process.env[source]) {
      process.env[target] = process.env[source];
      return;
    }
  }
}

function isAdmin(interaction) {
  if (!interaction) return false;
  const configured = new Set(parseList(process.env.UGLYBOT2_ADMIN_USER_IDS || process.env.ADMIN_USER_IDS || process.env.DEFAULT_ADMIN_USER || process.env.GAUNTLET_ADMINS));
  if (configured.has(String(interaction.user?.id || ''))) return true;
  return Boolean(
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function getPool() {
  if (pool) return pool;
  if (!DATABASE_URL) return null;
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: PGSSL ? { rejectUnauthorized: false } : false,
  });
  pool.on('error', (err) => console.error('[UglyBot2 DB] idle client error:', err));
  return pool;
}

async function ensureUnifiedSchema() {
  const db = getPool();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS uglybot2_settings (
      guild_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, key)
    );
  `);
}

async function hydrateSettingsFromDb() {
  const db = getPool();
  if (!db || !GUILD_IDS.length) return;
  await ensureUnifiedSchema();
  const { rows } = await db.query(
    'SELECT key, value FROM uglybot2_settings WHERE guild_id = ANY($1::text[])',
    [GUILD_IDS]
  );
  for (const row of rows) {
    const key = String(row.key || '').trim();
    if (key && process.env[key] == null) process.env[key] = String(row.value ?? '');
  }
}

function addCommands(commands, source) {
  for (const command of commands || []) {
    const json = typeof command?.toJSON === 'function' ? command.toJSON() : command;
    if (!json?.name) continue;
    capturedCommands.set(json.name, { ...json, __source: source });
  }
}

function combinedCommands() {
  const commands = [...capturedCommands.values()].map(({ __source, ...command }) => command);
  commands.push(uglybot2Command().toJSON());
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function uglybot2Command() {
  return new SlashCommandBuilder()
    .setName('uglybot2')
    .setDescription('Unified bot admin portal')
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show loaded integrations and configuration health')
    )
    .addSubcommand((sub) =>
      sub
        .setName('config')
        .setDescription('Show or update a Railway-style runtime variable')
        .addStringOption((opt) =>
          opt
            .setName('action')
            .setDescription('What to do')
            .setRequired(true)
            .addChoices(
              { name: 'show', value: 'show' },
              { name: 'set', value: 'set' },
              { name: 'unset', value: 'unset' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('key')
            .setDescription('Environment variable key, such as DRIP_REALM_ID or SQUIGS_CONTRACT')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('value')
            .setDescription('New value when action is set')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('features')
        .setDescription('Show enabled integrations')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
}

async function handleUglyBot2Command(interaction) {
  if (interaction.commandName !== 'uglybot2') return false;
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: 'Admin only.', flags: EPHEMERAL });
    return true;
  }

  const sub = interaction.options.getSubcommand(true);
  if (sub === 'status') {
    const commandNames = [...capturedCommands.keys()].sort();
    const embed = new EmbedBuilder()
      .setTitle('UglyBot2 Status')
      .addFields(
        { name: 'Discord', value: `Client: ${client.user?.tag || 'not ready'}\nGuild scope: ${GUILD_IDS.length ? GUILD_IDS.join(', ') : 'global'}` },
        { name: 'Database', value: getPool() ? 'configured' : 'not configured' },
        { name: 'Commands', value: `${commandNames.length + 1} total\n${commandNames.slice(0, 40).join(', ') || 'none captured'}` },
        { name: 'Boot warnings', value: bootErrors.length ? bootErrors.slice(-8).join('\n') : 'none' }
      )
      .setTimestamp(new Date());
    await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
    return true;
  }

  if (sub === 'features') {
    const lines = Object.entries(FEATURE_FLAGS).map(([name, enabled]) => `${enabled ? 'ON' : 'OFF'} ${name}`);
    await interaction.reply({ content: lines.join('\n'), flags: EPHEMERAL });
    return true;
  }

  if (sub === 'config') {
    const action = interaction.options.getString('action', true);
    const key = interaction.options.getString('key', false)?.trim();
    const value = interaction.options.getString('value', false);
    const guildId = interaction.guildId || GUILD_IDS[0] || 'global';
    const db = getPool();
    if (!db) {
      await interaction.reply({ content: 'Set DATABASE_URL or UGLYBOT2_DATABASE_URL to use the admin config portal.', flags: EPHEMERAL });
      return true;
    }
    await ensureUnifiedSchema();

    if (action === 'show') {
      if (key) {
        const { rows } = await db.query('SELECT key, value, updated_at FROM uglybot2_settings WHERE guild_id=$1 AND key=$2', [guildId, key]);
        await interaction.reply({ content: rows[0] ? `\`${key}\` = \`${redact(key, rows[0].value)}\`` : `No stored value for \`${key}\`.`, flags: EPHEMERAL });
        return true;
      }
      const { rows } = await db.query('SELECT key, value FROM uglybot2_settings WHERE guild_id=$1 ORDER BY key', [guildId]);
      const text = rows.map((r) => `\`${r.key}\` = \`${redact(r.key, r.value)}\``).join('\n') || 'No DB-backed settings stored for this guild.';
      await interaction.reply({ content: text.slice(0, 1900), flags: EPHEMERAL });
      return true;
    }

    if (!key || !/^[A-Z0-9_]+$/.test(key)) {
      await interaction.reply({ content: 'Key is required and must look like an env var, for example `DRIP_REALM_ID`.', flags: EPHEMERAL });
      return true;
    }

    if (action === 'set') {
      if (value == null || value === '') {
        await interaction.reply({ content: 'Value is required for `set`.', flags: EPHEMERAL });
        return true;
      }
      await db.query(
        `INSERT INTO uglybot2_settings (guild_id, key, value, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (guild_id, key)
         DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [guildId, key, value, interaction.user.id]
      );
      process.env[key] = value;
      await interaction.reply({ content: `Saved \`${key}\`. Restart the Railway service for legacy integrations that cached this variable at boot.`, flags: EPHEMERAL });
      return true;
    }

    if (action === 'unset') {
      await db.query('DELETE FROM uglybot2_settings WHERE guild_id=$1 AND key=$2', [guildId, key]);
      delete process.env[key];
      await interaction.reply({ content: `Removed stored value for \`${key}\`.`, flags: EPHEMERAL });
      return true;
    }
  }

  return true;
}

function redact(key, value) {
  if (/TOKEN|SECRET|KEY|PASSWORD|DATABASE_URL|API/i.test(key)) {
    const s = String(value || '');
    if (s.length <= 8) return '********';
    return `${s.slice(0, 4)}...${s.slice(-4)}`;
  }
  return String(value || '');
}

async function registerCombinedCommands() {
  const body = combinedCommands();
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (GUILD_IDS.length) {
    for (const guildId of GUILD_IDS) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body });
      console.log(`[UglyBot2] Registered ${body.length} guild commands for ${guildId}.`);
    }
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log(`[UglyBot2] Registered ${body.length} global commands.`);
  }
}

function patchedDiscordJs() {
  const real = require('discord.js');
  class CapturingREST {
    constructor() { return this; }
    setToken() { return this; }
    async put(route, payload = {}) {
      addCommands(payload.body || [], `legacy:${route}`);
      return payload.body || [];
    }
  }
  function SharedClient() {
    return client;
  }
  return { ...real, Client: SharedClient, REST: CapturingREST };
}

function withPatchedRequire(fn) {
  const originalLoad = Module._load;
  const originalLogin = client.login;
  client.login = async () => 'uglybot2-shared-client';
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'discord.js') return patchedDiscordJs();
    return originalLoad.apply(this, arguments);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
    client.login = originalLogin;
  }
}

function withCwd(dir, fn) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function loadCommonJsEntrypoint(name, file, transform = null) {
  try {
    withPatchedRequire(() => withCwd(path.dirname(file), () => {
      if (!transform) {
        require(file);
        return;
      }
      const code = transform(fs.readFileSync(file, 'utf8'));
      runScriptAsCommonJs(code, file);
    }));
    console.log(`[UglyBot2] Loaded ${name}.`);
  } catch (err) {
    const msg = `[${name}] ${err?.stack || err}`;
    bootErrors.push(msg.slice(0, 500));
    console.error(`[UglyBot2] Failed to load ${name}:`, err);
  }
}

function runScriptAsCommonJs(code, file) {
  const mod = new Module(file, module.parent);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(code, file);
}

function loadGauntlet() {
  try {
    withPatchedRequire(() => {
      const { initStore } = require(path.join(LEGACY.gauntlet, 'src/db'));
      const { initImageStore } = require(path.join(LEGACY.gauntlet, 'src/imageStore'));
      const { initSurvivalStore } = require(path.join(LEGACY.gauntlet, 'src/survivalStore'));
      const { startApprovalNotificationLoop } = require(path.join(LEGACY.gauntlet, 'src/approvalNotifier'));
      const gauntlet = require(path.join(LEGACY.gauntlet, 'src/soloGauntlet'));
      client.once(Events.ClientReady, async () => {
        await initStore();
        await initImageStore();
        await initSurvivalStore();
        await gauntlet.initSurvivalLobby(client);
        startApprovalNotificationLoop(client);
        await gauntlet.registerCommands();
      });
      client.on(Events.InteractionCreate, (interaction) => gauntlet.handleInteractionCreate(interaction));
      client.on(Events.MessageCreate, (message) => gauntlet.handleMessageCreate(message));
    });
    console.log('[UglyBot2] Loaded The Gauntlet.');
  } catch (err) {
    const msg = `[gauntlet] ${err?.stack || err}`;
    bootErrors.push(msg.slice(0, 500));
    console.error('[UglyBot2] Failed to load The Gauntlet:', err);
  }
}

async function loadSquigScope() {
  if (!FEATURE_FLAGS.scope) return;
  try {
    const commandUrl = pathToFileUrl(path.join(LEGACY.scope, 'commands', 'squiggrid.js'));
    const command = (await import(commandUrl)).default;
    if (!command?.data || !command?.execute) throw new Error('Squig Scope command shape not recognized.');
    addCommands([command.data], 'SquigScope');
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== command.data.name) return;
      const previous = process.cwd();
      process.chdir(LEGACY.scope);
      try {
        await command.execute(interaction);
      } catch (err) {
        console.error('[SquigScope] command error:', err);
        if (interaction.deferred || interaction.replied) await interaction.editReply('Something went wrong.');
        else await interaction.reply({ content: 'Something went wrong.', flags: EPHEMERAL });
      } finally {
        process.chdir(previous);
      }
    });
    console.log('[UglyBot2] Loaded Squig Scope.');
  } catch (err) {
    const msg = `[scope] ${err?.stack || err}`;
    bootErrors.push(msg.slice(0, 500));
    console.error('[UglyBot2] Failed to load Squig Scope:', err);
  }
}

function pathToFileUrl(value) {
  return `file:///${value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:')}`;
}

function loadScavenger() {
  if (!FEATURE_FLAGS.scavenger) return;
  const file = path.join(LEGACY.scavenger, 'index.js');
  loadCommonJsEntrypoint('Squigs Scavenger Hunt', file, (source) => {
    const admins = parseList(process.env.UGLYBOT2_ADMIN_USER_IDS || process.env.ADMIN_USER_IDS || process.env.DEFAULT_ADMIN_USER || process.env.GAUNTLET_ADMINS);
    return source
      .replace(
        /const ALLOWED_USERS = new Set\(\[[\s\S]*?\]\);/,
        `const ALLOWED_USERS = new Set(${JSON.stringify(admins)});`
      )
      .replace(/await client\.login\(DISCORD_TOKEN\);/g, "await client.login(DISCORD_TOKEN);");
  });
}

async function runTrialMigrations() {
  if (!FEATURE_FLAGS.trials || !process.env.DATABASE_URL) return;
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: PGSSL ? { rejectUnauthorized: false } : false });
  try {
    const sqlDir = path.join(LEGACY.trials, 'sql');
    const files = fs.readdirSync(sqlDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      await db.query(fs.readFileSync(path.join(sqlDir, file), 'utf8'));
    }
    console.log(`[UglyBot2] Applied ${files.length} Squig Trials migrations.`);
  } finally {
    await db.end();
  }
}

function loadTrials() {
  if (!FEATURE_FLAGS.trials) return;
  try {
    const CONFIG = buildTrialsConfig();
    const trialPool = new Pool({ connectionString: CONFIG.databaseUrl, ssl: PGSSL ? { rejectUnauthorized: false } : false });
    const localRequire = (request) => {
      if (request === 'discord.js') return patchedDiscordJs();
      if (request === './config.js') return { CONFIG };
      if (request === './db.js') {
        return {
          pool: trialPool,
          q: async (text, params) => {
            const dbClient = await trialPool.connect();
            try { return await dbClient.query(text, params); }
            finally { dbClient.release(); }
          },
        };
      }
      if (request === './util_time.js') return buildTrialTimeModule();
      if (request === './drip.js') return buildTrialsDripModule(CONFIG);
      return require(require.resolve(request, { paths: [LEGACY.trials, __dirname] }));
    };
    const originalLogin = client.login;
    client.login = async () => 'uglybot2-shared-client';
    try {
      const raw = fs.readFileSync(path.join(LEGACY.trials, 'index.js'), 'utf8');
      const code = raw
        .replace(/import\s+\{([\s\S]*?)\}\s+from\s+'discord\.js';/, "const {$1} = require('discord.js');")
        .replace(/import\s+\{ CONFIG \}\s+from\s+'\.\/config\.js';/, "const { CONFIG } = require('./config.js');")
        .replace(/import\s+\{ q \}\s+from\s+'\.\/db\.js';/, "const { q } = require('./db.js');")
        .replace(/import\s+\{ parseDurationToMs, formatDiscordTs \}\s+from\s+'\.\/util_time\.js';/, "const { parseDurationToMs, formatDiscordTs } = require('./util_time.js');")
        .replace(/import\s+\{ dripAwardByDiscordId, dripFindMemberByDiscordId \}\s+from\s+'\.\/drip\.js';/, "const { dripAwardByDiscordId, dripFindMemberByDiscordId } = require('./drip.js');");
      const context = {
        require: localRequire,
        console,
        process,
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URL,
        fetch,
        client: undefined,
      };
      vm.runInNewContext(code, context, { filename: path.join(LEGACY.trials, 'index.js') });
    } finally {
      client.login = originalLogin;
    }
    console.log('[UglyBot2] Loaded Squig Trials.');
  } catch (err) {
    const msg = `[trials] ${err?.stack || err}`;
    bootErrors.push(msg.slice(0, 500));
    console.error('[UglyBot2] Failed to load Squig Trials:', err);
  }
}

function buildTrialsConfig() {
  const req = (name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var for Squig Trials: ${name}`);
    return v;
  };
  const opt = (name, fallback = null) => process.env[name] || fallback;
  return {
    token: process.env.DISCORD_TOKEN,
    databaseUrl: req('DATABASE_URL'),
    guildId: req('GUILD_ID'),
    liveTrialsChannelId: req('LIVE_TRIALS_CHANNEL_ID'),
    pastTrialsChannelId: req('PAST_TRIALS_CHANNEL_ID'),
    submissionsChannelId: req('SUBMISSIONS_CHANNEL_ID'),
    imageSubmitChannelId: req('IMAGE_SUBMIT_CHANNEL_ID'),
    generalChatChannelId: req('GENERAL_CHAT_CHANNEL_ID'),
    adminUserIds: parseList(opt('ADMIN_USER_IDS', '')),
    timezone: opt('TZ', 'America/Toronto'),
    expiryTickMs: Number(opt('EXPIRY_TICK_MS', '60000')),
    dripApiKey: req('DRIP_API_KEY'),
    dripRealmId: req('DRIP_REALM_ID'),
    dripCurrencyId: req('DRIP_CURRENCY_ID'),
    dripCredentialType: opt('DRIP_CREDENTIAL_TYPE', 'discord-id'),
    dripJoinChannelId: opt('DRIP_JOIN_CHANNEL_ID', opt('GENERAL_CHAT_CHANNEL_ID')),
  };
}

function buildTrialTimeModule() {
  return {
    parseDurationToMs(input) {
      if (!input || typeof input !== 'string') return null;
      const re = /(\d+)\s*(d|h|m|s)/gi;
      let match;
      let totalMs = 0;
      let found = false;
      while ((match = re.exec(input)) !== null) {
        found = true;
        const n = Number(match[1]);
        const unit = String(match[2]).toLowerCase();
        if (unit === 'd') totalMs += n * 24 * 60 * 60 * 1000;
        else if (unit === 'h') totalMs += n * 60 * 60 * 1000;
        else if (unit === 'm') totalMs += n * 60 * 1000;
        else if (unit === 's') totalMs += n * 1000;
      }
      return found && totalMs > 0 ? totalMs : null;
    },
    formatDiscordTs(date) {
      const seconds = Math.floor(new Date(date).getTime() / 1000);
      return `<t:${seconds}:f> (<t:${seconds}:R>)`;
    },
  };
}

function buildTrialsDripModule(CONFIG) {
  function authHeaders() {
    return { Authorization: `Bearer ${CONFIG.dripApiKey}`, 'Content-Type': 'application/json' };
  }
  return {
    async dripAwardByDiscordId({ discordUserId, amount }) {
      const url = new URL(`https://api.drip.re/api/v1/realms/${CONFIG.dripRealmId}/credentials/balance`);
      url.searchParams.set('type', CONFIG.dripCredentialType);
      url.searchParams.set('value', String(discordUserId));
      const r = await fetch(url.toString(), {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ amount: Number(amount), realmPointId: CONFIG.dripCurrencyId }),
      });
      if (!r.ok) throw new Error(`DRIP award failed (${r.status}): ${await r.text().catch(() => '')}`);
      return r.json();
    },
    async dripFindMemberByDiscordId(discordUserId) {
      const url = new URL(`https://api.drip.re/api/v1/realms/${CONFIG.dripRealmId}/members/search`);
      url.searchParams.set('type', CONFIG.dripCredentialType);
      url.searchParams.set('values', String(discordUserId));
      const r = await fetch(url.toString(), { headers: authHeaders() });
      if (!r.ok) throw new Error(`DRIP member search failed (${r.status}): ${await r.text().catch(() => '')}`);
      const data = await r.json();
      return data?.data?.[0] || null;
    },
  };
}

function loadUglyBot() {
  if (!FEATURE_FLAGS.uglybot) return;
  loadCommonJsEntrypoint('UglyBot', path.join(LEGACY.uglybot, 'index.js'));
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleUglyBot2Command(interaction);
  } catch (err) {
    console.error('[UglyBot2] admin command error:', err);
    if (!interaction.isRepliable?.()) return;
    const payload = { content: 'UglyBot2 admin command failed. Check logs.', flags: EPHEMERAL };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`[UglyBot2] Logged in as ${client.user.tag}.`);
  setTimeout(() => {
    registerCombinedCommands().catch((err) => {
      bootErrors.push(`[commands] ${err?.message || err}`);
      console.error('[UglyBot2] combined command registration failed:', err);
    });
  }, 7000).unref();
});

async function boot() {
  console.log('[UglyBot2] Booting unified integrations.');
  await hydrateSettingsFromDb();
  await ensureUnifiedSchema().catch((err) => {
    bootErrors.push(`[schema] ${err?.message || err}`);
    console.warn('[UglyBot2] Settings schema skipped:', err.message);
  });

  loadUglyBot();
  if (FEATURE_FLAGS.gauntlet) loadGauntlet();
  await runTrialMigrations().catch((err) => {
    bootErrors.push(`[trials migrations] ${err?.message || err}`);
    console.warn('[UglyBot2] Squig Trials migrations skipped:', err.message);
  });
  loadTrials();
  loadScavenger();
  await loadSquigScope();

  await client.login(DISCORD_TOKEN);
}

boot().catch((err) => {
  console.error('[UglyBot2] Fatal boot error:', err);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100).unref();
});
