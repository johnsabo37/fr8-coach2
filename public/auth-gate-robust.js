// public/auth-gate-robust.js
// Robust, ID-agnostic password gate wiring.
// - No CSS changes (only toggles element.style.display)
// - Verifies password with /api/ping
// - Patches fetch to include x-site-password automatically

(function () {
  const MAX_TRIES = 40;   // ~4 seconds total if 100ms each
  const INTERVAL  = 100;

  // Utility
  const isVisible = el => !!el && el.offsetParent !== null;

  // Patch fetch once we know the password.
  function installFetchShim(pw) {
    window.__SITE_PASSWORD__ = pw;
    const _fetch = window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const headers = Object.assign({}, opts.headers, { 'x-site-password': window.__SITE_PASSWORD__ || '' });
      return _fetch(url, Object.assign({}, opts, { headers }));
    };
  }

  async function checkPassword(pw) {
    try {
      const r = await fetch('/api/ping', { headers: { 'x-site-password': pw || '' } });
      return r.ok;
    } catch {
      return false;
    }
  }

  function detectPanels() {
    // Password input + enter button
    const passInputs = Array.from(document.querySelectorAll('input[type="password"]'));
    const passInput  = passInputs.find(isVisible) || passInputs[0] || null;

    let enterBtn = passInput?.closest('form')?.querySelector('button') ||
                   passInput?.parentElement?.querySelector('button') ||
                   Array.from(document.querySelectorAll('button')).find(b =>
                     /enter|submit|sign in|login/i.test((b.textContent || '').trim())
                   ) || null;

    // Gate panel = container around visible password input
    const gatePanel =
      (passInput && (passInput.closest('section,div') || document.body)) ||
      Array.from(document.querySelectorAll('section,div')).find(el =>
        /password/i.test((el.textContent || '')) && isVisible(el)
      ) ||
      null;

    // Coach panel = container holding the textarea prompt or Sales/Ops links
    const prompt = document.querySelector('textarea#prompt, textarea[placeholder*="ask the coach" i], textarea');
    let coachPanel = prompt && (prompt.closest('section,div') || null);

    if (!coachPanel) {
      const candidates = Array.from(document.querySelectorAll('section,div'));
      coachPanel = candidates
        .map(el => ({ el, area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
        .filter(({ el }) => /sales cards|ops cards|ask the coach|clear conversation/i.test((el.textContent || '').toLowerCase()))
        .sort((a, b) => b.area - a.area)[0]?.el || null;
    }

    return { passInput, enterBtn, gatePanel, coachPanel, prompt };
  }

  function wire(passInput, enterBtn, gatePanel, coachPanel, prompt) {
    // Start with gate shown, coach hidden (no class changes)
    if (gatePanel) gatePanel.style.display = '';
    if (coachPanel) coachPanel.style.display = 'none';

    async function onEnter() {
      const pw = (passInput?.value || '').trim();
      const msg = document.getElementById('gateMsg');

      if (!pw) {
        if (msg) { msg.textContent = 'Enter password.'; msg.style.color = '#ff8b8b'; }
        return;
      }
      if (msg) { msg.textContent = 'Checking...'; msg.style.color = ''; }

      const ok = await checkPassword(pw);
      if (!ok) {
        if (msg) { msg.textContent = 'Invalid password.'; msg.style.color = '#ff8b8b'; }
        return;
      }

      installFetchShim(pw);

      if (gatePanel) gatePanel.style.display = 'none';
      if (coachPanel) coachPanel.style.display = '';

      if (msg) msg.textContent = '';
      if (prompt) prompt.focus();
    }

    enterBtn?.addEventListener('click', onEnter);
    passInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') onEnter(); });
  }

  function start() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const { passInput, enterBtn, gatePanel, coachPanel, prompt } = detectPanels();
      if (passInput && enterBtn && gatePanel && coachPanel) {
        clearInterval(timer);
        wire(passInput, enterBtn, gatePanel, coachPanel, prompt);
      } else if (tries >= MAX_TRIES) {
        clearInterval(timer);
        console.warn('[auth-gate-robust] Could not detect panels after retries.');
      }
    }, INTERVAL);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
