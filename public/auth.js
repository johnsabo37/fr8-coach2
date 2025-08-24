// public/auth.js — minimal gate restore; no layout/style changes.

(() => {
  const gatePanel    = document.getElementById("gatePanel");
  const coachPanel   = document.getElementById("coachPanel");
  const sitePass     = document.getElementById("sitePass");
  const enterBtn     = document.getElementById("enterBtn");
  const gateMsg      = document.getElementById("gateMsg");

  // Always start gated
  if (gatePanel) gatePanel.classList.remove("hidden");
  if (coachPanel) coachPanel.classList.add("hidden");

  async function checkPassword(pw) {
    try {
      const r = await fetch("/api/ping", { headers: { "x-site-password": pw || "" } });
      return r.ok;
    } catch { return false; }
  }

  async function enter() {
    const pw = (sitePass?.value || "").trim();
    if (!pw) { if (gateMsg) gateMsg.textContent = "Enter password."; return; }
    if (gateMsg) { gateMsg.textContent = "Checking..."; gateMsg.style.color = ""; }
    const ok = await checkPassword(pw);
    if (!ok) {
      if (gateMsg) { gateMsg.textContent = "Invalid password."; gateMsg.style.color = "#ff8b8b"; }
      return;
    }
    // keep only in memory for this page session
    window.__SITE_PASSWORD__ = pw;
    // Patch fetch so every API call carries the password header automatically
    const _fetch = window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const hdrs = Object.assign({}, opts.headers, { "x-site-password": window.__SITE_PASSWORD__ || "" });
      return _fetch(url, Object.assign({}, opts, { headers: hdrs }));
    };
    // Flip UI
    if (gatePanel) gatePanel.classList.add("hidden");
    if (coachPanel) coachPanel.classList.remove("hidden");
    if (gateMsg) gateMsg.textContent = "";
    // focus the prompt if it exists
    const promptEl = document.getElementById("prompt");
    if (promptEl) promptEl.focus();
  }

  if (enterBtn) enterBtn.addEventListener("click", enter);
  if (sitePass) sitePass.addEventListener("keydown", (e) => { if (e.key === "Enter") enter(); });
})();
