import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getAsset, isSea } from "node:sea";
import { commandAt, normalizePlayerState, sanitizeDevice, summarizePlayers } from "./lib/sync.js";
import { CommandTracker } from "./lib/command-tracker.js";
import {
  MAX_SCENES,
  applyScene,
  createScene,
  deserializeScenes,
  normalizeSceneName,
  serializeScenes
} from "./lib/scenes.js";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const root = typeof __dirname === "undefined" ? import.meta.dirname : __dirname;
const dataDir = process.env.SYNC_CUE_DATA_DIR
  ? resolve(process.env.SYNC_CUE_DATA_DIR)
  : isSea() ? join(dirname(process.execPath), "SyncCueData") : join(root, "uploads");
const uploadDir = isSea() ? join(dataDir, "uploads") : dataDir;
const statePath = join(dataDir, "state.json");
const scenesPath = join(dataDir, "scenes.json");
mkdirSync(uploadDir, { recursive: true });

const devices = loadDevices();
const scenes = loadScenes();
const playerSockets = new Map();
const commandTracker = new CommandTracker();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
let listenErrorHandled = false;

function handleListenError(error) {
  if (listenErrorHandled) return;
  listenErrorHandled = true;
  if (error.code === "EADDRINUSE") {
    console.error(`Sync Cue is already running or port ${port} is in use.`);
    console.error(`Close the other instance or set a different PORT.`);
  } else {
    console.error(`Failed to start Sync Cue: ${error.message}`);
  }
  setImmediate(() => process.exit(1));
}

server.on("error", handleListenError);
wss.on("error", handleListenError);

app.use(express.json());
if (isSea()) {
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/playback-timing.js", ["playback-timing.js", "text/javascript; charset=utf-8"]]
  ]);
  app.get([...assets.keys()], (req, res) => {
    const [key, contentType] = assets.get(req.path);
    res.type(contentType).send(Buffer.from(getAsset(key)));
  });
} else {
  app.use(express.static(join(root, "public")));
  app.get("/playback-timing.js", (_req, res) => {
    res.sendFile(join(root, "lib", "playback-timing.js"));
  });
}
app.use("/media", express.static(uploadDir, {
  acceptRanges: true,
  cacheControl: false
}));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, done) => {
    done(null, file.mimetype.startsWith("video/"));
  }
});

function publicState() {
  return {
    devices: [...devices.values()],
    scenes: scenes.map(({ name }) => ({ name })),
    playerBaseUrl: `${getLanOrigin()}/?mode=player&device=`
  };
}

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function publishState() {
  broadcast({ type: "state", state: publicState() });
}

function deliverCommand({ id, command, at, device }) {
  const sockets = [...(playerSockets.get(device) || [])]
    .filter((socket) => socket.readyState === WebSocket.OPEN);
  if (!sockets.length) return;
  const payload = JSON.stringify({ type: "command", id, command, at });
  for (const socket of sockets) socket.send(payload);
  commandTracker.markSent(id, device);
}

function issueCommand(command) {
  const baseDelay = command === "play" ? 2500 : 400;
  const at = commandAt(Date.now(), baseDelay);
  const id = randomUUID();
  commandTracker.issue({
    id,
    command,
    at,
    devices: [...devices.values()]
      .filter((device) => device.media && device.connected)
      .map((device) => device.name)
  });
  for (const candidate of commandTracker.retryCandidates()) deliverCommand(candidate);
  return { id, command, at };
}

function updatePresence(name) {
  const device = devices.get(name);
  if (!device) return;
  const sockets = [...(playerSockets.get(name) || [])];
  Object.assign(device, summarizePlayers(sockets.map((socket) => ({
    state: socket.playerState,
    ready: socket.playerReady
  }))));
}

function loadDevices() {
  const defaults = ["TV", "Laptop", "Phone"].map((name) => ({
    name,
    media: null,
    calibrationMs: 0
  }));
  let saved = defaults;
  try {
    saved = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  return new Map(saved.map((device) => [device.name, {
    name: device.name,
    media: device.media || null,
    connected: false,
    ready: false,
    playbackState: "offline",
    calibrationMs: Number(device.calibrationMs) || 0
  }]));
}

function persistDevices() {
  const saved = [...devices.values()].map(({ name, media, calibrationMs }) => ({
    name,
    media,
    calibrationMs
  }));
  writeFileSync(statePath, JSON.stringify(saved));
}

function loadScenes() {
  try {
    return deserializeScenes(readFileSync(scenesPath, "utf8"));
  } catch {
    return [];
  }
}

function persistScenes() {
  writeFileSync(scenesPath, serializeScenes(scenes));
}

function getLanOrigin() {
  const candidates = Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) => (addresses ?? []).map((address) => ({ name, ...address })))
    .filter((address) => address.family === "IPv4" && !address.internal)
    .sort((a, b) => interfaceScore(b) - interfaceScore(a));
  return candidates.length
    ? `http://${candidates[0].address}:${port}`
    : `http://localhost:${port}`;
}

function interfaceScore(address) {
  const name = address.name.toLowerCase();
  let score = address.netmask === "255.255.255.255" ? -20 : 0;
  if (/wi-?fi|wlan|ethernet/.test(name)) score += 20;
  if (/vethernet|wsl|hyper-v|virtual|loopback|tun|tap|vpn/.test(name)) score -= 30;
  return score;
}

app.get("/api/state", (_req, res) => res.json(publicState()));

app.post("/api/devices", (req, res) => {
  const name = sanitizeDevice(req.body.name);
  if (!name) return res.status(400).json({ error: "Invalid device name" });
  if (!devices.has(name)) {
    devices.set(name, {
      name,
      media: null,
      connected: false,
      ready: false,
      playbackState: "offline",
      calibrationMs: 0
    });
    persistDevices();
  }
  publishState();
  res.status(201).json(devices.get(name));
});

app.patch("/api/devices/:name", (req, res) => {
  const device = devices.get(sanitizeDevice(req.params.name));
  if (!device) return res.status(404).json({ error: "Device not found" });
  device.calibrationMs = Math.max(-1000, Math.min(1000, Number(req.body.calibrationMs) || 0));
  persistDevices();
  publishState();
  res.json(device);
});

app.delete("/api/devices/:name", (req, res) => {
  const name = sanitizeDevice(req.params.name);
  if (!devices.delete(name)) return res.status(404).json({ error: "Device not found" });
  persistDevices();
  publishState();
  res.sendStatus(204);
});

app.post("/api/upload/:name", upload.single("video"), (req, res) => {
  const name = sanitizeDevice(req.params.name);
  const device = devices.get(name);
  if (!device || !req.file) {
    if (req.file) unlinkSync(req.file.path);
    return res.status(400).json({ error: "Device and video are required" });
  }

  const extension = extname(req.file.originalname).toLowerCase() || ".mp4";
  const filename = `${encodeURIComponent(name)}-${Date.now()}${extension}`;
  renameSync(req.file.path, join(uploadDir, filename));
  device.media = `/media/${filename}`;
  device.ready = false;
  device.playbackState = device.connected ? "loading" : "offline";
  persistDevices();
  publishState();
  res.json(device);
});

app.get("/api/qr", async (req, res) => {
  const name = sanitizeDevice(req.query.device);
  if (!devices.has(name)) return res.sendStatus(404);
  const url = `${getLanOrigin()}/?mode=player&device=${encodeURIComponent(name)}`;
  res.type("png").send(await QRCode.toBuffer(url, { width: 360, margin: 1 }));
});

app.post("/api/scenes", (req, res) => {
  const name = normalizeSceneName(req.body.name);
  if (!name) return res.status(400).json({ error: "Invalid scene name" });
  const scene = createScene(name, devices);
  const index = scenes.findIndex((item) => item.name === name);
  if (index >= 0) scenes[index] = scene;
  else {
    if (scenes.length >= MAX_SCENES) return res.status(400).json({ error: "Scene limit reached" });
    scenes.push(scene);
  }
  persistScenes();
  publishState();
  res.status(201).json(scene);
});

app.post("/api/scenes/:name/apply", (req, res) => {
  const name = normalizeSceneName(req.params.name);
  const scene = scenes.find((item) => item.name === name);
  if (!scene) return res.status(404).json({ error: "Scene not found" });
  const previousMedia = new Map([...devices.values()].map((device) => [device.name, device.media]));
  const applied = applyScene(scene, devices);
  for (const device of devices.values()) {
    if (previousMedia.get(device.name) === device.media) continue;
    device.ready = false;
    device.playbackState = device.connected ? "loading" : "offline";
  }
  persistDevices();
  publishState();
  res.json({ name, applied });
});

app.delete("/api/scenes/:name", (req, res) => {
  const name = normalizeSceneName(req.params.name);
  const index = scenes.findIndex((item) => item.name === name);
  if (index < 0) return res.status(404).json({ error: "Scene not found" });
  scenes.splice(index, 1);
  persistScenes();
  publishState();
  res.sendStatus(204);
});

app.post("/api/command/:command", (req, res) => {
  const allowed = new Set(["play", "pause", "reset"]);
  if (!allowed.has(req.params.command)) return res.sendStatus(400);
  res.json(issueCommand(req.params.command));
});

wss.on("connection", (socket) => {
  let assignedDevice = null;
  socket.isAlive = true;
  socket.playerReady = false;
  socket.playerState = "loading";

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "hello") {
      const name = sanitizeDevice(message.device);
      if (message.role === "player" && devices.has(name)) {
        assignedDevice = name;
        socket.playerReady = Boolean(message.ready);
        socket.playerState = normalizePlayerState(message.playerState);
        if (!playerSockets.has(name)) playerSockets.set(name, new Set());
        playerSockets.get(name).add(socket);
        updatePresence(name);
        for (const candidate of commandTracker.retryCandidates().filter((item) => item.device === name)) {
          deliverCommand(candidate);
        }
      }
      socket.send(JSON.stringify({ type: "state", state: publicState() }));
      publishState();
    }

    if (message.type === "sync") {
      socket.send(JSON.stringify({
        type: "sync",
        id: message.id,
        clientSentAt: message.clientSentAt,
        serverTime: Date.now()
      }));
    }

    if ((message.type === "ready" || message.type === "player-state") && assignedDevice) {
      socket.playerReady = Boolean(message.ready);
      socket.playerState = normalizePlayerState(message.state || (message.ready ? "ready" : "loading"));
      updatePresence(assignedDevice);
      publishState();
    }

    if (message.type === "command-ack" && assignedDevice) {
      commandTracker.acknowledge({
        id: message.id,
        device: assignedDevice,
        phase: message.phase,
        ok: message.ok !== false,
        error: message.error
      });
    }

  });

  socket.on("close", () => {
    if (!assignedDevice) return;
    const sockets = playerSockets.get(assignedDevice);
    sockets?.delete(socket);
    if (!sockets?.size) playerSockets.delete(assignedDevice);
    updatePresence(assignedDevice);
    publishState();
  });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 15000);

const commandRetry = setInterval(() => {
  for (const candidate of commandTracker.retryCandidates()) deliverCommand(candidate);
}, 100);

server.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(commandRetry);
});

server.listen(port, host, () => {
  const controllerUrl = `http://localhost:${port}`;
  console.log(`Controller: ${controllerUrl}`);
  console.log(`Devices:    ${getLanOrigin()}`);
  if (isSea() && process.platform === "win32") {
    execFile("explorer.exe", [controllerUrl], { windowsHide: true });
  }
});
