export const CUE_ACTIONS = Object.freeze(["play", "pause", "reset"]);

const ACTIONS = new Set(CUE_ACTIONS);
const DEFAULT_MAX_CUES = 100;
const DEFAULT_MAX_DELAY_MS = 3_600_000;

function limit(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return number;
}

function cueId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Cue id must be a non-empty string");
  }
  return value.trim();
}

function actionFrom(cue) {
  const value = typeof cue === "string" ? cue : cue?.action ?? cue?.type;
  if (typeof value !== "string" || !ACTIONS.has(value)) {
    throw new RangeError(`Unsupported cue action: ${value}`);
  }
  return value;
}

function normalizedOptions(options = {}) {
  return {
    maxCues: limit(options.maxCues, DEFAULT_MAX_CUES, "maxCues"),
    maxDelayMs: limit(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, "maxDelayMs")
  };
}

export function normalizeCue(cue, { maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  if (cue === null || (typeof cue !== "string" && typeof cue !== "object")) {
    throw new TypeError("Cue must be an action or object");
  }

  const delay = Number(typeof cue === "object" ? cue.delayMs ?? 0 : 0);
  const normalizedDelay = limit(delay, 0, "Cue delayMs");
  const allowedDelay = limit(maxDelayMs, DEFAULT_MAX_DELAY_MS, "maxDelayMs");
  if (normalizedDelay > allowedDelay) {
    throw new RangeError(`Cue delayMs must not exceed ${allowedDelay}`);
  }

  const normalized = { action: actionFrom(cue), delayMs: normalizedDelay };
  const id = typeof cue === "object" ? cueId(cue.id) : undefined;
  return id === undefined ? normalized : { id, ...normalized };
}

export function serializeCueList(cues, options = {}) {
  if (!Array.isArray(cues)) throw new TypeError("Cues must be an array");
  const { maxCues, maxDelayMs } = normalizedOptions(options);
  if (cues.length > maxCues) throw new RangeError(`Cue list must not exceed ${maxCues} items`);

  const ids = new Set();
  const normalized = cues.map((cue) => {
    const item = normalizeCue(cue, { maxDelayMs });
    if (item.id !== undefined) {
      if (ids.has(item.id)) throw new Error(`Cue id must be unique: ${item.id}`);
      ids.add(item.id);
    }
    return item;
  });
  return { version: 1, cues: normalized };
}

export class CueList {
  constructor(cues = [], options = {}) {
    this.options = normalizedOptions(options);
    this.createId = options.createId ?? (() => `cue-${this.nextId++}`);
    if (typeof this.createId !== "function") throw new TypeError("createId must be a function");
    this.nextId = 1;
    this.cues = [];
    this.ids = new Set();
    for (const cue of serializeCueList(cues, this.options).cues) {
      const id = cue.id ?? cueId(this.createId());
      if (this.ids.has(id)) throw new Error(`Cue id must be unique: ${id}`);
      this.cues.push({ id, action: cue.action, delayMs: cue.delayMs });
      this.ids.add(id);
    }
  }

  list() {
    return this.cues.map((cue) => ({ ...cue }));
  }

  add(cue, index = this.cues.length) {
    if (this.cues.length >= this.options.maxCues) {
      throw new RangeError(`Cue list must not exceed ${this.options.maxCues} items`);
    }
    if (!Number.isSafeInteger(index) || index < 0 || index > this.cues.length) {
      throw new RangeError("Cue index is out of range");
    }

    const normalized = normalizeCue(cue, this.options);
    const id = normalized.id ?? cueId(this.createId());
    if (this.ids.has(id)) throw new Error(`Cue id must be unique: ${id}`);
    const item = { id, action: normalized.action, delayMs: normalized.delayMs };
    this.cues.splice(index, 0, item);
    this.ids.add(id);
    return { ...item };
  }

  remove(id) {
    const index = this.indexOf(id);
    if (index === -1) return null;
    const [removed] = this.cues.splice(index, 1);
    this.ids.delete(removed.id);
    return { ...removed };
  }

  reorder(id, index) {
    const currentIndex = this.indexOf(id);
    if (currentIndex === -1) return false;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.cues.length) {
      throw new RangeError("Cue index is out of range");
    }
    if (currentIndex === index) return true;
    const [cue] = this.cues.splice(currentIndex, 1);
    this.cues.splice(index, 0, cue);
    return true;
  }

  next(id) {
    if (id === undefined) return this.cues[0] ? { ...this.cues[0] } : null;
    const index = this.indexOf(id);
    return index === -1 || !this.cues[index + 1] ? null : { ...this.cues[index + 1] };
  }

  serialize(options = {}) {
    return serializeCueList(this.cues, { ...this.options, ...options });
  }

  toJSON() {
    return this.serialize();
  }

  indexOf(id) {
    return this.cues.findIndex((cue) => cue.id === id);
  }
}
