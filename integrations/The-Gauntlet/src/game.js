// src/game.js
// Core Gauntlet game logic (no Discord-specific code in here)
//
// - Tracks players, rounds, points
// - Ensures no repeated riddles or mini-games in a single game (until exhausted)
// - Handles 10-round structure (configurable)
// - Provides a hook for the Ugly Selector event between rounds 6 and 7

const { riddles, miniGameLorePool } = require("./gameData");

// --- Types / shape notes ---
// GameState = {
//   id: string,
//   createdAt: Date,
//   players: Map<playerId, { id, name, points }>,
//   round: number,
//   maxRounds: number,
//   usedRiddleIndices: Set<number>,
//   usedMiniGameIndices: Set<number>,
//   history: Array<RoundSummary>,
// }
//
// RoundSummary = {
//   round: number,
//   miniGameIndex: number,
//   riddleIndex: number,
//   miniGameResults: { [playerId: string]: number }, // delta points
//   riddleResults: { [playerId: string]: number },   // delta points
// };

/**
 * Create a new game state for a list of players.
 * @param {Array<{id: string, name?: string, username?: string}>} playerList
 * @param {{ maxRounds?: number }} options
 */
function createGameState(playerList, options = {}) {
  const maxRounds = options.maxRounds ?? 10;

  const players = new Map();
  for (const p of playerList) {
    if (!p || !p.id) continue;
    players.set(p.id, {
      id: p.id,
      name: p.name || p.username || `Player-${p.id}`,
      points: 0,
    });
  }

  return {
    id: `gauntlet_${Date.now()}`,
    createdAt: new Date(),
    players,
    round: 0,
    maxRounds,
    usedRiddleIndices: new Set(),
    usedMiniGameIndices: new Set(),
    history: [],
  };
}

// --- Helpers for non-repeating selection ---

function pickUniqueRiddleIndex(state, targetDifficulty) {
  const available = riddles
    .map((r, idx) => ({ r, idx }))
    .filter(
      ({ r, idx }) =>
        r.difficulty === targetDifficulty && !state.usedRiddleIndices.has(idx)
    );

  if (available.length === 0) {
    // Fallback: allow repeats if we’ve exhausted unique ones for this difficulty
    const allOfDifficulty = riddles
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.difficulty === targetDifficulty);

    if (allOfDifficulty.length === 0) {
      throw new Error(
        `No riddles available for difficulty ${targetDifficulty}.`
      );
    }

    const random =
      allOfDifficulty[Math.floor(Math.random() * allOfDifficulty.length)];
    return random.idx;
  }

  const random = available[Math.floor(Math.random() * available.length)];
  return random.idx;
}

function pickUniqueMiniGameIndex(state) {
  const total = miniGameLorePool.length;
  if (total === 0) throw new Error("miniGameLorePool is empty.");

  const allIndices = Array.from({ length: total }, (_, i) => i);
  const available = allIndices.filter((i) => !state.usedMiniGameIndices.has(i));

  if (available.length === 0) {
    // If we somehow use all of them in less rounds than total mini-games, allow repeats.
    return Math.floor(Math.random() * total);
  }

  const randomIdx = available[Math.floor(Math.random() * available.length)];
  return randomIdx;
}

// Optional difficulty curve by round
function getTargetDifficultyForRound(round) {
  // Example curve:
  // Rounds 1–3: easy (1)
  // Rounds 4–7: medium (2)
  // Rounds 8–10: hard (3)
  if (round <= 3) return 1;
  if (round <= 7) return 2;
  return 3;
}

// --- Round flow ---

/**
 * Start the next round.
 * Returns an object describing what should happen this round:
 * {
 *   round,
 *   miniGame: { index, data },
 *   riddle: { index, data },
 *   triggerUglySelector: boolean,
 *   historyEntry
 * }
 */
function startNextRound(state) {
  if (isGameOver(state)) {
    throw new Error("Game is already over.");
  }

  state.round += 1;
  const thisRound = state.round;

  const miniGameIndex = pickUniqueMiniGameIndex(state);
  state.usedMiniGameIndices.add(miniGameIndex);

  const targetDifficulty = getTargetDifficultyForRound(thisRound);
  const riddleIndex = pickUniqueRiddleIndex(state, targetDifficulty);
  state.usedRiddleIndices.add(riddleIndex);

  // Pre-create a history slot for this round
  state.history.push({
    round: thisRound,
    miniGameIndex,
    riddleIndex,
    miniGameResults: {},
    riddleResults: {},
  });

  const historyEntry = state.history[state.history.length - 1];

  // Fire Ugly Selector “between 6 and 7” → right as we enter round 7
  const triggerUglySelector = thisRound === 7;

  return {
    round: thisRound,
    miniGame: {
      index: miniGameIndex,
      data: miniGameLorePool[miniGameIndex],
    },
    riddle: {
      index: riddleIndex,
      data: riddles[riddleIndex],
    },
    triggerUglySelector,
    historyEntry,
  };
}

// --- Points handling ---

/**
 * Apply mini-game result.
 * deltaMap: { [playerId]: number } – positive or negative points per player.
 */
function applyMiniGameResults(state, deltaMap) {
  const historyEntry = state.history.find((h) => h.round === state.round);
  if (!historyEntry) {
    throw new Error("No history entry for current round.");
  }

  for (const [playerId, delta] of Object.entries(deltaMap)) {
    const player = state.players.get(playerId);
    if (!player) continue;
    const d = Number(delta) || 0;
    player.points += d;
    historyEntry.miniGameResults[playerId] =
      (historyEntry.miniGameResults[playerId] || 0) + d;
  }
}

/**
 * Apply riddle result per player.
 * correctPlayers: Set<string> of player IDs who answered correctly.
 * difficulty: riddle difficulty (1, 2, 3, 4)
 * scoring:
 *   1 → +1
 *   2 → +2
 *   3 → +3
 *   4 (Squig special) → +3 by default (tweak if you want).
 */
function applyRiddleResults(state, correctPlayers, difficulty) {
  const historyEntry = state.history.find((h) => h.round === state.round);
  if (!historyEntry) {
    throw new Error("No history entry for current round.");
  }

  let basePoints;
  switch (difficulty) {
    case 1:
      basePoints = 1;
      break;
    case 2:
      basePoints = 2;
      break;
    case 3:
      basePoints = 3;
      break;
    case 4:
      basePoints = 3; // Squig special; bump to 4 if you want it spicier
      break;
    default:
      basePoints = 1;
  }

  for (const [playerId, player] of state.players.entries()) {
    if (!correctPlayers.has(playerId)) continue;
    player.points += basePoints;
    historyEntry.riddleResults[playerId] =
      (historyEntry.riddleResults[playerId] || 0) + basePoints;
  }
}

// --- Game end & leaderboard ---

function isGameOver(state) {
  return state.round >= state.maxRounds;
}

function getLeaderboard(state) {
  const arr = Array.from(state.players.values());
  arr.sort((a, b) => b.points - a.points);
  return arr;
}

/**
 * Get the top N players with tie-awareness.
 * Returns:
 * {
 *   top: Array<{ id, name, points }>,
 *   cutoffPoints: number
 * }
 * If multiple players tie at the cutoff score, they are all included.
 */
function getTopNWithTies(state, n = 3) {
  const board = getLeaderboard(state);
  if (board.length === 0) return { top: [], cutoffPoints: 0 };
  if (board.length <= n) {
    return { top: board, cutoffPoints: board[board.length - 1].points };
  }

  const cutoffPoints = board[n - 1].points;
  const top = board.filter((p) => p.points >= cutoffPoints);
  return { top, cutoffPoints };
}

// --- Exported API ---

module.exports = {
  createGameState,
  startNextRound,
  applyMiniGameResults,
  applyRiddleResults,
  isGameOver,
  getLeaderboard,
  getTopNWithTies,
};
