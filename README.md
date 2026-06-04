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

Common variables:

- `DISCORD_TOKEN` or `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID` or `CLIENT_ID`
- `GUILD_ID` or `UGLYBOT2_GUILD_IDS`
- `DATABASE_URL`
- `ALCHEMY_API_KEY`
- `DRIP_API_KEY`
- `DRIP_REALM_ID`
- `DRIP_CURRENCY_ID`
- `ADMIN_USER_IDS` or `UGLYBOT2_ADMIN_USER_IDS`

Feature flags:

- `UGLYBOT2_ENABLE_UGLYBOT`
- `UGLYBOT2_ENABLE_GAUNTLET`
- `UGLYBOT2_ENABLE_TRIALS`
- `UGLYBOT2_ENABLE_SCAVENGER`
- `UGLYBOT2_ENABLE_SCOPE`

Set any flag to `false` to disable that integration.
