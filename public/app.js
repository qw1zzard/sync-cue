import {
  calculatePlayInvocationAt,
  decideDriftCorrection,
  estimateStartLatencyMs,
  expectedCurrentTime
} from "/playback-timing.js";

const app = document.querySelector("#app");
const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "control";
const deviceName = params.get("device") || "";
const protocol = location.protocol === "https:" ? "wss:" : "ws:";

let state = { devices: [], scenes: [], cues: [], playerBaseUrl: "" };
let clockOffset = 0;
let syncSamples = [];
let socket;
let reconnectTimer;
let reconnectDelay = 500;

function connectSocket() {
  clearTimeout(reconnectTimer);
  const connection = new WebSocket(`${protocol}//${location.host}`);
  socket = connection;

  connection.addEventListener("open", () => {
    reconnectDelay = 500;
    syncSamples = [];
    connection.send(JSON.stringify({
      type: "hello",
      role: mode === "player" ? "player" : "control",
      device: deviceName,
      playerState: currentPlaybackState,
      ready: playerReady()
    }));
    syncClock(connection);
    connection.syncTimer = setInterval(() => {
      syncSamples = [];
      syncClock(connection);
    }, 30000);
  });

  connection.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "state") {
      state = message.state;
      mode === "player" ? updatePlayer() : renderController();
    }
    if (message.type === "sync") handleSync(message);
    if (message.type === "command" && mode === "player") runCommand(message);
    if (message.type === "diagnostics" && mode === "control") {
      const device = state.devices.find((item) => item.name === message.device);
      if (device) device.diagnostics = message.diagnostics;
      updateDiagnostics(message.device);
    }
  });

  connection.addEventListener("close", () => {
    clearInterval(connection.syncTimer);
    if (socket !== connection) return;
    if (mode === "control") renderController();
    else setPlayerStatus("Переподключение");
    reconnectTimer = setTimeout(connectSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  });
}

function sendSocket(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function syncClock(connection, iteration = 0) {
  if (iteration >= 7 || socket !== connection || connection.readyState !== WebSocket.OPEN) return;
  const id = crypto.randomUUID();
  connection.send(JSON.stringify({ type: "sync", id, clientSentAt: Date.now() }));
  setTimeout(() => syncClock(connection, iteration + 1), 140);
}

function handleSync(message) {
  const receivedAt = Date.now();
  const rtt = receivedAt - message.clientSentAt;
  const offset = message.serverTime - (message.clientSentAt + rtt / 2);
  syncSamples.push({
    rtt,
    offset
  });
  const best = [...syncSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
  clockOffset = Math.round(best.reduce((sum, sample) => sum + sample.offset, 0) / best.length);
  if (mode === "player") sendSocket({ type: "telemetry", kind: "clock", rttMs: rtt, offsetMs: offset });
}

function renderController() {
  const helpOpen = app.querySelector(".interface-help")?.open;
  const participants = state.devices.filter((device) => device.media);
  const canPlay = participants.length > 0 && participants.every((device) => device.ready);
  const connected = socket?.readyState === WebSocket.OPEN;
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
      <details class="interface-help" ${helpOpen ? "open" : ""}>
        <summary>Как пользоваться</summary>
        <div class="help-grid">
          <div><strong>QR</strong><span>Откройте плеер устройства и нажмите «Подготовить».</span></div>
          <div><strong>Старт</strong><span>Одновременно запускает все устройства со статусом «Готов».</span></div>
          <div><strong>Пауза</strong><span>Останавливает воспроизведение на всех устройствах.</span></div>
          <div><strong>Сброс</strong><span>Ставит все ролики на начало.</span></div>
          <div><strong>Поправка</strong><span>Минус запускает устройство раньше, плюс — позже.</span></div>
          <div><strong>Сцена</strong><span>Сохраняет выбранные видео и поправки устройств.</span></div>
          <div><strong>Cue</strong><span>Запускает подготовленную последовательность команд.</span></div>
        </div>
      </details>
      <div class="device-list">
        ${state.devices.map(deviceCard).join("")}
      </div>
      <form class="add-device">
        <input name="name" maxlength="40" placeholder="Название устройства" required>
        <button>Добавить</button>
      </form>
      <section class="automation">
        <div class="automation-section">
          <div class="section-head">
            <h2>Сцены</h2>
          </div>
          <form class="scene-form compact-form">
            <input name="name" maxlength="40" placeholder="Название сцены" required>
            <button>Сохранить</button>
          </form>
          <div class="scene-list">
            ${(state.scenes || []).map(sceneRow).join("") || '<span class="empty-state">Нет сохранённых сцен</span>'}
          </div>
        </div>
        <div class="automation-section">
          <div class="section-head">
            <h2>Cue-лист</h2>
            <div class="cue-controls">
              <button class="cue-next" ${(state.cues || []).length ? "" : "disabled"}>Следующий</button>
              <button class="cue-reset" title="Вернуться к первому cue" aria-label="Вернуться к первому cue">↺</button>
            </div>
          </div>
          <form class="cue-form compact-form">
            <select name="action">
              <option value="play">Старт</option>
              <option value="pause">Пауза</option>
              <option value="reset">Сброс</option>
            </select>
            <input name="delayMs" type="number" min="0" max="3600000" step="100" value="0" aria-label="Задержка cue">
            <span>мс</span>
            <button>Добавить</button>
          </form>
          <div class="cue-list">
            ${(state.cues || []).map(cueRow).join("") || '<span class="empty-state">Cue-лист пуст</span>'}
          </div>
        </div>
      </section>
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
  app.querySelector(".scene-form").onsubmit = saveScene;
  app.querySelectorAll(".scene-apply").forEach((button) => {
    button.onclick = () => applyScene(button.dataset.scene);
  });
  app.querySelectorAll(".scene-delete").forEach((button) => {
    button.onclick = () => deleteScene(button.dataset.scene);
  });
  app.querySelector(".cue-form").onsubmit = addCue;
  app.querySelector(".cue-next").onclick = runNextCue;
  app.querySelector(".cue-reset").onclick = resetCues;
  app.querySelectorAll(".cue-delete").forEach((button) => {
    button.onclick = () => deleteCue(button.dataset.cue);
  });
  app.querySelectorAll(".cue-move").forEach((button) => {
    button.onclick = () => moveCue(button.dataset.cue, Number(button.dataset.index));
  });
}

function sceneRow(scene) {
  return `
    <div class="scene-row">
      <button class="scene-apply" data-scene="${escapeHtml(scene.name)}">${escapeHtml(scene.name)}</button>
      <button class="icon-button scene-delete" data-scene="${escapeHtml(scene.name)}"
        title="Удалить сцену" aria-label="Удалить сцену">×</button>
    </div>
  `;
}

function cueRow(cue, index) {
  const active = cue.id === state.cueCursorId;
  return `
    <div class="cue-row ${active ? "active" : ""}">
      <span class="cue-index">${index + 1}</span>
      <span class="cue-name">${cueActionLabel(cue.action)}</span>
      <span class="cue-delay">${cue.delayMs ? `+${cue.delayMs} мс` : "без задержки"}</span>
      <button class="icon-button cue-move" data-cue="${cue.id}" data-index="${index - 1}"
        title="Переместить выше" aria-label="Переместить выше" ${index ? "" : "disabled"}>↑</button>
      <button class="icon-button cue-move" data-cue="${cue.id}" data-index="${index + 1}"
        title="Переместить ниже" aria-label="Переместить ниже"
        ${index < state.cues.length - 1 ? "" : "disabled"}>↓</button>
      <button class="icon-button cue-delete" data-cue="${cue.id}"
        title="Удалить cue" aria-label="Удалить cue">×</button>
    </div>
  `;
}

function cueActionLabel(action) {
  return { play: "Старт", pause: "Пауза", reset: "Сброс" }[action] || action;
}

function deviceCard(device) {
  const status = deviceStatus(device);
  return `
    <article class="device">
      <div class="device-head">
        <h2>${escapeHtml(device.name)}</h2>
        <span class="status ${status[1]}">${status[0]}</span>
      </div>
      <div class="device-body">
        <input class="file" data-device="${escapeHtml(device.name)}" type="file" accept="video/*">
        <span class="media-name">${device.media ? device.media.split("/").pop() : "Нет видео"}</span>
        <span class="diagnostics" data-device="${escapeHtml(device.name)}"
          data-status="${device.diagnostics?.status || ""}">${diagnosticsText(device.diagnostics)}</span>
      </div>
      <div class="device-foot">
        <label class="calibration-wrap" title="Отрицательное значение запускает раньше, положительное — позже">
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

function diagnosticsText(diagnostics) {
  const metrics = diagnostics?.metrics;
  if (!metrics) return "Диагностика: нет данных";
  const values = [];
  if (metrics.rttMs !== null) values.push(`RTT ${metrics.rttMs} мс`);
  if (metrics.driftMs !== null) values.push(`drift ${metrics.driftMs > 0 ? "+" : ""}${metrics.driftMs} мс`);
  if (metrics.bufferedSeconds !== null) values.push(`буфер ${metrics.bufferedSeconds} с`);
  return values.length ? values.join(" · ") : "Диагностика: нет данных";
}

function updateDiagnostics(deviceName) {
  const device = state.devices.find((item) => item.name === deviceName);
  const element = [...app.querySelectorAll(".diagnostics")]
    .find((item) => item.dataset.device === deviceName);
  if (!device || !element) return;
  element.textContent = diagnosticsText(device.diagnostics);
  element.dataset.status = device.diagnostics?.status || "";
}

function deviceStatus(device) {
  if (!device.connected) return ["Не в сети", ""];
  if (!device.media) return ["Нет видео", ""];
  if (device.playbackState === "error") return ["Ошибка видео", "error"];
  if (device.playbackState === "loading") return ["Загрузка", "loading"];
  if (device.playbackState === "loaded") return ["Не готов", "loaded"];
  if (device.playbackState === "playing") return ["Играет", "playing"];
  if (device.playbackState === "paused") return ["Пауза", "ready"];
  return device.ready ? ["Готов", "ready"] : ["Не готов", "loaded"];
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

async function saveScene(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const response = await fetch("/api/scenes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: new FormData(form).get("name") })
  });
  if (response.ok) form.reset();
  else alert("Не удалось сохранить сцену");
}

async function applyScene(scene) {
  const response = await fetch(`/api/scenes/${encodeURIComponent(scene)}/apply`, { method: "POST" });
  if (!response.ok) alert("Не удалось применить сцену");
}

async function deleteScene(scene) {
  await fetch(`/api/scenes/${encodeURIComponent(scene)}`, { method: "DELETE" });
}

async function addCue(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const response = await fetch("/api/cues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: data.get("action"),
      delayMs: Number(data.get("delayMs"))
    })
  });
  if (!response.ok) alert("Не удалось добавить cue");
}

async function moveCue(cue, index) {
  await fetch(`/api/cues/${encodeURIComponent(cue)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index })
  });
}

async function deleteCue(cue) {
  await fetch(`/api/cues/${encodeURIComponent(cue)}`, { method: "DELETE" });
}

async function runNextCue() {
  const response = await fetch("/api/cues/next", { method: "POST" });
  if (response.status === 409) alert("Конец cue-листа");
}

async function resetCues() {
  await fetch("/api/cues/reset", { method: "POST" });
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
let wakeLock;
let currentPlaybackState = "loading";
let timelineStartAt;
let driftTimer;
let revealTimer;
let playRequestedAt;
let startLatencySamples = loadStartLatencySamples();
let pendingCommandId;
const commandResults = new Map();
let buffering = false;
let hardCorrectionPending = false;

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
  video.addEventListener("loadstart", () => reportPlayerState("loading"));
  video.addEventListener("canplay", () => {
    buffering = false;
    reportPlayerState(armed ? "ready" : "loaded");
  });
  video.addEventListener("playing", () => {
    if (playRequestedAt !== undefined) {
      rememberStartLatency(performance.now() - playRequestedAt);
      playRequestedAt = undefined;
    }
    armed = true;
    app.querySelector(".player").classList.add("armed");
    reportPlayerState("playing");
    runDriftCorrection();
  });
  video.addEventListener("pause", () => {
    if (currentMedia) reportPlayerState(armed ? "paused" : "loaded");
  });
  video.addEventListener("waiting", () => {
    buffering = true;
    video.playbackRate = 1;
    reportPlayerState("loading");
  });
  video.addEventListener("ended", () => {
    stopDriftCorrection();
    reportPlayerState(armed ? "ended" : "loaded");
  });
  video.addEventListener("error", () => reportPlayerState("error"));
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
    armed = false;
    currentPlaybackState = "loading";
    app.querySelector(".player").classList.remove("armed");
    video.src = currentMedia;
    video.load();
    reportPlayerState("loading");
  }
  status.textContent = device.media ? playerStatusText(currentPlaybackState) : "Ожидание видео";
}

async function armPlayer() {
  if (!currentMedia) return;
  try {
    video.muted = true;
    playRequestedAt = performance.now();
    const playRequest = video.play();
    const fullscreenRequest = enterFullscreen();
    await playRequest;
    await fullscreenRequest;
    video.pause();
    video.currentTime = 0;
    video.muted = false;
    armed = true;
    app.querySelector(".player").classList.add("armed");
    await keepAwake();
    reportPlayerState("ready");
  } catch {
    setPlayerStatus("Нажмите ещё раз");
  }
}

function loadStartLatencySamples() {
  try {
    const saved = JSON.parse(localStorage.getItem(`sync-cue-latency:${deviceName}`));
    return Array.isArray(saved) ? saved.filter(Number.isFinite).slice(-7) : [];
  } catch {
    return [];
  }
}

function rememberStartLatency(latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 2000) return;
  startLatencySamples = [...startLatencySamples.slice(-6), Math.round(latencyMs)];
  sendSocket({ type: "telemetry", kind: "startup", lagMs: latencyMs });
  try {
    localStorage.setItem(`sync-cue-latency:${deviceName}`, JSON.stringify(startLatencySamples));
  } catch {}
}

async function keepAwake() {
  if (!armed || document.visibilityState !== "visible" || wakeLock) return;
  wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
  wakeLock?.addEventListener("release", () => {
    wakeLock = null;
  }, { once: true });
}

function playerReady() {
  return Boolean(
    armed
    && currentMedia
    && video
    && !video.error
    && currentPlaybackState !== "loading"
    && currentPlaybackState !== "error"
  );
}

function reportPlayerState(nextState) {
  currentPlaybackState = nextState;
  setPlayerStatus(playerStatusText(nextState));
  sendSocket({
    type: "player-state",
    state: nextState,
    ready: playerReady()
  });
}

function setPlayerStatus(text) {
  const status = app.querySelector(".player-status");
  if (status) status.textContent = text;
}

function playerStatusText(playbackState) {
  return {
    loading: "Загрузка видео",
    loaded: "Видео загружено",
    ready: "Готов",
    playing: "Играет",
    paused: "Пауза",
    ended: "Готов",
    error: "Ошибка видео"
  }[playbackState] || "Подключение";
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

function runCommand({ id, command, at }) {
  const previous = commandResults.get(id);
  if (id && previous) {
    sendCommandAck(id, previous);
    return;
  }
  if (pendingCommandId && pendingCommandId !== id) {
    finishCommand(pendingCommandId, false, "superseded");
  }
  clearTimeout(commandTimer);
  clearTimeout(revealTimer);
  if (!video || !armed) {
    finishCommand(id, false, "not_ready");
    return;
  }
  pendingCommandId = id;
  if (id) {
    commandResults.set(id, { phase: "accepted", ok: true });
    sendCommandAck(id, commandResults.get(id));
  }
  const device = state.devices.find((item) => item.name === deviceName);
  const calibration = device?.calibrationMs || 0;
  const localAt = at - clockOffset + calibration;
  const startLatencyMs = Math.min(1000, estimateStartLatencyMs(startLatencySamples, {
    fallbackMs: 80,
    maxMs: 2000
  }));

  if (command === "play") {
    timelineStartAt = at + calibration;
    stopDriftCorrection();
    video.playbackRate = 1;
    if (video.currentTime > 0.03) video.currentTime = 0;
    const playAt = calculatePlayInvocationAt({
      startAt: at,
      clockOffsetMs: clockOffset,
      calibrationMs: calibration,
      startLatencyMs
    });
    commandTimer = setTimeout(() => {
      playRequestedAt = performance.now();
      video.muted = true;
      app.querySelector(".player").classList.add("prestarting");
      video.play().catch(() => {
        clearTimeout(revealTimer);
        video.muted = false;
        app.querySelector(".player").classList.remove("prestarting");
        finishCommand(id, false, "play_failed");
      });
    }, Math.max(0, playAt - Date.now()));
    revealTimer = setTimeout(() => {
      if (video.currentTime > 0.03) video.currentTime = 0;
      video.muted = false;
      app.querySelector(".player").classList.remove("prestarting");
      startDriftCorrection();
      finishCommand(id);
    }, Math.max(0, localAt - Date.now()));
    return;
  }

  commandTimer = setTimeout(async () => {
    if (command === "pause") {
      stopDriftCorrection();
      video.playbackRate = 1;
      video.pause();
      finishCommand(id);
    }
    if (command === "reset") {
      stopDriftCorrection();
      timelineStartAt = undefined;
      video.playbackRate = 1;
      video.pause();
      video.currentTime = 0;
      finishCommand(id);
    }
  }, Math.max(0, localAt - Date.now()));
}

function finishCommand(id, ok = true, error) {
  if (!id) return;
  if (commandResults.get(id)?.phase === "executed") return;
  const result = { phase: "executed", ok, error };
  commandResults.set(id, result);
  while (commandResults.size > 100) {
    commandResults.delete(commandResults.keys().next().value);
  }
  if (pendingCommandId === id) pendingCommandId = undefined;
  sendCommandAck(id, result);
}

function sendCommandAck(id, result) {
  sendSocket({
    type: "command-ack",
    id,
    phase: result.phase,
    ok: result.ok,
    error: result.error
  });
}

function startDriftCorrection() {
  stopDriftCorrection();
  hardCorrectionPending = true;
  runDriftCorrection();
  driftTimer = setInterval(runDriftCorrection, 1000);
}

function stopDriftCorrection() {
  clearInterval(driftTimer);
  driftTimer = undefined;
  hardCorrectionPending = false;
}

function runDriftCorrection() {
  if (correctDrift(hardCorrectionPending)) hardCorrectionPending = false;
}

function correctDrift(allowSeek = false) {
  if (
    !timelineStartAt
    || !video
    || video.paused
    || video.seeking
    || buffering
    || video.readyState < 3
  ) return false;
  const expected = expectedCurrentTime({
    now: Date.now(),
    startAt: timelineStartAt,
    clockOffsetMs: clockOffset,
    durationSeconds: video.duration
  });
  const correction = decideDriftCorrection({
    actualCurrentTime: video.currentTime,
    expectedCurrentTime: expected,
    rateThresholdMs: 80,
    seekThresholdMs: allowSeek ? 400 : Number.MAX_SAFE_INTEGER,
    correctionWindowMs: 6000,
    minRate: 0.97,
    maxRate: 1.03
  });
  sendSocket({
    type: "telemetry",
    kind: "playback",
    driftMs: correction.driftMs,
    bufferedSeconds: bufferedSeconds(),
    readyState: video.readyState
  });
  video.playbackRate = correction.playbackRate;
  if (correction.action === "seek") video.currentTime = correction.seekTo;
  return true;
}

function bufferedSeconds() {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= video.currentTime && video.buffered.end(index) >= video.currentTime) {
      return Math.max(0, video.buffered.end(index) - video.currentTime);
    }
  }
  return 0;
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

connectSocket();
document.addEventListener("visibilitychange", keepAwake);
