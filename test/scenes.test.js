import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SCENE_NAME_LENGTH,
  applyScene,
  createScene,
  deserializeScenes,
  normalizeSceneName,
  serializeScenes
} from "../lib/scenes.js";

test("scene names are safe, compact, and bounded", () => {
  assert.equal(normalizeSceneName("  Вечер / ../  "), "Вечер");
  assert.equal(normalizeSceneName("x".repeat(50)).length, MAX_SCENE_NAME_LENGTH);
  assert.equal(normalizeSceneName("<>"), "");
});

test("a scene snapshots only media and calibration assignments", () => {
  const scene = createScene("Opening", new Map([
    ["TV", { name: "TV", media: "/media/tv.mp4", calibrationMs: -25, ready: true }],
    ["Phone", { name: "Phone", media: null, calibrationMs: 70, connected: true }]
  ]));

  assert.deepEqual(scene, {
    name: "Opening",
    assignments: [
      { name: "TV", media: "/media/tv.mp4", calibrationMs: -25 },
      { name: "Phone", media: null, calibrationMs: 70 }
    ]
  });
});

test("applying a scene changes current matching devices without restoring removed ones", () => {
  const devices = new Map([
    ["TV", { name: "TV", media: "/media/old.mp4", calibrationMs: 0 }],
    ["Laptop", { name: "Laptop", media: "/media/laptop.mp4", calibrationMs: 10 }]
  ]);
  const applied = applyScene({
    assignments: [
      { name: "TV", media: "/media/new.mp4", calibrationMs: -30 },
      { name: "Phone", media: "/media/phone.mp4", calibrationMs: 20 }
    ]
  }, devices);

  assert.equal(applied, 1);
  assert.deepEqual([...devices.values()], [
    { name: "TV", media: "/media/new.mp4", calibrationMs: -30 },
    { name: "Laptop", media: "/media/laptop.mp4", calibrationMs: 10 }
  ]);
});

test("serialization normalizes limits and rejects malformed saved data", () => {
  const saved = serializeScenes([
    { name: " First ", assignments: [{ name: "TV", media: "/media/a.mp4", calibrationMs: 5000 }] },
    { name: "First", assignments: [] },
    { name: "Second", assignments: [{ name: "TV", media: 10, calibrationMs: "bad" }] }
  ]);

  assert.deepEqual(deserializeScenes(saved), [
    { name: "First", assignments: [{ name: "TV", media: "/media/a.mp4", calibrationMs: 1000 }] },
    { name: "Second", assignments: [{ name: "TV", media: null, calibrationMs: 0 }] }
  ]);
  assert.deepEqual(deserializeScenes("not json"), []);
  assert.deepEqual(deserializeScenes("[" + " ".repeat(200000)), []);
});
