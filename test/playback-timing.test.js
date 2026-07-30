import test from "node:test";
import assert from "node:assert/strict";
import {
  calculatePlayInvocationAt,
  decideDriftCorrection,
  estimateStartLatencyMs,
  expectedCurrentTime
} from "../lib/playback-timing.js";

test("startup latency uses the median and ignores malformed or excessive samples", () => {
  assert.equal(estimateStartLatencyMs([80, 100, 1000]), 100);
  assert.equal(estimateStartLatencyMs([
    { requestedAt: 100, startedAt: 220 },
    { latencyMs: 180 },
    -1,
    "bad",
    20000
  ]), 150);
  assert.equal(estimateStartLatencyMs([], { fallbackMs: 75 }), 75);
  assert.equal(estimateStartLatencyMs(null, { fallbackMs: 75 }), 75);
});

test("play invocation is scheduled early in local time", () => {
  assert.equal(calculatePlayInvocationAt({
    startAt: 10000,
    clockOffsetMs: 120,
    calibrationMs: 25,
    startLatencyMs: 180
  }), 9725);
  assert.equal(calculatePlayInvocationAt({ startAt: 1000, startLatencyMs: -50 }), 1000);
});

test("expected current time follows the shared timeline and respects bounds", () => {
  assert.equal(expectedCurrentTime({ now: 900, startAt: 1000, clockOffsetMs: 150 }), 0.05);
  assert.equal(expectedCurrentTime({ now: 3000, startAt: 1000, startPosition: 2, playbackRate: 1.5 }), 5);
  assert.equal(expectedCurrentTime({ now: 9000, startAt: 1000, durationSeconds: 3 }), 3);
  assert.equal(expectedCurrentTime({ now: 500, startAt: 1000, startPosition: -2 }), 0);
});

test("small drift resets playback rate without changing position", () => {
  assert.deepEqual(decideDriftCorrection({
    actualCurrentTime: 1.01,
    expectedCurrentTime: 1,
    basePlaybackRate: 1.25
  }), {
    action: "none",
    driftMs: -10.000000000000009,
    playbackRate: 1.25
  });
});

test("moderate drift uses bounded rate correction and large drift seeks", () => {
  const rate = decideDriftCorrection({
    actualCurrentTime: 4.9,
    expectedCurrentTime: 5,
    correctionWindowMs: 1000
  });
  assert.equal(rate.action, "rate");
  assert.equal(rate.playbackRate, 1.05);
  assert.equal(rate.driftMs, 99.99999999999964);

  assert.deepEqual(decideDriftCorrection({
    actualCurrentTime: 4,
    expectedCurrentTime: 5
  }), {
    action: "seek",
    driftMs: 1000,
    playbackRate: 1,
    seekTo: 5
  });
});

test("correction tolerates invalid input and inverted rate bounds", () => {
  assert.deepEqual(decideDriftCorrection({
    actualCurrentTime: "bad",
    expectedCurrentTime: "bad",
    minRate: 1.2,
    maxRate: 0.8
  }), {
    action: "none",
    driftMs: 0,
    playbackRate: 1
  });
});
