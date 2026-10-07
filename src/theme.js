(() => {
  const key = 'foco.theme.v1';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function preference() { try { return localStorage.getItem(key); } catch { return null; } }
  function apply(value) {
    const dark = value === 'dark' || (value !== 'light' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#12141b' : '#f6f5f1');
    document.querySelectorAll('[data-action="toggle-theme"]').forEach(button => {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
      button.setAttribute('data-tooltip', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
    });
  }
  apply(preference());
  let transitioning = false;
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action="toggle-theme"]');
    if (!button || transitioning) return;
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(key, next); } catch { /* Theme still works when browser storage is unavailable. */ }
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(next); return; }
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    document.documentElement.style.setProperty('--theme-x', x + 'px');
    document.documentElement.style.setProperty('--theme-y', y + 'px');
    document.documentElement.style.setProperty('--theme-radius', radius + 'px');
    transitioning = true;
    try {
      const transition = document.startViewTransition(() => apply(next));
      transition.finished.catch(() => {}).finally(() => { transitioning = false; });
    } catch { transitioning = false; apply(next); }
  });
  media.addEventListener('change', () => apply(preference()));
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
})();
