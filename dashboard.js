(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Config (EmailJS IDs kept from the original version)
     ------------------------------------------------------------------ */
  const EMAILJS_SERVICE_ID = "service_4g7mzax";
  const EMAILJS_TEMPLATE_ID = "template_t134fuk";
  const EMAILJS_PUBLIC_KEY = "w-dwTHaUHmgYkLXuG";

  const supabaseClient = window.makeSupabaseClient ? window.makeSupabaseClient() : null;

  const PRIORITY_WEIGHT = { High: 3, Medium: 2, Low: 1 };
  const PRIORITY_COLOR = { High: '#ef4444', Medium: '#f97316', Low: '#eab308' };
  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */
  let currentUser = null;
  let offlineSession = false;       // true when running from the cached login (no live session)
  let tasks = [];
  let queue = [];                   // changes made offline, waiting to sync
  const R = window.SimpleReminders;   // shared reminder schedule (reminder-schedule.js)
  const INTENSITY_HINTS = {
    off: 'You will not get any reminders.',
    gentle: 'A few emails and device alerts per task.',
    normal: 'Up to 4 emails and about 12 device alerts per High priority task.',
    persistent: 'Up to 4 emails and about 19 device alerts per High priority task.'
  };
  let settings = {
    email_reminders: true, browser_alerts: true,
    intensity: 'normal', daily_hour: 8, quiet_start: 22, quiet_end: 7,
    timezone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Manila'; } catch (e) { return 'Asia/Manila'; } })()
  };
  let calendar = null;
  let syncing = false;
  let syncError = '';
  let sortMode = 'smart';
  let filterMode = 'all';
  let categoryMode = 'all';
  let editingId = null;
  let K = {};                       // per-user storage keys
  let fetchTimer = null;
  let loggingOut = false;

  /* ------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------ */
  function readJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
  }

  // Builds DOM nodes with textContent only, so task text can never run as HTML
  function el(tag, opts, children) {
    const node = document.createElement(tag);
    Object.entries(opts || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach((c) => { if (c) node.append(c); });
    return node;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function toInputValue(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function defaultDue() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(23, 59, 0, 0);
    return d;
  }
  function fmtDue(iso) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function formatLocalDateTime(dateString) {
    return new Date(dateString).toLocaleString('en-US', {
      month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
    });
  }
  function fmtMinutes(m) {
    if (!m) return '';
    const h = Math.floor(m / 60), r = m % 60;
    if (h && r) return `${h}h ${r}m`;
    return h ? `${h}h` : `${r}m`;
  }
  function isLocalId(id) { return String(id).startsWith('local_'); }

  let toastTimer = null;
  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function persist() {
    writeJSON(K.tasks, tasks);
    writeJSON(K.queue, queue);
  }

  /* ------------------------------------------------------------------
     Email (EmailJS) - confirmation copy when a task is created
     ------------------------------------------------------------------ */
  async function sendEmailNotification(userEmail, userName, taskTitle, dueDate, priority) {
    if (typeof emailjs === 'undefined') return;
    emailjs.init(EMAILJS_PUBLIC_KEY);
    const templateParams = {
      to_email: userEmail,
      name: userName || userEmail.split('@')[0],
      title: taskTitle,
      due_date: formatLocalDateTime(dueDate),
      priority: priority,
      reminder_type: "New task added"
    };
    try {
      const res = await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams, EMAILJS_PUBLIC_KEY);
      console.log('Email sent via EmailJS:', res.status, res.text);
      toast('Email copy sent.');
    } catch (err) {
      console.error('EmailJS Error:', err);
      toast('Could not send the email copy.');
    }
  }

  /* ------------------------------------------------------------------
     Data layer: local-first, queued, synced to Supabase
     ------------------------------------------------------------------ */
  function addTask(data) {
    const localId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const task = Object.assign({
      id: localId, user_id: currentUser.id, is_completed: false, reminded: false, reminder_steps: [],
      created_at: new Date().toISOString(), remind_from: new Date().toISOString()
    }, data);
    tasks.push(task);
    queue.push({ op: 'insert', localId: localId, data: Object.assign({ remind_from: task.remind_from }, data) });
    persist();
    renderAll();
    flush();
    return task;
  }

  function updateTask(id, patch) {
    const t = tasks.find((x) => String(x.id) === String(id));
    if (!t) return;
    Object.assign(t, patch);
    if (isLocalId(id)) {
      const q = queue.find((i) => i.op === 'insert' && i.localId === id);
      if (q) Object.assign(q.data, patch);
    } else {
      const q = queue.find((i) => i.op === 'update' && String(i.id) === String(id));
      if (q) Object.assign(q.data, patch); else queue.push({ op: 'update', id: id, data: Object.assign({}, patch) });
    }
    persist();
    renderAll();
    flush();
  }

  function deleteTask(id) {
    tasks = tasks.filter((x) => String(x.id) !== String(id));
    if (isLocalId(id)) {
      queue = queue.filter((i) => !(i.op === 'insert' && i.localId === id));
    } else {
      queue = queue.filter((i) => !(i.op === 'update' && String(i.id) === String(id)));
      queue.push({ op: 'delete', id: id });
    }
    persist();
    renderAll();
    flush();
  }

  function isNetworkError(error) {
    return !navigator.onLine || /fetch|network|failed to load|timeout/i.test((error && error.message) || '');
  }

  async function flush() {
    if (syncing || !supabaseClient || offlineSession || !navigator.onLine || !currentUser) return;
    syncing = true;
    syncError = '';
    renderStatus();
    try {
      if (readJSON(K.settingsDirty, false)) await pushSettings();

      while (queue.length) {
        const item = queue[0];
        let res;
        if (item.op === 'insert') {
          res = await supabaseClient.from('tasks')
            .insert([Object.assign({}, item.data, { user_id: currentUser.id })])
            .select().single();
          if (!res.error && res.data) {
            const idx = tasks.findIndex((x) => x.id === item.localId);
            if (idx !== -1) tasks[idx] = res.data;
          }
        } else if (item.op === 'update') {
          res = await supabaseClient.from('tasks').update(item.data).eq('id', item.id);
        } else {
          res = await supabaseClient.from('tasks').delete().eq('id', item.id);
        }

        if (res.error) {
          if (!isNetworkError(res.error)) {
            syncError = res.error.message + ' (run supabase-setup.sql if you have not yet)';
            console.error('Sync error:', res.error);
          }
          break;
        }
        queue.shift();
        persist();
      }
      if (!queue.length) await fetchTasks();
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      syncing = false;
      renderStatus();
    }
  }

  async function fetchTasks() {
    if (!supabaseClient || offlineSession || !navigator.onLine || queue.length) return;
    const { data, error } = await supabaseClient.from('tasks').select('*').eq('user_id', currentUser.id);
    if (error) {
      if (!isNetworkError(error)) {
        syncError = error.message + ' (run supabase-setup.sql if you have not yet)';
        renderStatus();
      }
      return;
    }
    tasks = data || [];
    persist();
    renderAll();
    checkReminders();
  }

  function scheduleFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => { if (!queue.length && !syncing) fetchTasks(); }, 400);
  }

  /* ------------------------------------------------------------------
     Reminder settings (saved on this device + in Supabase)
     ------------------------------------------------------------------ */
  async function pushSettings() {
    if (!supabaseClient || offlineSession || !navigator.onLine) return;
    const { error } = await supabaseClient.from('user_settings').upsert({
      user_id: currentUser.id,
      email_reminders: settings.email_reminders,
      intensity: settings.intensity,
      daily_hour: settings.daily_hour,
      quiet_start: settings.quiet_start,
      quiet_end: settings.quiet_end,
      timezone: settings.timezone,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (!error) writeJSON(K.settingsDirty, false);
  }

  async function loadSettingsFromServer() {
    if (!supabaseClient || offlineSession || !navigator.onLine || readJSON(K.settingsDirty, false)) return;
    const { data, error } = await supabaseClient.from('user_settings').select('*').eq('user_id', currentUser.id).maybeSingle();
    if (!error && data) {
      ['email_reminders', 'intensity', 'daily_hour', 'quiet_start', 'quiet_end', 'timezone'].forEach((k) => {
        if (data[k] !== null && data[k] !== undefined) settings[k] = data[k];
      });
      writeJSON(K.settings, settings);
      renderStatus();
    }
  }

  /* ------------------------------------------------------------------
     Browser / device alerts
     ------------------------------------------------------------------ */
  function updateNotifyButton() {
    const btn = $('enableNotifyBtn');
    if (!('Notification' in window)) { btn.textContent = 'Alerts not supported'; btn.disabled = true; return; }
    btn.style.background = ''; btn.style.color = '';
    if (Notification.permission === 'granted') {
      btn.textContent = settings.browser_alerts ? '🔔 Alerts on' : '🔕 Alerts paused';
      btn.style.background = 'rgba(85,139,47,0.28)'; btn.style.color = '#c5e1a5';
    } else if (Notification.permission === 'denied') {
      btn.textContent = '🔕 Alerts blocked';
    } else {
      btn.textContent = '🔔 Enable alerts';
    }
  }

  async function showAlert(title, body, tag) {
    const opts = { body: body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: tag, data: { url: 'dashboard.html' } };
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.showNotification) { await reg.showNotification(title, opts); return; }
      }
    } catch (e) { /* fall back below */ }
    try { new Notification(title, opts); } catch (e) { /* not allowed on this device */ }
  }

  // Escalating device alerts. Uses the same schedule as the email job.
  // Each step alerts once per device; if several are overdue only the newest is shown.
  const MAX_ALERT_AGE_MS = 3 * 3600 * 1000;

  function checkReminders() {
    if (!R || !('Notification' in window) || Notification.permission !== 'granted' || !settings.browser_alerts) return;
    if (settings.intensity === 'off') return;
    const notified = readJSON(K.notified, {});
    const now = Date.now();
    let changed = false;

    tasks.forEach((t) => {
      if (t.is_completed) return;
      const key = new Date(t.remind_from || t.created_at).getTime() + '|' + new Date(t.due_date).getTime();
      const entry = notified[key] || { steps: [], t: now };
      const due = R.dueSteps(t, settings, entry.steps, now, 'alert');
      if (!due.length) return;

      const latest = due[due.length - 1];
      entry.steps = entry.steps.concat(due.map((s) => s.key).filter((k) => entry.steps.indexOf(k) === -1));
      entry.t = now;
      notified[key] = entry;
      changed = true;

      if (now - latest.at.getTime() <= MAX_ALERT_AGE_MS) {
        const title = (latest.key === 'now' ? '⏰ Due now: ' : '📌 ') + t.title;
        showAlert(title, R.describe(t.due_date, now, settings) + '. Priority: ' + (t.priority || 'Medium') + '.', key + '|' + latest.key);
      }
    });

    Object.keys(notified).forEach((k) => { if (now - notified[k].t > 14 * 86400000) { delete notified[k]; changed = true; } });
    if (changed) writeJSON(K.notified, notified);
  }

  /* ------------------------------------------------------------------
      Rendering
     ------------------------------------------------------------------ */
  function compareTasks(a, b) {
    if (a.is_completed !== b.is_completed) return a.is_completed ? 1 : -1;
    const da = new Date(a.due_date).getTime(), db = new Date(b.due_date).getTime();
    const pa = PRIORITY_WEIGHT[a.priority] || 0, pb = PRIORITY_WEIGHT[b.priority] || 0;
    if (sortMode === 'deadline') return da - db;
    if (sortMode === 'priority') return (pb - pa) || (da - db);
    const now = Date.now();
    const oa = !a.is_completed && da < now, ob = !b.is_completed && db < now;
    if (oa !== ob) return oa ? -1 : 1;
    return (pb - pa) || (da - db);
  }

  function visibleTasks() {
    const now = Date.now();
    return tasks.filter((t) => {
      if (categoryMode !== 'all' && (t.category || '') !== categoryMode) return false;
      if (filterMode === 'pending') return !t.is_completed;
      if (filterMode === 'done') return t.is_completed;
      if (filterMode === 'overdue') return !t.is_completed && new Date(t.due_date).getTime() < now;
      return true;
    }).sort(compareTasks);
  }

  function taskItem(t) {
    const overdue = !t.is_completed && new Date(t.due_date).getTime() < Date.now();
    const priority = t.priority || 'Medium';

    const titleRow = el('div', { class: 'task-title-row' }, [
      el('strong', { text: t.title }),
      el('span', { class: 'badge ' + priority.toLowerCase(), text: priority })
    ]);
    if (t.category) titleRow.append(el('span', { class: 'badge cat', text: t.category }));
    if (t.estimated_minutes) titleRow.append(el('span', { class: 'badge time', text: '⏱ ' + fmtMinutes(t.estimated_minutes) }));

    const main = el('div', { class: 'task-main' }, [titleRow]);
    if (t.description) main.append(el('div', { class: 'task-desc', text: t.description }));
    main.append(el('small', {
      class: 'task-meta' + (overdue ? ' overdue' : ''),
      text: (overdue ? 'Overdue: ' : 'Due: ') + fmtDue(t.due_date) + (isLocalId(t.id) ? ' (waiting to sync)' : '')
    }));

    const actions = el('div', { class: 'task-actions' }, [
      el('button', { class: 'mini-btn', type: 'button', text: t.is_completed ? 'Undo' : 'Done',
        onclick: () => updateTask(t.id, { is_completed: !t.is_completed }) }),
      el('button', { class: 'mini-btn', type: 'button', text: '✏️', title: 'Edit task', 'aria-label': 'Edit task ' + t.title,
        onclick: () => openEdit(t.id) }),
      el('button', { class: 'mini-btn danger', type: 'button', text: '🗑️', title: 'Delete task', 'aria-label': 'Delete task ' + t.title,
        onclick: () => confirmDelete(t.id) })
    ]);

    return el('li', { class: 'task-item' + (t.is_completed ? ' completed' : '') + (overdue ? ' overdue' : '') }, [main, actions]);
  }

  function renderList() {
    const ul = $('taskList');
    ul.replaceChildren();
    const list = visibleTasks();
    if (!list.length) {
      ul.append(el('li', { class: 'empty-state', text: tasks.length ? 'No tasks match this filter.' : 'No tasks yet. Type a title above and press Add.' }));
      return;
    }
    list.forEach((t) => ul.append(taskItem(t)));
  }

  function renderStats() {
    const now = Date.now();
    let pending = 0, completed = 0, soon = 0, overdue = 0, workload = 0;
    tasks.forEach((t) => {
      if (t.is_completed) { completed++; return; }
      pending++;
      workload += t.estimated_minutes || 0;
      const diff = new Date(t.due_date).getTime() - now;
      if (diff < 0) overdue++; else if (diff <= 48 * 3600 * 1000) soon++;
    });
    $('pendingCount').textContent = pending;
    $('completedCount').textContent = completed;
    $('upcomingCount').textContent = soon;
    $('overdueCount').textContent = overdue;

    const total = tasks.length;
    const pct = total ? Math.round((completed / total) * 100) : 0;
    $('progressFill').style.width = pct + '%';
    $('progressBar').setAttribute('aria-valuenow', pct);
    const label = $('progressLabel');
    label.replaceChildren(el('strong', { text: pct + '%' }), document.createTextNode(` of tasks completed (${completed} of ${total})`));
    $('workloadLabel').textContent = workload ? 'Planned workload: ' + fmtMinutes(workload) : 'Planned workload: add time estimates to see it';
  }

  function renderStatus() {
    const b = $('statusBanner');
    const online = navigator.onLine;
    b.className = 'notify-banner flex flex-wrap items-center gap-x-4 gap-y-1' + (!online ? ' is-offline' : '') + (syncError ? ' is-error' : '');
    b.replaceChildren();

    b.append(el('strong', { text: online ? '● Online' : '○ Offline' }));
    if (!online) b.append(el('span', { text: 'Your changes are saved on this device and will sync when you reconnect.' }));
    if (offlineSession && online) b.append(el('span', { text: 'Session expired. Log out and log in again to sync.' }));
    if (queue.length) b.append(el('span', { text: `${queue.length} change${queue.length > 1 ? 's' : ''} waiting to sync` }));
    if (syncError) b.append(el('span', { text: 'Sync problem: ' + syncError }));
    const levelName = { off: 'off', gentle: 'Gentle', normal: 'Normal', persistent: 'Persistent' }[settings.intensity] || 'Normal';
    b.append(el('span', { text: settings.intensity === 'off' ? 'Reminders: off'
      : `Reminders: ${levelName}, daily at ${hourLabel(settings.daily_hour)}${settings.email_reminders ? '' : ' (email off)'}` }));

    let alertText = 'Device alerts: not enabled';
    if (!('Notification' in window)) alertText = 'Device alerts: not supported here';
    else if (Notification.permission === 'denied') alertText = 'Device alerts: blocked in browser settings';
    else if (Notification.permission === 'granted') alertText = settings.browser_alerts ? 'Device alerts: on' : 'Device alerts: paused';
    b.append(el('span', { text: alertText }));
    updateNotifyButton();
  }

  /* ---------- Calendar ---------- */
  function initCalendar() {
    if (typeof FullCalendar === 'undefined') {
      $('calendar').replaceChildren(el('p', { class: 'empty-state', text: 'The calendar could not load. Reconnect once so it can be saved for offline use. Your task list still works.' }));
      return;
    }
    calendar = new FullCalendar.Calendar($('calendar'), {
      initialView: 'dayGridMonth',
      timeZone: 'local',
      height: 'auto',
      nowIndicator: true,
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listWeek' },
      events: [],
      eventTimeFormat: {
        hour: 'numeric',
        minute: '2-digit',
        meridiem: 'short',
        hour12: true
      },
      slotLabelFormat: {
        hour: 'numeric',
        minute: '2-digit',
        meridiem: 'short',
        hour12: true
      },
      eventClick: (info) => openEdit(info.event.id),
      dateClick: (info) => {
        const d = new Date(info.date);
        if (info.allDay) d.setHours(23, 59, 0, 0);
        $('moreDetails').open = true;
        $('taskDueDate').value = toInputValue(d);
        $('taskTitle').focus();
      }
    });
    calendar.render();
  }

  function renderCalendar() {
    if (!calendar) return;
    const events = tasks.map((t) => {
      const due = new Date(t.due_date);
      const mins = t.estimated_minutes;
      const done = t.is_completed;
      const color = done ? '#5d656d' : (PRIORITY_COLOR[t.priority] || '#f97316');
      const ev = {
        id: String(t.id),
        title: t.title,
        start: mins ? new Date(due.getTime() - mins * 60000) : due,
        backgroundColor: color,
        borderColor: 'transparent',
        textColor: (!done && t.priority === 'Low') ? '#854d0e' : '#ffffff',
        classNames: done ? ['fc-done'] : []
      };
      if (mins) ev.end = due;
      return ev;
    });
    calendar.removeAllEvents();
    calendar.addEventSource(events);
  }

  function renderAll() {
    renderStats();
    renderList();
    renderCalendar();
    renderStatus();
  }

  /* ------------------------------------------------------------------
      Dialogs and forms
     ------------------------------------------------------------------ */
  function openEdit(id) {
    const t = tasks.find((x) => String(x.id) === String(id));
    if (!t) return;
    editingId = t.id;
    $('editTitle').value = t.title;
    $('editDescription').value = t.description || '';
    $('editCategory').value = t.category || '';
    $('editPriority').value = t.priority || 'Medium';
    $('editEstimate').value = t.estimated_minutes || '';
    $('editDue').value = toInputValue(new Date(t.due_date));
    $('editDialog').showModal();
  }

  function confirmDelete(id) {
    const t = tasks.find((x) => String(x.id) === String(id));
    if (!t) return;
    if (confirm(`Delete "${t.title}"? This cannot be undone.`)) {
      deleteTask(id);
      toast('Task deleted.');
    }
  }

  function parseEstimate(value) {
    const n = parseInt(value, 10);
    return n > 0 ? n : null;
  }

  function wireForms() {
    // Add task
    $('taskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const title = $('taskTitle').value.trim();
      if (!title) return;
      const raw = $('taskDueDate').value;
      const due = raw ? new Date(raw) : defaultDue();
      if (isNaN(due.getTime())) return toast('Enter a valid deadline.');

      const data = {
        title: title,
        description: $('taskDescription').value.trim() || null,
        category: $('taskCategory').value,
        priority: $('taskPriority').value,
        due_date: due.toISOString(),
        estimated_minutes: parseEstimate($('taskEstimate').value),
        is_completed: false
      };
      const sendEmail = $('sendEmailCheckbox').checked;
      addTask(data);

      if (sendEmail) {
        if (navigator.onLine) {
          const userName = (currentUser.user_metadata && currentUser.user_metadata.full_name) || currentUser.email.split('@')[0];
          sendEmailNotification(currentUser.email, userName, title, data.due_date, data.priority);
        } else {
          toast('Task saved. The email copy needs an internet connection.');
        }
      }
      $('taskForm').reset();
      $('moreDetails').open = false;
      $('taskTitle').focus();
    });

    // Edit task
    $('editForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = tasks.find((x) => String(x.id) === String(editingId));
      if (!t) return $('editDialog').close();
      const due = new Date($('editDue').value);
      if (isNaN(due.getTime())) return toast('Enter a valid deadline.');
      const patch = {
        title: $('editTitle').value.trim(),
        description: $('editDescription').value.trim() || null,
        category: $('editCategory').value || null,
        priority: $('editPriority').value,
        due_date: due.toISOString(),
        estimated_minutes: parseEstimate($('editEstimate').value)
      };
      if (!patch.title) return toast('Title cannot be empty.');
      if (new Date(t.due_date).getTime() !== due.getTime()) {
        patch.reminded = false;
        patch.reminder_steps = [];
        patch.remind_from = new Date().toISOString();
      }
      updateTask(editingId, patch);
      $('editDialog').close();
      toast('Task updated.');
    });
    $('editCancel').addEventListener('click', () => $('editDialog').close());
    $('editDelete').addEventListener('click', () => {
      const id = editingId;
      $('editDialog').close();
      confirmDelete(id);
    });

    // Sort / filter
    $('sortSelect').addEventListener('change', (e) => { sortMode = e.target.value; renderList(); });
    $('categoryFilter').addEventListener('change', (e) => { categoryMode = e.target.value; renderList(); });
    $('filterSelect').addEventListener('change', (e) => { filterMode = e.target.value; renderList(); });

    // Reminder settings dialog
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsCancel').addEventListener('click', () => $('settingsDialog').close());
    $('setIntensity').addEventListener('change', (e) => { $('intensityHint').textContent = INTENSITY_HINTS[e.target.value] || ''; });
    $('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      settings.email_reminders = $('setEmail').checked;
      settings.browser_alerts = $('setBrowser').checked;
      settings.intensity = $('setIntensity').value;
      settings.daily_hour = parseInt($('setDailyHour').value, 10);
      settings.quiet_start = parseInt($('setQuietStart').value, 10);
      settings.quiet_end = parseInt($('setQuietEnd').value, 10);
      writeJSON(K.settings, settings);
      writeJSON(K.settingsDirty, true);
      $('settingsDialog').close();
      renderStatus();
      await pushSettings();
      toast(readJSON(K.settingsDirty, false) ? 'Saved on this device. Will sync when online.' : 'Reminder settings saved.');
      checkReminders();
    });

    // Enable alerts
    $('enableNotifyBtn').addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result === 'granted') {
          showAlert('SimpleTask', 'Alerts are on. You will be notified before deadlines.', 'welcome');
          checkReminders();
        }
        renderStatus();
      } else if (Notification.permission === 'denied') {
        toast('Alerts are blocked. Allow notifications for this site in your browser settings.');
      } else {
        openSettings();
      }
    });

    // Logout
    $('logoutBtn').addEventListener('click', logout);
  }

  function hourLabel(h) {
    const hr = ((h + 11) % 12) + 1;
    return hr + ':00 ' + (h < 12 ? 'AM' : 'PM');
  }

  function fillHourSelect(id, from, to) {
    const sel = $(id);
    sel.replaceChildren();
    for (let h = from; h <= to; h++) sel.append(el('option', { value: String(h), text: hourLabel(h) }));
  }

  function openSettings() {
    fillHourSelect('setDailyHour', 5, 12);
    fillHourSelect('setQuietStart', 18, 23);
    fillHourSelect('setQuietEnd', 4, 10);
    $('setEmail').checked = settings.email_reminders;
    $('setBrowser').checked = settings.browser_alerts;
    $('setIntensity').value = settings.intensity;
    $('setDailyHour').value = String(settings.daily_hour);
    $('setQuietStart').value = String(settings.quiet_start);
    $('setQuietEnd').value = String(settings.quiet_end);
    $('setTimezone').value = settings.timezone;
    $('intensityHint').textContent = INTENSITY_HINTS[settings.intensity] || '';
    $('settingsDialog').showModal();
  }

  async function logout() {
    loggingOut = true;
    if (queue.length && navigator.onLine) await flush();
    if (queue.length && !confirm('Some changes have not synced yet. Log out and lose them?')) { loggingOut = false; return; }
    try {
      if (supabaseClient) await supabaseClient.auth.signOut(navigator.onLine ? undefined : { scope: 'local' });
    } catch (e) { /* clear locally below */ }
    try {
      [localStorage, sessionStorage].forEach((s) => Object.keys(s).filter((k) => k.startsWith('sb-')).forEach((k) => s.removeItem(k)));
      Object.values(K).forEach((k) => localStorage.removeItem(k));
      localStorage.removeItem('st_last_user');
    } catch (e) { /* ignore */ }
    window.location.href = 'index.html';
  }

  /* ------------------------------------------------------------------
      Start-up
     ------------------------------------------------------------------ */
  async function init() {
    let user = null;
    let sessionFailed = false;

    if (supabaseClient) {
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session) user = session.user;
      } catch (e) { sessionFailed = true; }
    }

    if (!user) {
      const cached = readJSON('st_last_user', null);
      if (cached && (!navigator.onLine || sessionFailed)) { user = cached; offlineSession = true; }
    }
    if (!user) { window.location.href = 'index.html'; return; }

    currentUser = user;
    const displayName = (user.user_metadata && user.user_metadata.full_name) || (user.name) || '';
    if (!offlineSession) {
      writeJSON('st_last_user', { id: user.id, email: user.email, name: displayName, user_metadata: user.user_metadata || {} });
    }
    $('userEmail').textContent = user.email;

    K = {
      tasks: 'st_tasks_' + user.id, queue: 'st_queue_' + user.id, settings: 'st_settings_' + user.id,
      settingsDirty: 'st_settings_dirty_' + user.id, notified: 'st_notified2_' + user.id
    };
    tasks = readJSON(K.tasks, []);
    queue = readJSON(K.queue, []);
    settings = Object.assign(settings, readJSON(K.settings, {}));

    wireForms();
    initCalendar();
    renderAll();
    if (location.hash === '#quick') $('taskTitle').focus();

    // Connectivity
    window.addEventListener('online', async () => {
      if (offlineSession && supabaseClient) {
        try {
          const { data: { session } } = await supabaseClient.auth.getSession();
          if (session) { currentUser = session.user; offlineSession = false; subscribeRealtime(); }
        } catch (e) { /* stay offline-session */ }
      }
      renderStatus();
      flush();
      toast('Back online. Syncing…');
    });
    window.addEventListener('offline', () => { renderStatus(); toast('You are offline. Changes are saved on this device.'); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { flush(); checkReminders(); renderAll(); }
    });

    if (!offlineSession && navigator.onLine) {
      await loadSettingsFromServer();
      subscribeRealtime();
      if (queue.length) await flush(); else await fetchTasks();
    }

    checkReminders();
    setInterval(() => { checkReminders(); renderStats(); }, 60 * 1000);
  }

  let realtimeChannel = null;
  function subscribeRealtime() {
    if (!supabaseClient || offlineSession || realtimeChannel) return;
    try {
      realtimeChannel = supabaseClient.channel('tasks-' + currentUser.id)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'tasks', filter: 'user_id=eq.' + currentUser.id },
          scheduleFetch)
        .subscribe();
    } catch (e) { console.warn('Realtime unavailable:', e); }
  }

  if (supabaseClient) {
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && !offlineSession && !loggingOut) window.location.href = 'index.html';
    });
  }

  init();
})();
