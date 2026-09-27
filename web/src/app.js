// MomMeds web app. One app, two modes: Mummy's big-button screen and the admin dashboard.
import { initializeApp } from "firebase/app";
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";
import { parseAnswer } from "../../functions/lib/schedule.js";
import { demoApi } from "./demo.js";

const REGION = "asia-southeast1"; // must match functions/index.js
const params = new URLSearchParams(location.search);
const DEMO = params.get("demo");
const $app = document.getElementById("app");

const audio = {
  dose: new Audio("/audio/ask-dose.m4a"),
  photo: new Audio("/audio/ask-photo.m4a"),
};

let api; // { call(name, data), signOut }
let me = null; // result of whoami
let firebaseApp = null;
let homeTimer = null;
let pushRegistered = false;

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/* global __VERSION__ */
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

function render(html) {
  clearTimeout(homeTimer);
  $app.innerHTML = `${html}<p class="version">v ${VERSION}</p>`;
  window.scrollTo(0, 0);
}

function on(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

function play(which) {
  const a = audio[which];
  a.currentTime = 0;
  return a.play().then(() => true, () => false);
}

function say(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "hi-IN";
    speechSynthesis.speak(u);
  } catch {
    /* no speech synthesis */
  }
}

const HI_PART_OF_DAY = [[12, "सुबह"], [17, "दोपहर"], [20, "शाम"], [24, "रात"]];

/** "21:00" -> "रात 9:00 बजे" */
function hiTime(time) {
  const [h, m] = time.split(":").map(Number);
  const part = HI_PART_OF_DAY.find(([end]) => h < end)[1];
  return `${part} ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} बजे`;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function busy(text = "एक सेकंड...") {
  render(`<div class="screen center"><div class="spinner"></div><p class="big">${esc(text)}</p></div>`);
}

function errorScreen(e) {
  render(`<div class="screen center">
    <div class="emoji">😕</div>
    <p class="big">कुछ गड़बड़ हो गई</p>
    <p class="muted">${esc(e?.message || e)}</p>
    <button class="btn primary" id="retry">फिर से कोशिश करें</button>
  </div>`);
  on("retry", () => start());
}

// ---------- boot ----------
async function start() {
  if (DEMO) {
    api = demoApi(DEMO);
    me = await api.call("whoami");
    return route();
  }
  busy("खुल रहा है...");
  try {
    const config = await (await fetch("/__/firebase/init.json")).json();
    firebaseApp = initializeApp(config);
    firebaseApp._mommedsConfig = config;
  } catch (e) {
    return errorScreen("App is not deployed to Firebase Hosting yet (missing /__/firebase/init.json).");
  }
  // Stay logged in forever: the login is kept on the phone (IndexedDB, with localStorage
  // as backup) and Firebase refreshes it automatically. Only "Sign out" on the admin
  // dashboard, a password change or deleting the user in Firebase ends it.
  const auth = initializeAuth(firebaseApp, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  // Ask the browser not to clear this app's storage when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
  const functions = getFunctions(firebaseApp, REGION);
  api = {
    call: async (name, data) => (await httpsCallable(functions, name, { timeout: 120000 })(data)).data,
    signOut: () => signOut(auth),
  };
  onAuthStateChanged(auth, async (user) => {
    if (!user) return loginScreen(auth);
    try {
      me = await api.call("whoami");
      route();
    } catch (e) {
      if (e.code === "functions/permission-denied") {
        render(`<div class="screen center"><p class="big">This account isn't set up for MomMeds.</p>
          <p class="muted">${esc(user.email)}</p><button class="btn" id="out">Sign out</button></div>`);
        on("out", () => api.signOut());
      } else errorScreen(e);
    }
  });
}

function route() {
  const asMom = me.role === "mom" || params.get("as") === "mom";
  if (!DEMO && (!isStandalone && isIOS)) return installScreen(asMom);
  if (!DEMO && notificationsNeedSetup()) return notifyScreen(asMom);
  if (!DEMO && !pushRegistered) {
    pushRegistered = true;
    registerPush(asMom).catch((e) => console.warn("push registration failed", e));
  }
  if (asMom) {
    if (params.get("ask") === "photo") {
      try { localStorage.removeItem(SNOOZE_KEY); } catch { /* ignore */ }
    }
    return momHome();
  }
  return adminHome();
}

// ---------- login / setup ----------
function loginScreen(auth) {
  render(`<form class="screen" id="login">
    <div class="emoji">💊</div>
    <h1>MomMeds</h1>
    <label>ईमेल / Email<input type="email" id="email" autocomplete="username" required></label>
    <label>पासवर्ड / Password<input type="password" id="pw" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">लॉग इन / Log in</button>
    <p class="muted" id="err"></p>
  </form>`);
  document.getElementById("login").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, document.getElementById("email").value.trim(), document.getElementById("pw").value);
    } catch (err) {
      document.getElementById("err").textContent = err.message;
    }
  });
}

function installScreen(asMom) {
  if (asMom) {
    return render(`<div class="screen">
    <div class="emoji">📲</div>
    <h1>होम स्क्रीन पर जोड़ें</h1>
    <ol class="steps">
      <li>Safari में नीचे <b>शेयर</b> बटन <span class="share">⎋</span> दबाइए</li>
      <li>नीचे जाकर <b>Add to Home Screen</b> दबाइए</li>
      <li><b>Add</b> दबाइए, फिर होम स्क्रीन से <b>MomMeds</b> खोलिए</li>
    </ol>
  </div>`);
  }
  render(`<div class="screen">
    <div class="emoji">📲</div>
    <h1>Add to Home Screen</h1>
    <ol class="steps">
      <li>Tap the <b>Share</b> button <span class="share">⎋</span> at the bottom of Safari</li>
      <li>Scroll and tap <b>Add to Home Screen</b></li>
      <li>Tap <b>Add</b>, then open <b>MomMeds</b> from the Home Screen</li>
    </ol>
    <p class="muted">Notifications on iPhone only work from the Home Screen app (iOS 16.4 or newer).</p>
  </div>`);
}

function notificationsNeedSetup() {
  return !("Notification" in window) || Notification.permission !== "granted";
}

function notifyScreen(asMom) {
  const blocked = "Notification" in window && Notification.permission === "denied";
  render(`<div class="screen center">
    <div class="emoji">🔔</div>
    <h1>${asMom ? "नोटिफ़िकेशन चालू करें" : "Turn on notifications"}</h1>
    ${blocked
      ? (asMom
        ? `<p>नोटिफ़िकेशन बंद हैं। <b>Settings → Notifications → MomMeds</b> में जाकर <b>Allow Notifications</b> चालू करें, फिर ऐप दोबारा खोलें।</p>`
        : `<p>Notifications are blocked. Open <b>Settings → Notifications → MomMeds</b> and turn on <b>Allow Notifications</b>, then reopen the app.</p>`)
      : `<button class="btn yes" id="enable">🔔 ${asMom ? "चालू करें" : "Turn on"}</button>`}
  </div>`);
  on("enable", async () => {
    const p = await Notification.requestPermission();
    if (p === "granted") {
      pushRegistered = true;
      await registerPush(asMom).catch((e) => toast(`Could not register: ${e.message}`));
      toast(asMom ? "✅ नोटिफ़िकेशन चालू" : "✅ Notifications on");
    }
    route();
  });
}

async function registerPush(asMom) {
  if (!(await isSupported())) throw new Error("Push is not supported in this browser.");
  const config = firebaseApp._mommedsConfig;
  const reg = await navigator.serviceWorker.register(
    `/firebase-messaging-sw.js?config=${encodeURIComponent(JSON.stringify(config))}`,
  );
  await navigator.serviceWorker.ready;
  const messaging = getMessaging(firebaseApp);
  const token = await getToken(messaging, { vapidKey: me.vapidKey, serviceWorkerRegistration: reg });
  await api.call("registerDevice", { token, userAgent: navigator.userAgent });
  onMessage(messaging, (payload) => {
    if (asMom) {
      if (payload.data?.tag === "photo") localStorage.removeItem(SNOOZE_KEY);
      momHome();
    } else {
      toast(payload.notification?.body || "Update");
      adminHome();
    }
  });
}

// ---------- Mummy's screens ----------
async function momHome() {
  let s;
  try {
    s = await api.call("getStatus");
  } catch (e) {
    return errorScreen(e);
  }
  if (s.current) return askDose(s.current);
  if (s.photoRequested && !photoSnoozed()) return askPhoto();
  idleScreen(s);
}

function askDose(slot) {
  render(`<div class="screen ask">
    <button class="question" id="replay">
      <span class="emoji">💊</span>
      <span class="q">मम्मी, दवाई खा लिए?</span>
      <span class="sub">${esc(hiTime(slot.time))} की दवाई · 🔊</span>
    </button>
    <button class="btn yes huge" id="yes">हाँ</button>
    <button class="btn no" id="no">नहीं</button>
    ${speechSupported() ? `<button class="btn ghost" id="mic">🎤 बोलकर बताइए</button>` : ""}
  </div>`);
  on("replay", () => play("dose"));
  on("yes", () => answer(slot, "yes", "button"));
  on("no", () => answer(slot, "no", "button"));
  on("mic", () => listen(slot));
  play("dose"); // may be blocked until she taps 🔊
}

async function answer(slot, ans, via) {
  busy();
  try {
    await api.call("answerDose", { id: slot.id, answer: ans, via });
  } catch (e) {
    return errorScreen(e);
  }
  if (ans === "yes") {
    render(`<div class="screen center thanks">
      <div class="emoji">🙏</div>
      <p class="huge-text">शाबाश मम्मी!</p>
      <p class="big">दवाई खा ली ✅</p>
    </div>`);
    say("शाबाश मम्मी!");
  } else {
    render(`<div class="screen center">
      <div class="emoji">🙂</div>
      <p class="big">ठीक है मम्मी।</p>
      <p class="big">आधे घंटे में फिर याद दिलाएँगे।</p>
    </div>`);
    say("ठीक है मम्मी, आधे घंटे में फिर याद दिलाएंगे");
  }
  homeTimer = setTimeout(() => momHome(), 6000);
}

function speechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function listen(slot) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = "hi-IN";
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  const mic = document.getElementById("mic");
  mic.textContent = "🎤 सुन रहे हैं... बोलिए";
  mic.classList.add("listening");
  let handled = false;
  rec.onresult = (e) => {
    const heard = [...e.results[0]].map((r) => r.transcript);
    const ans = heard.map(parseAnswer).find(Boolean);
    handled = true;
    if (ans) answer(slot, ans, "voice");
    else {
      mic.textContent = `🎤 "${heard[0] || ""}" — समझ नहीं आया। बटन दबाइए`;
      mic.classList.remove("listening");
    }
  };
  rec.onerror = rec.onend = () => {
    if (!handled) {
      mic.textContent = "🎤 बोलकर बताइए";
      mic.classList.remove("listening");
    }
  };
  rec.start();
}

function askPhoto() {
  render(`<div class="screen ask">
    <button class="question" id="replay">
      <span class="emoji">📷</span>
      <span class="q">मम्मी, दवाई की बैग का फ़ोटो भेजो</span>
      <span class="sub">सारी दवाइयों के पत्ते टेबल पर रखकर फ़ोटो लीजिए · 🔊</span>
    </button>
    <label class="btn yes huge" for="cam">📷 फ़ोटो खींचिए</label>
    <input type="file" id="cam" accept="image/*" capture="environment" hidden>
    <button class="btn ghost" id="later">⏰ बाद में भेजूँगी</button>
  </div>`);
  on("replay", () => play("photo"));
  on("later", () => {
    snoozePhoto();
    momHome();
  });
  document.getElementById("cam").addEventListener("change", (e) => e.target.files[0] && sendPhoto(e.target.files[0]));
  play("photo");
}

// "Later" on the photo screen hides it for an hour (the next photo reminder comes then).
const SNOOZE_KEY = "photoSnoozedUntil";
function snoozePhoto() {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 60 * 60 * 1000));
  } catch {
    /* storage unavailable */
  }
}
function photoSnoozed() {
  try {
    return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now();
  } catch {
    return false;
  }
}

async function compress(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82).split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function sendPhoto(file) {
  busy("फ़ोटो भेज रहे हैं...");
  let res;
  try {
    res = await api.call("uploadPhoto", { image: await compress(file), mimeType: "image/jpeg" });
  } catch (e) {
    return errorScreen(e);
  }
  if (res.retakeAdvice) {
    render(`<div class="screen center">
      <div class="emoji">🤔</div>
      <p class="big">फ़ोटो साफ़ नहीं आया।</p>
      <p class="big">${esc(res.retakeAdvice)}</p>
      <label class="btn yes huge" for="cam">📷 फिर से खींचिए</label>
      <input type="file" id="cam" accept="image/*" capture="environment" hidden>
    </div>`);
    document.getElementById("cam").addEventListener("change", (e) => e.target.files[0] && sendPhoto(e.target.files[0]));
    return;
  }
  render(`<div class="screen center thanks">
    <div class="emoji">🙏</div>
    <p class="huge-text">धन्यवाद मम्मी!</p>
    <p class="big">फ़ोटो मिल गया ✅</p>
  </div>`);
  say("धन्यवाद मम्मी!");
  homeTimer = setTimeout(() => momHome(), 6000);
}

function idleScreen(s) {
  render(`<div class="screen center">
    <div class="emoji">🙂</div>
    <p class="huge-text">सब ठीक है, मम्मी!</p>
    ${s.next ? `<p class="big">अगली दवाई: ${esc(hiTime(s.next.time))}</p>` : ""}
    ${s.early ? `<button class="btn yes" id="early">✅ मैंने ${esc(s.early.label)} की दवाई खा ली</button>` : ""}
    <label class="btn ghost" for="cam">📷 दवाई का फ़ोटो भेजो</label>
    <input type="file" id="cam" accept="image/*" capture="environment" hidden>
    ${me.role === "admin" ? `<a class="btn ghost" href="/">← Admin dashboard</a>` : ""}
  </div>`);
  on("early", () => answer(s.early, "yes", "early"));
  document.getElementById("cam").addEventListener("change", (e) => e.target.files[0] && sendPhoto(e.target.files[0]));
}

// ---------- Admin dashboard ----------
const STATUS = {
  taken: ["✅", "Taken"],
  pending: ["⏳", "Waiting"],
  missed: ["❌", "Missed"],
};

function fmtTime(ms, tz) {
  return ms ? new Date(ms).toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : "";
}

function fmtDate(ms, tz) {
  return new Date(ms).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

async function adminHome() {
  let d;
  try {
    d = await api.call("adminDashboard");
  } catch (e) {
    return errorScreen(e);
  }
  const tz = d.config.timezone;
  const byId = Object.fromEntries(d.doses.map((x) => [x.id, x]));
  const days = [];
  for (let i = 0; i < 14; i++) {
    const t = Date.parse(`${d.today}T00:00:00Z`) - i * 86400000;
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  const momDevices = d.devices.filter((x) => x.role === "mom");
  const taken = d.doses.filter((x) => x.status === "taken").length;
  const total = d.doses.filter((x) => x.status !== "pending").length;

  const cell = (date, time) => {
    const x = byId[`${date}_${time.replace(":", "")}`];
    if (!x) return `<td class="muted">–</td>`;
    const [icon, label] = STATUS[x.status] || ["?", x.status];
    const detail = x.status === "taken"
      ? `${fmtTime(x.takenAt, tz)}${x.remindersSent > 1 ? ` · ${x.remindersSent} asks` : ""}`
      : `${x.remindersSent || 0} asks`;
    return `<td class="s-${esc(x.status)}" title="${esc(label)}">${icon}<small>${esc(detail)}</small></td>`;
  };

  const photoCard = (p) => {
    const a = p.analysis;
    const icon = a ? { consistent: "✅", inconsistent: "⚠️", unsure: "❓" }[a.verdict] : "⚠️";
    const meds = a?.medicines?.map((m) =>
      `<li>${esc(m.name)}: <b>${m.remaining >= 0 ? m.remaining : "?"}</b> left${m.remainingInPrevious >= 0 ? ` (was ${m.remainingInPrevious})` : ""}</li>`).join("") || "";
    return `<div class="photo">
      <a href="${esc(p.url)}" target="_blank"><img src="${esc(p.url)}" alt="medicine photo" loading="lazy"></a>
      <div>
        <p><b>${icon} ${esc(fmtDate(p.createdAt, tz))}</b></p>
        <p>${esc(a ? a.summary : `Automatic check failed: ${p.error || "unknown error"}`)}</p>
        ${meds ? `<ul>${meds}</ul>` : ""}
        ${a?.lowSupply ? `<p>🛒 <b>Running low — refill soon.</b></p>` : ""}
        ${p.log?.since ? `<p class="muted">Log since previous photo: ${p.log.taken} taken, ${p.log.missed} missed</p>` : ""}
      </div>
    </div>`;
  };

  render(`<div class="admin">
    <header><h1>💊 MomMeds</h1><button class="btn small ghost" id="out">Sign out</button></header>

    ${momDevices.length ? "" : `<div class="warn">⚠️ Mummy's phone is not registered for notifications yet. Log in on her iPhone and turn on notifications.</div>`}

    <section class="cards">
      <div class="card"><span class="num">${total ? Math.round((taken / total) * 100) : "–"}${total ? "%" : ""}</span><span>taken, last 14 days</span></div>
      <div class="card"><span class="num">${d.view.next ? esc(d.view.next.nice) : "–"}</span><span>next reminder</span></div>
      <div class="card"><span class="num">${d.state.lastPhotoDate ? esc(d.state.lastPhotoDate.slice(5)) : "–"}</span><span>last photo</span></div>
    </section>

    <section class="actions">
      <button class="btn" id="remind">🔔 Remind Mummy now</button>
      <button class="btn" id="photo">📷 Ask for photo now</button>
      <button class="btn ghost" id="testMom">Test Mummy's phone</button>
      <button class="btn ghost" id="testAdmin">Test my notifications</button>
      <a class="btn ghost" href="/?as=mom">👀 Mummy's screen</a>
    </section>

    <h2>Last 14 days</h2>
    <table class="log">
      <thead><tr><th>Date</th>${d.config.doseTimes.map((t) => `<th>${esc(t)}</th>`).join("")}</tr></thead>
      <tbody>${days.map((date) => `<tr><td>${esc(date.slice(5))}</td>${d.config.doseTimes.map((t) => cell(date, t)).join("")}</tr>`).join("")}</tbody>
    </table>

    <h2>Photo checks</h2>
    ${d.photos.length ? d.photos.map(photoCard).join("") : `<p class="muted">No photos yet.</p>`}

    <h2>Settings</h2>
    <p class="muted">
      Doses at ${d.config.doseTimes.map(esc).join(" & ")} (${esc(tz)}) · ask again every ${d.config.intervalMin} min ·
      alert you after ${d.config.alertAfter} unanswered · photo every ${d.config.photoEveryDays} days at ${esc(d.config.photoTime)} ·
      WhatsApp alerts ${d.config.whatsapp ? "on" : "off"} · ${momDevices.length} Mummy device(s), ${d.devices.length - momDevices.length} admin device(s).
      Change these in <code>functions/.env</code>.
    </p>
  </div>`);

  on("out", () => api.signOut());
  const act = (id, action, ok) => on(id, async () => {
    try {
      const r = await api.call("adminAction", { action });
      toast(r && r.devices === 0 ? "⚠️ No device registered to receive it" : ok);
    } catch (e) {
      toast(e.message);
    }
  });
  act("remind", "remindDose", "Reminder sent");
  act("photo", "requestPhoto", "Photo request sent");
  act("testMom", "testMom", "Test sent to Mummy's phone");
  act("testAdmin", "testAdmin", "Test sent to your devices");
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && me && !$app.querySelector("form")) route();
});

start();
