// public/auth-gate.js
// Minimal, ID-agnostic password gate wiring.
// DOES NOT change any CSS or layout; only toggles element.style.display.

(() => {
  // Find the password input (first password field on the page)
  const passInput = document.querySelector('input[type="password"]');
  if (!passInput) return; // page doesn't have a gate

  // Find a nearby enter/submit button
  const enterBtn =
    passInput.closest('form')?.querySelector('button') ||
    passInput.parentElement?.querySelector('button') ||
    Array.from(document.querySelectorAll('button')).find(b =>
      /enter|submit|sign in|login/i.test((b.textContent || '').trim())
    );

  if (!enterBtn) return;

  // Gate panel = closest section/div containing the password input
  const gatePanel = passInput.closest('section,div') || document.body;

  // "Coach" panel = the section containing the main app (textarea or Sales/Ops links)
  const prompt = document.querySelector('textarea#prompt, textarea');
  let coachPanel = prompt?.closest('section,div');
  if (!coachPanel) {
    coachPanel = Array.from(document.querySelectorAll('section,div')).find(el =>
      /sales cards|ops cards|ask the coach|clear conversation/i.test((el.textContent || '').toLowerCase())
    );
  }
  if (!coachPanel) return;

  // Make sure we start with gate visible, coach hidden — without using classes
  if (gatePanel) gatePanel.style.display = '';
  if (coachPanel) coachPanel.style.display = 'none';

  async function checkPassword(pw) {
    try {
      const r = await fetch('/api/ping', { headers: { 'x-site-password': pw || '' } });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function onEnter() {
    const pw = (passInput.value || '').trim();
    // Optional message element if your page has it:
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

    // Keep pw only in memory for this tab
    window.__SITE_PASSWORD__ = pw;

    // Patch fetch so every API call includes the header automatically
    const _fetch = window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const headers = Object.assign({}, opts.headers, { 'x-site-password': window.__SITE_PASSWORD__ || '' });
      return _fetch(url, Object.assign({}, opts, { headers }));
    };

    // Flip visibility (no CSS classes touched)
    gatePanel.style.display = 'none';
    coachPanel.style.display = '';

    // Focus the prompt if present
    prompt && prompt.focus();

    if (msg) msg.textContent = '';
  }

  enterBtn.addEventListener('click', onEnter);
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onEnter(); });
})();
