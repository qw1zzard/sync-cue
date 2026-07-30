const DEFAULT_MAX_SAMPLES = 20;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value, now) {
  return finiteNumber(value) ?? now();
}

function median(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value, decimals = 0) {
  if (value === null) return null;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

export class DeviceDiagnostics {
  constructor({
    now = () => Date.now(),
    maxSamples = DEFAULT_MAX_SAMPLES,
    staleMs = 7_500,
    warningRttMs = 450,
    errorRttMs = 1_200,
    warningStartupLagMs = 400,
    errorStartupLagMs = 1_500,
    warningDriftMs = 120,
    errorDriftMs = 500,
    warningBufferedSeconds = 0.75,
    errorBufferedSeconds = 0.15
  } = {}) {
    this.now = now;
    this.maxSamples = Math.max(1, Math.floor(finiteNumber(maxSamples) ?? DEFAULT_MAX_SAMPLES));
    this.staleMs = Math.max(0, finiteNumber(staleMs) ?? 7_500);
    this.thresholds = {
      warningRttMs,
      errorRttMs,
      warningStartupLagMs,
      errorStartupLagMs,
      warningDriftMs,
      errorDriftMs,
      warningBufferedSeconds,
      errorBufferedSeconds
    };
    this.devices = new Map();
  }

  recordClock(device, { rttMs, offsetMs, at } = {}) {
    const record = this.record(device, at);
    const rtt = finiteNumber(rttMs);
    const offset = finiteNumber(offsetMs);
    if (rtt !== null && rtt >= 0) this.addSample(record.rttSamples, rtt);
    if (offset !== null) this.addSample(record.offsetSamples, offset);
    return this.snapshot(device, record.lastSeenAt);
  }

  recordStartup(device, { lagMs, at } = {}) {
    const record = this.record(device, at);
    const lag = finiteNumber(lagMs);
    if (lag !== null) this.addSample(record.startupLagSamples, lag);
    return this.snapshot(device, record.lastSeenAt);
  }

  recordPlayback(device, { driftMs, bufferedSeconds, readyState, at } = {}) {
    const record = this.record(device, at);
    const drift = finiteNumber(driftMs);
    const buffered = finiteNumber(bufferedSeconds);
    const ready = finiteNumber(readyState);
    if (drift !== null) record.driftMs = drift;
    if (buffered !== null && buffered >= 0) record.bufferedSeconds = buffered;
    if (ready !== null) record.readyState = Math.max(0, Math.min(4, Math.round(ready)));
    return this.snapshot(device, record.lastSeenAt);
  }

  snapshot(device, at = this.now()) {
    const record = this.devices.get(device);
    if (!record) return null;
    const seenAt = timestamp(at, this.now);
    const ageMs = Math.max(0, seenAt - record.lastSeenAt);
    const metrics = {
      rttMs: rounded(median(record.rttSamples)),
      clockOffsetMs: rounded(median(record.offsetSamples)),
      startupLagMs: rounded(median(record.startupLagSamples)),
      driftMs: rounded(record.driftMs),
      bufferedSeconds: rounded(record.bufferedSeconds, 2),
      readyState: record.readyState
    };
    return {
      device,
      status: this.status(metrics, ageMs),
      stale: ageMs > this.staleMs,
      lastSeenAt: record.lastSeenAt,
      ageMs: rounded(ageMs),
      metrics,
      samples: {
        clock: record.rttSamples.length,
        startup: record.startupLagSamples.length
      }
    };
  }

  snapshots(at = this.now()) {
    return [...this.devices.keys()].map((device) => this.snapshot(device, at));
  }

  remove(device) {
    return this.devices.delete(device);
  }

  record(device, at) {
    if (typeof device !== "string" || !device.trim()) throw new Error("Device must be a non-empty string");
    const lastSeenAt = timestamp(at, this.now);
    let record = this.devices.get(device);
    if (!record) {
      record = {
        lastSeenAt,
        rttSamples: [],
        offsetSamples: [],
        startupLagSamples: [],
        driftMs: null,
        bufferedSeconds: null,
        readyState: null
      };
      this.devices.set(device, record);
    } else {
      record.lastSeenAt = lastSeenAt;
    }
    return record;
  }

  addSample(samples, value) {
    samples.push(value);
    if (samples.length > this.maxSamples) samples.splice(0, samples.length - this.maxSamples);
  }

  status(metrics, ageMs) {
    if (ageMs > this.staleMs) return "error";
    if (
      this.exceeds(metrics.rttMs, this.thresholds.errorRttMs)
      || this.exceeds(metrics.startupLagMs, this.thresholds.errorStartupLagMs)
      || this.exceeds(Math.abs(metrics.driftMs ?? 0), this.thresholds.errorDriftMs)
      || this.atMost(metrics.bufferedSeconds, this.thresholds.errorBufferedSeconds)
      || this.atMost(metrics.readyState, 1)
    ) return "error";
    if (
      this.exceeds(metrics.rttMs, this.thresholds.warningRttMs)
      || this.exceeds(metrics.startupLagMs, this.thresholds.warningStartupLagMs)
      || this.exceeds(Math.abs(metrics.driftMs ?? 0), this.thresholds.warningDriftMs)
      || this.atMost(metrics.bufferedSeconds, this.thresholds.warningBufferedSeconds)
      || this.atMost(metrics.readyState, 2)
    ) return "warning";
    return "healthy";
  }

  exceeds(value, threshold) {
    const limit = finiteNumber(threshold);
    return value !== null && limit !== null && value >= limit;
  }

  atMost(value, threshold) {
    const limit = finiteNumber(threshold);
    return value !== null && limit !== null && value <= limit;
  }
}
