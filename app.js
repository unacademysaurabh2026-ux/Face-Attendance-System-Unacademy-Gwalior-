// ============================================================
//  FaceScan Attendance  –  Production-Grade app.js
//  ⬆ Upgraded: multi-angle registration (Front/Left/Right),
//    delete/edit student records, duplicate detection,
//    CSV & PDF export
// ============================================================

// ─── Firebase Setup ──────────────────────────────────────────
// 🔧 REPLACE these values with your own Firebase project config
// Get them from: https://console.firebase.google.com → Project Settings → Your Apps
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

// Firebase SDK modules (loaded via CDN in index.html)
let db = null;   // Firestore instance – set in initFirebase()

async function initFirebase() {
  try {
    const { initializeApp }   = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getFirestore, collection, doc, setDoc, getDocs, deleteDoc, addDoc, query, orderBy, onSnapshot }
      = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);

    // Expose Firestore helpers onto a single namespace so the rest of the
    // file can reach them without extra imports later.
    window._fs = { collection, doc, setDoc, getDocs, deleteDoc, addDoc, query, orderBy, onSnapshot };

    console.log("✅ Firebase connected.");
    return true;
  } catch (err) {
    console.error("❌ Firebase init failed:", err);
    return false;
  }
}

// ─── Firebase: Students ──────────────────────────────────────
async function saveStudentToFirebase(student) {
  if (!db) return;
  try {
    const { doc, setDoc } = window._fs;
    // Descriptors must be stored as plain arrays (Firestore-safe)
    const payload = {
      ...student,
      descriptors: (student.descriptors || []).map(d => Array.from(d)),
      descriptor:  student.descriptor ? Array.from(student.descriptor) : null,
      // Remove binary blob – facePhoto (base64) can be large; keep it but
      // Firestore has a 1 MB per-document limit. If photos cause quota errors,
      // store them in Firebase Storage instead and save the download URL here.
      facePhoto: student.facePhoto || "",
      // angleData photos can also be large – strip them, keep only counts
      angleData: student.angleData
        ? Object.fromEntries(
            Object.entries(student.angleData).map(([k, v]) => [
              k, v ? { count: v.count || 0 } : null,
            ])
          )
        : null,
    };
    await setDoc(doc(db, "students", student.id), payload);
  } catch (err) {
    console.error("saveStudentToFirebase error:", err);
  }
}

async function loadStudentsFromFirebase() {
  if (!db) return [];
  try {
    const { collection, getDocs } = window._fs;
    const snapshot = await getDocs(collection(db, "students"));
    return snapshot.docs.map(d => normalizeStudent(d.data()));
  } catch (err) {
    console.error("loadStudentsFromFirebase error:", err);
    return [];
  }
}

async function deleteStudentFromFirebase(studentId) {
  if (!db) return;
  try {
    const { doc, deleteDoc } = window._fs;
    await deleteDoc(doc(db, "students", studentId));
  } catch (err) {
    console.error("deleteStudentFromFirebase error:", err);
  }
}

// ─── Firebase: Attendance ────────────────────────────────────
async function saveAttendanceToFirebase(record) {
  if (!db) return;
  try {
    const { doc, setDoc } = window._fs;
    // scanPhoto (base64) can be very large – strip it before saving to Firestore
    const payload = { ...record, scanPhoto: "" };
    await setDoc(doc(db, "attendance", record.id), payload);
  } catch (err) {
    console.error("saveAttendanceToFirebase error:", err);
  }
}

async function loadAttendanceFromFirebase() {
  if (!db) return [];
  try {
    const { collection, getDocs, query, orderBy } = window._fs;
    const q        = query(collection(db, "attendance"), orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => normalizeAttendance(d.data()));
  } catch (err) {
    console.error("loadAttendanceFromFirebase error:", err);
    return [];
  }
}

async function deleteAttendanceFromFirebase(recordId) {
  if (!db) return;
  try {
    const { doc, deleteDoc } = window._fs;
    await deleteDoc(doc(db, "attendance", recordId));
  } catch (err) {
    console.error("deleteAttendanceFromFirebase error:", err);
  }
}

// ─── Real-time listeners (onSnapshot) ───────────────────────
function subscribeToStudents() {
  if (!db) return;
  const { collection, onSnapshot } = window._fs;
  onSnapshot(collection(db, "students"), (snapshot) => {
    state.students = snapshot.docs.map(d => normalizeStudent(d.data()));
    updateDashboardStats();
    renderStudentsGrid();
  }, (err) => console.error("Students listener error:", err));
}

function subscribeToAttendance() {
  if (!db) return;
  const { collection, onSnapshot, query, orderBy } = window._fs;
  const q = query(collection(db, "attendance"), orderBy("timestamp", "desc"));
  onSnapshot(q, (snapshot) => {
    state.attendances = snapshot.docs.map(d => normalizeAttendance(d.data()));
    updateDashboardStats();
    renderAttendanceTable();
  }, (err) => console.error("Attendance listener error:", err));
}

// ─── Storage Keys (kept for settings only) ───────────────────
const STORAGE_KEYS = {
  settings:        "face-attendance-settings",
  // Legacy keys – read once on first load to migrate old data, then ignored
  students:        "face-attendance-students",
  attendance:      "face-attendance-log",
  legacyStudents:  "facscan_students",
  legacyAttendance:"facscan_attendances",
};

// ─── Defaults ────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  instituteName: "FaceScan Attendance",
  deviceLabel: "Institute Device",
  appsScriptUrl: "",
  matchThreshold: 0.42,
  modelUrl: "https://cdn.jsdelivr.net/gh/vladmandic/face-api/model/",
};

// ─── Registration constants ───────────────────────────────────
const REG_VIDEO_DURATION_MS    = 3000;
const REG_FRAME_INTERVAL_MS    = 90;
const REG_TARGET_EMBEDDINGS    = 10;   // per angle
const REG_MIN_EMBEDDINGS       = 3;    // per angle minimum
const REG_MIN_FACE_FRACTION    = 0.08;
const REG_MAX_FACE_FRACTION    = 0.80;
const REG_LAPLACIAN_THRESHOLD  = 60;
const REG_CENTER_TOLERANCE     = 0.35;
const REG_DUP_DISTANCE         = 0.08;
const REG_DETECTION_SCORE_MIN  = 0.68;

// ─── Angle definitions ───────────────────────────────────────
const ANGLES = [
  { key: "front", label: "😐 Front Face", icon: "😐", instruction: "Look straight at the camera" },
  { key: "left",  label: "← Left Face",  icon: "←",  instruction: "Slowly turn your head to the LEFT" },
  { key: "right", label: "Right Face →", icon: "→",  instruction: "Slowly turn your head to the RIGHT" },
];

// ─── Live attendance constants ────────────────────────────────
const LIVE_RECOGNITION_INTERVAL_MS    = 400;
const LIVE_REQUIRED_STABLE_MATCHES    = 4;
const LIVE_DYNAMIC_THRESHOLD_BOOST    = 0.06;
const LIVE_BLINK_EYE_DIFF_THRESHOLD   = 1.8;
const LIVE_MOVEMENT_LANDMARK_DELTA    = 2.5;
const LIVE_LIVENESS_FRAMES_REQUIRED   = 3;
const LIVE_MULTI_FACE_MAX             = 4;

// ─── App State ───────────────────────────────────────────────
const state = {
  settings: { ...DEFAULT_SETTINGS },
  students: [],
  attendances: [],
  currentStream: null,
  currentCameraMode: null,

  // Registration – per-angle data
  registerPhoto: null,         // best frame overall (for profile pic)
  registerDescriptors: null,   // final merged array
  angleData: { front: null, left: null, right: null },  // {descriptors, photo}
  currentAngleIndex: 0,        // 0=front 1=left 2=right
  isUpdateMode: false,         // true when editing existing student

  // Attendance
  attendancePhoto: null,
  liveMatches: [],
  selectedAttendanceStudentId: null,
  liveCandidateStudentId: null,
  liveCandidateStableCount: 0,
  liveRecognitionTimerId: null,
  liveRecognitionBusy: false,
  lastLandmarks: null,
  livenessFrameCount: 0,
  blinkDetected: false,
  livenessConfirmed: false,

  overlayCtx: null,
  modelsLoaded: false,
  modalRecord: null,

  regCapturing: false,
  regFrameTimerId: null,
  regCollectedDescriptors: [],
  regCollectedPhotos: [],
  regProgress: 0,
};

const dom = {};

window.onload = initApp;

// ─── Init ─────────────────────────────────────────────────────
async function initApp() {
  assignDom();
  loadSettings();           // load only settings from localStorage
  renderStaticLabels();
  updateClock();
  window.setInterval(updateClock, 1000);
  showSection("home");
  setupOverlayCanvas();

  // Show loading indicator while Firebase connects
  showLoadingBanner("Connecting to Firebase...");

  const firebaseReady = await initFirebase();

  if (firebaseReady) {
    // Load initial data from Firestore
    showLoadingBanner("Loading students & attendance...");
    [state.students, state.attendances] = await Promise.all([
      loadStudentsFromFirebase(),
      loadAttendanceFromFirebase(),
    ]);

    // Start real-time listeners so all devices stay in sync
    subscribeToStudents();
    subscribeToAttendance();
  } else {
    // Fallback to localStorage if Firebase is not configured
    console.warn("Firebase unavailable - falling back to localStorage.");
    loadData();
  }

  hideLoadingBanner();
  updateDashboardStats();
  renderStudentsGrid();
  renderAttendanceTable();
}

// ─── Loading Banner Helpers ───────────────────────────────────
function showLoadingBanner(msg) {
  let banner = document.getElementById("fb-loading-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fb-loading-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;width:100%;z-index:9999;background:#0ea5e9;" +
      "color:#fff;text-align:center;padding:10px 16px;font-size:0.9rem;font-weight:600;";
    document.body.prepend(banner);
  }
  banner.textContent = "⏳ " + msg;
  banner.style.display = "block";
}

function hideLoadingBanner() {
  const banner = document.getElementById("fb-loading-banner");
  if (banner) banner.style.display = "none";
}

function assignDom() {
  dom.sections        = document.querySelectorAll('[id^="section-"]');
  dom.tabs            = document.querySelectorAll('[id^="tab-"]');
  dom.currentTime     = document.getElementById("current-time");
  dom.instituteLabel  = document.getElementById("institute-label");
  dom.deviceLabel     = document.getElementById("device-label");
  dom.totalStudents   = document.getElementById("total-students");
  dom.todayAttendance = document.getElementById("today-attendance");

  dom.registerForm         = document.getElementById("register-form");
  dom.registerVideo        = document.getElementById("register-video");
  dom.registerCanvas       = document.getElementById("register-canvas");
  dom.registerOverlay      = document.getElementById("register-overlay");
  dom.startRegisterButton  = document.getElementById("start-register-btn");
  dom.registerPreview      = document.getElementById("register-preview");
  dom.registerPhotoPreview = document.getElementById("register-photo-preview");
  dom.registerStatus       = document.getElementById("register-status");
  dom.captureAngleBtn      = document.getElementById("capture-angle-btn");

  dom.attendanceVideo          = document.getElementById("attendance-video");
  dom.attendanceCanvas         = document.getElementById("attendance-canvas");
  dom.startAttendanceButton    = document.getElementById("start-attendance-btn");
  dom.captureAttendanceButton  = document.getElementById("capture-attendance-btn");
  dom.attendanceStatus         = document.getElementById("attendance-status");
  dom.recognitionResult        = document.getElementById("recognition-result");
  dom.recognitionTitle         = document.getElementById("recognition-title");
  dom.recognitionCopy          = document.getElementById("recognition-copy");
  dom.studentMatchList         = document.getElementById("student-match-list");

  dom.studentsGrid        = document.getElementById("students-grid");
  dom.attendanceTableBody = document.getElementById("attendance-table-body");
  dom.studentsListView    = document.getElementById("students-list-view");
  dom.attendanceListView  = document.getElementById("attendance-list-view");
  dom.showStudentsButton  = document.getElementById("show-students-btn");
  dom.showAttendanceButton= document.getElementById("show-attendance-btn");

  dom.successModal         = document.getElementById("success-modal");
  dom.modalTitle           = document.getElementById("modal-title");
  dom.modalSubtitle        = document.getElementById("modal-subtitle");
  dom.modalDetails         = document.getElementById("modal-details");
  dom.modalWhatsappButton  = document.getElementById("modal-whatsapp-btn");

  injectAttendanceOverlay();
}

function injectAttendanceOverlay() {
  const box = document.getElementById("attendance-camera-box");
  if (!box || document.getElementById("attendance-face-overlay")) return;
  const ov = document.createElement("canvas");
  ov.id = "attendance-face-overlay";
  ov.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;border-radius:inherit;";
  box.appendChild(ov);
  dom.faceOverlay = ov;
}

function setupOverlayCanvas() {
  if (!dom.faceOverlay) return;
  const resizeOv = () => {
    if (!dom.faceOverlay) return;
    dom.faceOverlay.width  = dom.faceOverlay.offsetWidth;
    dom.faceOverlay.height = dom.faceOverlay.offsetHeight;
  };
  resizeOv();
  window.addEventListener("resize", resizeOv);
}

// ─── Data ─────────────────────────────────────────────────────
// loadSettings: only restores app settings from localStorage
function loadSettings() {
  const config = typeof window.FACESCAN_CONFIG === "object" ? window.FACESCAN_CONFIG : {};
  const saved  = loadJson(STORAGE_KEYS.settings, {});
  state.settings = { ...DEFAULT_SETTINGS, ...config, ...saved };
}

// loadData: full localStorage fallback used when Firebase is unavailable
function loadData() {
  loadSettings();

  const savedStudents =
    loadJson(STORAGE_KEYS.students, null) ?? loadJson(STORAGE_KEYS.legacyStudents, []);
  const savedAttendances =
    loadJson(STORAGE_KEYS.attendance, null) ?? loadJson(STORAGE_KEYS.legacyAttendance, []);

  state.students    = Array.isArray(savedStudents)
    ? savedStudents.map(normalizeStudent).filter(Boolean) : [];
  state.attendances = Array.isArray(savedAttendances)
    ? savedAttendances.map(normalizeAttendance).filter(Boolean) : [];
}

// saveData: persists settings to localStorage; triggers UI refresh.
// Students and attendance are saved individually via Firebase helpers.
function saveData() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
  updateDashboardStats();
  renderStudentsGrid();
  renderAttendanceTable();
}

// saveDataLocalFallback: used only when Firebase is unavailable
function saveDataLocalFallback() {
  localStorage.setItem(STORAGE_KEYS.students,   JSON.stringify(state.students));
  localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(state.attendances));
  localStorage.setItem(STORAGE_KEYS.settings,   JSON.stringify(state.settings));
  updateDashboardStats();
  renderStudentsGrid();
  renderAttendanceTable();
}

// ─── UI helpers ───────────────────────────────────────────────
function renderStaticLabels() {
  dom.instituteLabel.textContent = state.settings.instituteName || "Attendance System";
  dom.deviceLabel.textContent    = state.settings.deviceLabel   || "Institute Device";
}

function updateDashboardStats() {
  dom.totalStudents.textContent = String(state.students.length);
  const todayKey   = getLocalDateKey(new Date());
  const todayCount = state.attendances.filter(e => e.dateKey === todayKey).length;
  dom.todayAttendance.innerHTML =
    `${todayCount}<span class="text-base ml-2 font-medium">/${state.students.length}</span>`;
}

function updateClock() {
  dom.currentTime.textContent = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit",
  });
}

function showSection(section) {
  dom.sections.forEach(el => el.classList.add("hidden"));
  document.getElementById(`section-${section}`)?.classList.remove("hidden");
  dom.tabs.forEach(t => t.classList.remove("nav-active"));
  document.getElementById(`tab-${section}`)?.classList.add("nav-active");

  if (section === "attendance") {
    if (!state.students.length) {
      dom.attendanceStatus.textContent = "Register at least one student before attendance scan.";
    } else if (state.currentCameraMode !== "attendance") {
      void startAttendanceCamera();
    }
  } else {
    stopCamera();
    if (section !== "register") resetRegisterCaptureUi();
    if (section !== "attendance") resetAttendanceCaptureUi();
  }
  if (section === "records") showStudentsList();
}

// ─── Camera core ──────────────────────────────────────────────
async function startCamera(videoElement, mode) {
  stopCamera();
  if (!window.isSecureContext) {
    alert("Camera access requires HTTPS or localhost.");
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    state.currentStream     = stream;
    state.currentCameraMode = mode;
    videoElement.srcObject  = stream;
    await videoElement.play();
    return true;
  } catch {
    alert("Camera permission is required to continue.");
    return false;
  }
}

function stopCamera() {
  if (state.regFrameTimerId) {
    clearInterval(state.regFrameTimerId);
    state.regFrameTimerId = null;
  }
  state.regCapturing = false;

  if (state.currentStream) {
    state.currentStream.getTracks().forEach(t => t.stop());
  }
  if (state.liveRecognitionTimerId) {
    clearInterval(state.liveRecognitionTimerId);
    state.liveRecognitionTimerId = null;
  }
  state.currentStream             = null;
  state.currentCameraMode         = null;
  state.liveCandidateStudentId    = null;
  state.liveCandidateStableCount  = 0;
  state.liveRecognitionBusy       = false;
  state.lastLandmarks             = null;
  state.livenessFrameCount        = 0;
  state.blinkDetected             = false;
  state.livenessConfirmed         = false;
  if (dom.registerVideo) dom.registerVideo.srcObject   = null;
  if (dom.attendanceVideo) dom.attendanceVideo.srcObject = null;
  clearOverlayCanvas();
  syncAttendanceControls(false);
}

// ─── DUPLICATE CHECK ──────────────────────────────────────────
function checkExistingStudent() {
  const roll      = document.getElementById("roll")?.value.trim();
  const className = document.getElementById("class")?.value.trim();
  const banner    = document.getElementById("already-registered-banner");
  const text      = document.getElementById("already-registered-text");
  const submitBtn = document.getElementById("register-submit-btn");

  if (!roll || !className || !banner) return;

  const studentId = buildStudentId(className, roll);
  const existing  = state.students.find(s => s.id === studentId);

  if (existing && !state.isUpdateMode) {
    banner.classList.remove("hidden");
    if (text) text.textContent =
      `${existing.name} (Roll: ${existing.roll}, ${existing.class}) is already registered on ${formatDate(existing.registeredOn)}.`;
    if (submitBtn) submitBtn.disabled = true;
  } else {
    banner.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = false;
  }
}

function proceedAsUpdate() {
  state.isUpdateMode = true;
  const banner = document.getElementById("already-registered-banner");
  if (banner) banner.classList.add("hidden");
  const submitBtn = document.getElementById("register-submit-btn");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "✏️ Update Student";
  }
  dom.registerStatus.textContent = "Update mode: Re-capture face and save to update this student.";
}

function cancelDuplicateRegistration() {
  state.isUpdateMode = false;
  const banner = document.getElementById("already-registered-banner");
  if (banner) banner.classList.add("hidden");
  dom.registerForm.reset();
  resetAllAngles();
  stopCamera();
  dom.registerOverlay.classList.remove("hidden");
  dom.startRegisterButton.classList.remove("hidden");
}

// ─── MULTI-ANGLE REGISTRATION ─────────────────────────────────

function startRegisterCamera() {
  startCamera(dom.registerVideo, "register").then(started => {
    if (!started) return;
    dom.registerOverlay.classList.add("hidden");
    dom.startRegisterButton.classList.add("hidden");
    updateAngleUI();
    dom.registerStatus.textContent = "Camera ready. Capture each angle one by one.";
  });
}

function updateAngleUI() {
  const idx = state.currentAngleIndex;
  const angle = ANGLES[idx];

  // Update step pills
  const pills = document.querySelectorAll(".angle-step-pill");
  pills.forEach((pill, i) => {
    pill.classList.remove(
      "border-sky-500", "bg-sky-500/10", "text-sky-300",
      "border-emerald-500", "bg-emerald-500/10", "text-emerald-300",
      "border-slate-600", "text-slate-500"
    );
    if (i < idx) {
      // done
      pill.classList.add("border-emerald-500", "bg-emerald-500/10", "text-emerald-300");
      pill.textContent = ANGLES[i].label.replace(ANGLES[i].icon, "✓");
    } else if (i === idx) {
      // active
      pill.classList.add("border-sky-500", "bg-sky-500/10", "text-sky-300");
      pill.textContent = ANGLES[i].label;
    } else {
      // pending
      pill.classList.add("border-slate-600", "text-slate-500");
      pill.textContent = ANGLES[i].label;
    }
  });

  // Update instruction
  const instrEl = document.getElementById("angle-instruction");
  if (instrEl) {
    instrEl.textContent = idx < ANGLES.length
      ? `Step ${idx + 1} of 3: ${angle.instruction}`
      : "All angles captured! Fill in details and register.";
  }

  // Update capture button
  if (dom.captureAngleBtn) {
    if (idx < ANGLES.length) {
      dom.captureAngleBtn.textContent = `📸 Capture ${angle.label}`;
      dom.captureAngleBtn.disabled = false;
    } else {
      dom.captureAngleBtn.textContent = "✅ All Angles Captured";
      dom.captureAngleBtn.disabled = true;
    }
  }
}

async function captureCurrentAngle() {
  if (!dom.registerVideo.srcObject) {
    alert("Please start camera first.");
    return;
  }
  const idx = state.currentAngleIndex;
  if (idx >= ANGLES.length) return;

  const angle = ANGLES[idx];
  dom.registerStatus.textContent = `Scanning ${angle.label}… Hold steady.`;
  if (dom.captureAngleBtn) dom.captureAngleBtn.disabled = true;

  try {
    await ensureModels();
    const { descriptors, bestFrameUrl } = await captureAngleVideo(dom.registerVideo, dom.registerCanvas, angle);

    if (!descriptors || descriptors.length < REG_MIN_EMBEDDINGS) {
      dom.registerStatus.textContent =
        `Only ${descriptors?.length ?? 0} quality frames for ${angle.label} (need ${REG_MIN_EMBEDDINGS}+). Try again.`;
      if (dom.captureAngleBtn) dom.captureAngleBtn.disabled = false;
      return;
    }

    // Store angle data
    state.angleData[angle.key] = { descriptors, photo: bestFrameUrl };

    // Update thumbnail
    const thumb = document.getElementById(`thumb-${angle.key}`);
    if (thumb) {
      thumb.innerHTML = `<img src="${bestFrameUrl}" class="w-full h-full object-cover rounded-2xl" alt="${angle.key}">`;
      thumb.style.borderColor = "#10b981";
      thumb.style.borderStyle = "solid";
    }

    dom.registerStatus.textContent =
      `✅ ${angle.label} captured (${descriptors.length} frames).` +
      (idx + 1 < ANGLES.length ? ` Now capture ${ANGLES[idx + 1].label}.` : " All angles done!");

    state.currentAngleIndex += 1;
    updateAngleUI();

    // If all 3 done, merge descriptors
    if (state.currentAngleIndex >= ANGLES.length) {
      mergeAngleDescriptors();
    }
  } catch (err) {
    dom.registerStatus.textContent = err.message;
    if (dom.captureAngleBtn) dom.captureAngleBtn.disabled = false;
  }
}

function mergeAngleDescriptors() {
  const all = [];
  for (const angle of ANGLES) {
    const d = state.angleData[angle.key];
    if (d?.descriptors?.length) all.push(...d.descriptors);
  }
  state.registerDescriptors = all;
  // Best photo = front
  state.registerPhoto = state.angleData.front?.photo || state.angleData.left?.photo || state.angleData.right?.photo;

  // Show preview
  if (state.registerPhoto) {
    dom.registerPhotoPreview.src = state.registerPhoto;
    dom.registerPreview.classList.remove("hidden");
  }
  dom.registerStatus.textContent =
    `✅ All 3 angles captured (${all.length} total face samples). Fill details and register.`;
}

async function captureAngleVideo(videoElement, canvasElement) {
  const collected = [];
  const photos = [];
  const startTime = Date.now();

  return new Promise((resolve) => {
    state.regCapturing = true;
    state.regFrameTimerId = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= REG_VIDEO_DURATION_MS || collected.length >= REG_TARGET_EMBEDDINGS || !state.regCapturing) {
        clearInterval(state.regFrameTimerId);
        state.regFrameTimerId = null;
        state.regCapturing = false;
        const final = storeMultipleEmbeddings(collected);
        resolve({ descriptors: final, bestFrameUrl: photos[0] || captureFrameAsDataUrl(videoElement, canvasElement) });
        return;
      }

      const result = await extractBestFrame(videoElement, canvasElement);
      if (result) {
        const { descriptor, dataUrl } = result;
        if (!isDuplicateDescriptor(descriptor, collected)) {
          collected.push(descriptor);
          if (photos.length < 2) photos.push(dataUrl);
        }
      }
    }, REG_FRAME_INTERVAL_MS);
  });
}

// Keep old captureRegisterPhoto for backward compat, redirect to angle flow
async function captureRegisterPhoto() {
  await captureCurrentAngle();
}

function resetAllAngles() {
  state.currentAngleIndex = 0;
  state.angleData = { front: null, left: null, right: null };
  state.registerDescriptors = null;
  state.registerPhoto = null;
  state.regCollectedDescriptors = [];
  state.regCollectedPhotos = [];
  state.isUpdateMode = false;

  // Reset thumbnails
  for (const angle of ANGLES) {
    const thumb = document.getElementById(`thumb-${angle.key}`);
    if (thumb) {
      thumb.innerHTML = `<span style="font-size:1.5rem;color:#475569;">${angle.icon}</span>`;
      thumb.style.borderColor = "";
      thumb.style.borderStyle = "dashed";
    }
  }

  const instrEl = document.getElementById("angle-instruction");
  if (instrEl) instrEl.textContent = "Start camera, then capture each angle one by one.";

  dom.registerPreview.classList.add("hidden");
  dom.registerPhotoPreview.removeAttribute("src");

  const submitBtn = document.getElementById("register-submit-btn");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "✅ Register Student";
  }

  updateAngleUI();
  dom.registerStatus.textContent = "Angles reset. Start camera and capture again.";
}

function retakeRegisterPhoto() {
  resetAllAngles();
}

// ─── Blur detection ───────────────────────────────────────────
function computeLaplacianVariance(ctx, box, vw, vh) {
  try {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(vw - x, Math.round(box.width));
    const h = Math.min(vh - y, Math.round(box.height));
    if (w < 20 || h < 20) return 0;

    const imageData = ctx.getImageData(x, y, w, h);
    const d = imageData.data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    let sumSq = 0, count = 0;
    for (let row = 1; row < h - 1; row++) {
      for (let col = 1; col < w - 1; col++) {
        const lap =
          -gray[(row - 1) * w + col] - gray[(row + 1) * w + col] -
          gray[row * w + (col - 1)] - gray[row * w + (col + 1)] +
          4 * gray[row * w + col];
        sumSq += lap * lap;
        count++;
      }
    }
    return count > 0 ? sumSq / count : 0;
  } catch {
    return 999;
  }
}

async function extractBestFrame(videoElement, canvasElement) {
  const vw = videoElement.videoWidth  || 640;
  const vh = videoElement.videoHeight || 480;

  canvasElement.width  = vw;
  canvasElement.height = vh;
  const ctx = canvasElement.getContext("2d");
  ctx.drawImage(videoElement, 0, 0, vw, vh);

  const detection = await faceapi
    .detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: REG_DETECTION_SCORE_MIN,
    }))
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return null;
  if ((detection.detection?.score ?? 0) < REG_DETECTION_SCORE_MIN) return null;

  const box     = detection.detection.box;
  const faceArea  = box.width * box.height;
  const frameArea = vw * vh;
  const faceFrac  = faceArea / frameArea;
  if (faceFrac < REG_MIN_FACE_FRACTION || faceFrac > REG_MAX_FACE_FRACTION) return null;

  const faceCenterX = (box.x + box.width  / 2) / vw;
  const faceCenterY = (box.y + box.height / 2) / vh;
  if (Math.abs(faceCenterX - 0.5) > REG_CENTER_TOLERANCE ||
      Math.abs(faceCenterY - 0.5) > REG_CENTER_TOLERANCE + 0.1) return null;

  const sharpness = computeLaplacianVariance(ctx, box, vw, vh);
  if (sharpness < REG_LAPLACIAN_THRESHOLD) return null;

  const descriptor = Array.from(detection.descriptor);
  const dataUrl    = canvasElement.toDataURL("image/jpeg", 0.82);
  return { descriptor, dataUrl };
}

function isDuplicateDescriptor(newDesc, existing, threshold = REG_DUP_DISTANCE) {
  for (const e of existing) {
    if (descriptorDistance(newDesc, e) < threshold) return true;
  }
  return false;
}

function storeMultipleEmbeddings(descriptors) {
  if (!descriptors || !descriptors.length) return null;
  const final = [];
  for (const d of descriptors) {
    if (!isDuplicateDescriptor(d, final, 0.06)) final.push(d);
    if (final.length >= REG_TARGET_EMBEDDINGS) break;
  }
  return final;
}

// ─── Register student save ────────────────────────────────────
async function registerStudent(event) {
  event.preventDefault();

  const hasMinAngles =
    (state.angleData.front?.descriptors?.length >= REG_MIN_EMBEDDINGS) ||
    (state.registerDescriptors?.length >= REG_MIN_EMBEDDINGS);

  if (!hasMinAngles) {
    alert("Please capture at least the Front face angle before registering.");
    return;
  }

  const name         = document.getElementById("name").value.trim();
  const roll         = document.getElementById("roll").value.trim();
  const className    = document.getElementById("class").value.trim();
  const studentPhone = document.getElementById("student-phone").value.trim();
  const parentPhone  = document.getElementById("parent-phone").value.trim();

  if (!name || !roll || !className || !parentPhone) {
    alert("Please complete all required student details.");
    return;
  }

  // Merge all captured angle descriptors
  const allDescriptors = state.registerDescriptors || [];
  if (!allDescriptors.length) {
    // Fall back to any captured angle
    for (const angle of ANGLES) {
      const d = state.angleData[angle.key];
      if (d?.descriptors?.length) allDescriptors.push(...d.descriptors);
    }
  }

  const bestPhoto = state.registerPhoto ||
    state.angleData.front?.photo ||
    state.angleData.left?.photo ||
    state.angleData.right?.photo;

  const studentId     = buildStudentId(className, roll);
  const existingStudent = state.students.find(s => s.id === studentId);

  const student = {
    id: studentId,
    name,
    roll,
    class: className,
    studentPhone,
    parentPhone,
    facePhoto: bestPhoto || "",
    descriptors: allDescriptors,
    descriptor: averageDescriptors(allDescriptors),
    embeddingCount: allDescriptors.length,
    angleData: {
      front: state.angleData.front ? { count: state.angleData.front.descriptors?.length || 0, photo: state.angleData.front.photo } : null,
      left:  state.angleData.left  ? { count: state.angleData.left.descriptors?.length  || 0, photo: state.angleData.left.photo  } : null,
      right: state.angleData.right ? { count: state.angleData.right.descriptors?.length || 0, photo: state.angleData.right.photo } : null,
    },
    registeredOn: existingStudent?.registeredOn || new Date().toISOString(),
    updatedOn: new Date().toISOString(),
  };

  const idx = state.students.findIndex(e => e.id === studentId);
  if (idx === -1) state.students.unshift(student);
  else state.students[idx] = student;

  // Save to Firebase (real-time listeners will update UI automatically)
  if (db) {
    await saveStudentToFirebase(student);
  } else {
    saveDataLocalFallback();
  }
  dom.registerForm.reset();
  resetAllAngles();
  stopCamera();
  dom.registerOverlay.classList.remove("hidden");
  dom.startRegisterButton.classList.remove("hidden");
  state.isUpdateMode = false;

  const submittedAngles = Object.values(state.angleData).filter(Boolean).length;
  dom.registerStatus.textContent =
    `${student.name} registered with ${student.embeddingCount} face embeddings (${submittedAngles}/3 angles).`;

  void postToBackend("registerStudent", {
    student: {
      id: student.id, name: student.name, rollNumber: student.roll,
      className: student.class, studentMobile: student.studentPhone,
      parentMobile: student.parentPhone, notes: "",
      embeddingCount: student.embeddingCount,
      registeredAt: student.registeredOn, updatedAt: student.updatedOn,
    },
  });

  alert(`${student.name} registered with ${student.embeddingCount} face samples.`);
  showSection("records");
  showStudentsList();
}

// ─── ATTENDANCE SCANNING ──────────────────────────────────────

async function startAttendanceCamera() {
  if (!state.students.length) {
    dom.attendanceStatus.textContent = "Register at least one student before attendance scan.";
    return;
  }

  const started = await startCamera(dom.attendanceVideo, "attendance");
  if (!started) return;

  dom.recognitionResult.classList.remove("hidden");
  dom.recognitionTitle.textContent = "Loading face identification";
  dom.recognitionCopy.textContent  = "Please wait while the face recognition models are loaded.";
  dom.studentMatchList.innerHTML   = '<div class="text-center text-slate-400 py-8">Preparing live face scan…</div>';
  setAttendanceConfirmState(false, "🔍 Identifying Face…");

  try {
    await ensureModels();
    if (dom.faceOverlay) {
      dom.faceOverlay.width  = dom.faceOverlay.offsetWidth;
      dom.faceOverlay.height = dom.faceOverlay.offsetHeight;
    }
    dom.attendanceStatus.textContent = "Camera is live. Identifying student…";
    dom.recognitionTitle.textContent = "Waiting for face";
    dom.recognitionCopy.textContent  = "Position one student clearly in front of the camera.";
    beginLiveRecognition();
  } catch (err) {
    dom.attendanceStatus.textContent = err.message;
    alert(err.message);
    stopCamera();
    resetAttendanceCaptureUi();
  }
}

function syncAttendanceControls(cameraStarted) {
  dom.startAttendanceButton.classList.toggle("hidden", cameraStarted);
  dom.captureAttendanceButton.classList.toggle("hidden", !cameraStarted);
}

function setAttendanceConfirmState(enabled, label) {
  dom.captureAttendanceButton.disabled = !enabled;
  dom.captureAttendanceButton.classList.toggle("opacity-60",        !enabled);
  dom.captureAttendanceButton.classList.toggle("cursor-not-allowed",!enabled);
  dom.captureAttendanceButton.innerHTML = label || "✅ Confirm &amp; Save Attendance";
  syncAttendanceControls(true);
}

function beginLiveRecognition() {
  if (state.liveRecognitionTimerId) clearInterval(state.liveRecognitionTimerId);
  state.liveRecognitionTimerId = setInterval(() => void runLiveRecognition(), LIVE_RECOGNITION_INTERVAL_MS);
  void runLiveRecognition();
}

async function runLiveRecognition() {
  if (
    state.liveRecognitionBusy ||
    state.currentCameraMode !== "attendance" ||
    !dom.attendanceVideo.srcObject
  ) return;

  state.liveRecognitionBusy = true;

  try {
    const detections = await faceapi
      .detectAllFaces(
        dom.attendanceVideo,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();

    clearOverlayCanvas();

    if (!detections || detections.length === 0) {
      state.liveMatches = [];
      resetLiveRecognitionSelection();
      renderMatchList([]);
      dom.attendanceStatus.textContent = "Looking for a face. Ask student to face the camera.";
      return;
    }

    const faces = detections
      .slice(0, LIVE_MULTI_FACE_MAX)
      .sort((a, b) =>
        b.detection.box.width * b.detection.box.height -
        a.detection.box.width * a.detection.box.height
      );

    const primaryFace = faces[0];
    drawFaceBoxes(faces);

    const livenessOk   = checkLiveness(primaryFace);
    const detScore     = primaryFace.detection.score ?? 0.8;
    const dynThreshold = Number(state.settings.matchThreshold) +
      (detScore < 0.7 ? LIVE_DYNAMIC_THRESHOLD_BOOST : 0);

    const descriptor  = Array.from(primaryFace.descriptor);
    state.liveMatches = rankStudentsByMultiEmbedding(descriptor, dynThreshold).slice(0, 5);

    if (!state.liveMatches.length) {
      resetLiveRecognitionSelection();
      renderMatchList([]);
      dom.attendanceStatus.textContent = "No registered students found.";
      return;
    }

    const bestMatch      = state.liveMatches[0];
    const confidentMatch = isSelectableMatch(bestMatch, dynThreshold);

    if (!confidentMatch) {
      resetLiveRecognitionSelection();
      renderMatchList(state.liveMatches.slice(0, 3));
      dom.attendanceStatus.textContent =
        "Unregistered or unclear face. Closest: " +
        (bestMatch.student?.name || "unknown") +
        ` (${Math.round(distanceToPercent(bestMatch.distance))}% match)`;
      return;
    }

    if (!livenessOk) {
      dom.attendanceStatus.textContent =
        `Verifying liveness… ${state.livenessFrameCount}/${LIVE_LIVENESS_FRAMES_REQUIRED} — Please blink or move slightly`;
      renderMatchList(state.liveMatches);
      return;
    }

    if (state.liveCandidateStudentId === bestMatch.student.id) {
      state.liveCandidateStableCount += 1;
    } else {
      state.liveCandidateStudentId   = bestMatch.student.id;
      state.liveCandidateStableCount = 1;
    }

    state.selectedAttendanceStudentId =
      state.liveCandidateStableCount >= LIVE_REQUIRED_STABLE_MATCHES
        ? bestMatch.student.id : null;

    const pct = Math.round(distanceToPercent(bestMatch.distance));

    if (state.selectedAttendanceStudentId) {
      dom.attendanceStatus.textContent =
        `✅ Identified ${bestMatch.student.name} — ${pct}% match. Tap confirm.`;
    } else {
      dom.attendanceStatus.textContent =
        `Confirming ${bestMatch.student.name} (${pct}% match) — Hold still ` +
        `${state.liveCandidateStableCount}/${LIVE_REQUIRED_STABLE_MATCHES}`;
    }

    renderMatchList(state.liveMatches);

    if (faces.length > 1) {
      dom.attendanceStatus.textContent +=
        ` — ⚠ ${faces.length} faces detected, using closest.`;
    }

  } catch (err) {
    dom.attendanceStatus.textContent = err.message;
  } finally {
    state.liveRecognitionBusy = false;
  }
}

function rankStudentsByMultiEmbedding(descriptor, dynThreshold) {
  const threshold = dynThreshold ?? Number(state.settings.matchThreshold);

  const withDescriptors = state.students.filter(s =>
    Array.isArray(s.descriptors) && s.descriptors.length > 0
  );
  const legacyOnly = state.students.filter(s =>
    !Array.isArray(s.descriptors) && Array.isArray(s.descriptor)
  );

  const ranked = [
    ...withDescriptors.map(student => {
      const distances = student.descriptors.map(emb => descriptorDistance(descriptor, emb));
      const minDist   = Math.min(...distances);
      return { student, distance: minDist };
    }),
    ...legacyOnly.map(student => ({
      student,
      distance: descriptorDistance(descriptor, student.descriptor),
    })),
  ].sort((a, b) => a.distance - b.distance);

  const noDescriptor = state.students
    .filter(s => !Array.isArray(s.descriptors) && !Array.isArray(s.descriptor))
    .map(s => ({ student: s, distance: null }));

  return [...ranked, ...noDescriptor];
}

// ─── Liveness Detection ───────────────────────────────────────
function checkLiveness(detection) {
  if (!detection?.landmarks) return true;

  const landmarks = detection.landmarks.positions;
  const centroid  = computeLandmarkCentroid(landmarks);

  if (state.lastLandmarks) {
    const prevCentroid = computeLandmarkCentroid(state.lastLandmarks);
    const movement     = Math.sqrt(
      Math.pow(centroid.x - prevCentroid.x, 2) +
      Math.pow(centroid.y - prevCentroid.y, 2)
    );
    if (movement > LIVE_MOVEMENT_LANDMARK_DELTA) {
      state.livenessFrameCount = Math.min(
        state.livenessFrameCount + 1,
        LIVE_LIVENESS_FRAMES_REQUIRED + 2
      );
    }
  }

  if (!state.blinkDetected && state.lastLandmarks) {
    const earNow  = computeEAR(landmarks);
    const earPrev = computeEAR(state.lastLandmarks);
    if (earPrev > 0.25 && earNow < earPrev / LIVE_BLINK_EYE_DIFF_THRESHOLD) {
      state.blinkDetected     = true;
      state.livenessFrameCount = Math.max(
        state.livenessFrameCount,
        LIVE_LIVENESS_FRAMES_REQUIRED - 1
      );
    }
  }

  state.lastLandmarks     = landmarks;
  state.livenessConfirmed = state.livenessFrameCount >= LIVE_LIVENESS_FRAMES_REQUIRED;
  return state.livenessConfirmed;
}

function computeLandmarkCentroid(positions) {
  const n = positions.length;
  let sx = 0, sy = 0;
  for (const p of positions) { sx += p.x; sy += p.y; }
  return { x: sx / n, y: sy / n };
}

function computeEAR(positions) {
  try {
    const ear = (eye) => {
      const A = dist2d(eye[1], eye[5]);
      const B = dist2d(eye[2], eye[4]);
      const C = dist2d(eye[0], eye[3]);
      return (A + B) / (2.0 * C);
    };
    const leftEye  = positions.slice(36, 42);
    const rightEye = positions.slice(42, 48);
    return (ear(leftEye) + ear(rightEye)) / 2;
  } catch {
    return 0.3;
  }
}

function dist2d(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

// ─── Overlay canvas face boxes ────────────────────────────────
function drawFaceBoxes(faces) {
  if (!dom.faceOverlay) return;
  const ctx = dom.faceOverlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, dom.faceOverlay.width, dom.faceOverlay.height);

  const vw = dom.attendanceVideo.videoWidth  || 640;
  const vh = dom.attendanceVideo.videoHeight || 480;
  const sw = dom.faceOverlay.width  / vw;
  const sh = dom.faceOverlay.height / vh;

  faces.forEach((face, idx) => {
    const box = face.detection.box;
    const x = box.x * sw, y = box.y * sh;
    const w = box.width * sw, h = box.height * sh;
    const color = idx === 0 ? "#0ea5e9" : "#f59e0b";

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.strokeRect(x, y, w, h);

    const cs = 16;
    ctx.lineWidth = 3;
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy], ci) => {
      ctx.beginPath();
      ctx.moveTo(cx + (ci % 2 === 0 ? cs : -cs), cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + (ci < 2 ? cs : -cs));
      ctx.stroke();
    });

    const pct = Math.round((face.detection.score ?? 0) * 100);
    ctx.fillStyle    = color;
    ctx.font         = "bold 12px system-ui";
    ctx.textBaseline = "bottom";
    ctx.fillText(idx === 0 ? `Primary · ${pct}%` : `Face ${idx + 1} · ${pct}%`, x + 4, y - 4);
  });
}

function clearOverlayCanvas() {
  if (!dom.faceOverlay) return;
  const ctx = dom.faceOverlay.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, dom.faceOverlay.width, dom.faceOverlay.height);
}

// ─── Attendance confirm & save ────────────────────────────────
async function captureAttendancePhoto() {
  if (!dom.attendanceVideo.srcObject) {
    alert("Please start camera first.");
    return;
  }

  await runLiveRecognition();

  const student = state.students.find(s => s.id === state.selectedAttendanceStudentId);
  if (!student) {
    alert("No confirmed student yet. Hold the face steady until identification is complete.");
    return;
  }

  state.attendancePhoto = captureFrameAsDataUrl(dom.attendanceVideo, dom.attendanceCanvas);

  const matchInfo = state.liveMatches.find(m => m.student.id === student.id);
  const now       = new Date();
  const dateKey   = getLocalDateKey(now);

  const alreadyMarked = state.attendances.some(
    a => a.studentId === student.id && a.dateKey === dateKey
  );
  if (alreadyMarked) {
    alert(`${student.name} already has attendance marked for today.`);
    return;
  }

  const matchPct = matchInfo && matchInfo.distance !== null
    ? Math.round(distanceToPercent(matchInfo.distance)) : null;

  const record = {
    id:           `ATT-${Date.now()}`,
    studentId:    student.id,
    name:         student.name,
    roll:         student.roll,
    class:        student.class,
    studentPhone: student.studentPhone,
    parentPhone:  student.parentPhone,
    dateKey,
    date:         dateKey,
    timestamp:    now.toISOString(),
    dateLabel:    formatDate(now),
    timeLabel:    formatTime(now),
    formattedTime:formatDateTime(now),
    scanPhoto:    state.attendancePhoto,
    matchDistance: matchInfo?.distance != null && isFinite(matchInfo.distance)
      ? Number(matchInfo.distance.toFixed(4)) : null,
    matchPercent: matchPct,
    syncState:    state.settings.appsScriptUrl ? "submitted" : "local-only",
  };

  state.attendances.unshift(record);

  // Save attendance to Firebase (real-time listener updates UI automatically)
  if (db) {
    await saveAttendanceToFirebase(record);
    record.syncState = "firebase-synced";
  } else {
    saveDataLocalFallback();
  }

  const syncResult = await postToBackend("logAttendance", {
    attendance: {
      attendanceId:  record.id,
      studentId:     record.studentId,
      name:          record.name,
      rollNumber:    record.roll,
      className:     record.class,
      studentMobile: record.studentPhone,
      parentMobile:  record.parentPhone,
      scannedAt:     record.timestamp,
      dateKey:       record.dateKey,
      dateLabel:     record.dateLabel,
      timeLabel:     record.timeLabel,
      matchDistance: record.matchDistance || 0,
      matchPercent:  record.matchPercent  || 0,
    },
  });

  if (!db) {
    record.syncState = syncResult.ok
      ? (state.settings.appsScriptUrl ? "submitted" : "local-only")
      : "failed";
    saveDataLocalFallback();
  }
  showSuccessModal(record);

  dom.attendanceStatus.textContent = `Attendance saved for ${student.name}. Ready for next scan.`;
  state.attendancePhoto = null;
  state.selectedAttendanceStudentId = null;
  state.livenessFrameCount  = 0;
  state.blinkDetected       = false;
  state.livenessConfirmed   = false;
  state.lastLandmarks       = null;
  setTimeout(() => void runLiveRecognition(), 250);
}

// ─── Match list render ────────────────────────────────────────
function renderMatchList(matches) {
  dom.recognitionResult.classList.remove("hidden");
  dom.studentMatchList.innerHTML = "";

  if (!matches.length) {
    dom.recognitionTitle.textContent = "Waiting for identified face";
    dom.recognitionCopy.textContent  =
      "Keep one student in front of the camera. Top matches will appear here.";
    dom.studentMatchList.innerHTML   =
      '<div class="text-center text-slate-400 py-8">No clear face detected yet.</div>';
    setAttendanceConfirmState(false, "🔍 Identifying Face…");
    return;
  }

  const threshold   = Number(state.settings.matchThreshold);
  const bestMatch   = matches[0];
  const selectedId  = state.selectedAttendanceStudentId;
  const confidentMatch = isSelectableMatch(bestMatch, threshold);

  if (!confidentMatch) {
    dom.recognitionTitle.textContent = "Unknown / Unregistered Face";
    dom.recognitionCopy.textContent  =
      bestMatch.distance !== null && isFinite(bestMatch.distance)
        ? `Closest: ${bestMatch.student.name} — ${Math.round(distanceToPercent(bestMatch.distance))}% match (below threshold)`
        : "This face does not match any registered student.";
    setAttendanceConfirmState(false, "❌ Face Not Registered");
  } else if (selectedId) {
    const pct = Math.round(distanceToPercent(bestMatch.distance));
    dom.recognitionTitle.textContent = `Identified: ${bestMatch.student.name}`;
    dom.recognitionCopy.textContent  =
      `${pct}% match confirmed across ${state.liveCandidateStableCount} frames. Tap confirm.`;
    setAttendanceConfirmState(true, `✅ Confirm ${escapeHtml(bestMatch.student.name)}`);
  } else {
    const pct = Math.round(distanceToPercent(bestMatch.distance));
    dom.recognitionTitle.textContent = `Identifying: ${bestMatch.student.name}`;
    dom.recognitionCopy.textContent  =
      `${pct}% match — Hold still (${state.liveCandidateStableCount}/${LIVE_REQUIRED_STABLE_MATCHES})`;
    setAttendanceConfirmState(false, "🔍 Hold Still…");
  }

  matches.forEach((match, idx) => {
    const isSelected   = match.student.id === selectedId;
    const isSelectable = isSelectableMatch(match, threshold);
    const pct = match.distance !== null && isFinite(match.distance)
      ? Math.round(distanceToPercent(match.distance)) : null;

    const card = document.createElement("button");
    card.type      = "button";
    card.className =
      `match-card bg-slate-900 rounded-3xl p-4 flex gap-4 items-center border-2 text-left ${
        isSelected  ? "border-sky-400 bg-slate-700/80" :
        isSelectable? "border-transparent" :
                      "border-red-500/30 bg-slate-900/70 opacity-80"
      }`;
    card.disabled = true;
    card.dataset.studentId = match.student.id;

    const embCount = match.student.embeddingCount
      ? `<span style="font-size:10px;color:#64748b;"> · ${match.student.embeddingCount} samples</span>` : "";

    card.innerHTML = `
      <img src="${escapeHtml(match.student.facePhoto||"")}"
           class="w-16 h-16 object-cover rounded-2xl bg-slate-800"
           alt="${escapeHtml(match.student.name)}">
      <div class="flex-1 min-w-0">
        <div class="font-semibold">${escapeHtml(match.student.name)}${embCount}</div>
        <div class="text-xs text-slate-400">Roll ${escapeHtml(match.student.roll)} · ${escapeHtml(match.student.class)}</div>
        <div class="text-xs mt-1 ${idx===0&&confidentMatch ? "text-emerald-400" : isSelectable ? "text-slate-500" : "text-red-300"}">
          ${pct !== null ? `${pct}% match` : "Manual confirmation"}
        </div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-xs text-slate-500">${
          isSelected ? "Confirmed" : !isSelectable ? "Rejected" : idx===0 ? "Top match" : "Candidate"
        }</div>
        <div class="text-2xl">${isSelected?"✅":!isSelectable?"❌":idx===0&&confidentMatch?"⭐":"👀"}</div>
      </div>
    `;
    dom.studentMatchList.appendChild(card);
  });
}

// ─── Success modal ────────────────────────────────────────────
function showSuccessModal(record) {
  state.modalRecord = record;
  dom.modalTitle.innerHTML =
    `✅ Attendance Marked!<br><span class="text-emerald-400">${escapeHtml(record.name)}</span>`;
  dom.modalSubtitle.textContent = `Roll ${record.roll} · ${record.class}`;

  const syncText  = record.syncState === "failed" ? "Failed" :
                    record.syncState === "submitted" ? "Requested" : "Saved locally";
  const syncColor = record.syncState === "failed" ? "text-red-400" : "text-emerald-400";
  const matchInfo = record.matchPercent !== null && record.matchPercent !== undefined
    ? `${record.matchPercent}% confidence`
    : record.matchDistance !== null ? `Distance ${Number(record.matchDistance).toFixed(3)}` : "Manual confirm";

  dom.modalDetails.innerHTML = `
    <div class="flex justify-between py-2 border-b border-slate-700">
      <span class="text-slate-400">Date &amp; Time</span>
      <span class="font-medium">${escapeHtml(record.formattedTime)}</span>
    </div>
    <div class="flex justify-between py-2 border-b border-slate-700">
      <span class="text-slate-400">Roll Number</span>
      <span class="font-medium">${escapeHtml(record.roll)}</span>
    </div>
    <div class="flex justify-between py-2 border-b border-slate-700">
      <span class="text-slate-400">Face Match</span>
      <span class="font-medium">${matchInfo}</span>
    </div>
    <div class="flex justify-between py-2">
      <span class="text-slate-400">Google Sheet</span>
      <span class="${syncColor} font-medium">${escapeHtml(syncText)}</span>
    </div>
  `;

  dom.modalWhatsappButton.classList.toggle("hidden", !record.parentPhone);
  dom.successModal.classList.remove("hidden");
}

function hideModal() {
  dom.successModal.classList.add("hidden");
  if (state.currentCameraMode === "attendance" && dom.attendanceVideo.srcObject) {
    setTimeout(() => void runLiveRecognition(), 150);
  }
}

function sendWhatsAppMessage() {
  if (!state.modalRecord) return;
  openWhatsappForRecord(state.modalRecord);
  hideModal();
}

function openWhatsappForRecord(record) {
  const phone = normalizeWhatsappNumber(record.parentPhone);
  if (!phone) { alert("Parent mobile number is missing."); return; }
  const message = encodeURIComponent(
    `Dear Parent,\n\nYour ward *${record.name}* (Roll No. ${record.roll}, ${record.class}) has marked attendance today.\n\nTime: ${record.formattedTime}\n\nThank you!\n${state.settings.instituteName}`
  );
  window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener,noreferrer");
}

// ─── Records UI ───────────────────────────────────────────────
function showStudentsList() {
  dom.studentsListView.classList.remove("hidden");
  dom.attendanceListView.classList.add("hidden");
  dom.showStudentsButton.classList.add("bg-sky-500","text-white");
  dom.showStudentsButton.classList.remove("bg-slate-800");
  dom.showAttendanceButton.classList.remove("bg-sky-500","text-white");
  dom.showAttendanceButton.classList.add("bg-slate-800");

  // Hide export buttons when students tab active
  document.getElementById("export-csv-btn")?.classList.add("hidden");
  document.getElementById("export-pdf-btn")?.classList.add("hidden");

  renderStudentsGrid();
}

function renderStudentsGrid() {
  dom.studentsGrid.innerHTML = "";
  if (!state.students.length) {
    dom.studentsGrid.innerHTML =
      '<div class="col-span-3 text-center py-16 text-slate-400">No students registered yet.<br>Go to Register tab.</div>';
    return;
  }
  state.students.forEach(student => {
    const card = document.createElement("div");
    card.className =
      "bg-slate-900 border border-slate-700 hover:border-sky-400 rounded-3xl p-5 transition-all";

    const embBadge = student.embeddingCount
      ? `<div class="text-xs text-sky-400 mt-1">🧠 ${student.embeddingCount} face samples</div>` : "";

    // Angle badges
    const angleInfo = student.angleData
      ? Object.entries(student.angleData)
          .filter(([, v]) => v)
          .map(([k]) => `<span class="inline-block bg-emerald-500/10 text-emerald-400 text-xs px-2 py-0.5 rounded-lg">${k}</span>`)
          .join("")
      : "";

    card.innerHTML = `
      <img src="${escapeHtml(student.facePhoto||"")}"
           class="w-full aspect-square object-cover rounded-3xl mb-4 bg-slate-800"
           alt="${escapeHtml(student.name)}">
      <div class="font-semibold text-lg">${escapeHtml(student.name)}</div>
      <div class="flex justify-between text-sm mt-1 gap-4">
        <span class="text-slate-400">Roll ${escapeHtml(student.roll)}</span>
        <span class="font-medium">${escapeHtml(student.class)}</span>
      </div>
      ${embBadge}
      ${angleInfo ? `<div class="flex gap-1 flex-wrap mt-2">${angleInfo}</div>` : ""}
      <div class="text-xs text-slate-400 mt-4 space-y-1">
        <div>📱 Student: ${escapeHtml(student.studentPhone||"-")}</div>
        <div>👨‍👩‍👧 Parent: ${escapeHtml(student.parentPhone||"-")}</div>
      </div>
      <div class="flex gap-2 mt-4">
        <button type="button"
          class="flex-1 text-xs bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 px-3 py-2 rounded-2xl font-medium transition-colors"
          onclick="openEditModal('${escapeHtml(student.id)}')">
          ✏️ Edit
        </button>
        <button type="button"
          class="flex-1 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-2 rounded-2xl font-medium transition-colors"
          onclick="deleteStudent('${escapeHtml(student.id)}')">
          🗑️ Delete
        </button>
      </div>
    `;
    dom.studentsGrid.appendChild(card);
  });
}

function showAttendanceList() {
  dom.studentsListView.classList.add("hidden");
  dom.attendanceListView.classList.remove("hidden");
  dom.showAttendanceButton.classList.add("bg-sky-500","text-white");
  dom.showAttendanceButton.classList.remove("bg-slate-800");
  dom.showStudentsButton.classList.remove("bg-sky-500","text-white");
  dom.showStudentsButton.classList.add("bg-slate-800");

  // Show export buttons
  document.getElementById("export-csv-btn")?.classList.remove("hidden");
  document.getElementById("export-pdf-btn")?.classList.remove("hidden");

  renderAttendanceTable();
}

function renderAttendanceTable() {
  dom.attendanceTableBody.innerHTML = "";
  if (!state.attendances.length) {
    dom.attendanceTableBody.innerHTML =
      '<tr><td colspan="5" class="text-center py-12 text-slate-400">No attendance records yet</td></tr>';
    return;
  }
  state.attendances.forEach(record => {
    const row = document.createElement("tr");
    row.className = "border-b border-slate-700 last:border-none hover:bg-slate-800/50";
    const matchLabel = record.matchPercent !== null && record.matchPercent !== undefined
      ? `${record.matchPercent}%` : "";
    const actionLabel = record.syncState === "failed" ? "Retry WhatsApp" : "Send again";
    row.innerHTML = `
      <td class="px-6 py-5">${escapeHtml(record.formattedTime)}</td>
      <td class="px-6 py-5 font-medium">${escapeHtml(record.name)}${matchLabel ? `<span class="ml-2 text-xs text-emerald-400">${matchLabel}</span>` : ""}</td>
      <td class="px-6 py-5">${escapeHtml(record.roll)}</td>
      <td class="px-6 py-5">${escapeHtml(record.class)}</td>
      <td class="px-6 py-5 text-right">
        <div class="flex gap-2 justify-end">
          <button type="button"
            class="attendance-wa-btn text-emerald-400 text-xs font-medium px-3 py-2 bg-emerald-400/10 hover:bg-emerald-400/20 rounded-2xl"
            data-record-id="${escapeHtml(record.id)}">
            📤 ${escapeHtml(actionLabel)}
          </button>
          <button type="button"
            class="attendance-del-btn text-red-400 text-xs font-medium px-3 py-2 bg-red-400/10 hover:bg-red-400/20 rounded-2xl"
            data-record-id="${escapeHtml(record.id)}">
            🗑️
          </button>
        </div>
      </td>
    `;
    row.querySelector(".attendance-wa-btn")?.addEventListener("click", () => {
      mockSendWhatsAppFromLog(record.id);
    });
    row.querySelector(".attendance-del-btn")?.addEventListener("click", () => {
      deleteAttendanceRecord(record.id);
    });
    dom.attendanceTableBody.appendChild(row);
  });
}

function mockSendWhatsAppFromLog(recordId) {
  const record = state.attendances.find(e => e.id === recordId);
  if (record) openWhatsappForRecord(record);
}

// ─── DELETE STUDENT ──────────────────────────────────────────
async function deleteStudent(studentId) {
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  if (!confirm(`Delete student "${student.name}" (Roll: ${student.roll})?\n\nThis will also remove their attendance records.`)) return;

  state.students    = state.students.filter(s => s.id !== studentId);
  state.attendances = state.attendances.filter(a => a.studentId !== studentId);

  if (db) {
    await deleteStudentFromFirebase(studentId);
    // Also delete this student's attendance records from Firestore
    const attToDelete = state.attendances.filter(a => a.studentId === studentId);
    await Promise.all(attToDelete.map(a => deleteAttendanceFromFirebase(a.id)));
  } else {
    saveDataLocalFallback();
  }
}

// ─── DELETE ATTENDANCE RECORD ─────────────────────────────────
async function deleteAttendanceRecord(recordId) {
  const record = state.attendances.find(r => r.id === recordId);
  if (!record) return;
  if (!confirm(`Delete attendance record for ${record.name} on ${record.formattedTime}?`)) return;

  state.attendances = state.attendances.filter(r => r.id !== recordId);

  if (db) {
    await deleteAttendanceFromFirebase(recordId);
  } else {
    saveDataLocalFallback();
    renderAttendanceTable();
  }
}

// ─── EDIT STUDENT MODAL ───────────────────────────────────────
function openEditModal(studentId) {
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;

  document.getElementById("edit-student-id").value      = student.id;
  document.getElementById("edit-name").value            = student.name;
  document.getElementById("edit-roll").value            = student.roll;
  document.getElementById("edit-class").value           = student.class;
  document.getElementById("edit-student-phone").value   = student.studentPhone || "";
  document.getElementById("edit-parent-phone").value    = student.parentPhone  || "";

  document.getElementById("edit-student-modal").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("edit-student-modal").classList.add("hidden");
}

async function saveEditStudent() {
  const id          = document.getElementById("edit-student-id").value;
  const name        = document.getElementById("edit-name").value.trim();
  const roll        = document.getElementById("edit-roll").value.trim();
  const className   = document.getElementById("edit-class").value.trim();
  const studentPhone= document.getElementById("edit-student-phone").value.trim();
  const parentPhone = document.getElementById("edit-parent-phone").value.trim();

  if (!name || !roll || !className || !parentPhone) {
    alert("Name, Roll Number, Class, and Parent Mobile are required.");
    return;
  }

  const idx = state.students.findIndex(s => s.id === id);
  if (idx === -1) { alert("Student not found."); return; }

  state.students[idx] = {
    ...state.students[idx],
    name,
    roll,
    class: className,
    studentPhone,
    parentPhone,
    updatedOn: new Date().toISOString(),
  };

  // Also update name/roll/class in existing attendance records
  state.attendances = state.attendances.map(a =>
    a.studentId === id
      ? { ...a, name, roll, class: className, studentPhone, parentPhone }
      : a
  );

  if (db) {
    await saveStudentToFirebase(state.students[idx]);
    // Update affected attendance records in Firestore
    const affected = state.attendances.filter(a => a.studentId === id);
    await Promise.all(affected.map(a => saveAttendanceToFirebase(a)));
  } else {
    saveDataLocalFallback();
  }
  closeEditModal();
}

// ─── EXPORT CSV ───────────────────────────────────────────────
function exportAttendanceCSV() {
  if (!state.attendances.length) {
    alert("No attendance records to export.");
    return;
  }

  const headers = ["Date", "Time", "Student Name", "Roll No", "Class", "Student Phone", "Parent Phone", "Match %", "Sync Status"];
  const rows = state.attendances.map(r => [
    r.dateLabel    || r.date,
    r.timeLabel    || "",
    r.name,
    r.roll,
    r.class,
    r.studentPhone || "",
    r.parentPhone  || "",
    r.matchPercent != null ? `${r.matchPercent}%` : "",
    r.syncState    || "",
  ]);

  const csvContent = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `attendance_${getLocalDateKey(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── EXPORT PDF ───────────────────────────────────────────────
function exportAttendancePDF() {
  if (!state.attendances.length) {
    alert("No attendance records to export.");
    return;
  }

  const instituteName = escapeHtml(state.settings.instituteName || "FaceScan Attendance");
  const exportDate    = formatDateTime(new Date());

  // Build table rows
  const tableRows = state.attendances.map((r, i) => `
    <tr style="background:${i % 2 === 0 ? "#f8fafc" : "#fff"};">
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.dateLabel || r.date)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.timeLabel || "")}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${escapeHtml(r.name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.roll)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.class)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#10b981;">${r.matchPercent != null ? r.matchPercent + "%" : "-"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.syncState || "")}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Attendance Report – ${instituteName}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 0; padding: 24px; }
    .header { background: linear-gradient(135deg, #0ea5e9, #3b82f6); color: white; border-radius: 12px; padding: 24px 32px; margin-bottom: 24px; }
    .header h1 { margin: 0 0 4px; font-size: 1.8rem; }
    .header p  { margin: 0; opacity: 0.85; font-size: 0.9rem; }
    .meta { display: flex; gap: 24px; margin-bottom: 20px; font-size: 0.88rem; color: #64748b; }
    .meta span { background: #f1f5f9; padding: 6px 14px; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    thead tr { background: #0f172a; color: #e2e8f0; }
    thead th { padding: 10px 12px; text-align: left; font-weight: 600; }
    tbody tr:hover { background: #f0f9ff !important; }
    .footer { margin-top: 24px; text-align: center; font-size: 0.8rem; color: #94a3b8; }
    @media print {
      body { padding: 0; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>📋 Attendance Report</h1>
    <p>${instituteName}</p>
  </div>
  <div class="meta">
    <span>📅 Exported: ${exportDate}</span>
    <span>👥 Total Records: ${state.attendances.length}</span>
    <span>🎓 Students: ${state.students.length}</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Date</th><th>Time</th><th>Student</th><th>Roll No</th><th>Class</th><th>Match %</th><th>Status</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="footer">Generated by FaceScan Attendance · ${exportDate}</div>
  <br/>
  <button class="no-print" onclick="window.print()" style="margin:0 auto;display:block;background:#0ea5e9;color:#fff;border:none;padding:12px 28px;border-radius:24px;font-size:1rem;cursor:pointer;font-weight:600;">
    🖨️ Print / Save as PDF
  </button>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, "_blank");
  if (!win) {
    // Fallback: download the HTML
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `attendance_report_${getLocalDateKey(new Date())}.html`;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ─── Reset / Clear ────────────────────────────────────────────
async function clearAllData() {
  if (!confirm("Reset all demo data? This will delete ALL records from Firebase too.")) return;

  [STORAGE_KEYS.students, STORAGE_KEYS.attendance,
   STORAGE_KEYS.legacyStudents, STORAGE_KEYS.legacyAttendance].forEach(k =>
    localStorage.removeItem(k)
  );

  // Delete all documents from Firestore if connected
  if (db) {
    showLoadingBanner("Clearing Firebase data...");
    try {
      const { collection, getDocs, deleteDoc, doc } = window._fs;
      const [stuSnap, attSnap] = await Promise.all([
        getDocs(collection(db, "students")),
        getDocs(collection(db, "attendance")),
      ]);
      await Promise.all([
        ...stuSnap.docs.map(d => deleteDoc(doc(db, "students",   d.id))),
        ...attSnap.docs.map(d => deleteDoc(doc(db, "attendance", d.id))),
      ]);
    } catch (err) {
      console.error("clearAllData Firebase error:", err);
    }
    hideLoadingBanner();
  }

  state.students             = [];
  state.attendances          = [];
  state.registerPhoto        = null;
  state.registerDescriptors  = null;
  state.regCollectedDescriptors = [];
  state.regCollectedPhotos   = [];
  state.attendancePhoto      = null;
  state.modalRecord          = null;
  state.isUpdateMode         = false;
  state.angleData            = { front: null, left: null, right: null };
  state.currentAngleIndex    = 0;
  hideModal();
  stopCamera();
  resetRegisterCaptureUi();
  resetAttendanceCaptureUi();
  saveData();
  showSection("home");
  alert("All saved demo data has been cleared.");
}

function resetRegisterCaptureUi(preserveLiveCamera = false) {
  state.registerPhoto       = null;
  state.registerDescriptors = null;
  dom.registerPreview.classList.add("hidden");
  dom.registerPhotoPreview.removeAttribute("src");
  dom.registerStatus.textContent = preserveLiveCamera
    ? "Camera is still live. Press Capture angle buttons when ready."
    : "Start the camera and capture 3 angles: Front → Left → Right.";
  dom.registerOverlay.classList.toggle("hidden",     preserveLiveCamera);
  dom.startRegisterButton.classList.toggle("hidden", preserveLiveCamera);
}

function resetAttendanceCaptureUi() {
  state.attendancePhoto = null;
  resetLiveRecognitionSelection();
  dom.recognitionResult.classList.add("hidden");
  dom.studentMatchList.innerHTML = "";
  dom.attendanceStatus.textContent = "Start the camera to scan a student face.";
  setAttendanceConfirmState(false, "✅ Confirm &amp; Save Attendance");
  syncAttendanceControls(false);
}

function resetLiveRecognitionSelection() {
  state.liveMatches                = [];
  state.selectedAttendanceStudentId = null;
  state.liveCandidateStudentId     = null;
  state.liveCandidateStableCount   = 0;
}

// ─── Model loading (lazy, cached) ────────────────────────────
const _modelLoadPromise = { current: null };

async function ensureModels() {
  if (state.modelsLoaded) return;
  if (_modelLoadPromise.current) return _modelLoadPromise.current;

  if (typeof faceapi === "undefined") {
    throw new Error("Face recognition library did not load. Check your internet connection.");
  }

  _modelLoadPromise.current = (async () => {
    const url = normalizeModelUrl(state.settings.modelUrl);
    await faceapi.nets.tinyFaceDetector.loadFromUri(url);
    await faceapi.nets.faceLandmark68Net.loadFromUri(url);
    await faceapi.nets.faceRecognitionNet.loadFromUri(url);
    state.modelsLoaded = true;
  })();

  return _modelLoadPromise.current;
}

// ─── Face detection helpers ───────────────────────────────────
async function detectFace(videoElement) {
  return faceapi
    .detectSingleFace(videoElement,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
    )
    .withFaceLandmarks()
    .withFaceDescriptor();
}

function captureFrameAsDataUrl(videoElement, canvasElement) {
  canvasElement.width  = videoElement.videoWidth  || 640;
  canvasElement.height = videoElement.videoHeight || 480;
  const ctx = canvasElement.getContext("2d");
  ctx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
  return canvasElement.toDataURL("image/jpeg", 0.85);
}

// ─── Descriptor math ─────────────────────────────────────────
function averageDescriptors(descriptors) {
  if (!descriptors?.length) return null;
  const len = descriptors[0]?.length || 0;
  if (!len) return null;
  const totals = new Array(len).fill(0);
  descriptors.forEach(d => d.forEach((v, i) => { totals[i] += Number(v); }));
  return totals.map(v => v / descriptors.length);
}

function descriptorDistance(a, b) {
  const left  = Array.from(a);
  const right = Array.from(b);
  if (left.length !== right.length || !left.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < left.length; i++) {
    const d = left[i] - right[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function distanceToPercent(distance) {
  if (distance === null || !isFinite(distance)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - distance / 0.6) * 100)));
}

function isSelectableMatch(match, threshold) {
  const thr = threshold ?? Number(state.settings.matchThreshold);
  return Boolean(
    match &&
    match.distance !== null &&
    isFinite(match.distance) &&
    match.distance <= thr
  );
}

// ─── Backend sync ─────────────────────────────────────────────
async function postToBackend(action, payload) {
  if (!state.settings.appsScriptUrl) return { ok: true, mode: "local-only" };
  try {
    await fetch(state.settings.appsScriptUrl, {
      method: "POST",
      mode:   "no-cors",
      headers:{ "Content-Type": "text/plain;charset=utf-8" },
      body:   JSON.stringify({
        action,
        instituteName: state.settings.instituteName,
        deviceLabel:   state.settings.deviceLabel,
        sentAt:        new Date().toISOString(),
        ...payload,
      }),
    });
    return { ok: true, mode: "submitted" };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// ─── Data normalization ───────────────────────────────────────
function normalizeStudent(student) {
  if (!student) return null;

  let descriptors = null;
  if (Array.isArray(student.descriptors) && student.descriptors.length > 0) {
    descriptors = student.descriptors.map(d => Array.isArray(d) ? d.map(Number) : null).filter(Boolean);
  }

  const descriptor = Array.isArray(student.descriptor)
    ? student.descriptor.map(Number) : null;

  return {
    id:           String(student.id || buildStudentId(student.className || student.class, student.roll || student.rollNumber)),
    name:         String(student.name || ""),
    roll:         String(student.roll || student.rollNumber || ""),
    class:        String(student.class || student.className || ""),
    studentPhone: String(student.studentPhone || student.studentMobile || ""),
    parentPhone:  String(student.parentPhone  || student.parentMobile  || ""),
    facePhoto:    String(student.facePhoto || ""),
    descriptors,
    descriptor,
    embeddingCount: student.embeddingCount || descriptors?.length || (descriptor ? 1 : 0),
    angleData:    student.angleData || null,
    registeredOn: String(student.registeredOn || student.registeredAt || new Date().toISOString()),
    updatedOn:    String(student.updatedOn    || student.updatedAt    || new Date().toISOString()),
  };
}

function normalizeAttendance(record) {
  if (!record) return null;
  const timestamp = record.timestamp || record.scannedAt || new Date().toISOString();
  const date      = new Date(timestamp);
  return {
    id:           String(record.id || record.attendanceId || `ATT-${Date.now()}`),
    studentId:    String(record.studentId || ""),
    name:         String(record.name      || ""),
    roll:         String(record.roll      || record.rollNumber || ""),
    class:        String(record.class     || record.className  || ""),
    studentPhone: String(record.studentPhone || record.studentMobile || ""),
    parentPhone:  String(record.parentPhone  || record.parentMobile  || ""),
    dateKey:      String(record.dateKey   || record.date       || getLocalDateKey(date)),
    date:         String(record.date      || record.dateKey    || getLocalDateKey(date)),
    timestamp:    String(timestamp),
    dateLabel:    String(record.dateLabel    || formatDate(date)),
    timeLabel:    String(record.timeLabel    || formatTime(date)),
    formattedTime:String(record.formattedTime|| formatDateTime(date)),
    scanPhoto:    String(record.scanPhoto    || ""),
    matchDistance: record.matchDistance == null ? null : Number(record.matchDistance),
    matchPercent:  record.matchPercent  == null ? null : Number(record.matchPercent),
    syncState:    String(record.syncState    || "local-only"),
  };
}

// ─── Utility ─────────────────────────────────────────────────
function buildStudentId(className, rollNumber) {
  return `${slugify(className)}-${slugify(rollNumber) || Date.now()}`;
}

function normalizeModelUrl(url) {
  const v = url || DEFAULT_SETTINGS.modelUrl;
  return v.endsWith("/") ? v : `${v}/`;
}

function normalizeWhatsappNumber(value) {
  const cleaned = String(value || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned.slice(1);
  if (cleaned.length === 10) return `91${cleaned}`;
  return cleaned;
}

function getLocalDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDate(input) {
  return new Intl.DateTimeFormat("en-IN", { day:"numeric", month:"short", year:"numeric" }).format(new Date(input));
}

function formatTime(input) {
  return new Intl.DateTimeFormat("en-IN", { hour:"2-digit", minute:"2-digit" }).format(new Date(input));
}

function formatDateTime(input) {
  return new Intl.DateTimeFormat("en-IN", {
    day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit",
  }).format(new Date(input));
}

function slugify(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#39;");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
