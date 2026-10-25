#!/bin/sh
# Regenerates reminder-schedule.js (browser copy) from the Edge Function source.
# Run this after editing supabase/functions/send-reminders/schedule.js
{
  echo "/* GENERATED from supabase/functions/send-reminders/schedule.js by build-schedule.sh. Do not edit by hand. */"
  echo "(function () {"
  sed -e '/^\/\/ @ts-nocheck/d' -e 's/^export //' supabase/functions/send-reminders/schedule.js
  echo "  window.SimpleReminders = { DEFAULTS, settingsWithDefaults, stepsFor, buildSchedule, dueSteps, describe, partsIn, zonedToUtc, fmtTime, fmtDateTime };"
  echo "})();"
} > reminder-schedule.js
