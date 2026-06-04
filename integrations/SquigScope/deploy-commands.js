import { REST, Routes } from 'discord.js';
import { config as dotenvConfig } from 'dotenv';
import config from './config.json' assert { type: 'json' };
import fs from 'fs';

dotenvConfig();

const commands = [];
const commandFiles = fs.readdirSync('./commands');

for (const file of commandFiles) {
  const command = await import(`./commands/${file}`);
  commands.push(command.default.data.toJSON());
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// Register in both servers instantly
const guilds = [process.env.TEST_GUILD_ID, process.env.UGLY_GUILD_ID];

for (const guildId of guilds) {
  try {
    console.log(`Registering slash commands in guild: ${guildId}`);
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, guildId),
      { body: commands }
    );
    console.log(`✅ Commands registered in ${guildId}`);
  } catch (err) {
    console.error(`❌ Failed to register commands in ${guildId}:`, err);
  }
}
