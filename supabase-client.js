/* Creates the Supabase client. Keys stay in supabase-config.js.
   "Remember me" decides whether the login lives in localStorage (stays signed in)
   or sessionStorage (signed out when the tab closes). */
(function () {
  function remembered() {
    try { return localStorage.getItem('st_remember') !== '0'; } catch (e) { return true; }
  }
  var adapter = {
    getItem: function (k) {
      try { return window.sessionStorage.getItem(k) || window.localStorage.getItem(k); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try {
        if (remembered()) { window.localStorage.setItem(k, v); window.sessionStorage.removeItem(k); }
        else { window.sessionStorage.setItem(k, v); window.localStorage.removeItem(k); }
      } catch (e) {}
    },
    removeItem: function (k) {
      try { window.localStorage.removeItem(k); window.sessionStorage.removeItem(k); } catch (e) {}
    }
  };

  window.makeSupabaseClient = function () {
    var url = window.SIMPLETASK_SUPABASE_URL;
    var key = window.SIMPLETASK_SUPABASE_ANON_KEY;
    var ready = window.supabase && url && key && String(url).indexOf('PASTE_YOUR_') === -1 && String(key).indexOf('PASTE_YOUR_') === -1;
    if (!ready) return null;
    return window.supabase.createClient(url, key, {
      auth: { storage: adapter, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  };
})();
