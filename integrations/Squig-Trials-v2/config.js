import 'dotenv/config';

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error('Missing env var: ' + name);
  return v;
}

function opt(name, fallback = null) {
  const v = process.env[name];
  return v ? v : fallback;
}

export const CONFIG = {
  // Discord
  token: req('DISCORD_TOKEN'),
  databaseUrl: req('DATABASE_URL'),
  guildId: req('GUILD_ID'),

  liveTrialsChannelId: req('LIVE_TRIALS_CHANNEL_ID'),
  pastTrialsChannelId: req('PAST_TRIALS_CHANNEL_ID'),
  submissionsChannelId: req('SUBMISSIONS_CHANNEL_ID'),
  imageSubmitChannelId: req('IMAGE_SUBMIT_CHANNEL_ID'),
  generalChatChannelId: req('GENERAL_CHAT_CHANNEL_ID'),

  // Admins (comma separated user ids)
  adminUserIds: (opt('ADMIN_USER_IDS', '') || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  timezone: opt('TZ', 'America/Toronto'),
  expiryTickMs: Number(opt('EXPIRY_TICK_MS', '60000')),

  // DRIP / $CHARM
  dripApiKey: req('DRIP_API_KEY'),
  dripRealmId: req('DRIP_REALM_ID'),
  dripCurrencyId: req('DRIP_CURRENCY_ID'),
  // Some DRIP realms use a different credential type (e.g. discord_id, discord).
  dripCredentialType: opt('DRIP_CREDENTIAL_TYPE', 'discord-id'),

  // Used only for the “join DRIP” help message
  dripJoinChannelId: opt('DRIP_JOIN_CHANNEL_ID', '1330159233320222814')
};
