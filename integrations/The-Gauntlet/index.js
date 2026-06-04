// index.js - Entry Point for The Gauntlet (Solo + Group)

require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} = require("discord.js");

const { TOKEN } = require("./src/utils");
const { initStore } = require("./src/db");
const { initImageStore } = require("./src/imageStore");
const { initSurvivalStore } = require("./src/survivalStore");
const { startApprovalNotificationLoop } = require("./src/approvalNotifier");

// Unified Gauntlet (solo + group commands & routing)
const {
  registerCommands,
  handleInteractionCreate,
  handleMessageCreate,
  initSurvivalLobby,
} = require("./src/soloGauntlet");

// --------------------------------------------
// CREATE CLIENT
// --------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions, // needed for joins
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction, // helps with reactions on cached messages
  ],
});

// --------------------------------------------
// BOOT SEQUENCE
// --------------------------------------------
client.once(Events.ClientReady, async () => {
  console.log(`? Logged in as ${client.user.tag}`);

  try {
    await initStore();
    await initImageStore();
    await initSurvivalStore();
    await initSurvivalLobby(client);
    startApprovalNotificationLoop(client);
  } catch (err) {
    console.error("? Startup failed:", err?.message || err);
    if (err?.stack) {
      console.error(err.stack);
    }
    client.destroy();
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref();
    return;
  }

  try {
    // This now registers BOTH solo + group commands in one shot
    await registerCommands();
    console.log("? Slash commands registered (solo + group)." );
  } catch (err) {
    console.error("? Error registering commands:", err);
  }
});

client.on(Events.Error, (err) => {
  console.error("? Discord client error:", err?.message || err);
});

// --------------------------------------------
// INTERACTION HANDLER
// --------------------------------------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // soloGauntlet's handler internally routes:
    // - /gauntlet, /gauntletlb, /gauntletrecent, /gauntletinfo, /mygauntlet
    // - /groupgauntlet ? handleGroupInteractionCreate (from groupGauntlet)
    await handleInteractionCreate(interaction);
  } catch (err) {
    console.error("interaction error (root):", err);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessageCreate(message);
  } catch (err) {
    console.error("messageCreate error (root):", err);
  }
});

// --------------------------------------------
// LOGIN
// --------------------------------------------
client.login(TOKEN);
