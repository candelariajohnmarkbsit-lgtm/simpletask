const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const loginMessage = document.getElementById("loginMessage");
const registerMessage = document.getElementById("registerMessage");

const supabaseClient = window.makeSupabaseClient ? window.makeSupabaseClient() : null;

function showForm(formName) {
  const showRegister = formName === "register";
  loginForm.classList.toggle("hidden", showRegister);
  registerForm.classList.toggle("hidden", !showRegister);
  loginMessage.textContent = "";
  registerMessage.textContent = "";
}

document.querySelectorAll("[data-switch]").forEach((button) => {
  button.addEventListener("click", () => showForm(button.dataset.switch));
});

document.querySelectorAll(".show-password").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.target);
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    button.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
    button.textContent = isPassword ? "◎" : "◉";
  });
});

function showMessage(element, message, success = false) {
  element.className = success ? "message success" : "message";
  element.textContent = message;
}

function missingConfig(element) {
  showMessage(element, "Supabase is not configured yet. Add your Project URL and anon/public key in supabase-config.js.");
}

function offlineMessage(element) {
  showMessage(element, "You are offline. Connect to the internet to log in or register.");
}

/* ---------- Remember me ---------- */
function applyRemember(remember) {
  try {
    localStorage.setItem("st_remember", remember ? "1" : "0");
    if (remember) {
      localStorage.setItem("st_remember_email", document.getElementById("loginEmail").value.trim());
    } else {
      localStorage.removeItem("st_remember_email");
      // remove any older saved login so it does not linger after this tab closes
      Object.keys(localStorage).filter((k) => k.startsWith("sb-")).forEach((k) => localStorage.removeItem(k));
    }
  } catch (e) { /* storage unavailable */ }
}

try {
  const savedEmail = localStorage.getItem("st_remember_email");
  if (savedEmail) document.getElementById("loginEmail").value = savedEmail;
  if (localStorage.getItem("st_remember") === "0") document.getElementById("rememberMe").checked = false;
} catch (e) { /* ignore */ }

/* ---------- Skip the login page if already signed in ---------- */
(async function redirectIfLoggedIn() {
  try {
    if (supabaseClient) {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session) return window.location.replace("dashboard.html");
    }
  } catch (e) { /* fall through */ }
  // Installed app opened with no connection: go to the dashboard, which works offline
  if (!navigator.onLine && localStorage.getItem("st_last_user")) {
    window.location.replace("dashboard.html");
  }
})();

/* ---------- Log in ---------- */
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) return missingConfig(loginMessage);
  if (!navigator.onLine) return offlineMessage(loginMessage);
  applyRemember(document.getElementById("rememberMe").checked);
  showMessage(loginMessage, "Signing in…", true);
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) return showMessage(loginMessage, error.message);
    showMessage(loginMessage, "Login successful! Redirecting...", true);
    setTimeout(() => { window.location.href = "dashboard.html"; }, 800);
  } catch (err) {
    showMessage(loginMessage, "Could not reach the server. Check your connection and try again.");
  }
});

/* ---------- Register ---------- */
registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) return missingConfig(registerMessage);
  if (!navigator.onLine) return offlineMessage(registerMessage);
  const fullName = document.getElementById("fullName").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  if (password !== confirmPassword) return showMessage(registerMessage, "Passwords do not match. Please check and try again.");
  try { localStorage.setItem("st_remember", "1"); } catch (e) {}
  showMessage(registerMessage, "Creating your account…", true);
  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName }, emailRedirectTo: window.location.origin + "/dashboard.html" }
    });
    if (error) return showMessage(registerMessage, error.message);
    if (data.session) {
      showMessage(registerMessage, "Account created successfully! Redirecting...", true);
      setTimeout(() => { window.location.href = "dashboard.html"; }, 800);
    } else {
      showMessage(registerMessage, "Account created! Check your email to confirm it, then log in.", true);
    }
  } catch (err) {
    showMessage(registerMessage, "Could not reach the server. Check your connection and try again.");
  }
});

/* ---------- Google ---------- */
async function signInWithGoogle(element, remember) {
  if (!supabaseClient) return missingConfig(element);
  if (!navigator.onLine) return offlineMessage(element);
  try { localStorage.setItem("st_remember", remember ? "1" : "0"); } catch (e) {}
  showMessage(element, "Redirecting to Google…", true);
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + "/dashboard.html" }
  });
  if (error) showMessage(element, error.message);
}

document.getElementById("googleLogin").addEventListener("click", () =>
  signInWithGoogle(loginMessage, document.getElementById("rememberMe").checked));
document.getElementById("googleRegister").addEventListener("click", () =>
  signInWithGoogle(registerMessage, true));

/* ---------- Forgot password ---------- */
document.getElementById("forgotPassword").addEventListener("click", async () => {
  if (!supabaseClient) return missingConfig(loginMessage);
  if (!navigator.onLine) return offlineMessage(loginMessage);
  const email = document.getElementById("loginEmail").value.trim();
  if (!email) return showMessage(loginMessage, "Enter your email address first, then click Forgot password again.");
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/reset.html"
    });
    if (error) return showMessage(loginMessage, error.message);
    showMessage(loginMessage, "If an account exists for that email, a password reset link has been sent.", true);
  } catch (err) {
    showMessage(loginMessage, "Could not reach the server. Check your connection and try again.");
  }
});
