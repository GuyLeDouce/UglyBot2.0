# UglyBot2

Unified standalone Discord bot that vendors and loads the previous bot integrations:

- UglyBot
- The Gauntlet
- Squig Trials
- Squigs Scavenger Hunt
- Squig Scope

## Start

```bash
npm install
npm start
```

Railway uses `railway.json` and `npm start`.

## Configuration

Set Discord, database, collection, channel, and DRIP values through Railway variables. The bot also adds `/uglybot2 config` for DB-backed runtime settings when `DATABASE_URL` or `UGLYBOT2_DATABASE_URL` is configured.

UglyBot2 is optimized for one organized Railway Postgres database. Set `DATABASE_URL` once and the runtime maps the older split database variables back to that same database unless you explicitly override one of them.

Common variables:

- `DISCORD_TOKEN` or `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID` or `CLIENT_ID`
- `GUILD_ID` or `UGLYBOT2_GUILD_IDS` (`GUILD_ID` is required for Squig Trials)
- `DATABASE_URL`
- `ALCHEMY_API_KEY`
- `DRIP_API_KEY`
- `DRIP_REALM_ID`
- `DRIP_CURRENCY_ID`
- `ADMIN_USER_IDS` or `UGLYBOT2_ADMIN_USER_IDS`

Squig Trials also requires:

- `LIVE_TRIALS_CHANNEL_ID`
- `PAST_TRIALS_CHANNEL_ID`
- `SUBMISSIONS_CHANNEL_ID`
- `IMAGE_SUBMIT_CHANNEL_ID`
- `GENERAL_CHAT_CHANNEL_ID`

Feature flags:

- `UGLYBOT2_ENABLE_UGLYBOT`
- `UGLYBOT2_ENABLE_GAUNTLET`
- `UGLYBOT2_ENABLE_TRIALS`
- `UGLYBOT2_ENABLE_SCAVENGER`
- `UGLYBOT2_ENABLE_SCOPE`

Set any flag to `false` to disable that integration.

## Database Consolidation

These legacy variables are automatically pointed at `DATABASE_URL` when they are unset:

- `DATABASE_URL_HOLDERS`
- `DATABASE_URL_TEAM`
- `DATABASE_URL_POINTS`
- `DATABASE_URL_CLAIMS`
- `DATABASE_URL_PRIZES`
- `GAUNTLET_DATABASE_URL`
- `DATABASE_URL_DRIP`
- `DATABASE_URL_IMAGE`
- `DATABASE_URL_SURVIVAL`

`IMAGE_DB_SAFE` is also defaulted to `true` so Gauntlet image storage is enabled in the shared database.
