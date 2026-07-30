const ACK_PHASES = new Set(["accepted", "executed"]);

export class CommandTracker {
  constructor({ now = () => Date.now(), retryMs = 350, timeoutMs = 8_000 } = {}) {
    this.now = now;
    this.retryMs = retryMs;
    this.timeoutMs = timeoutMs;
    this.commands = new Map();
  }

  issue({ id, command, devices, at, expiresAt }) {
    if (!id || this.commands.has(id)) throw new Error("Command id must be unique");
    const issuedAt = this.now();
    const targetDevices = [...new Set(devices)].filter(Boolean);
    const record = {
      id,
      command,
      at,
      expiresAt: expiresAt ?? Math.max(issuedAt + this.timeoutMs, at + this.timeoutMs),
      targets: new Map(targetDevices.map((device) => [device, {
        device,
        status: "pending",
        attempts: 0,
        lastSentAt: null,
        acceptedAt: null,
        executedAt: null,
        error: null
      }]))
    };
    this.commands.set(id, record);
    return this.snapshot(id);
  }

  markSent(id, device, at = this.now()) {
    const target = this.target(id, device);
    if (!target || target.status !== "pending") return false;
    target.attempts += 1;
    target.lastSentAt = at;
    return true;
  }

  acknowledge({ id, device, phase = "accepted", ok = true, error, at = this.now() }) {
    const target = this.target(id, device);
    if (!target || !ACK_PHASES.has(phase) || target.status === "timed_out") return false;
    if (!ok) {
      target.status = "failed";
      target.error = error || "Command failed";
      return true;
    }
    if (phase === "accepted") {
      if (target.status === "pending") {
        target.status = "accepted";
        target.acceptedAt = at;
      }
      return true;
    }
    target.status = "executed";
    target.acceptedAt ??= at;
    target.executedAt ??= at;
    return true;
  }

  retryCandidates(at = this.now()) {
    this.expire(at);
    this.prune(at);
    const candidates = [];
    for (const record of this.commands.values()) {
      for (const target of record.targets.values()) {
        if (target.status !== "pending") continue;
        if (target.lastSentAt === null || at - target.lastSentAt >= this.retryMs) {
          candidates.push({ id: record.id, command: record.command, at: record.at, device: target.device });
        }
      }
    }
    return candidates;
  }

  expire(at = this.now()) {
    for (const record of this.commands.values()) {
      if (at < record.expiresAt) continue;
      for (const target of record.targets.values()) {
        if (target.status === "pending") target.status = "timed_out";
      }
    }
  }

  prune(at = this.now(), retentionMs = 60_000) {
    for (const [id, record] of this.commands) {
      if (at > record.expiresAt + retentionMs) this.commands.delete(id);
    }
  }

  snapshot(id) {
    const record = this.commands.get(id);
    if (!record) return null;
    const targets = [...record.targets.values()].map((target) => ({ ...target }));
    return {
      id: record.id,
      command: record.command,
      at: record.at,
      expiresAt: record.expiresAt,
      complete: targets.every((target) => ["executed", "failed", "timed_out"].includes(target.status)),
      targets
    };
  }

  target(id, device) {
    return this.commands.get(id)?.targets.get(device);
  }
}
