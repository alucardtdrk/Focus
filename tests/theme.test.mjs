import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const saved = new Map();
const events = {};
let systemChanged;
const button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = String(value); } };
const root = { dataset: {} };
const media = { matches: true, addEventListener(name, fn) { systemChanged = fn; } };
const meta = { setAttribute(name, value) { this[name] = value; } };
const context = vm.createContext({
  document: { documentElement: root, querySelector: () => meta, querySelectorAll: () => [button], addEventListener: (name, fn) => { events[name] = fn; } },
  window: { matchMedia: () => media, addEventListener: (name, fn) => { events[name] = fn; } },
  localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) },
});
vm.runInContext(readFileSync(new URL('../src/theme.js', import.meta.url), 'utf8'), context);
assert.equal(root.dataset.theme, 'dark');
assert.equal(meta.content, '#12141b');
events.click({ target: { closest: () => button } });
assert.equal(root.dataset.theme, 'light');
assert.equal(saved.get('foco.theme.v1'), 'light');
assert.equal(button.attributes['aria-pressed'], 'false');
media.matches = true; systemChanged();
assert.equal(root.dataset.theme, 'light', 'saved preference must override system');
saved.clear(); media.matches = false; systemChanged();
assert.equal(root.dataset.theme, 'light');
events.storage({ key: 'foco.theme.v1', newValue: 'dark' });
assert.equal(root.dataset.theme, 'dark');
console.log('Tema: preferência do sistema, alternância, persistência e acessibilidade OK');
