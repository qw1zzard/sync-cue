import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, extname, join } from "node:path";
import { execFile } from "node:child_process";
import { getAsset, isSea } from "node:sea";
import { commandAt, sanitizeDevice } from "./lib/sync.js";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const root = typeof __dirname === "undefined" ? import.meta.dirname : __dirname;
const dataDir = isSea() ? join(dirname(process.execPath), "SyncCueData") : join(root, "uploads");
const uploadDir = isSea() ? join(dataDir, "uploads") : dataDir;
const statePath = join(dataDir, "state.json");
mkdirSync(uploadDir, { recursive: true });

const devices = loadDevices();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
if (isSea()) {
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
  ]);
  app.get([...assets.keys()], (req, res) => {
    const [key, contentType] = assets.get(req.path);
    res.type(contentType).send(Buffer.from(getAsset(key)));
  });
} else {
  app.use(express.static(join(root, "public")));
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
    devices.set(name, { name, media: null, connected: false, ready: false, calibrationMs: 0 });
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

app.post("/api/command/:command", (req, res) => {
  const allowed = new Set(["play", "pause", "reset"]);
  if (!allowed.has(req.params.command)) return res.sendStatus(400);
  const at = commandAt(Date.now(), req.params.command === "play" ? 2500 : 400);
  broadcast({ type: "command", command: req.params.command, at });
  res.json({ command: req.params.command, at });
});

wss.on("connection", (socket) => {
  let assignedDevice = null;

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
        devices.get(name).connected = true;
        devices.get(name).ready = false;
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

    if (message.type === "ready" && assignedDevice) {
      devices.get(assignedDevice).ready = Boolean(message.ready);
      publishState();
    }
  });

  socket.on("close", () => {
    if (!assignedDevice) return;
    const device = devices.get(assignedDevice);
    if (!device) return;
    device.connected = false;
    device.ready = false;
    publishState();
  });
});

server.listen(port, host, () => {
  const controllerUrl = `http://localhost:${port}`;
  console.log(`Controller: ${controllerUrl}`);
  console.log(`Devices:    ${getLanOrigin()}`);
  if (isSea() && process.platform === "win32") {
    execFile("explorer.exe", [controllerUrl], { windowsHide: true });
  }
});
