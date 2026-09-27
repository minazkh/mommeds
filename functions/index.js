// MomMeds – reminds Mummy to take her medicines and keeps the family informed.
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineString, defineInt, defineBoolean, defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { randomUUID } from "node:crypto";

import { DEFAULTS, slotsAround, decideDose, doseView, decidePhoto } from "./lib/schedule.js";
import { localParts, addDays } from "./lib/time.js";
import { pushTo, whatsapp, deviceId } from "./lib/notify.js";
import { analyzePhoto, formatAnalysis } from "./lib/photo.js";

initializeApp();
const db = getFirestore();

// Same region as the Firestore database (Singapore), close to Mummy in India.
const REGION = "asia-southeast1";
setGlobalOptions({ region: REGION, maxInstances: 5 });

// ---- Configuration (set in functions/.env, see README) ----
const MOM_EMAIL = defineString("MOM_EMAIL", { description: "Login email for Mummy's phone" });
const ADMIN_EMAILS = defineString("ADMIN_EMAILS", { description: "Comma-separated admin login emails" });
const VAPID_KEY = defineString("VAPID_KEY", { description: "Firebase Cloud Messaging web push key pair" });
const TIMEZONE = defineString("TIMEZONE", { default: DEFAULTS.timezone });
const DOSE_TIMES = defineString("DOSE_TIMES", { default: DEFAULTS.doseTimes.join(",") });
const REMINDER_INTERVAL_MIN = defineInt("REMINDER_INTERVAL_MIN", { default: DEFAULTS.intervalMin });
const ALERT_AFTER_REMINDERS = defineInt("ALERT_AFTER_REMINDERS", { default: DEFAULTS.alertAfter });
const MAX_REMINDERS = defineInt("MAX_REMINDERS", { default: DEFAULTS.maxReminders });
const PHOTO_EVERY_DAYS = defineInt("PHOTO_EVERY_DAYS", { default: DEFAULTS.photoEveryDays });
const PHOTO_TIME = defineString("PHOTO_TIME", { default: DEFAULTS.photoTime });
const NOTIFY_ADMIN_ON_TAKEN = defineBoolean("NOTIFY_ADMIN_ON_TAKEN", { default: true });
const GEMINI_MODEL = defineString("GEMINI_MODEL", { default: "gemini-flash-latest" });
// Optional settings are read straight from functions/.env so deploy doesn't prompt for them.
// Empty or "none" means off.
function optional(name) {
  const v = (process.env[name] || "").trim();
  return v.toLowerCase() === "none" ? "" : v;
}
const whatsappConfig = () => ({ phone: optional("WHATSAPP_PHONE"), apiKey: optional("WHATSAPP_APIKEY") });
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

function cfg() {
  return {
    ...DEFAULTS,
    timezone: TIMEZONE.value(),
    doseTimes: DOSE_TIMES.value().split(",").map((s) => s.trim()).filter(Boolean).sort(),
    intervalMin: REMINDER_INTERVAL_MIN.value(),
    alertAfter: ALERT_AFTER_REMINDERS.value(),
    maxReminders: MAX_REMINDERS.value(),
    photoEveryDays: PHOTO_EVERY_DAYS.value(),
    photoTime: PHOTO_TIME.value(),
  };
}

function appUrl() {
  return optional("APP_URL") || `https://${process.env.GCLOUD_PROJECT}.web.app`;
}

function slotLabel(time) {
  const h = Number(time.slice(0, 2));
  if (h < 12) return "सुबह";
  if (h < 17) return "दोपहर";
  if (h < 20) return "शाम";
  return "रात";
}

function niceTime(time) {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// ---- Auth ----
function roleOf(req) {
  const email = req.auth?.token?.email?.toLowerCase();
  if (!email) throw new HttpsError("unauthenticated", "Please log in.");
  const admins = ADMIN_EMAILS.value().toLowerCase().split(",").map((s) => s.trim());
  if (admins.includes(email)) return "admin";
  if (email === MOM_EMAIL.value().toLowerCase().trim()) return "mom";
  throw new HttpsError("permission-denied", "This account is not set up for MomMeds.");
}

function requireAdmin(req) {
  if (roleOf(req) !== "admin") throw new HttpsError("permission-denied", "Admins only.");
}

// ---- Messages ----
function remindMom(slot, n) {
  return pushTo("mom", {
    title: "💊 मम्मी, दवाई खा लिए?",
    body: n === 1
      ? `${slotLabel(slot.time)} की दवाई का समय। यहाँ दबाइए 👆`
      : `याद से ${slotLabel(slot.time)} की दवाई खा लीजिए 🙏 यहाँ दबाइए 👆`,
    link: `${appUrl()}/?ask=dose`,
    tag: "dose",
  });
}

function askPhoto() {
  return pushTo("mom", {
    title: "📷 मम्मी, दवाई की बैग का फ़ोटो भेजो",
    body: "यहाँ दबाइए और फ़ोटो खींचिए 👆",
    link: `${appUrl()}/?ask=photo`,
    tag: "photo",
  });
}

async function alertAdmin(text, { urgent = true } = {}) {
  logger.info("Admin alert", { text });
  await pushTo("admin", { title: "MomMeds", body: text, link: `${appUrl()}/`, tag: `admin-${Date.now()}` });
  if (urgent) {
    const { phone, apiKey } = whatsappConfig();
    await whatsapp(phone, apiKey, `MomMeds: ${text}`);
  }
}

function doseAlertText(kind, slot, c) {
  const t = niceTime(slot.time);
  if (kind === "noAnswer") {
    const hours = (c.alertAfter * c.intervalMin) / 60;
    return `⏰ Mummy hasn't confirmed her ${t} medicine after ${c.alertAfter} reminders (${hours}h). Maybe give her a call.`;
  }
  return `❌ Mummy did not confirm her ${t} medicine today. Reminders have stopped.`;
}

// ---- Scheduler: runs every 5 minutes ----
export const tick = onSchedule({ schedule: "every 5 minutes", timeZone: "UTC" }, async () => {
  const c = cfg();
  const now = Date.now();

  for (const slot of slotsAround(now, c).filter((s) => s.start <= now)) {
    const ref = db.collection("doses").doc(slot.id);
    const d = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const decision = decideDose(slot, snap.exists ? snap.data() : null, now, c);
      if (decision.write) tx.set(ref, decision.write, { merge: true });
      return decision;
    });
    if (d.remind) await remindMom(slot, d.remind);
    if (d.adminAlert) await alertAdmin(doseAlertText(d.adminAlert, slot, c));
  }

  const stateRef = db.doc("meta/state");
  const p = await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    const decision = decidePhoto(now, c, snap.data() || {});
    if (decision.request) tx.set(stateRef, { photoRequest: decision.request }, { merge: true });
    return decision;
  });
  if (p.remind) await askPhoto();
  if (p.adminAlert) await alertAdmin("📷 Mummy hasn't sent today's medicine photo after 3 reminders.");
});

// ---- Callable functions used by the app ----
async function loadDoseDocs(now, c) {
  const refs = slotsAround(now, c).map((s) => db.collection("doses").doc(s.id));
  const snaps = await db.getAll(...refs);
  return Object.fromEntries(snaps.filter((s) => s.exists).map((s) => [s.id, s.data()]));
}

function slotJson(slot) {
  return slot && { id: slot.id, date: slot.date, time: slot.time, label: slotLabel(slot.time), nice: niceTime(slot.time) };
}

export const whoami = onCall(async (req) => {
  const c = cfg();
  return { role: roleOf(req), vapidKey: VAPID_KEY.value(), timezone: c.timezone, doseTimes: c.doseTimes };
});

export const registerDevice = onCall(async (req) => {
  const role = roleOf(req);
  const token = String(req.data?.token || "");
  if (token.length < 20) throw new HttpsError("invalid-argument", "Missing token.");
  await db.collection("devices").doc(deviceId(token)).set({
    token,
    role,
    email: req.auth.token.email,
    userAgent: String(req.data?.userAgent || "").slice(0, 300),
    updatedAt: Date.now(),
  });
  return { ok: true };
});

export const getStatus = onCall(async (req) => {
  roleOf(req);
  const c = cfg();
  const now = Date.now();
  const docs = await loadDoseDocs(now, c);
  const view = doseView(now, c, docs);
  const state = (await db.doc("meta/state").get()).data() || {};
  return {
    current: view.current && { ...slotJson(view.current), status: docs[view.current.id]?.status || "pending" },
    next: slotJson(view.next),
    early: slotJson(view.early),
    photoRequested: state.photoRequest?.status === "pending",
  };
});

export const answerDose = onCall(async (req) => {
  const role = roleOf(req);
  const answer = req.data?.answer;
  if (!["yes", "no"].includes(answer)) throw new HttpsError("invalid-argument", "answer must be yes or no");
  const via = ["button", "voice", "early"].includes(req.data?.via) ? req.data.via : "button";

  const c = cfg();
  const now = Date.now();
  const view = doseView(now, c, await loadDoseDocs(now, c));
  const slot = [view.current, view.early].find((s) => s && s.id === req.data?.id) || view.current || view.early;
  if (!slot) throw new HttpsError("failed-precondition", "No medicine is due right now.");

  const ref = db.collection("doses").doc(slot.id);
  const record = { answer, at: now, via, by: role };
  const before = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists ? snap.data() : null;
    const base = doc ? {} : {
      date: slot.date, time: slot.time, start: slot.start, createdAt: now, remindersSent: 0, lastPromptAt: now,
    };
    if (answer === "yes") {
      tx.set(ref, { ...base, status: "taken", takenAt: now, answers: FieldValue.arrayUnion(record) }, { merge: true });
    } else if (doc?.status !== "taken") {
      // Ask again one interval from now (a dose already marked missed stays missed).
      const status = doc?.status === "missed" ? "missed" : "pending";
      tx.set(ref, { ...base, status, lastPromptAt: now, answers: FieldValue.arrayUnion(record) }, { merge: true });
    }
    return doc;
  });

  if (answer === "yes" && before?.status !== "taken") {
    const t = localParts(now, c.timezone).hhmm;
    const who = role === "admin" ? " (marked by admin)" : "";
    if (before?.status === "missed") {
      await alertAdmin(`✅ Mummy confirmed her ${niceTime(slot.time)} medicine late, at ${niceTime(t)}${who}.`);
    } else if (NOTIFY_ADMIN_ON_TAKEN.value()) {
      const n = before?.remindersSent || 0;
      const after = via === "early" ? "before the reminder" : `after ${n} reminder${n === 1 ? "" : "s"}`;
      await alertAdmin(`✅ Mummy took her ${niceTime(slot.time)} medicine at ${niceTime(t)}, ${after}${who}.`, { urgent: false });
    }
  }
  return { ok: true, slot: slotJson(slot) };
});

export const uploadPhoto = onCall(
  { secrets: [GEMINI_API_KEY], timeoutSeconds: 120, memory: "512MiB" },
  async (req) => {
    const role = roleOf(req);
    const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(req.data?.mimeType) ? req.data.mimeType : "image/jpeg";
    const data = Buffer.from(String(req.data?.image || ""), "base64");
    if (data.length < 1000 || data.length > 8 * 1024 * 1024) throw new HttpsError("invalid-argument", "Bad image.");

    const c = cfg();
    const now = Date.now();
    const bucket = getStorage().bucket();
    const path = `photos/${new Date(now).toISOString().replace(/[:.]/g, "-")}.jpg`;
    const token = randomUUID();
    await bucket.file(path).save(data, {
      contentType: mimeType,
      metadata: { metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

    // Previous photo + what the reminder log says since then.
    const prevSnap = await db.collection("photos").orderBy("createdAt", "desc").limit(1).get();
    const prev = prevSnap.docs[0]?.data() || null;
    let previous = null;
    const log = { taken: 0, missed: 0, since: null, dosesPerDay: c.doseTimes.length };
    if (prev) {
      const [prevData] = await bucket.file(prev.path).download().catch(() => [null]);
      if (prevData) {
        previous = {
          data: prevData,
          mimeType: prev.mimeType || "image/jpeg",
          takenAt: `${Math.round((now - prev.createdAt) / 3600000)} hours ago`,
        };
      }
      const doses = await db.collection("doses").where("start", ">=", prev.createdAt).get();
      for (const d of doses.docs) {
        if (d.get("start") > now) continue;
        if (d.get("status") === "taken") log.taken++;
        else log.missed++;
      }
      log.since = new Date(prev.createdAt).toISOString();
    }

    let analysis = null;
    let error = null;
    try {
      analysis = await analyzePhoto({
        apiKey: GEMINI_API_KEY.value(), model: GEMINI_MODEL.value(), image: { data, mimeType }, previous, log,
      });
    } catch (e) {
      logger.error("Gemini analysis failed", e);
      error = String(e.message || e).slice(0, 300);
    }

    await db.collection("photos").add({ path, url, mimeType, createdAt: now, by: role, log, analysis, error });
    const today = localParts(now, c.timezone).date;
    await db.runTransaction(async (tx) => {
      const ref = db.doc("meta/state");
      const state = (await tx.get(ref)).data() || {};
      const update = { lastPhotoDate: today };
      if (state.photoRequest?.status === "pending") update.photoRequest = { ...state.photoRequest, status: "done" };
      tx.set(ref, update, { merge: true });
    });

    const text = analysis
      ? `📷 New medicine photo. ${formatAnalysis(analysis)}`
      : "📷 Mummy sent a medicine photo, but the automatic check failed. Please look at it in the app.";
    await alertAdmin(text, { urgent: !analysis || analysis.verdict === "inconsistent" || analysis.lowSupply });

    return { ok: true, retakeAdvice: analysis && !analysis.medicinesVisible ? analysis.retakeAdvice || "" : "" };
  },
);

export const adminDashboard = onCall(async (req) => {
  requireAdmin(req);
  const c = cfg();
  const now = Date.now();
  const today = localParts(now, c.timezone).date;
  const [doses, photos, devices, state] = await Promise.all([
    db.collection("doses").where("date", ">=", addDays(today, -13)).get(),
    db.collection("photos").orderBy("createdAt", "desc").limit(10).get(),
    db.collection("devices").get(),
    db.doc("meta/state").get(),
  ]);
  return {
    today,
    config: { ...c, appUrl: appUrl(), whatsapp: Boolean(whatsappConfig().phone && whatsappConfig().apiKey) },
    doses: doses.docs.map((d) => ({ id: d.id, ...d.data() })),
    photos: photos.docs.map((d) => ({ id: d.id, ...d.data() })),
    devices: devices.docs.map((d) => {
      const { role, email, userAgent, updatedAt } = d.data();
      return { role, email, userAgent, updatedAt };
    }),
    state: state.data() || {},
    view: (() => {
      const v = doseView(now, c, {});
      return { next: slotJson(v.next) };
    })(),
  };
});

export const adminAction = onCall(async (req) => {
  requireAdmin(req);
  const c = cfg();
  const now = Date.now();
  switch (req.data?.action) {
    case "remindDose": {
      const docs = await loadDoseDocs(now, c);
      const { current } = doseView(now, c, docs);
      if (!current || docs[current.id]?.status === "taken") {
        throw new HttpsError("failed-precondition", "No medicine is waiting for an answer right now.");
      }
      return remindMom(current, 2);
    }
    case "requestPhoto": {
      const today = localParts(now, c.timezone).date;
      await db.doc("meta/state").set(
        { photoRequest: { date: today, status: "pending", remindersSent: 1, lastPromptAt: now } },
        { merge: true },
      );
      return askPhoto();
    }
    case "testMom":
      return pushTo("mom", { title: "🙂 टेस्ट", body: "नोटिफ़िकेशन ठीक काम कर रहा है", link: `${appUrl()}/`, tag: "test" });
    case "testAdmin":
      return pushTo("admin", { title: "MomMeds test", body: "Admin notifications are working ✅", link: `${appUrl()}/`, tag: "test" });
    default:
      throw new HttpsError("invalid-argument", "Unknown action.");
  }
});
