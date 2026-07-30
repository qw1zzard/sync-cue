const app = document.querySelector("#app");
const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "control";
const deviceName = params.get("device") || "";
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}`);

let state = { devices: [], playerBaseUrl: "" };
let clockOffset = 0;
let syncSamples = [];

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    type: "hello",
    role: mode === "player" ? "player" : "control",
    device: deviceName
  }));
  syncClock();
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "state") {
    state = message.state;
    mode === "player" ? updatePlayer() : renderController();
  }
  if (message.type === "sync") handleSync(message);
  if (message.type === "command" && mode === "player") runCommand(message);
});

socket.addEventListener("close", () => {
  document.querySelector(".connection")?.classList.remove("online");
  const label = document.querySelector(".connection");
  if (label) label.textContent = "Отключено";
});

function syncClock(iteration = 0) {
  if (iteration >= 7 || socket.readyState !== WebSocket.OPEN) return;
  const id = crypto.randomUUID();
  socket.send(JSON.stringify({ type: "sync", id, clientSentAt: Date.now() }));
  setTimeout(() => syncClock(iteration + 1), 140);
}

function handleSync(message) {
  const receivedAt = Date.now();
  const rtt = receivedAt - message.clientSentAt;
  syncSamples.push({
    rtt,
    offset: message.serverTime - (message.clientSentAt + rtt / 2)
  });
  const best = [...syncSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
  clockOffset = Math.round(best.reduce((sum, sample) => sum + sample.offset, 0) / best.length);
}

function renderController() {
  const participants = state.devices.filter((device) => device.media);
  const canPlay = participants.length > 0 && participants.every((device) => device.ready);
  const connected = socket.readyState === WebSocket.OPEN;
  app.innerHTML = `
    <section class="controller">
      <header>
        <h1>Sync Cue</h1>
        <span class="connection ${connected ? "online" : ""}">${connected ? "Подключено" : "Подключение"}</span>
      </header>
      <div class="transport">
        <button class="play" ${canPlay ? "" : "disabled"}>Старт</button>
        <button data-command="pause">Пауза</button>
        <button data-command="reset">Сброс</button>
      </div>
      <div class="device-list">
        ${state.devices.map(deviceCard).join("")}
      </div>
      <form class="add-device">
        <input name="name" maxlength="40" placeholder="Название устройства" required>
        <button>Добавить</button>
      </form>
      <dialog class="qr-dialog">
        <button class="dialog-close" aria-label="Закрыть" title="Закрыть">×</button>
        <h2></h2>
        <img alt="QR-код устройства">
        <a target="_blank" rel="noreferrer"></a>
      </dialog>
    </section>
  `;

  app.querySelector(".play").onclick = () => sendCommand("play");
  app.querySelectorAll("[data-command]").forEach((button) => {
    button.onclick = () => sendCommand(button.dataset.command);
  });
  app.querySelectorAll(".file").forEach((input) => {
    input.onchange = () => uploadVideo(input.dataset.device, input.files[0]);
  });
  app.querySelectorAll(".calibration").forEach((input) => {
    input.onchange = () => updateCalibration(input.dataset.device, input.value);
  });
  app.querySelectorAll(".qr-button").forEach((button) => {
    button.onclick = () => showQr(button.dataset.device);
  });
  app.querySelectorAll(".delete-button").forEach((button) => {
    button.onclick = () => deleteDevice(button.dataset.device);
  });
  app.querySelector(".dialog-close").onclick = () => app.querySelector(".qr-dialog").close();
  app.querySelector(".add-device").onsubmit = addDevice;
}

function deviceCard(device) {
  const status = device.ready
    ? ["Готов", "ready"]
    : device.connected
      ? [device.media ? "Загрузка" : "Нет видео", "loading"]
      : ["Не в сети", ""];
  return `
    <article class="device">
      <div class="device-head">
        <h2>${escapeHtml(device.name)}</h2>
        <span class="status ${status[1]}">${status[0]}</span>
      </div>
      <div class="device-body">
        <input class="file" data-device="${escapeHtml(device.name)}" type="file" accept="video/*">
        <span class="media-name">${device.media ? device.media.split("/").pop() : "Нет видео"}</span>
      </div>
      <div class="device-foot">
        <label class="calibration-wrap" title="Поправка старта">
          <input class="calibration" data-device="${escapeHtml(device.name)}" type="number"
            min="-1000" max="1000" step="10" value="${device.calibrationMs}">
          <span>мс</span>
        </label>
        <div class="device-actions">
          <button class="icon-button qr-button" data-device="${escapeHtml(device.name)}"
            title="Показать QR-код" aria-label="Показать QR-код">QR</button>
          <button class="icon-button delete-button" data-device="${escapeHtml(device.name)}"
            title="Удалить устройство" aria-label="Удалить устройство">×</button>
        </div>
      </div>
    </article>
  `;
}

async function uploadVideo(device, file) {
  if (!file) return;
  const body = new FormData();
  body.append("video", file);
  const response = await fetch(`/api/upload/${encodeURIComponent(device)}`, { method: "POST", body });
  if (!response.ok) alert("Не удалось загрузить видео");
}

async function updateCalibration(device, calibrationMs) {
  await fetch(`/api/devices/${encodeURIComponent(device)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calibrationMs: Number(calibrationMs) })
  });
}

async function addDevice(event) {
  event.preventDefault();
  await fetch("/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: new FormData(event.currentTarget).get("name") })
  });
  event.currentTarget.reset();
}

function showQr(device) {
  const dialog = app.querySelector(".qr-dialog");
  const url = `${state.playerBaseUrl}${encodeURIComponent(device)}`;
  dialog.querySelector("h2").textContent = device;
  dialog.querySelector("img").src = `/api/qr?device=${encodeURIComponent(device)}`;
  const link = dialog.querySelector("a");
  link.href = url;
  link.textContent = url;
  dialog.showModal();
}

async function deleteDevice(device) {
  await fetch(`/api/devices/${encodeURIComponent(device)}`, { method: "DELETE" });
}

async function sendCommand(command) {
  await fetch(`/api/command/${command}`, { method: "POST" });
}

let video;
let currentMedia;
let armed = false;
let commandTimer;

function renderPlayer() {
  app.innerHTML = `
    <section class="player">
      <video playsinline preload="auto"></video>
      <span class="player-badge">${escapeHtml(deviceName)}</span>
      <div class="player-overlay">
        <div class="player-panel">
          <h1>${escapeHtml(deviceName || "Устройство")}</h1>
          <p class="player-status">Подключение</p>
          <button class="arm">Подготовить</button>
          <button class="fullscreen">Во весь экран</button>
        </div>
      </div>
    </section>
  `;
  video = app.querySelector("video");
  app.querySelector(".arm").onclick = armPlayer;
  app.querySelector(".fullscreen").onclick = enterFullscreen;
}

function updatePlayer() {
  if (!video) renderPlayer();
  const device = state.devices.find((item) => item.name === deviceName);
  const status = app.querySelector(".player-status");
  if (!device) {
    status.textContent = "Неизвестное устройство";
    return;
  }
  if (device.media && device.media !== currentMedia) {
    currentMedia = device.media;
    video.src = currentMedia;
    video.load();
    socket.send(JSON.stringify({ type: "ready", ready: false }));
  }
  status.textContent = device.media ? (armed ? "Готов" : "Видео загружено") : "Ожидание видео";
}

async function armPlayer() {
  if (!currentMedia) return;
  try {
    video.muted = true;
    const playRequest = video.play();
    const fullscreenRequest = enterFullscreen();
    await playRequest;
    await fullscreenRequest;
    video.pause();
    video.currentTime = 0;
    video.muted = false;
    armed = true;
    app.querySelector(".player").classList.add("armed");
    await navigator.wakeLock?.request("screen").catch(() => null);
    socket.send(JSON.stringify({ type: "ready", ready: true }));
  } catch {
    app.querySelector(".player-status").textContent = "Нажмите ещё раз";
  }
}

async function enterFullscreen() {
  if (video.requestFullscreen) {
    try {
      await video.requestFullscreen({ navigationUI: "hide" });
      return;
    } catch {}
  }
  if (video.webkitEnterFullscreen) {
    try {
      video.webkitEnterFullscreen();
      return;
    } catch {}
  }
  if (document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    } catch {}
  }
}

function runCommand({ command, at }) {
  if (!video || !armed) return;
  clearTimeout(commandTimer);
  const device = state.devices.find((item) => item.name === deviceName);
  const calibration = device?.calibrationMs || 0;
  const localAt = at - clockOffset + calibration;
  commandTimer = setTimeout(async () => {
    if (command === "play") {
      video.currentTime = 0;
      await video.play().catch(() => null);
    }
    if (command === "pause") video.pause();
    if (command === "reset") {
      video.pause();
      video.currentTime = 0;
    }
  }, Math.max(0, localAt - Date.now()));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if (mode === "player") {
  renderPlayer();
} else {
  try {
    state = await fetch("/api/state").then((response) => response.json());
  } catch {}
  renderController();
}
