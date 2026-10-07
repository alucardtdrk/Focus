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
      button.setAttribute('title', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
    });
  }
  apply(preference());
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-action="toggle-theme"]')) return;
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(key, next); } catch { /* Theme still works when browser storage is unavailable. */ }
    apply(next);
  });
  media.addEventListener('change', () => apply(preference()));
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
})();
