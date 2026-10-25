/* GENERATED from supabase/functions/send-reminders/schedule.js by build-schedule.sh. Do not edit by hand. */
(function () {
// SimpleTask reminder schedule: the ONE place that decides when reminders happen.
// The email job (Supabase Edge Function) and the app both use this same logic.
// Source of truth: supabase/functions/send-reminders/schedule.js
// (reminder-schedule.js in the website root is generated from it by build-schedule.sh)

const DEFAULTS = {
  intensity: "normal",   // off | gentle | normal | persistent
  daily_hour: 8,         // hour of day for the daily / "due today" reminder
  quiet_start: 22,       // no reminders from this hour...
  quiet_end: 7,          // ...until this hour (same start and end = no quiet hours)
  timezone: "Asia/Manila",
};

const LOW_STEPS = ["day1", "morning", "now"];
const GENTLE_STEPS = ["day1", "morning", "h1", "now"];
const NORMAL_STEPS = ["day3", "day2", "day1", "morning", "h6", "h3", "h2", "h1", "m30", "m10", "m5", "now"];
const PERSISTENT_STEPS = ["day5", "day4", "day3", "day2", "day1", "morning", "h6", "h5", "h4", "h3", "h2", "h1", "m45", "m30", "m20", "m10", "m5", "m2", "now"];

// Only these steps are EMAILED (email quota is limited, 200/month on the EmailJS free plan).
// Every other step is a free on-device alert, so those can be as frequent as we like.
const EMAIL_STEPS = ["day1", "morning", "h1", "m10"];
// Time-critical steps are never delayed by quiet hours or merged with neighbours
const EXEMPT = ["now", "m30", "m10", "m5", "m2"];
// Frequent device-only steps: never merged with neighbours, and skipped (not delayed) during quiet hours
const DENSE = ["h5", "h4", "h3", "h2", "m45", "m20"];
// When two reminders fall within MIN_GAP_MIN of each other, the earlier in this list wins
const KEEP_ORDER = ["now", "morning", "h1", "h6", "day1", "day2", "day3", "day4", "day5"];
const MIN_GAP_MIN = 90;

function settingsWithDefaults(s) {
  const out = Object.assign({}, DEFAULTS);
  Object.keys(DEFAULTS).forEach((k) => { if (s && s[k] !== null && s[k] !== undefined) out[k] = s[k]; });
  return out;
}

function stepsFor(intensity, priority) {
  if (intensity === "off") return [];
  let set = intensity === "gentle" ? GENTLE_STEPS : intensity === "persistent" ? PERSISTENT_STEPS : NORMAL_STEPS;
  if (priority === "Low") set = set.filter((k) => LOW_STEPS.indexOf(k) !== -1);
  else if (priority === "Medium") set = set.filter((k) => ["day5", "day4", "day3", "h6"].indexOf(k) === -1);
  return set;
}

/* ---------- time zone helpers (no libraries) ---------- */
function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o = {};
  f.formatToParts(date).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

// the real moment when the wall clock in `tz` reads y-m-d h:mi
function zonedToUtc(y, m, d, h, mi, tz) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    guess += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(guess);
}

function localAt(dueParts, dayOffset, hour, tz) {
  const t = new Date(Date.UTC(dueParts.y, dueParts.m - 1, dueParts.d + dayOffset));
  return zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), hour, 0, tz);
}

function inQuiet(hour, qs, qe) {
  if (qs === qe) return false;
  return qs > qe ? (hour >= qs || hour < qe) : (hour >= qs && hour < qe);
}

/* ---------- the schedule ---------- */
// Returns [{ key, at: Date, email: bool, alert: bool }] sorted by time
function buildSchedule(dueIso, priority, rawSettings, remindFromIso) {
  const s = settingsWithDefaults(rawSettings);
  const due = new Date(dueIso);
  const remindFrom = remindFromIso ? new Date(remindFromIso).getTime() : 0;
  const dueParts = partsIn(due, s.timezone);
  const dueMs = due.getTime();
  let items = [];

  stepsFor(s.intensity, priority).forEach((key) => {
    let at;
    if (/^day\d$/.test(key)) at = localAt(dueParts, -Number(key.slice(3)), s.daily_hour, s.timezone);
    else if (key === "morning") {
      at = localAt(dueParts, 0, s.daily_hour, s.timezone);
      if (at.getTime() > dueMs - 30 * 60000) return; // due too early in the day for a morning reminder
    } else if (key === "now") at = new Date(dueMs);
    else at = new Date(dueMs - (key[0] === "h" ? Number(key.slice(1)) * 60 : Number(key.slice(1))) * 60000);

    // quiet hours: move to the end of quiet time, or drop if that is too close to the deadline
    if (EXEMPT.indexOf(key) === -1) {
      const p = partsIn(at, s.timezone);
      if (inQuiet(p.h, s.quiet_start, s.quiet_end)) {
        if (DENSE.indexOf(key) !== -1) return; // frequent alerts are simply skipped overnight
        const dayShift = p.h >= s.quiet_start && s.quiet_start > s.quiet_end ? 1 : 0;
        at = localAt(p, dayShift, s.quiet_end, s.timezone);
        if (at.getTime() > dueMs - 30 * 60000) return;
      }
    }
    if (at.getTime() <= remindFrom) return; // already in the past when the task was created or changed
    items.push({ key, at, email: EMAIL_STEPS.indexOf(key) !== -1, alert: true });
  });

  // merge reminders that land too close together
  const kept = [];
  const NO_MERGE = EXEMPT.concat(DENSE);
  const critical = items.filter((it) => NO_MERGE.indexOf(it.key) !== -1);
  const regular = items.filter((it) => NO_MERGE.indexOf(it.key) === -1)
    .sort((a, b) => KEEP_ORDER.indexOf(a.key) - KEEP_ORDER.indexOf(b.key));
  critical.forEach((it) => kept.push(it));
  regular.forEach((it) => {
    const clash = kept.some((k) => NO_MERGE.indexOf(k.key) === -1 && Math.abs(k.at - it.at) < MIN_GAP_MIN * 60000);
    if (!clash) kept.push(it);
  });
  return kept.sort((a, b) => a.at - b.at);
}

// Reminders whose time has come and were not sent yet, for one channel ("email" or "alert").
// The caller should send only the LAST one (the most recent) and mark all of them as sent.
function dueSteps(task, rawSettings, sentKeys, nowMs, channel) {
  const dueMs = new Date(task.due_date).getTime();
  if (nowMs > dueMs + 60 * 60000) return []; // more than an hour late: stop
  const sent = sentKeys || [];
  return buildSchedule(task.due_date, task.priority, rawSettings, task.remind_from || task.created_at)
    .filter((s) => s[channel] && s.at.getTime() <= nowMs && sent.indexOf(s.key) === -1);
}

/* ---------- wording ---------- */
function fmtTime(date, tz) {
  return date.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
}
function fmtDateTime(date, tz) {
  return date.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

// "Due today at 5:00 PM (in 6 hours)", "Due tomorrow at 5:00 PM", "Due in 3 days (Fri, Oct 30, 5:00 PM)"
function describe(dueIso, nowMs, rawSettings) {
  const tz = settingsWithDefaults(rawSettings).timezone;
  const due = new Date(dueIso);
  const diff = due.getTime() - nowMs;
  const time = fmtTime(due, tz);
  if (diff <= 0) return "Due now (" + time + ")";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return "Due in " + mins + " minute" + (mins === 1 ? "" : "s") + " (" + time + ")";
  const a = partsIn(new Date(nowMs), tz), b = partsIn(due, tz);
  const dayDiff = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  if (dayDiff === 0) {
    const hrs = Math.round(diff / 3600000);
    return "Due today at " + time + " (in " + hrs + " hour" + (hrs === 1 ? "" : "s") + ")";
  }
  if (dayDiff === 1) return "Due tomorrow at " + time;
  return "Due in " + dayDiff + " days (" + fmtDateTime(due, tz) + ")";
}
  window.SimpleReminders = { DEFAULTS, settingsWithDefaults, stepsFor, buildSchedule, dueSteps, describe, partsIn, zonedToUtc, fmtTime, fmtDateTime };
})();
