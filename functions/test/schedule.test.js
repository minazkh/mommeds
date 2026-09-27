import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, slotsAround, decideDose, doseView, decidePhoto, parseAnswer, slotId } from "../lib/schedule.js";
import { zonedToUtc, localParts } from "../lib/time.js";

const cfg = { ...DEFAULTS, doseTimes: ["12:30", "21:00"] };
const at = (date, hhmm) => zonedToUtc(date, hhmm, cfg.timezone);
const MIN = 60 * 1000;

test("zonedToUtc handles India time", () => {
  assert.equal(new Date(at("2026-09-26", "12:30")).toISOString(), "2026-09-26T07:00:00.000Z");
  assert.deepEqual(localParts(at("2026-09-26", "21:00"), cfg.timezone).hhmm, "21:00");
});

test("zonedToUtc handles DST zones", () => {
  const ny = zonedToUtc("2026-07-01", "09:00", "America/New_York");
  assert.equal(new Date(ny).toISOString(), "2026-07-01T13:00:00.000Z");
});

function simulate(fromHHMM, minutes, answerAt = {}) {
  // Runs the scheduler every 5 minutes for the 12:30 slot.
  const slot = slotsAround(at("2026-09-26", "12:30"), cfg).find((s) => s.id === "2026-09-26_1230");
  let doc = null;
  const reminders = [];
  const alerts = [];
  for (let t = at("2026-09-26", fromHHMM); t <= at("2026-09-26", fromHHMM) + minutes * MIN; t += 5 * MIN) {
    const hhmm = localParts(t, cfg.timezone).hhmm;
    if (answerAt[hhmm] && doc) {
      if (answerAt[hhmm] === "yes") doc = { ...doc, status: "taken" };
      else doc = { ...doc, lastPromptAt: t };
    }
    const d = decideDose(slot, doc, t + 4000, cfg); // scheduler fires a few seconds late
    if (d.write) doc = { ...(doc || {}), ...d.write };
    if (d.remind) reminders.push(hhmm);
    if (d.adminAlert) alerts.push(`${d.adminAlert}@${hhmm}`);
  }
  return { doc, reminders, alerts };
}

test("reminds every 30 minutes, alerts admin after 4, marks missed after 8", () => {
  const { doc, reminders, alerts } = simulate("12:00", 6 * 60);
  assert.deepEqual(reminders, ["12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);
  assert.deepEqual(alerts, ["noAnswer@14:30", "missed@16:30"]);
  assert.equal(doc.status, "missed");
});

test("stops reminding once she says Haan", () => {
  const { doc, reminders, alerts } = simulate("12:30", 4 * 60, { "13:10": "yes" });
  assert.deepEqual(reminders, ["12:30", "13:00"]);
  assert.deepEqual(alerts, []);
  assert.equal(doc.status, "taken");
});

test("Nahi pushes the next reminder 30 minutes from the answer", () => {
  const { reminders } = simulate("12:30", 90, { "12:40": "no" });
  assert.deepEqual(reminders, ["12:30", "13:10", "13:40"]);
});

test("does not start reminding for a slot that is long over", () => {
  const slot = { id: "x", date: "2026-09-26", time: "12:30", start: at("2026-09-26", "12:30") };
  assert.equal(decideDose(slot, null, at("2026-09-26", "18:00"), cfg).remind, null);
});

test("doseView shows current, next and early slots", () => {
  let v = doseView(at("2026-09-26", "12:45"), cfg, {});
  assert.equal(v.current.id, "2026-09-26_1230");
  assert.equal(v.next.id, "2026-09-26_2100");
  assert.equal(v.early, null);

  const taken = { "2026-09-26_1230": { status: "taken" } };
  v = doseView(at("2026-09-26", "19:00"), cfg, taken);
  assert.equal(v.current, null);
  assert.equal(v.early.id, "2026-09-26_2100");

  v = doseView(at("2026-09-27", "08:00"), cfg, { "2026-09-26_2100": { status: "taken" } });
  assert.equal(v.current, null);
  assert.equal(v.next.id, slotId("2026-09-27", "12:30"));
});

test("photo requested every 3 days at photo time, reminded, then admin alerted", () => {
  let state = {};
  assert.equal(decidePhoto(at("2026-09-26", "17:00"), cfg, state).remind, null);

  let d = decidePhoto(at("2026-09-26", "18:00"), cfg, state);
  assert.equal(d.remind, 1);
  state = { photoRequest: d.request };

  d = decidePhoto(at("2026-09-26", "19:00"), cfg, state);
  assert.equal(d.remind, 2);
  state = { photoRequest: d.request };
  d = decidePhoto(at("2026-09-26", "20:00"), cfg, state);
  state = { photoRequest: d.request };
  d = decidePhoto(at("2026-09-26", "21:00"), cfg, state);
  assert.equal(d.adminAlert, "photoMissed");
  state = { photoRequest: d.request };

  assert.equal(decidePhoto(at("2026-09-28", "18:00"), cfg, state).remind, null);
  assert.equal(decidePhoto(at("2026-09-29", "18:00"), cfg, state).remind, 1);
});

test("a photo she sends on her own resets the 3-day clock", () => {
  const state = { photoRequest: { date: "2026-09-20", status: "done" }, lastPhotoDate: "2026-09-25" };
  assert.equal(decidePhoto(at("2026-09-26", "18:00"), cfg, state).remind, null);
  assert.equal(decidePhoto(at("2026-09-28", "18:00"), cfg, state).remind, 1);
});

test("parseAnswer understands Hindi and Hinglish", () => {
  for (const s of ["हाँ", "Haan", "haan ji", "हां खा ली", "yes", "kha liya"]) assert.equal(parseAnswer(s), "yes", s);
  for (const s of ["नहीं", "Nahi", "abhi nahi", "no", "नहीं खाई"]) assert.equal(parseAnswer(s), "no", s);
  assert.equal(parseAnswer("kya?"), null);
});
