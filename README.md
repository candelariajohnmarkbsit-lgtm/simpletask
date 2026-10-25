# SimpleTask (revised to match the thesis)

Your Supabase URL and anon key in `supabase-config.js` and your EmailJS IDs in `dashboard.js` are unchanged.

## Setup (do these in order)

### 1. Database (required, 2 minutes)
Supabase dashboard > **SQL Editor** > paste all of `supabase-setup.sql` > **Run**.
It adds the task columns, the reminder settings and reminders tables, Row Level Security, and Realtime. It is safe to run again on your existing project, and **you must re-run it for this version** because it adds the new reminder columns and the `category` column (without it, adding tasks will fail).

### 2. Allow the new redirect pages (required for password reset)
Supabase > **Authentication > URL Configuration** > add to *Redirect URLs*:
- `https://YOUR-SITE.vercel.app/reset.html`
- `https://YOUR-SITE.vercel.app/dashboard.html`
- `http://localhost:3000/**` (only if you test locally)

### 3. Deploy to Vercel
Upload this whole folder (or push it to GitHub and import it). No build step. PWA install needs HTTPS, which Vercel provides.

### 4. Automatic email reminders (escalating schedule)
You need the Supabase CLI (`npm i -g supabase`). If you deployed the old version, just run the last command again to update it.

```bash
supabase login
supabase link --project-ref zpymkpckhxhqzdxzjyjz

supabase secrets set CRON_SECRET=pick-a-long-random-string \
  EMAILJS_SERVICE_ID=service_4g7mzax \
  EMAILJS_TEMPLATE_ID=template_t134fuk \
  EMAILJS_PUBLIC_KEY=w-dwTHaUHmgYkLXuG \
  EMAILJS_PRIVATE_KEY=your-emailjs-private-key

supabase functions deploy send-reminders --no-verify-jwt
```
- EmailJS dashboard > **Account > Security**: turn ON "Allow EmailJS API for non-browser applications" and copy your **Private Key**.
- In your EmailJS template, add `{{reminder_type}}` (for example in the subject or the first line). It carries the wording such as "Due today at 5:00 PM (in 6 hours)".

Schedule it **every 5 minutes** (SQL Editor). If you already created the old 15-minute job, this replaces it:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('simpletask-reminders') where exists (select 1 from cron.job where jobname = 'simpletask-reminders');

select cron.schedule('simpletask-reminders', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://zpymkpckhxhqzdxzjyjz.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','SAME-CRON_SECRET-AS-ABOVE'),
    body := '{}'::jsonb
  );
$$);
```

#### How the reminders work
Each student chooses **Off / Gentle / Normal / Persistent**, a daily reminder time (default 8:00 AM) and quiet hours (default 10 PM to 7 AM) in *Reminder settings*. For a task due Friday at 5:00 PM on Normal:

| When | Reminder | Email | Device alert |
|---|---|---|---|
| Tue, Wed, Thu 8 AM | Due in 3 days / 2 days / tomorrow | yes | yes |
| Fri 8 AM | Due today at 5:00 PM | yes | yes |
| Fri 11 AM | 6 hours left | yes | yes |
| Fri 4 PM | 1 hour left | yes | yes |
| Fri 4:50 PM | 10 minutes left | no | yes |
| Fri 5 PM | Due now | yes | yes |

- Each step is sent **once**. Completing a task stops everything. Changing the deadline restarts the schedule from that moment.
- Steps already in the past when a task is created are skipped. A task created at 2 PM and due at 5 PM only gets the 1 hour, 10 minute and "due now" reminders.
- If two reminders fall within 90 minutes of each other, the more useful one is kept (for example a task due at 9 AM gets one "due today" at 8 AM, not three).
- Quiet hours delay reminders to the end of the quiet period. "Due now" and the 10-minute alert are never delayed.
- **Priority:** High gets the full schedule, Medium skips the 3-days-before and 6-hours steps, Low gets only the day before, the morning, and the deadline.
- **Email quota:** a High task on Normal sends up to 7 emails. The EmailJS free plan allows 200 per month, so Gentle (3 per task) is kinder if you expect many tasks. The job sends at most 40 emails per run.
- The schedule lives in one file, `supabase/functions/send-reminders/schedule.js`. After editing it, run `./build-schedule.sh` to regenerate `reminder-schedule.js` (the copy the website uses), then redeploy the function.

### 5. Test the PWA
Open the deployed site in Chrome > the **Install app** button appears (iPhone: Share > Add to Home Screen). Log in once online, then turn on airplane mode and reopen: tasks still load, and you can add, edit and delete. Changes sync when you reconnect.

## What changed, mapped to the thesis

| Thesis feature | Where |
|---|---|
| PWA (Service Worker + Web App Manifest), offline access | `sw.js`, `manifest.json`, `pwa.js`, `icons/` |
| Offline task entry, then sync | `dashboard.js` (local cache + sync queue) |
| Quick-capture entry (title only) | Quick Add box: defaults to Medium, due tomorrow 11:59 PM |
| Description, time estimation | Task form and edit dialog, shown on list, calendar, and "planned workload" |
| Edit task | Edit button, or tap a task on the calendar |
| Task categories (Assignment, Project, Presentation, Exam / Quiz, Reading, Report / Paper, Group Work, Personal, Other) | `category` column, dropdown in the task form and edit dialog, badge and filter in the list |
| Prioritization and deadline organization | Sort (priority + deadline / deadline / priority) and filters |
| Deadline monitoring | "Due in 48 Hours" and "Overdue" cards |
| Task progress | Progress bar |
| Visual calendar | FullCalendar: month, week, list. Estimated tasks show as a block ending at the deadline |
| Reminders and notifications | Escalating schedule: email job (`supabase/functions/send-reminders`), device alerts, reminder settings (intensity, daily time, quiet hours) |
| Reminders stored in the database | `reminders` and `user_settings` tables |
| Real-time data handling | Supabase Realtime subscription |
| Data security | Row Level Security on every table, no raw HTML injection |
| Forgot password, Remember me | `reset.html`, `supabase-client.js` |
| Tailwind CSS | Loaded on the dashboard for layout utilities, alongside `style.css` |

## Things to know (be honest in your thesis)
- **Push when the app is fully closed:** the email job covers that case. True background Web Push needs a push server and VAPID keys, which this version does not include. `sw.js` already has the `push` handler ready for it. Your Limitations section already mentions iOS and third-party limits, which fits.
- **Tailwind:** the dashboard uses the Tailwind CDN build, which is meant for development. For a stricter match, replace it with a compiled Tailwind build later. `style.css` still carries most of the styling.
- **Survey, Alpha and Beta testing, ISO 25010 results:** these are thesis work, not code.
- The "Email me a copy of this task" box is now unchecked by default so quick-adding does not use up your EmailJS quota.
"# simpletask" 
