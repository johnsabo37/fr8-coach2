// public/auth-generic.js — ID-agnostic gate wiring (no style/layout changes)

(() => {
  const passInput = document.querySelector('input[type="password"]');
  if (!passInput) return;

  let enterBtn = passInput.closest('form')?.querySelector('button') ||
                 passInput.parentElement?.querySelector('button') ||
                 Array.from(document.querySelectorAll('button')).find(b => /enter|submit|sign in|login/i.test(b.textContent));

  if (!enterBtn) return;

  const gatePanel = passInput.closest('section,div') || document.body;

  const prompt = document.querySelector('textarea#prompt, textarea[placeholder*="Ask the Coach"], textarea');
  let coachPanel = prompt?.closest('section,div');
  if (!coachPanel) {
    coachPanel = Array.from(document.querySelectorAll('section,div')).find(el =>
      /sales cards|ops cards|ask the coach|clear conversation/i.test((el.textContent || '').toLowerCase())
    );
  }
  if (!coachPanel) return;

  // Ensure .hidden exists
  if (!Array.from(document.styleSheets).some(s => Array.from(s.cssRules||[]).some(r => r.selectorText === '.hidden'))) {
    const style = document.createElement('style'); style.textContent = `.hidden{display:none!important}`;
    document.head.appendChild(style);
  }

  async function checkPassword(pw) {
    try { const r = await fetch('/api/ping', { headers: { 'x-site-password': pw || '' } }); return r.ok; }
    catch { return false; }
  }

  async function enter() {
    const pw = (passInput.value || '').trim();
    const ok = await checkPassword(pw);
    const gateMsg = document.getElementById('gateMsg');
    if (!ok) { if (gateMsg) { gateMsg.textContent = 'Invalid password.'; gateMsg.style.color = '#ff8b8b'; } return; }

    window.__SITE_PASSWORD__ = pw;
    const _fetch = window.fetch.bind(window);
    window.fetch = (url, opts = {}) => {
      const headers = Object.assign({}, opts.headers, { 'x-site-password': window.__SITE_PASSWORD__ || '' });
      return _fetch(url, Object.assign({}, opts, { headers }));
    };

    gatePanel.classList.add('hidden');
    coachPanel.classList.remove('hidden');
    prompt && prompt.focus();
  }

  enterBtn.addEventListener('click', enter);
  passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

  gatePanel.classList.remove('hidden');
  coachPanel.classList.add('hidden');
})();
