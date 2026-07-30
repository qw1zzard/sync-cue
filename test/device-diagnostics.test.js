import test from "node:test";
import assert from "node:assert/strict";
import { DeviceDiagnostics } from "../lib/device-diagnostics.js";

test("tracks rounded per-device telemetry using bounded samples", () => {
  const diagnostics = new DeviceDiagnostics({ now: () => 1_000, maxSamples: 3 });
  diagnostics.recordClock("Phone", { rttMs: 101.4, offsetMs: -20.6, at: 100 });
  diagnostics.recordClock("Phone", { rttMs: 500, offsetMs: -19.5, at: 200 });
  diagnostics.recordClock("Phone", { rttMs: 120, offsetMs: -18.5, at: 300 });
  diagnostics.recordClock("Phone", { rttMs: 140, offsetMs: -17.5, at: 400 });
  diagnostics.recordStartup("Phone", { lagMs: 230.5, at: 450 });
  diagnostics.recordPlayback("Phone", {
    driftMs: -41.6,
    bufferedSeconds: 2.345,
    readyState: 4,
    at: 500
  });

  assert.deepEqual(diagnostics.snapshot("Phone", 500), {
    device: "Phone",
    status: "healthy",
    stale: false,
    lastSeenAt: 500,
    ageMs: 0,
    metrics: {
      rttMs: 140,
      clockOffsetMs: -18,
      startupLagMs: 231,
      driftMs: -42,
      bufferedSeconds: 2.35,
      readyState: 4
    },
    samples: { clock: 3, startup: 1 }
  });
});

test("reports warning and error from current playback and transport metrics", () => {
  const diagnostics = new DeviceDiagnostics({ now: () => 0 });
  diagnostics.recordPlayback("TV", { driftMs: 160, bufferedSeconds: 2, readyState: 4, at: 100 });
  assert.equal(diagnostics.snapshot("TV", 100).status, "warning");

  diagnostics.recordPlayback("TV", { driftMs: 600, bufferedSeconds: 2, readyState: 4, at: 200 });
  assert.equal(diagnostics.snapshot("TV", 200).status, "error");

  diagnostics.recordPlayback("Laptop", { driftMs: 0, bufferedSeconds: 0.5, readyState: 4, at: 100 });
  assert.equal(diagnostics.snapshot("Laptop", 100).status, "warning");

  diagnostics.recordPlayback("Laptop", { bufferedSeconds: 0.1, at: 200 });
  assert.equal(diagnostics.snapshot("Laptop", 200).status, "error");
});

test("marks stale devices as errors while preserving their latest telemetry", () => {
  const diagnostics = new DeviceDiagnostics({ now: () => 0, staleMs: 500 });
  diagnostics.recordClock("Phone", { rttMs: 80, offsetMs: 12, at: 100 });

  assert.equal(diagnostics.snapshot("Phone", 600).stale, false);
  const stale = diagnostics.snapshot("Phone", 601);
  assert.equal(stale.stale, true);
  assert.equal(stale.status, "error");
  assert.equal(stale.metrics.clockOffsetMs, 12);
});

test("lists and removes devices and rejects unnamed records", () => {
  const diagnostics = new DeviceDiagnostics({ now: () => 1 });
  diagnostics.recordClock("TV", { rttMs: 10 });
  diagnostics.recordClock("Phone", { rttMs: 20 });

  assert.deepEqual(diagnostics.snapshots().map((item) => item.device), ["TV", "Phone"]);
  assert.equal(diagnostics.remove("TV"), true);
  assert.equal(diagnostics.snapshot("TV"), null);
  assert.throws(() => diagnostics.recordClock("", { rttMs: 10 }), /non-empty/);
});
