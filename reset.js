const resetClient = window.makeSupabaseClient ? window.makeSupabaseClient() : null;
const resetForm = document.getElementById("resetForm");
const resetInvalid = document.getElementById("resetInvalid");
const resetLoading = document.getElementById("resetLoading");
const resetMessage = document.getElementById("resetMessage");

function setResetMessage(text, success = false) {
  resetMessage.className = success ? "message success" : "message";
  resetMessage.textContent = text;
}

function showResetForm() {
  resetLoading.classList.add("hidden");
  resetInvalid.classList.add("hidden");
  resetForm.classList.remove("hidden");
}

function showInvalid() {
  resetLoading.classList.add("hidden");
  resetForm.classList.add("hidden");
  resetInvalid.classList.remove("hidden");
}

if (!resetClient) {
  showInvalid();
  setResetMessage("Supabase is not configured yet. Check supabase-config.js.");
} else {
  resetClient.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") showResetForm();
  });

  // Fallback: if the recovery session is already in place, show the form
  setTimeout(async () => {
    if (!resetForm.classList.contains("hidden")) return;
    const { data: { session } } = await resetClient.auth.getSession();
    if (session) showResetForm(); else showInvalid();
  }, 1200);

  resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.getElementById("newPassword").value;
    const confirm = document.getElementById("confirmNewPassword").value;
    if (password.length < 8) return setResetMessage("Password must be at least 8 characters.");
    if (password !== confirm) return setResetMessage("Passwords do not match. Please check and try again.");
    setResetMessage("Saving…", true);
    try {
      const { error } = await resetClient.auth.updateUser({ password });
      if (error) return setResetMessage(error.message);
      setResetMessage("Password updated! Redirecting...", true);
      setTimeout(() => { window.location.href = "dashboard.html"; }, 1200);
    } catch (err) {
      setResetMessage("Could not reach the server. Check your connection and try again.");
    }
  });
}
