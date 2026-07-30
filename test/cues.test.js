import test from "node:test";
import assert from "node:assert/strict";
import { CueList, normalizeCue, serializeCueList } from "../lib/cues.js";

test("normalizes supported cues and their optional delay", () => {
  assert.deepEqual(normalizeCue("play"), { action: "play", delayMs: 0 });
  assert.deepEqual(normalizeCue({ id: " intro ", type: "pause", delayMs: "250" }), {
    id: "intro",
    action: "pause",
    delayMs: 250
  });
  assert.throws(() => normalizeCue({ action: "skip" }), /Unsupported cue action/);
  assert.throws(() => normalizeCue({ action: "reset", delayMs: -1 }), /delayMs/);
  assert.throws(() => normalizeCue({ action: "play", delayMs: 501 }, { maxDelayMs: 500 }), /must not exceed/);
});

test("adds, removes and reorders cues without exposing mutable state", () => {
  let id = 0;
  const list = new CueList([], { createId: () => `item-${++id}` });
  const play = list.add("play");
  const reset = list.add({ action: "reset", delayMs: 200 });
  const pause = list.add("pause", 1);

  assert.deepEqual(list.list().map((cue) => cue.id), [play.id, pause.id, reset.id]);
  assert.equal(list.reorder(reset.id, 0), true);
  assert.deepEqual(list.list().map((cue) => cue.action), ["reset", "play", "pause"]);
  assert.deepEqual(list.remove(play.id), play);
  assert.equal(list.remove("missing"), null);

  const copy = list.list();
  copy[0].delayMs = 999;
  assert.equal(list.list()[0].delayMs, 200);
});

test("returns the next cue and handles empty or unknown positions", () => {
  const list = new CueList([
    { id: "one", action: "play" },
    { id: "two", action: "pause" }
  ]);

  assert.equal(list.next().id, "one");
  assert.equal(list.next("one").id, "two");
  assert.equal(list.next("two"), null);
  assert.equal(list.next("unknown"), null);
  assert.equal(new CueList().next(), null);
});

test("serializes a bounded, JSON-safe cue list", () => {
  const list = new CueList([{ id: "a", action: "play", delayMs: 100 }], { maxCues: 2, maxDelayMs: 500 });
  assert.deepEqual(list.serialize(), {
    version: 1,
    cues: [{ id: "a", action: "play", delayMs: 100 }]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(list)), list.serialize());
  assert.throws(() => serializeCueList(["play", "pause"], { maxCues: 1 }), /must not exceed/);
  assert.throws(() => new CueList([{ id: "same", action: "play" }, { id: "same", action: "pause" }]), /unique/);
});

test("rejects invalid positions and duplicate generated ids", () => {
  const list = new CueList([], { createId: () => "one" });
  list.add("play");
  assert.throws(() => list.add("pause"), /unique/);
  assert.throws(() => list.add("reset", 3), /out of range/);
  assert.throws(() => list.reorder("one", 3), /out of range/);
});
