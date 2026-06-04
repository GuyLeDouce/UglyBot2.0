// src/gameData.js
// All Gauntlet data: mini-games, fates, point flavor, riddles, pickers

const { rand } = require("./utils");

// ------------------------------------------------------------
// MINI-GAMES
// ------------------------------------------------------------
const miniGameLorePool = [
  {
    title: "🎁 Chamber of the Ugly",
    lore: "A Squig leads you into a crumbling cavern deep beneath the old arcade. Four boxes glow under flickering slime lights...",
    buttons: ["Box A", "Box B", "Box C", "Box D"],
    image: "https://i.imgur.com/7G2PMce.png",
  },
  {
    title: "🍕 Feast of Regret",
    lore: "Inside a crooked Squig diner with flickering lights and a suspicious chef...",
    buttons: ["Cold Pizza", "Weird Burrito", "Melted Ice Cream", "Mystery Meat"],
    image: "https://i.imgur.com/3nzMYZp.jpeg",
  },
  {
    title: "🛏️ Inception? Never Heard of Her",
    lore: "You’ve drifted off in a Squig nap pod. Suddenly, dreams begin to drift around your head...",
    buttons: ["Flying Dream", "Falling Dream", "Late-for-Class Dream", "Totally Blank Dream"],
    image: "https://i.imgur.com/eTJISg9.jpeg",
  },
  {
    title: "🥄 The Soup of Uncertainty",
    lore: "A Squig invites you to sit at a crooked wooden table. Four steaming bowls sit before you...",
    buttons: ["Glowing Bowl", "Face Bubbles", "Cold Teeth", "Normal Soup"],
    image: "https://i.imgur.com/FNYqXHz.jpeg",
  },
  {
    title: "🧳 Luggage Claim of the Damned",
    lore: "You stand at a slow-moving carousel in a dim, echoing room. Four strange suitcases pass by...",
    buttons: ["Dripping Case", "Humming Case", "Breathing Case", "Still Case"],
    image: "https://i.imgur.com/UsrlWEx.jpeg",
  },
  {
    title: "🧼 Clean or Cursed?",
    lore: "The Squigs don’t really understand hygiene, but they’re trying...",
    buttons: ["Lemon Fresh", "Minty One", "Sketchy Bar", "Unknown Goo"],
    image: "https://i.imgur.com/1J8oNW4.png",
  },
  {
    title: "🚪 Ugly Door Policy",
    lore: "A Squig stands beside four doors. “Only one leads to safety...”",
    buttons: ["Red Door", "Blue Door", "Green Door", "Wiggly Door"],
    image: "https://i.imgur.com/utSECnX.jpeg",
  },
  {
    title: "🌌 The Archive of Forgotten Things",
    lore: "Deep inside the Squigs’ oldest vault, shelves stretch into darkness...",
    buttons: ["Smoke Jar", "Humming Coin", "Strap Mask", "Warm Cube"],
    image: "https://i.imgur.com/35OO8T1.jpeg",
  },
  {
    title: "📺 SquigVision™ Live",
    lore: "You grab the remote. The screen flashes violently...",
    buttons: ["Cooking Show", "Weather Alert", "Cartoon Hour", "Static"],
    image: "https://i.imgur.com/I2QB6Ls.png",
  },
  {
    title: "🎨 Gallery of Regret",
    lore: "Four Squigs submitted artwork to the Ugly Labs gallery...",
    buttons: ["Squig A", "Squig B", "Squig C", "Squig D"],
    image: "https://i.imgur.com/HdQtSol.jpeg",
  },
  {
    title: "🔮 Charm Coin Flip",
    lore: "Every Squig carries a Charm Coin — not for luck, but because sometimes reality needs a decision...",
    buttons: ["Truth Coin", "Liar Coin", "Screaming Coin", "Still Warm"],
    image: "https://i.imgur.com/7IoCjbB.jpeg",
  },
  {
    title: "🧃 Pick Your Potion",
    lore: "A Squig offers you a tray of bubbling concoctions. “Each one changes something...”",
    buttons: ["Blue Bubbler", "Echo Juice", "Time Syrup", "Definitely Nothing"],
    image: "https://i.imgur.com/23BxgsM.jpeg",
  },
  {
    title: "🪑 The Seat of Consequence",
    lore: "You enter a room with four chairs. One hums softly...",
    buttons: ["Wobbly Chair", "Warm Chair", "Gnawed Chair", "Humming Chair"],
    image: "https://i.imgur.com/hHVScHi.jpeg",
  },
  {
    title: "🪞 Reflections That Aren’t",
    lore: "You step into a dusty hall lined with warped mirrors...",
    buttons: ["Tall You", "Small You", "No You", "Too Many Teeth"],
    image: "https://i.imgur.com/xc6aIXP.jpeg",
  },
  {
    title: "🪁 Ugly Monster Windstorm",
    lore: "The Monster charges in holding a giant kite made of trash bags and noodles...",
    buttons: ["Flying Shoe", "Noodle Kite", "Crumpled Note", "Monster's Wig"],
    image: "https://i.imgur.com/zCvzLBj.jpeg",
  },
  {
    title: "🎨 Ugly Monster Art Class",
    lore: "The Monster sets up easels, splashing paint on the floor...",
    buttons: ["Crayon Stub", "Mud Brush", "Glitter Bomb", "Soggy Canvas"],
    image: "https://i.imgur.com/5GrVfwD.jpeg",
  },
  {
    title: "🚀 Ugly Monster Space Trip",
    lore: "The Monster unveils a cardboard rocket, duct-taped together and leaking slime...",
    buttons: ["Pilot Seat", "Middle Seat", "Cargo Hold", "Roof Seat"],
    image: "https://i.imgur.com/4kGMixf.jpeg",
  },
  {
    title: "🍉 Ugly Monster Picnic",
    lore: "The Monster flops onto a checkered blanket, unpacking a basket of questionable snacks...",
    buttons: ["Glowing Fruit", "Pickle Cupcake", "Spaghetti Milkshake", "Mystery Sandwich"],
    image: "https://i.imgur.com/jFnYqcm.jpeg",
  },
];

// ------------------------------------------------------------
// MINI-GAME FATES
// ------------------------------------------------------------
const miniGameFateDescriptions = [
  "They say the ugliest Squig once survived this by sneezing.",
  "The floorboards are judging you. Quietly.",
  "None of these were tested. Proceed accordingly.",
  "A Squig once solved this blindfolded. Then got lost forever.",
  "Just pick what smells right. Trust your nose.",
  "Legends say the correct answer tastes like burnt syrup.",
  "This choice once decided a mayoral race in Uglytown.",
  "Worms know the answer. Unfortunately, they won’t say.",
  "History will not remember what you picked. But we will.",
  "One button leads to treasure. The others... paperwork.",
  "This scenario was predicted by a Squig horoscope in 1997.",
  "You had a dream about this once. Probably shouldn’t trust it.",
  "The correct answer was scratched into a bathroom stall.",
  "A toad guessed right last time. That toad is now a CEO.",
  "Try not to overthink it. That's how the fog gets in.",
  "Even the ugliest choice might be the right one.",
  "Your ancestors are watching. Some are laughing.",
  "A squig with a broken antenna won this round once. Barely.",
  "Nothing about this is fair. But it is fabulous.",
  "It’s not random. It’s just curated chaos.",
  "Whispers say the correct answer glows under moonlight.",
  "Someone flipped a coin for this once. The coin exploded.",
  "This moment is 42% fate, 58% vibes.",
  "Your shadow just tried to warn you. Too late.",
  "Statistically speaking, someone is always wrong.",
  "The fourth option was banned in two dimensions. Not this one.",
];

// ------------------------------------------------------------
// POINT FLAVORS
// ------------------------------------------------------------
const pointFlavors = {
  "+2": [
    "✨ Bathed in the forbidden glow of a Squig lamp. **+2 points!**",
    "🧃 Drank something that blinked back. Felt stronger. **+2 points!**",
    "📜 Misread the prophecy but impressed the paper. **+2 points!**",
    "🐸 Kissed a Squig out of curiosity. Got rewarded. **+2 points!**",
    "🌀 Stared into the static void. It whispered 'nice'. **+2 points!**",
  ],
  "+1": [
    "🎈 Floated past danger like a confused balloon. **+1 point!**",
    "💡 Guessed wrong twice, then guessed right. **+1 point!**",
    "📦 Opened the least cursed option. Just barely. **+1 point!**",
    "🔮 Licked the charm instead of solving it. Unexpected success. **+1 point!**",
    "🎤 Answered with total confidence. It was even right. **+1 point!**",
  ],
  "-1": [
    "🍄 Stepped on a lore mushroom. Instant regret. **-1 point!**",
    "🧤 Chose the sticky button. Ew. **-1 point!**",
    "📺 Watched cursed SquigTV for too long. **-1 point!**",
    "🧻 Slipped on ceremonial toilet paper. **-1 point!**",
    "📉 Traded UglyBucks for SquigCoin. Market tanked. **-1 point!**",
  ],
  "-2": [
    "🥴 Called a Squig 'mid'. It hexed you. **-2 points!**",
    "🪦 Tripped over lore and landed in a portable grave. **-2 points!**",
    "🍖 Tried to eat the Monster’s leftovers. Got slapped. **-2 points!**",
    "🎭 Mocked the ritual with a sock puppet. It mocked back harder. **-2 points!**",
    "🪞 Challenged your reflection. Lost everything. **-2 points!**",
  ],
};

// ------------------------------------------------------------
// RIDDLES (import full list)
// ------------------------------------------------------------
const riddles = require("./riddles");

// ------------------------------------------------------------
// PICKERS (with safe call signatures)
// ------------------------------------------------------------

/**
 * Pick a mini-game that hasn't been used yet (tracked by Set).
 */
function pickMiniGame(usedSet) {
  const avail = miniGameLorePool
    .map((g, i) => ({ ...g, index: i }))
    .filter((g) => !usedSet.has(g.index));

  // If we've used them all, reset and try again
  if (!avail.length) {
    usedSet.clear();
    return pickMiniGame(usedSet);
  }

  const chosen = rand(avail);
  usedSet.add(chosen.index);
  return chosen;
}

/**
 * Flexible picker for riddles.
 *
 * Supports these call patterns:
 *   pickRiddle(usedSet)
 *   pickRiddle(difficulty, usedSet)
 *   pickRiddle(poolArray, usedSet)  // legacy
 */
function pickRiddle(arg1, arg2) {
  let pool = riddles;
  let usedSet;
  let forcedDifficulty;

  // Case A: pickRiddle(poolArray, usedSet) – legacy style
  if (Array.isArray(arg1) && arg2 instanceof Set) {
    pool = arg1;
    usedSet = arg2;
  }
  // Case B: pickRiddle(difficultyNumber, usedSet)
  else if (typeof arg1 === "number" && arg2 instanceof Set) {
    forcedDifficulty = arg1;
    usedSet = arg2;
  }
  // Case C: pickRiddle(usedSet)
  else if (arg1 instanceof Set && arg2 === undefined) {
    usedSet = arg1;
  } else {
    // Fallback – create a temporary Set if somehow called differently
    usedSet = arg2 instanceof Set ? arg2 : new Set();
  }

  const difficulties = [1, 2, 3, 4];
  const targetDifficulty =
    forcedDifficulty && difficulties.includes(forcedDifficulty)
      ? forcedDifficulty
      : difficulties[Math.floor(Math.random() * difficulties.length)];

  // First, try matching target difficulty and not-yet-used
  const filtered = pool
    .map((r, i) => ({ ...r, index: i }))
    .filter(
      (r) => r.difficulty === targetDifficulty && !usedSet.has(r.index)
    );

  let avail = filtered;

  // If nothing available at that difficulty, fall back to any not-yet-used riddle
  if (!avail.length) {
    avail = pool
      .map((r, i) => ({ ...r, index: i }))
      .filter((r) => !usedSet.has(r.index));
  }

  // If *still* nothing, clear usedSet and allow full pool again
  if (!avail.length) {
    usedSet.clear();
    avail = pool.map((r, i) => ({ ...r, index: i }));
  }

  if (!avail.length) return null; // should never happen, but just in case

  const chosen = rand(avail);
  usedSet.add(chosen.index);
  return chosen;
}

// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------
module.exports = {
  miniGameLorePool,
  miniGameFateDescriptions,
  pointFlavors,
  riddles,
  pickMiniGame,
  pickRiddle,
};
