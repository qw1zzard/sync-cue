import test from "node:test";
import assert from "node:assert/strict";
import { CommandTracker } from "../lib/command-tracker.js";

test("a command retries only until a device accepts it", () => {
  const tracker = new CommandTracker({ now: () => 1_000, retryMs: 100 });
  tracker.issue({ id: "cmd-1", command: "play", devices: ["TV", "Phone", "TV"], at: 3_500 });

  assert.deepEqual(tracker.retryCandidates(1_000).map((item) => item.device), ["TV", "Phone"]);
  tracker.markSent("cmd-1", "TV", 1_000);
  tracker.markSent("cmd-1", "Phone", 1_000);
  assert.deepEqual(tracker.retryCandidates(1_050), []);

  tracker.acknowledge({ id: "cmd-1", device: "TV", phase: "accepted", at: 1_060 });
  assert.deepEqual(tracker.retryCandidates(1_100).map((item) => item.device), ["Phone"]);
});

test("execution ACK implies accepted delivery and is idempotent", () => {
  const tracker = new CommandTracker({ now: () => 1_000 });
  tracker.issue({ id: "cmd-2", command: "pause", devices: ["TV"], at: 1_400 });

  assert.equal(tracker.acknowledge({ id: "cmd-2", device: "TV", phase: "executed", at: 1_500 }), true);
  assert.equal(tracker.acknowledge({ id: "cmd-2", device: "TV", phase: "executed", at: 1_600 }), true);
  assert.deepEqual(tracker.snapshot("cmd-2").targets[0], {
    device: "TV",
    status: "executed",
    attempts: 0,
    lastSentAt: null,
    acceptedAt: 1_500,
    executedAt: 1_500,
    error: null
  });
});

test("unacknowledged devices time out without hiding successful devices", () => {
  const tracker = new CommandTracker({ now: () => 1_000, timeoutMs: 200 });
  tracker.issue({ id: "cmd-3", command: "reset", devices: ["TV", "Phone"], at: 1_050 });
  tracker.acknowledge({ id: "cmd-3", device: "TV", phase: "executed", at: 1_060 });

  tracker.expire(1_250);
  assert.deepEqual(tracker.snapshot("cmd-3").targets.map((target) => target.status), ["executed", "timed_out"]);
});
