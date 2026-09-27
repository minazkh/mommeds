// Pure decision logic for reminders. No Firebase in here, so it is easy to test.
import { localParts, zonedToUtc, addDays, daysBetween, MINUTE } from "./time.js";

export const DEFAULTS = {
  timezone: "Asia/Kolkata",
  doseTimes: ["09:00", "21:00"],
  intervalMin: 30, // ask again this often while she hasn't said "Haan"
  alertAfter: 4, // tell the admin after this many unanswered reminders
  maxReminders: 8, // after this many, stop and mark the dose as missed
  toleranceMin: 3, // scheduler runs every 5 min; don't slip a whole tick
  earlyWindowMin: 180, // "Maine kha li" can be pressed up to 3h before a dose
  photoEveryDays: 3,
  photoTime: "18:00",
  photoIntervalMin: 60,
  photoMaxReminders: 3,
};

export function slotId(date, time) {
  return `${date}_${time.replace(":", "")}`;
}

/** Dose slots for yesterday, today and tomorrow (local), oldest first. */
export function slotsAround(now, cfg) {
  const today = localParts(now, cfg.timezone).date;
  const out = [];
  for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
    for (const time of cfg.doseTimes) {
      out.push({ id: slotId(date, time), date, time, start: zonedToUtc(date, time, cfg.timezone) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function reminderWindow(cfg) {
  return cfg.maxReminders * cfg.intervalMin * MINUTE;
}

/**
 * What the scheduler should do for one dose slot right now.
 * Returns { write, remind, adminAlert }:
 *   write      – fields to create/merge on the dose doc (null = nothing)
 *   remind     – reminder number to send to Mummy (null = don't)
 *   adminAlert – "noAnswer" | "missed" | null
 */
export function decideDose(slot, doc, now, cfg) {
  const none = { write: null, remind: null, adminAlert: null };
  if (now < slot.start) return none;

  if (!doc) {
    if (now - slot.start >= reminderWindow(cfg)) return none; // too old (e.g. app just installed)
    return {
      write: {
        date: slot.date,
        time: slot.time,
        start: slot.start,
        status: "pending",
        remindersSent: 1,
        lastPromptAt: now,
        createdAt: now,
        answers: [],
      },
      remind: 1,
      adminAlert: null,
    };
  }

  if (doc.status !== "pending") return none;

  const interval = cfg.intervalMin * MINUTE;
  if (now - doc.lastPromptAt < interval - cfg.toleranceMin * MINUTE) return none;

  if (doc.remindersSent >= cfg.maxReminders) {
    return { write: { status: "missed", missedAt: now }, remind: null, adminAlert: "missed" };
  }

  const n = doc.remindersSent + 1;
  const write = { remindersSent: n, lastPromptAt: now };
  let adminAlert = null;
  if (doc.remindersSent >= cfg.alertAfter && !doc.adminAlerted) {
    adminAlert = "noAnswer";
    write.adminAlerted = true;
  }
  return { write, remind: n, adminAlert };
}

/**
 * What Mummy's screen should show about doses.
 * docs: map of slot id -> dose doc (for the ids from slotsAround).
 */
export function doseView(now, cfg, docs) {
  const slots = slotsAround(now, cfg);
  const started = slots.filter((s) => s.start <= now);
  const upcoming = slots.filter((s) => s.start > now);
  const latest = started[started.length - 1];

  let current = null;
  if (latest) {
    const doc = docs[latest.id];
    if (doc ? ["pending", "missed"].includes(doc.status) : now - latest.start < reminderWindow(cfg)) {
      current = latest;
    }
  }

  const next = upcoming[0] || null;
  const early =
    next && !docs[next.id] && next.start - now <= cfg.earlyWindowMin * MINUTE ? next : null;

  return { current, next, early };
}

/**
 * Photo request logic. state is the meta/state doc:
 *   { photoRequest: {date, status, remindersSent, lastPromptAt}, lastPhotoDate }
 * Returns { request, remind, adminAlert } where request is the new
 * photoRequest value to store (null = unchanged).
 */
export function decidePhoto(now, cfg, state = {}) {
  const none = { request: null, remind: null, adminAlert: null };
  const req = state.photoRequest;
  const { date: today, hhmm } = localParts(now, cfg.timezone);

  if (req && req.status === "pending") {
    const interval = cfg.photoIntervalMin * MINUTE;
    if (now - req.lastPromptAt < interval - cfg.toleranceMin * MINUTE) return none;
    if (req.remindersSent >= cfg.photoMaxReminders) {
      return { request: { ...req, status: "missed" }, remind: null, adminAlert: "photoMissed" };
    }
    const n = req.remindersSent + 1;
    return { request: { ...req, remindersSent: n, lastPromptAt: now }, remind: n, adminAlert: null };
  }

  const last = [req?.date, state.lastPhotoDate].filter(Boolean).sort().pop();
  const due = !last || daysBetween(last, today) >= cfg.photoEveryDays;
  if (!due || hhmm < cfg.photoTime) return none;
  return {
    request: { date: today, status: "pending", remindersSent: 1, lastPromptAt: now },
    remind: 1,
    adminAlert: null,
  };
}

/** Very small Hindi/Hinglish yes/no detector for voice answers. */
export function parseAnswer(text) {
  const t = ` ${String(text).toLowerCase().replace(/[.,!?।]/g, " ")} `;
  if (/(नहीं|नही|nahi|nahin|nai|\bno\b|\bna\b|ना )/.test(t)) return "no";
  if (/(हाँ|हां|हा |haan|\bhan\b|\bhaa?\b|\bhanji\b|\byes\b|खा ली|खा लिया|खा लिए|kha li|kha liya|kha liye|ले ली|le li)/.test(t)) {
    return "yes";
  }
  return null;
}
