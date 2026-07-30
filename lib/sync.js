export const START_DELAY_MS = 2500;
const PLAYER_STATES = new Set(["loading", "loaded", "ready", "playing", "paused", "ended", "error"]);
const STATE_PRIORITY = ["error", "loading", "loaded", "playing", "paused", "ready", "ended"];

export function sanitizeDevice(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .slice(0, 40);
}

export function estimateClockOffset(samples) {
  if (!samples.length) return 0;
  const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
  return Math.round(best.reduce((sum, sample) => sum + sample.offset, 0) / best.length);
}

export function commandAt(now = Date.now(), delay = START_DELAY_MS) {
  return now + delay;
}

export function normalizePlayerState(value) {
  return PLAYER_STATES.has(value) ? value : "loading";
}

export function summarizePlayers(players) {
  if (!players.length) {
    return { connected: false, ready: false, playbackState: "offline" };
  }
  const states = players.map((player) => normalizePlayerState(player.state));
  return {
    connected: true,
    ready: players.every((player) => Boolean(player.ready)),
    playbackState: STATE_PRIORITY.find((state) => states.includes(state)) || "loading"
  };
}
