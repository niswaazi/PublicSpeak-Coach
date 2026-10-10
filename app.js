const STORAGE_KEY = "publicspeak-sessions-v2";
const FEATURE_INFO = {
  gaze: {
    title: "Kontak mata",
    kicker: "01 · FOKUS",
    image: "/assets/feature-eye.svg",
    description: "Kamera memperkirakan seberapa sering pandanganmu mengarah ke lensa. Gunakan sebagai panduan ringan, bukan penilaian.",
  },
  posture: {
    title: "Bahasa tubuh",
    kicker: "02 · POSTUR",
    image: "/assets/feature-posture.svg",
    description: "Analisis posisi bahu dan badan membantu kamu menemukan postur yang terasa tegap dan nyaman.",
  },
  gesture: {
    title: "Gestur tangan",
    kicker: "03 · GERAK",
    image: "/assets/feature-gesture.svg",
    description: "Lihat kapan tanganmu bergerak, lalu gunakan gestur alami untuk memberi penekanan pada ide.",
  },
  expression: {
    title: "Ekspresi wajah",
    kicker: "04 · EKSPRESI",
    image: "/assets/feature-expression.svg",
    description: "Indikator senyum memberi gambaran sederhana tentang ekspresi. Wajah netral juga wajar saat presentasi.",
  },
};
const pages = [...document.querySelectorAll(".page")];
const navItems = [...document.querySelectorAll(".nav-item")];
const pageNames = { beranda: "Beranda", latihan: "Latihan baru", laporan: "Laporan saya" };
const toast = document.querySelector("#toast");
const setupForm = document.querySelector("#setup-form");
const cameraPage = document.querySelector("#page-kamera");
const cameraVideo = document.querySelector("#camera-video");
const trackingCanvas = document.querySelector("#tracking-canvas");
const trackingContext = trackingCanvas.getContext("2d");
const videoPlaceholder = document.querySelector("#video-placeholder");
const cameraToggle = document.querySelector("#camera-toggle");
const recordToggle = document.querySelector("#record-toggle");
const finishSession = document.querySelector("#finish-session");
const samples = { gaze: [], posture: [], gesture: [], expression: [] };
const frameCanvas = document.createElement("canvas");
const frameContext = frameCanvas.getContext("2d", { alpha: false });
let stream = null;
let timerInterval = null;
let animationFrame = 0;
let lastInference = 0;
let lastHandPosition = null;
let remainingSeconds = 180;
let selectedDuration = 3;
let sessionStartedAt = 0;
let currentTopic = "";
let sessionStarted = false;
let toastTimeout;
let backendAvailable = false;
let analysisRequestActive = false;
let backendFailureReported = false;
let activeAnalysisController = null;

function showToast(message, duration = 4500) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("show"), duration);
}

document.querySelectorAll("[data-feature]").forEach((card) => {
  card.addEventListener("click", () => {
    const feature = FEATURE_INFO[card.dataset.feature];
    if (!feature) return;
    document.querySelector("#feature-dialog-kicker").textContent = feature.kicker;
    document.querySelector("#feature-dialog-art").src = feature.image;
    document.querySelector("#feature-dialog-title").textContent = feature.title;
    document.querySelector("#feature-dialog-copy").textContent = feature.description;
    document.querySelector("#feature-dialog").showModal();
  });
});

const featureDialog = document.querySelector("#feature-dialog");
document.querySelector("#feature-dialog-close").addEventListener("click", () => featureDialog.close());
featureDialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    featureDialog.close();
  }
});
featureDialog.addEventListener("click", (event) => {
  if (event.target === featureDialog) featureDialog.close();
});
document.querySelector("#feature-dialog-cta").addEventListener("click", () => {
  featureDialog.close();
  navigate("latihan");
});

document.querySelectorAll("[data-topic]").forEach((suggestion) => {
  suggestion.addEventListener("click", () => {
    const topicInput = document.querySelector("#topic");
    topicInput.value = suggestion.dataset.topic;
    topicInput.dispatchEvent(new Event("input", { bubbles: true }));
    topicInput.focus();
  });
});

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} dtk`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} m ${remainder} dtk` : `${minutes} menit`;
}

function readSessions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((item) => item && typeof item.topic === "string") : [];
  } catch (error) {
    showToast("Riwayat latihan tidak dapat dibaca dari penyimpanan browser.");
    return [];
  }
}

function writeSession(session) {
  const sessions = [...readSessions(), session].slice(-30);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (error) {
    showToast("Sesi selesai, tetapi riwayat tidak dapat disimpan di browser.");
  }
  renderHistory();
}

function updateMetric(name, score, state) {
  document.querySelector(`#live-${name}`).textContent = score === null ? "—" : `${Math.round(score)}%`;
  document.querySelector(`#${name}-bar`).style.width = score === null ? "0%" : `${Math.round(score)}%`;
  document.querySelector(`#${name}-state`).textContent = state;
}

function average(values) {
  return values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : null;
}

function currentMetrics() {
  return Object.fromEntries(Object.keys(samples).map((key) => [key, average(samples[key])]));
}

function updateLiveMetrics() {
  const metrics = currentMetrics();
  const faceDetected = metrics.gaze !== null;
  const poseDetected = metrics.posture !== null;
  const handDetected = metrics.gesture !== null;
  const faceState = faceDetected ? (metrics.gaze >= 70 ? "Menghadap kamera" : "Arahkan pandangan ke kamera") : "Wajah belum terdeteksi";
  const postureState = poseDetected ? (metrics.posture >= 70 ? "Postur stabil" : "Coba tegakkan badan") : "Berdiri dalam bingkai";
  const gestureState = handDetected ? (metrics.gesture >= 45 ? "Gerakan terdeteksi" : "Gerakkan tangan dengan natural") : "Tangan belum terdeteksi";
  const expressionState = metrics.expression === null ? "Wajah belum terdeteksi" : metrics.expression >= 35 ? "Senyum terdeteksi" : "Ekspresi rileks";
  updateMetric("gaze", metrics.gaze, faceState);
  updateMetric("posture", metrics.posture, postureState);
  updateMetric("gesture", metrics.gesture, gestureState);
  updateMetric("expression", metrics.expression, expressionState);
}

function resetSamples() {
  Object.values(samples).forEach((values) => { values.length = 0; });
  lastHandPosition = null;
  for (const key of Object.keys(samples)) updateMetric(key, null, "Menunggu kamera");
}

function renderHistory() {
  const sessions = readSessions();
  const latest = sessions[sessions.length - 1];
  if (!latest) return;
  showReport(latest);
}

function showReport(session) {
  const keys = ["gaze", "posture", "gesture", "expression"];
  const titles = { gaze: "Kontak mata", posture: "Postur tubuh", gesture: "Gestur tangan", expression: "Ekspresi wajah" };
  document.querySelector("#report-topic").textContent = session.topic;
  document.querySelector("#report-date").textContent = `${new Date(session.createdAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })} · ${formatDuration(session.duration)}`;
  document.querySelector("#report-status-title").textContent = session.score === null ? "Latihan selesai · tanpa analisis kamera" : "Analisis kamera selesai";
  document.querySelector("#report-status-copy").textContent = session.score === null ? "Nyalakan kamera saat latihan berikutnya untuk melihat metrik." : "Frame dianalisis lokal dan tidak disimpan atau diunggah.";
  document.querySelector("#report-status-tag").textContent = session.score === null ? "TANPA KAMERA" : "ANALISIS AI";
  document.querySelector("#report-score").textContent = session.score === null ? "—" : `${session.score}%`;
  document.querySelector("#report-score-caption").textContent = session.score === null ? "Belum ada skor" : "Rata-rata area terukur";
  document.querySelector("#report-progress").style.width = session.score === null ? "0%" : `${session.score}%`;
  document.querySelector("#report-summary-caption").textContent = session.score === null ? "Gunakan kamera agar metrik dapat diukur." : "Skor ringkasan dari metrik kamera terdeteksi.";

  for (const key of keys) {
    const score = session.metrics?.[key] ?? null;
    document.querySelector(`#report-${key}`).textContent = score === null ? "—" : `${score}%`;
    document.querySelector(`#report-${key}-bar`).style.width = score === null ? "0%" : `${score}%`;
  }
  const available = keys.filter((key) => session.metrics?.[key] !== null && session.metrics?.[key] !== undefined);
  const weakest = available.sort((left, right) => session.metrics[left] - session.metrics[right])[0];
  document.querySelector("#feedback-title").textContent = weakest ? `${titles[weakest]} untuk dilatih` : "Mulai dengan kamera";
  document.querySelector("#feedback-copy").textContent = weakest
    ? coachingTip(weakest, session.metrics[weakest])
    : "Laporan tanpa kamera hanya mencatat topik dan durasi latihan.";
}

function coachingTip(key, score) {
  const advice = {
    gaze: score >= 70 ? "Pandanganmu sering mengarah ke kamera. Pertahankan kontak mata yang nyaman." : "Coba lihat lensa kamera saat menyampaikan poin utama.",
    posture: score >= 70 ? "Postur terlihat cukup stabil. Pertahankan posisi yang terasa nyaman." : "Atur posisi tubuh di tengah bingkai dan rilekskan bahu.",
    gesture: score >= 45 ? "Gerakan tangan terdeteksi. Gunakan gestur untuk menekankan ide penting." : "Coba gerakkan tangan dengan natural saat menjelaskan poin.",
    expression: score >= 35 ? "Senyum terdeteksi. Gunakan ekspresi yang terasa alami." : "Ekspresi netral juga wajar; ini hanya indikator senyum.",
  };
  return advice[key];
}

function resetPractice() {
  window.clearInterval(timerInterval);
  timerInterval = null;
  sessionStarted = false;
  stopCamera();
  setupForm.reset();
  setupForm.classList.remove("hidden");
  document.querySelector(".practice-aside").classList.remove("hidden");
  remainingSeconds = 180;
  selectedDuration = 3;
  sessionStartedAt = 0;
  currentTopic = "";
  document.querySelector("#timer").textContent = formatTime(remainingSeconds);
  document.querySelector("#timer-status").textContent = "Siap saat kamu siap";
  document.querySelector("#analysis-status").textContent = "Aktifkan kamera untuk mulai analisis";
  document.querySelector("#analysis-badge").innerHTML = "<span></span> KAMERA MATI";
  document.querySelector("#analysis-live-dot").classList.remove("active");
  resetSamples();
  recordToggle.classList.remove("hidden");
  finishSession.classList.add("hidden");
}

function navigate(pageName, preservePractice = false) {
  if (sessionStarted && pageName !== "kamera") {
    showToast("Latihan sedang berlangsung. Selesaikan sesi sebelum berpindah halaman.");
    return;
  }
  if (pageName === "latihan" && !preservePractice) resetPractice();
  else if (pageName !== "kamera" && (stream || sessionStarted)) {
    window.clearInterval(timerInterval);
    timerInterval = null;
    sessionStarted = false;
    stopCamera();
    showToast("Kamera dimatikan saat meninggalkan latihan.");
  }
  pages.forEach((page) => page.classList.toggle("active", page.id === `page-${pageName}`));
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.page === pageName));
  document.querySelector("#page-label").textContent = pageNames[pageName] || "Latihan langsung";
  document.body.classList.toggle("camera-mode", pageName === "kamera");
  document.body.classList.toggle("landing-mode", pageName === "beranda");
  const heading = document.querySelector(`#page-${pageName} h1`);
  if (heading) {
    heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.page));
});

document.body.classList.add("landing-mode");

document.querySelector("#backend-indicator").addEventListener("click", async () => {
  const health = await refreshAnalysisBackend();
  if (health?.ready) {
    showToast(health.status === "degraded"
      ? "Sebagian model siap. Fitur analisis yang tersedia tetap dapat digunakan."
      : "Analisis kamera lokal siap. Frame diproses tanpa disimpan.");
  } else if (health) {
    showToast(health.status === "loading"
      ? "Model AI sedang disiapkan. Tunggu sebentar sebelum menyalakan kamera."
      : "Model AI belum siap. Pastikan internet tersedia saat pertama kali menjalankan backend.");
  } else {
    showToast("Backend belum aktif. Jalankan: .venv\\Scripts\\python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000");
  }
});

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

async function checkAnalysisBackend() {
  let response;
  try {
    response = await fetch("/api/health", { cache: "no-store" });
  } catch {
    throw new Error("Backend belum aktif. Jalankan server FastAPI lokal terlebih dahulu.");
  }
  if (!response.ok) throw new Error("Endpoint backend lokal tidak ditemukan. Buka aplikasi melalui server FastAPI.");
  const health = await response.json();
  backendAvailable = Boolean(health.ready);
  const indicator = document.querySelector("#backend-indicator");
  const label = document.querySelector("#backend-label");
  indicator.dataset.status = backendAvailable ? "ready" : health.status === "loading" ? "loading" : "offline";
  label.textContent = backendAvailable
    ? health.status === "degraded" ? "AI lokal · sebagian siap" : "AI lokal siap"
    : health.status === "loading" ? "Menyiapkan AI lokal…" : "AI lokal perlu model";
  indicator.title = backendAvailable
    ? `${health.available.length} model lokal siap. Klik untuk memeriksa status.`
    : "Klik untuk memeriksa layanan analisis lokal.";
  return health;
}

async function refreshAnalysisBackend() {
  try {
    return await checkAnalysisBackend();
  } catch (error) {
    backendAvailable = false;
    document.querySelector("#backend-indicator").dataset.status = "offline";
    document.querySelector("#backend-label").textContent = "AI lokal offline";
    document.querySelector("#backend-indicator").title = error.message;
    return null;
  }
}

function stopCamera() {
  activeAnalysisController?.abort();
  activeAnalysisController = null;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  window.cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  cameraVideo.srcObject = null;
  cameraVideo.classList.add("hidden");
  trackingCanvas.classList.add("hidden");
  videoPlaceholder.classList.remove("hidden");
  cameraToggle.textContent = "Aktifkan kamera";
  analysisRequestActive = false;
  document.querySelector("#analysis-badge").innerHTML = "<span></span> KAMERA MATI";
  document.querySelector("#analysis-live-dot").classList.remove("active");
}

cameraToggle.addEventListener("click", async () => {
  if (stream) {
    stopCamera();
    document.querySelector("#analysis-status").textContent = "Kamera dimatikan";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    showToast("Kamera perlu HTTPS atau localhost. Jalankan web di alamat lokal yang aman.");
    return;
  }
  cameraToggle.disabled = true;
  cameraToggle.textContent = "Memeriksa analisis lokal…";
  try {
    const health = await checkAnalysisBackend();
    if (!health.ready) {
      const detail = Object.values(health.errors || {})[0];
      throw new Error(detail
        ? `Model AI lokal belum siap: ${detail}`
        : health.status === "loading"
          ? "Model AI lokal sedang disiapkan. Tunggu sebentar lalu coba lagi."
        : "Backend analisis belum aktif. Jalankan server lokal terlebih dahulu.");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    });
    cameraVideo.srcObject = stream;
    await cameraVideo.play();
    cameraVideo.classList.remove("hidden");
    trackingCanvas.classList.remove("hidden");
    videoPlaceholder.classList.add("hidden");
    cameraToggle.textContent = "Matikan kamera";
    document.querySelector("#analysis-status").textContent = "Memuat model analisis…";
    document.querySelector("#analysis-badge").innerHTML = "<span></span> AI LOKAL";
    document.querySelector("#analysis-live-dot").classList.add("active");
    if (!stream) return;
    document.querySelector("#analysis-status").textContent = sessionStarted ? "Analisis berlangsung di server lokal" : "AI siap — mulai latihan untuk mengukur";
    document.querySelector("#analysis-badge").innerHTML = `<span></span> ${sessionStarted ? "AI AKTIF" : "AI SIAP"}`;
    lastInference = 0;
    backendFailureReported = false;
    animationFrame = window.requestAnimationFrame(analyzeFrame);
  } catch (error) {
    stopCamera();
    document.querySelector("#analysis-status").textContent = "Analisis belum aktif";
    showToast(error.name === "NotAllowedError"
      ? "Izin kamera ditolak. Aktifkan akses kamera di pengaturan browser."
      : error.name === "NotFoundError"
        ? "Kamera tidak ditemukan pada perangkat ini."
        : error.message || "Kamera atau model AI gagal dimuat. Periksa server lokal.");
  } finally {
    cameraToggle.disabled = false;
    if (!stream) cameraToggle.textContent = "Aktifkan kamera";
  }
});

function analyzeFrame(timestamp) {
  if (!stream || cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !cameraVideo.videoWidth) {
    animationFrame = window.requestAnimationFrame(analyzeFrame);
    return;
  }
  if (backendAvailable && !analysisRequestActive && timestamp - lastInference >= 500) {
    lastInference = timestamp;
    void sendFrameToLocalAnalysis();
  }
  if (stream) animationFrame = window.requestAnimationFrame(analyzeFrame);
}

async function sendFrameToLocalAnalysis() {
  if (analysisRequestActive || !stream || !backendAvailable) return;
  analysisRequestActive = true;
  const controller = new AbortController();
  activeAnalysisController = controller;
  try {
    const width = Math.min(cameraVideo.videoWidth, 640);
    const height = Math.round(cameraVideo.videoHeight * (width / cameraVideo.videoWidth));
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameContext.drawImage(cameraVideo, 0, 0, width, height);
    const frame = await new Promise((resolve) => frameCanvas.toBlob(resolve, "image/jpeg", 0.75));
    if (!frame) throw new Error("Frame kamera tidak dapat disiapkan.");

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: frame,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.detail || `Analisis lokal merespons ${response.status}.`);
    }
    const result = await response.json();
    if (!stream || controller.signal.aborted) return;
    const metrics = result.metrics;
    if (sessionStarted) {
      for (const key of ["gaze", "posture", "expression"]) {
        if (Number.isFinite(metrics[key])) samples[key].push(metrics[key]);
      }
      const gesture = estimateGestures(result.hands);
      if (gesture !== null) samples.gesture.push(gesture);
    }
    drawTracking(result);
    updateLiveMetrics();
    document.querySelector("#analysis-status").textContent = sessionStarted
      ? "Analisis berlangsung di server lokal"
      : "AI siap — mulai latihan untuk mengukur";
  } catch (error) {
    if (error.name === "AbortError") return;
    backendAvailable = false;
    document.querySelector("#analysis-status").textContent = "Analisis lokal terputus";
    document.querySelector("#analysis-badge").innerHTML = "<span></span> AI OFFLINE";
    document.querySelector("#backend-indicator").dataset.status = "offline";
    document.querySelector("#backend-label").textContent = "AI lokal offline";
    if (!backendFailureReported) {
      showToast(`Analisis kamera berhenti: ${error.message}`);
      backendFailureReported = true;
    }
  } finally {
    analysisRequestActive = false;
    if (activeAnalysisController === controller) activeAnalysisController = null;
  }
}

function estimateGestures(hands) {
  const wrists = (hands || []).map((hand) => hand[0]).filter(Boolean);
  if (!wrists.length) {
    lastHandPosition = null;
    return null;
  }
  const center = wrists.reduce(
    (position, wrist) => ({ x: position.x + wrist.x / wrists.length, y: position.y + wrist.y / wrists.length }),
    { x: 0, y: 0 },
  );
  const motion = lastHandPosition ? Math.hypot(center.x - lastHandPosition.x, center.y - lastHandPosition.y) : 0;
  lastHandPosition = center;
  return Math.round(Math.min(100, 20 + motion * 1600));
}

function drawTracking(result) {
  const width = result.width || cameraVideo.videoWidth;
  const height = result.height || cameraVideo.videoHeight;
  if (trackingCanvas.width !== width || trackingCanvas.height !== height) {
    trackingCanvas.width = width;
    trackingCanvas.height = height;
  }
  const canvasWidth = trackingCanvas.width;
  const canvasHeight = trackingCanvas.height;
  trackingContext.clearRect(0, 0, canvasWidth, canvasHeight);
  trackingContext.lineWidth = Math.max(canvasWidth / 320, 2);
  trackingContext.strokeStyle = "#a6ff65";
  trackingContext.fillStyle = "#a6ff65";
  const poseLines = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
  const pose = result.posePoints || {};
  for (const [start, end] of poseLines) {
      if (!pose[start] || !pose[end]) continue;
      trackingContext.beginPath();
      trackingContext.moveTo(pose[start].x * canvasWidth, pose[start].y * canvasHeight);
      trackingContext.lineTo(pose[end].x * canvasWidth, pose[end].y * canvasHeight);
      trackingContext.stroke();
  }
  const handLines = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [17, 0]];
  for (const hand of result.hands || []) {
    for (const [start, end] of handLines) {
      if (!hand[start] || !hand[end]) continue;
      trackingContext.beginPath();
      trackingContext.moveTo(hand[start].x * canvasWidth, hand[start].y * canvasHeight);
      trackingContext.lineTo(hand[end].x * canvasWidth, hand[end].y * canvasHeight);
      trackingContext.stroke();
    }
    for (const landmark of hand) {
      trackingContext.beginPath();
      trackingContext.arc(landmark.x * canvasWidth, landmark.y * canvasHeight, Math.max(canvasWidth / 240, 3), 0, Math.PI * 2);
      trackingContext.fill();
    }
  }
  if (result.faceBox) {
    const { x, y, width: boxWidth, height: boxHeight } = result.faceBox;
    trackingContext.strokeRect(x * canvasWidth, y * canvasHeight, boxWidth * canvasWidth, boxHeight * canvasHeight);
  }
}

function clearTracking() {
  trackingContext.clearRect(0, 0, trackingCanvas.width, trackingCanvas.height);
}

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(setupForm);
  currentTopic = formData.get("topic").trim();
  selectedDuration = Number(formData.get("duration"));
  if (!currentTopic) {
    const topicInput = document.querySelector("#topic");
    topicInput.setAttribute("aria-invalid", "true");
    document.querySelector("#topic-error").classList.remove("hidden");
    document.querySelector("#topic").focus();
    return;
  }
  document.querySelector("#topic").setAttribute("aria-invalid", "false");
  document.querySelector("#topic-error").classList.add("hidden");
  remainingSeconds = selectedDuration * 60;
  sessionStarted = false;
  resetSamples();
  document.querySelector("#session-topic").textContent = currentTopic;
  document.querySelector("#session-notes").textContent = formData.get("notes").trim() || "Tidak ada catatan. Sampaikan presentasimu dengan gayamu sendiri.";
  document.querySelector("#timer").textContent = formatTime(remainingSeconds);
  document.querySelector("#timer-status").textContent = "Siap mulai";
  document.querySelector("#analysis-status").textContent = stream ? "Analisis kamera siap" : "Aktifkan kamera untuk mulai analisis";
  recordToggle.classList.remove("hidden");
  finishSession.classList.add("hidden");
  navigate("kamera");
});

document.querySelector("#topic").addEventListener("input", () => {
  document.querySelector("#topic").setAttribute("aria-invalid", "false");
  document.querySelector("#topic-error").classList.add("hidden");
});

document.querySelector("#camera-back").addEventListener("click", () => {
  if (sessionStarted) {
    document.querySelector("#abandon-dialog").showModal();
    return;
  }
  returnToSetup();
});

function returnToSetup() {
  window.clearInterval(timerInterval);
  timerInterval = null;
  sessionStarted = false;
  stopCamera();
  navigate("latihan", true);
}

const abandonDialog = document.querySelector("#abandon-dialog");
document.querySelector("#keep-session").addEventListener("click", () => abandonDialog.close());
document.querySelector("#discard-session").addEventListener("click", () => {
  abandonDialog.close();
  returnToSetup();
});

let teleprompterFontSize = 20;
document.querySelector("#font-smaller").addEventListener("click", () => {
  teleprompterFontSize = Math.max(16, teleprompterFontSize - 2);
  document.querySelector("#session-notes").style.fontSize = `${teleprompterFontSize}px`;
});
document.querySelector("#font-larger").addEventListener("click", () => {
  teleprompterFontSize = Math.min(36, teleprompterFontSize + 2);
  document.querySelector("#session-notes").style.fontSize = `${teleprompterFontSize}px`;
});

const teleprompterContent = document.querySelector("#session-notes");
const teleprompterToggle = document.querySelector("#teleprompter-toggle");
function setTeleprompterOpen(open) {
  teleprompterContent.classList.toggle("hidden", !open);
  teleprompterToggle.setAttribute("aria-expanded", String(open));
  teleprompterToggle.textContent = open ? "Sembunyikan" : "Tampilkan";
}
setTeleprompterOpen(window.matchMedia("(max-width: 760px)").matches ? false : true);
teleprompterToggle.addEventListener("click", () => {
  setTeleprompterOpen(teleprompterContent.classList.contains("hidden"));
});

document.querySelector("#export-sessions").addEventListener("click", () => {
  const exportData = {
    schema: "publicspeak.sessions/v1",
    exportedAt: new Date().toISOString(),
    sessions: readSessions(),
  };
  const download = document.createElement("a");
  download.href = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" }));
  download.download = "publicspeak-sessions.json";
  download.click();
  window.setTimeout(() => URL.revokeObjectURL(download.href), 1000);
});

recordToggle.addEventListener("click", () => {
  sessionStarted = true;
  sessionStartedAt = Date.now();
  resetSamples();
  recordToggle.classList.add("hidden");
  finishSession.classList.remove("hidden");
  document.querySelector("#timer-status").textContent = "Sedang latihan";
  document.querySelector("#analysis-status").textContent = stream ? "Analisis berlangsung" : "Latihan berlangsung tanpa kamera";
  timerInterval = window.setInterval(() => {
    remainingSeconds -= 1;
    document.querySelector("#timer").textContent = formatTime(remainingSeconds);
    if (remainingSeconds <= 0) completeSession();
  }, 1000);
});

function completeSession() {
  if (!sessionStarted) return;
  window.clearInterval(timerInterval);
  timerInterval = null;
  sessionStarted = false;
  const metrics = currentMetrics();
  const available = Object.values(metrics).filter((value) => value !== null);
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - sessionStartedAt) / 1000));
  const session = {
    topic: currentTopic,
    duration: Math.min(selectedDuration * 60, elapsedSeconds),
    score: available.length ? Math.round(available.reduce((sum, value) => sum + value, 0) / available.length) : null,
    metrics,
    createdAt: new Date().toISOString(),
  };
  writeSession(session);
  stopCamera();
  navigate("laporan");
  showToast(session.score === null ? "Latihan tersimpan. Nyalakan kamera untuk mendapat analisis." : "Latihan dan hasil analisis berhasil disimpan.");
}

finishSession.addEventListener("click", completeSession);
window.addEventListener("beforeunload", (event) => {
  if (!sessionStarted) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pagehide", stopCamera);
void refreshAnalysisBackend();
renderHistory();
