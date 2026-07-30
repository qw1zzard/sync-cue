const DEFAULT_RATE_THRESHOLD_MS = 40;
const DEFAULT_SEEK_THRESHOLD_MS = 250;
const DEFAULT_CORRECTION_WINDOW_MS = 1000;
const DEFAULT_MIN_RATE = 0.95;
const DEFAULT_MAX_RATE = 1.05;

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function latencyFromMeasurement(measurement) {
  if (Number.isFinite(Number(measurement))) return Number(measurement);
  if (!measurement || typeof measurement !== "object") return null;
  if (Number.isFinite(Number(measurement.latencyMs))) return Number(measurement.latencyMs);

  const requestedAt = Number(measurement.requestedAt);
  const startedAt = Number(measurement.startedAt);
  return Number.isFinite(requestedAt) && Number.isFinite(startedAt)
    ? startedAt - requestedAt
    : null;
}

export function estimateStartLatencyMs(measurements, { fallbackMs = 0, maxMs = 10000 } = {}) {
  if (!Array.isArray(measurements)) return finiteNumber(fallbackMs);
  const upperBound = positiveNumber(maxMs, 10000);
  const values = measurements
    .map(latencyFromMeasurement)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= upperBound)
    .sort((left, right) => left - right);

  if (!values.length) return finiteNumber(fallbackMs);
  const middle = Math.floor(values.length / 2);
  return values.length % 2
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

export function calculatePlayInvocationAt({
  startAt,
  clockOffsetMs = 0,
  calibrationMs = 0,
  startLatencyMs = 0
} = {}) {
  return finiteNumber(startAt)
    - finiteNumber(clockOffsetMs)
    + finiteNumber(calibrationMs)
    - Math.max(0, finiteNumber(startLatencyMs));
}

export function expectedCurrentTime({
  now = Date.now(),
  startAt,
  clockOffsetMs = 0,
  startPosition = 0,
  playbackRate = 1,
  durationSeconds
} = {}) {
  const position = Math.max(0, finiteNumber(startPosition));
  const rate = positiveNumber(playbackRate, 1);
  const elapsedMs = Math.max(0, finiteNumber(now) + finiteNumber(clockOffsetMs) - finiteNumber(startAt));
  const expected = position + elapsedMs / 1000 * rate;
  const duration = finiteNumber(durationSeconds, Infinity);
  return Number.isFinite(duration) && duration >= 0 ? Math.min(expected, duration) : expected;
}

export function decideDriftCorrection({
  actualCurrentTime,
  expectedCurrentTime: expected,
  basePlaybackRate = 1,
  rateThresholdMs = DEFAULT_RATE_THRESHOLD_MS,
  seekThresholdMs = DEFAULT_SEEK_THRESHOLD_MS,
  correctionWindowMs = DEFAULT_CORRECTION_WINDOW_MS,
  minRate = DEFAULT_MIN_RATE,
  maxRate = DEFAULT_MAX_RATE
} = {}) {
  const actual = finiteNumber(actualCurrentTime);
  const target = Math.max(0, finiteNumber(expected));
  const baseRate = positiveNumber(basePlaybackRate, 1);
  const driftMs = (target - actual) * 1000;
  const rateThreshold = Math.max(0, finiteNumber(rateThresholdMs, DEFAULT_RATE_THRESHOLD_MS));
  const seekThreshold = Math.max(rateThreshold, finiteNumber(seekThresholdMs, DEFAULT_SEEK_THRESHOLD_MS));

  if (Math.abs(driftMs) < rateThreshold) {
    return { action: "none", driftMs, playbackRate: baseRate };
  }
  if (Math.abs(driftMs) >= seekThreshold) {
    return { action: "seek", driftMs, playbackRate: baseRate, seekTo: target };
  }

  const windowMs = positiveNumber(correctionWindowMs, DEFAULT_CORRECTION_WINDOW_MS);
  const lowerRate = positiveNumber(minRate, DEFAULT_MIN_RATE);
  const upperRate = Math.max(lowerRate, positiveNumber(maxRate, DEFAULT_MAX_RATE));
  const playbackRate = clamp(baseRate * (1 + driftMs / windowMs), lowerRate, upperRate);
  return { action: "rate", driftMs, playbackRate };
}
