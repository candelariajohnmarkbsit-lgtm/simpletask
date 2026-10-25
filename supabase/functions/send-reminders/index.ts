// SimpleTask reminder job (Supabase Edge Function)
// Runs every 5 minutes (see README). For every pending task it checks the
// escalating schedule in schedule.js and emails the student when a step is due:
// daily at the chosen hour in the last days, a "due today" reminder in the morning,
// then 6 hours / 1 hour before, and "due now". Each step is sent once.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { dueSteps, describe, fmtDateTime, settingsWithDefaults } from "./schedule.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const EMAILJS_SERVICE_ID = Deno.env.get("EMAILJS_SERVICE_ID")!;
const EMAILJS_TEMPLATE_ID = Deno.env.get("EMAILJS_TEMPLATE_ID")!;
const EMAILJS_PUBLIC_KEY = Deno.env.get("EMAILJS_PUBLIC_KEY")!;
const EMAILJS_PRIVATE_KEY = Deno.env.get("EMAILJS_PRIVATE_KEY")!;

const LOOKAHEAD_DAYS = 6;           // longest schedule starts 5 days before the deadline
const MAX_EMAIL_AGE_HOURS = 12;     // a reminder older than this is marked as sent but not emailed
const MAX_EMAILS_PER_RUN = 40;      // safety cap for the email quota
const DELAY_BETWEEN_EMAILS_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const nowMs = Date.now();

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, user_id, title, priority, due_date, remind_from, created_at, reminder_steps")
    .eq("is_completed", false)
    .gt("due_date", new Date(nowMs - 60 * 60000).toISOString())
    .lte("due_date", new Date(nowMs + LOOKAHEAD_DAYS * 86400000).toISOString());

  if (error) return new Response(error.message, { status: 500 });
  if (!tasks || tasks.length === 0) return Response.json({ checked: 0, sent: 0 });

  const userIds = [...new Set(tasks.map((t) => t.user_id))];
  const { data: settingsRows } = await supabase.from("user_settings").select("*").in("user_id", userIds);
  const settingsByUser = new Map((settingsRows ?? []).map((s) => [s.user_id, s]));

  const userCache = new Map<string, { email: string; name: string } | null>();
  async function getUser(id: string) {
    if (userCache.has(id)) return userCache.get(id)!;
    const { data } = await supabase.auth.admin.getUserById(id);
    const u = data?.user;
    const info = u?.email
      ? { email: u.email, name: (u.user_metadata?.full_name as string) || u.email.split("@")[0] }
      : null;
    userCache.set(id, info);
    return info;
  }

  let sent = 0;
  const failures: string[] = [];
  const skipped: string[] = [];

  for (const task of tasks) {
    const row = settingsByUser.get(task.user_id);
    if (row && row.email_reminders === false) continue;
    const settings = settingsWithDefaults(row);

    const already: string[] = task.reminder_steps ?? [];
    const due = dueSteps(task, settings, already, nowMs, "email");
    if (due.length === 0) continue;

    // Send only the most recent step; older missed steps are marked as sent without an email
    const latest = due[due.length - 1];
    const allKeys = [...new Set([...already, ...due.map((s: { key: string }) => s.key)])];
    const ageHours = (nowMs - latest.at.getTime()) / 3600000;

    if (ageHours > MAX_EMAIL_AGE_HOURS) {
      await supabase.from("tasks").update({ reminder_steps: allKeys }).eq("id", task.id);
      skipped.push(`${task.id}:${latest.key}`);
      continue;
    }
    if (sent >= MAX_EMAILS_PER_RUN) break; // the rest is picked up on the next run

    const user = await getUser(task.user_id);
    if (!user) continue;

    if (sent > 0) await sleep(DELAY_BETWEEN_EMAILS_MS);
    const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID,
        template_id: EMAILJS_TEMPLATE_ID,
        user_id: EMAILJS_PUBLIC_KEY,
        accessToken: EMAILJS_PRIVATE_KEY,
        template_params: {
          to_email: user.email,
          name: user.name,
          title: task.title,
          priority: task.priority,
          due_date: fmtDateTime(new Date(task.due_date), settings.timezone),
          reminder_type: describe(task.due_date, nowMs, settings),
        },
      }),
    });

    if (!res.ok) {
      failures.push(`${task.id}: ${res.status} ${await res.text()}`);
      continue; // not marked, so it is retried on the next run
    }

    await supabase.from("tasks").update({ reminder_steps: allKeys }).eq("id", task.id);
    await supabase.from("reminders").insert({ task_id: task.id, user_id: task.user_id, channel: "email", step: latest.key });
    sent++;
  }

  return Response.json({ checked: tasks.length, sent, skipped, failures });
});
