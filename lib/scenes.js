export const MAX_SCENES = 20;
export const MAX_SCENE_ASSIGNMENTS = 50;
export const MAX_SCENE_NAME_LENGTH = 40;
export const MAX_CALIBRATION_MS = 1000;

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clampCalibration(value) {
  return Math.max(-MAX_CALIBRATION_MS, Math.min(MAX_CALIBRATION_MS, finiteNumber(value)));
}

function deviceList(devices) {
  if (devices instanceof Map) return [...devices.values()];
  return Array.isArray(devices) ? devices : [];
}

function normalizeAssignment(value) {
  if (!value || typeof value !== "object") return null;
  const name = normalizeSceneName(value.name);
  if (!name) return null;
  return {
    name,
    media: typeof value.media === "string" && value.media.length <= 2048 ? value.media : null,
    calibrationMs: clampCalibration(value.calibrationMs)
  };
}

function normalizeAssignments(assignments) {
  if (!Array.isArray(assignments)) return [];
  const names = new Set();
  const result = [];
  for (const candidate of assignments) {
    const assignment = normalizeAssignment(candidate);
    if (!assignment || names.has(assignment.name)) continue;
    names.add(assignment.name);
    result.push(assignment);
    if (result.length === MAX_SCENE_ASSIGNMENTS) break;
  }
  return result;
}

export function normalizeSceneName(value) {
  return String(value ?? "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SCENE_NAME_LENGTH);
}

export function snapshotAssignments(devices) {
  return normalizeAssignments(deviceList(devices));
}

export function createScene(name, devices) {
  return {
    name: normalizeSceneName(name),
    assignments: snapshotAssignments(devices)
  };
}

export function normalizeScenes(scenes) {
  if (!Array.isArray(scenes)) return [];
  const names = new Set();
  const result = [];
  for (const candidate of scenes) {
    if (!candidate || typeof candidate !== "object") continue;
    const name = normalizeSceneName(candidate.name);
    if (!name || names.has(name)) continue;
    names.add(name);
    result.push({ name, assignments: normalizeAssignments(candidate.assignments) });
    if (result.length === MAX_SCENES) break;
  }
  return result;
}

export function applyScene(scene, devices) {
  const assignments = normalizeAssignments(scene?.assignments);
  const current = new Map(deviceList(devices).map((device) => [device?.name, device]));
  let applied = 0;
  for (const assignment of assignments) {
    const device = current.get(assignment.name);
    if (!device) continue;
    device.media = assignment.media;
    device.calibrationMs = assignment.calibrationMs;
    applied += 1;
  }
  return applied;
}

export function serializeScenes(scenes) {
  return JSON.stringify(normalizeScenes(scenes));
}

export function deserializeScenes(value) {
  if (typeof value !== "string" || value.length > 200000) return [];
  try {
    return normalizeScenes(JSON.parse(value));
  } catch {
    return [];
  }
}
