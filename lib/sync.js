export const START_DELAY_MS = 2500;

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
