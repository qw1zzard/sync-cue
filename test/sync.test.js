import test from "node:test";
import assert from "node:assert/strict";
import {
  commandAt,
  estimateClockOffset,
  normalizePlayerState,
  sanitizeDevice,
  summarizePlayers
} from "../lib/sync.js";

test("device names are safe and bounded", () => {
  assert.equal(sanitizeDevice(" TV/../../ 1 "), "TV 1");
  assert.equal(sanitizeDevice("x".repeat(50)).length, 40);
});

test("clock offset ignores slow samples", () => {
  const samples = [
    { rtt: 100, offset: 90 },
    { rtt: 10, offset: 20 },
    { rtt: 12, offset: 22 },
    { rtt: 11, offset: 21 }
  ];
  assert.equal(estimateClockOffset(samples), 21);
});

test("commands are scheduled in the future", () => {
  assert.equal(commandAt(1000, 2500), 3500);
});

test("player state is normalized", () => {
  assert.equal(normalizePlayerState("playing"), "playing");
  assert.equal(normalizePlayerState("unknown"), "loading");
});

test("player connections are summarized", () => {
  assert.deepEqual(summarizePlayers([]), {
    connected: false,
    ready: false,
    playbackState: "offline"
  });
  assert.deepEqual(summarizePlayers([
    { state: "playing", ready: true },
    { state: "loaded", ready: false }
  ]), {
    connected: true,
    ready: false,
    playbackState: "loaded"
  });
});
