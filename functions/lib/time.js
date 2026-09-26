// Small time-zone helpers built on Intl, so we don't need a date library.
// All "local" values are in Mummy's time zone (e.g. Asia/Kolkata).

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function parts(ms, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return p;
}

/** Local date ("2026-09-26") and time for an instant. */
export function localParts(ms, tz) {
  const p = parts(ms, tz);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    hhmm: `${p.hour}:${p.minute}`,
  };
}

function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant (ms) of a local wall-clock time, e.g. ("2026-09-26", "12:30"). */
export function zonedToUtc(date, hhmm, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

export function daysBetween(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / DAY);
}

export { MINUTE, DAY };
