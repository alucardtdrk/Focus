import { createCloud } from './supabase.js';
import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';

const cloud = createCloud({ url: SUPABASE_URL, key: SUPABASE_KEY });
const KEYS = { tests: 'foco.tests.v1', attempts: 'foco.attempts.v1', pending: 'foco.pending.v1' };
const LETTERS = ['A', 'B', 'C', 'D'];
const EXAMPLE = {
  id: 'foco-example-01', title: 'Avaliação de demonstração',
  instructions: 'Responda com calma. Este teste curto mostra como as perguntas e a revisão aparecem no Foco.',
  durationMinutes: 8, isExample: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  questions: [
    { id: 'ex-q1', type: 'multiple', text: 'Qual destas atitudes ajuda a deixar uma instrução mais fácil de entender?', options: [{ letter: 'A', text: 'Usar frases diretas e uma ação por vez.' }, { letter: 'B', text: 'Acrescentar vários assuntos na mesma frase.' }, { letter: 'C', text: 'Omitir o contexto da tarefa.' }, { letter: 'D', text: 'Evitar exemplos em qualquer situação.' }], correct: 'A' },
    { id: 'ex-q2', type: 'multiple', text: 'Ao preparar uma avaliação curta, qual informação é importante combinar antes?', options: [{ letter: 'A', text: 'A cor do navegador.' }, { letter: 'B', text: 'O objetivo e o tempo disponível.' }, { letter: 'C', text: 'O modelo de computador.' }, { letter: 'D', text: 'A quantidade de abas abertas.' }], correct: 'B' },
    { id: 'ex-q3', type: 'free', text: 'Em uma frase, o que você gostaria de avaliar com um teste?', options: [], correct: null },
  ],
};

function readStore(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : fallback; }
  catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { toast('O armazenamento local está cheio. Exporte os resultados e remova dados antigos.', 'error'); return false; }
}

const state = {
  view: 'dashboard', tests: [], attempts: [], editor: null, editorIsNew: false,
  activeQuiz: null, examIndex: 0, attempt: null, previewMode: false, questionAnimating: false,
  selectedAttemptId: null, examTimer: null, toastTimer: null, bootError: '',
  user: null, loading: false, accountError: '', authVersion: 0,
  shareToken: null, revision: null, delivery: '', deliveryError: '', sending: false,
  localSaved: true,
};
const app = document.querySelector('#app');

function requireSameAccount(owner, version) {
  if (state.user?.id !== owner || state.authVersion !== version) throw new Error('A conta mudou durante a operação. Entre novamente antes de continuar.');
}

async function loadRows(table, columns) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await cloud.request(`/rest/v1/${table}?select=${columns}&order=id&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
async function loadAccount() {
  const version = state.authVersion;
  state.loading = true; state.accountError = ''; render();
  try {
    const [quizzes, reports] = await Promise.all([loadRows('foco_tests', 'quiz,share_token'), loadRows('foco_attempts', 'data')]);
    if (version !== state.authVersion) return;
    state.tests = quizzes.map(row => ({ ...row.quiz, shareToken: row.share_token }));
    state.attempts = reports.map(row => row.data);
  } catch (error) {
    if (version === state.authVersion) {
      state.accountError = `Não foi possível carregar seus dados. Verifique a conexão e se o SQL de configuração foi executado. ${error.message}`;
      if (!cloud.user) { state.user = null; state.tests = []; state.attempts = []; state.editor = null; state.selectedAttemptId = null; }
    }
  } finally {
    if (version === state.authVersion) { state.loading = false; render(); }
  }
}
async function saveQuiz(quiz) {
  if (!state.user) throw new Error('Entre com sua conta de avaliador.');
  const owner = state.user.id; const version = state.authVersion;
  const content = clone(quiz); delete content.shareToken;
  const rows = await cloud.request('/rest/v1/foco_tests?on_conflict=owner_id,id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: { owner_id: owner, id: quiz.id, quiz: content, ...(quiz.shareToken ? { share_token: quiz.shareToken } : {}) },
  });
  requireSameAccount(owner, version);
  if (!rows?.length) throw new Error('O teste não foi salvo. Entre novamente.');
  return { ...rows[0].quiz, shareToken: rows[0].share_token };
}
async function storeImportedAttempt(attempt, quizzes = state.tests) {
  if (!state.user) throw new Error('Entre com sua conta de avaliador.');
  const owner = state.user.id; const version = state.authVersion;
  if (!isAttempt(attempt) || !attempt.submittedAt) throw new Error('Só é possível importar tentativas concluídas.');
  const data = clone(attempt);
  const original = quizzes.find(test => test.id === data.quizId);
  if (!data.quizSnapshot?.questions?.length) throw new Error('O relatório não contém as perguntas.');
  if (!data.snapshotLocked) {
    data.quizSnapshot.questions = data.quizSnapshot.questions.map(question => {
      const source = original?.questions.find(q => q.id === question.id && q.type === question.type && q.text === question.text
        && (q.type !== 'multiple' || JSON.stringify(q.options) === JSON.stringify(question.options)));
      return { ...question, ...(source?.correct ? { correct: source.correct } : {}) };
    });
    data.snapshotLocked = true;
  }
  await cloud.request('/rest/v1/foco_attempts?on_conflict=owner_id,id', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
    body: { owner_id: owner, id: data.id, quiz_id: data.quizId, data },
  });
  requireSameAccount(owner, version);
}
async function migrateLocal() {
  if (!window.confirm('Importar as avaliações e tentativas concluídas deste navegador para a conta atual? As cópias locais serão preservadas.')) return;
  const quizzes = readStore(KEYS.tests, []);
  const owner = state.user.id; const version = state.authVersion;
  let errors = 0;
  for (const quiz of quizzes) {
    requireSameAccount(owner, version);
    if (state.tests.some(test => test.id === quiz.id)) continue;
    try { const saved = await saveQuiz(quiz); state.tests.push(saved); } catch { errors++; }
  }
  for (const attempt of readStore(KEYS.attempts, []).filter(item => item.submittedAt)) {
    requireSameAccount(owner, version);
    try { await storeImportedAttempt(attempt, quizzes); } catch { errors++; }
  }
  requireSameAccount(owner, version);
  await loadAccount();
  toast(errors ? `${errors} item(ns) não puderam ser importados. As cópias locais foram preservadas.` : 'Dados locais importados para sua conta.', errors ? 'error' : '');
}
async function deleteAttempt(id) {
  if (!window.confirm('Excluir este resultado da sua conta? Esta ação não pode ser desfeita.')) return;
  const owner = state.user.id; const version = state.authVersion;
  const rows = await cloud.request(`/rest/v1/foco_attempts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  requireSameAccount(owner, version);
  if (!rows?.length) throw new Error('O resultado não foi excluído. Atualize a lista e tente novamente.');
  state.attempts = state.attempts.filter(item => item.id !== id);
  state.selectedAttemptId = null; state.view = 'results'; render(); toast('Resultado excluído.');
}
function renderLogin() {
  return `<div class="participant-page"><header class="participant-top">${brand()}</header><main class="participant-content"><span class="eyebrow">ÁREA DO AVALIADOR</span><h1>Entre para avaliar.</h1><p>Seus testes e resultados ficam na sua conta.</p><form id="login-form" class="intro-card"><div class="field"><label for="login-email">E-mail</label><input class="input" id="login-email" name="email" type="email" autocomplete="username" required></div><div class="field"><label for="login-password">Senha</label><input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required></div><p id="login-error" role="alert">${escapeHtml(state.accountError)}</p><button class="button primary" type="submit">Entrar</button></form></main></div>`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function uid() { return globalThis.crypto?.randomUUID?.() || `foco-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function formatDate(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}
function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
function elapsedSeconds(attempt) {
  const start = new Date(attempt.startedAt).getTime();
  const end = new Date(attempt.submittedAt || Date.now()).getTime();
  return Math.max(0, Math.round((end - start) / 1000));
}
function brandMark() {
  return '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M8.4 3.5H5.8a2.3 2.3 0 0 0-2.3 2.3v2.6M15.6 3.5h2.6a2.3 2.3 0 0 1 2.3 2.3v2.6M20.5 15.6v2.6a2.3 2.3 0 0 1-2.3 2.3h-2.6M8.4 20.5H5.8a2.3 2.3 0 0 1-2.3-2.3v-2.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.1" fill="#D8F178"/></svg></span>';
}
function brand(compact = false) {
  return `<div class="brand-group"><a class="brand" href="#" data-action="go-dashboard" aria-label="Foco — início">${brandMark()}<span class="brand-copy"><span class="brand-word">Foco</span>${compact ? '' : '<span class="brand-caption">SESSÕES DE AVALIAÇÃO</span>'}</span></a>${themeButton()}</div>`;
}
function themeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'Ativar modo claro' : 'Ativar modo escuro';
  return `<button class="theme-toggle" data-action="toggle-theme" data-tooltip="${label}" type="button" aria-label="${label}" aria-pressed="${dark}"><svg class="theme-icon moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.5 13.5A8.5 8.5 0 0 1 10.5 3.5a8.5 8.5 0 1 0 10 10Z"/></svg><svg class="theme-icon sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg></button>`;
}
function renderLoading() {
  return `<div class="loading-page"><header class="loading-header">${brand()}</header><main class="loading-content" role="status" aria-live="polite" aria-busy="true"><div class="loader-orbit" aria-hidden="true"><span></span>${brandMark()}</div><span class="eyebrow">UM MOMENTO DE FOCO</span><h1>Preparando seu espaço.</h1><p>${new URLSearchParams(window.location.search).has('test') ? 'Estamos abrindo sua avaliação.' : 'Estamos buscando seus testes e resultados.'}</p><div class="loading-preview" aria-hidden="true"><div class="skeleton-heading"></div><div class="skeleton-cards"><span></span><span></span><span></span></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div><span class="loading-caption">Tudo pronto para continuar, em instantes.</span></main></div>`;
}
function toast(message, kind = '') {
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.setAttribute('role', 'status');
  node.textContent = message;
  document.body.append(node);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.remove(), 3400);
}
async function navigate(view) { state.view = view; state.selectedAttemptId = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); if (state.user && ['dashboard', 'results'].includes(view)) await loadAccount(); }
function sortAttempts(items = state.attempts) { return [...items].sort((a, b) => new Date(b.submittedAt || b.startedAt) - new Date(a.submittedAt || a.startedAt)); }
function allFocusEvents() { return state.attempts.reduce((sum, item) => sum + (item.events?.length || 0), 0); }
function displayTestName(id, fallback = 'Teste importado') { return state.tests.find(test => test.id === id)?.title || fallback; }

function shell(content, active = 'dashboard', topRight = '') {
  const navItems = [
    ['dashboard', '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>', 'Avaliações'],
    ['results', '<path d="M5 20V10m7 10V4m7 16v-7"/><path d="M3 21h18"/>', 'Resultados'],
    ['guide', '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01"/>', 'Como funciona'],
  ];
  return `<div class="app-shell"><aside class="sidebar">${brand()}<div class="side-label">ÁREA DO AVALIADOR</div><nav class="side-nav" aria-label="Navegação principal">${navItems.map(([key, icon, label]) => `<button class="nav-link ${active === key ? 'active' : ''}" type="button" data-action="navigate" data-view="${key}" data-tooltip="${label}" aria-label="${label}" title="${label}" aria-current="${active === key ? 'page' : 'false'}"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span><span class="nav-text">${label}</span></button>`).join('')}</nav></aside><main class="workspace"><header class="topbar"><span class="topbar-label">${active === 'results' ? 'REVISÃO DE TENTATIVAS' : active === 'guide' ? 'GUIA RÁPIDO' : 'SESSÕES DE AVALIAÇÃO'}</span><div class="topbar-actions"><span class="mobile-theme">${themeButton()}</span>${topRight}<button class="button ghost small" type="button" data-action="logout">Sair</button></div></header><div class="page-content">${state.accountError ? `<p class="account-error" role="alert">${escapeHtml(state.accountError)} <button class="button secondary small" data-action="refresh-results" type="button">Tentar novamente</button></p>` : ""}${content}</div></main></div>`;
}
function topActions() {
  return '<button class="button secondary small" type="button" data-action="refresh-results">Atualizar</button>';
}
function searchText(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function searchField(label) {
  return `<div class="list-search"><label for="list-search">${label}</label><div class="search-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input class="input" id="list-search" type="search" placeholder="${label}" autocomplete="off"></div><p id="search-count" role="status"></p></div>`;
}
function filterList(value) {
  const query = searchText(value.trim());
  let visible = 0;
  document.querySelectorAll('[data-search]').forEach(row => { row.hidden = !searchText(row.dataset.search).includes(query); if (!row.hidden) visible++; });
  const status = document.querySelector('#search-count');
  if (status) status.textContent = query ? (visible ? `${visible} resultado(s) encontrado(s)` : 'Nenhum resultado. Tente outro nome.') : '';
}
function testRow(test) {
  const count = test.questions?.length || 0;
  const attemptsForTest = state.attempts.filter(item => item.quizId === test.id).length;
  return `<article class="test-row" data-search="${escapeHtml(test.title)}"><div class="test-card-heading"><span class="test-card-icon" aria-hidden="true">▤</span><div><div class="test-title-line"><h3>${escapeHtml(test.title || 'Teste sem título')}</h3>${test.isExample ? '<span class="pill lime">DEMONSTRAÇÃO</span>' : ''}</div><div class="test-meta"><span>${count} ${count === 1 ? 'pergunta' : 'perguntas'}</span><span class="separator">•</span><span>${Number(test.durationMinutes) || 1} min</span><span class="separator">•</span><span>${attemptsForTest} ${attemptsForTest === 1 ? 'tentativa' : 'tentativas'}</span></div></div></div><div class="test-actions"><button class="button ghost small" type="button" data-action="edit-test" data-id="${escapeHtml(test.id)}">Editar</button><button class="button secondary small" type="button" data-action="share-test" data-id="${escapeHtml(test.id)}">Copiar link</button><button class="button ghost small" type="button" data-action="preview-test" data-id="${escapeHtml(test.id)}">Prévia</button><button class="button ghost small" type="button" data-action="test-menu" data-id="${escapeHtml(test.id)}" data-tooltip="Mais opções" aria-expanded="false" aria-controls="extra-${escapeHtml(test.id)}" aria-label="Mais opções para ${escapeHtml(test.title)}">•••</button></div><div class="test-extra disclosure-panel" id="extra-${escapeHtml(test.id)}" inert><div class="disclosure-content"><button class="button ghost small" data-action="export-test" data-id="${escapeHtml(test.id)}" type="button">Baixar teste</button><button class="button ghost small" data-action="duplicate-test" data-id="${escapeHtml(test.id)}" type="button">Duplicar</button><button class="button danger small" data-action="delete-test" data-id="${escapeHtml(test.id)}" type="button">Excluir</button></div></div></article>`;
}
function renderDashboard() {
  const testList = state.tests.length
    ? `<div class="test-list">${[...state.tests].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).map(testRow).join('')}</div>`
    : `<div class="empty-state"><div class="empty-symbol">＋</div><h3>O primeiro teste começa aqui.</h3><p>Adicione perguntas, escolha o tempo e compartilhe um link quando estiver pronto.</p><button class="button primary" data-action="new-test" type="button">Criar primeiro teste</button></div>`;
  const content = `<section class="page-intro"><div><span class="eyebrow">AVALIAÇÃO SEM OPERAÇÃO</span><h1>Avalie com clareza.<br><em>Sem complicar.</em></h1><p>Monte um teste, compartilhe um link e revise as respostas no seu tempo. Os participantes respondem pelo link e as entregas chegam à sua conta.</p></div><aside class="hero-aside"><span class="aside-number">01 / ONLINE</span><strong>Um teste. Um link.</strong><p>Avaliações e resultados ficam na sua conta. As respostas chegam automaticamente.</p></aside></section><div class="metric-row"><article class="metric-card"><div class="metric-label">Testes guardados</div><div class="metric-value">${state.tests.length}<small>na sua conta</small></div></article><article class="metric-card"><div class="metric-label">Tentativas recebidas</div><div class="metric-value">${state.attempts.length}<small>recebidas online</small></div></article><article class="metric-card"><div class="metric-label">Sinais de perda de foco</div><div class="metric-value">${allFocusEvents()}<small>em todas as tentativas</small></div></article></div><section><div class="section-heading"><div><h2>Seus testes</h2><p>Edite, compartilhe ou faça uma prévia antes de enviar.</p></div><button class="button primary" type="button" data-action="new-test"><span class="button-icon">＋</span>Criar teste</button></div>${state.tests.length ? searchField('Buscar avaliações') : ''}${testList}</section><div class="page-footnote"><span aria-hidden="true">↗</span><span><strong>Privacidade, sem letra miúda.</strong> O Foco registra mudanças de aba, perda de foco da janela e cliques fora da área da prova. Isso são sinais técnicos — não uma prova de fraude.</span></div>`;
  return shell(`<div class="dashboard-content">${content}</div>`, 'dashboard', topActions());
}

function emptyQuestion() { return { id: uid(), type: 'multiple', text: '', options: LETTERS.map(letter => ({ letter, text: '' })), correct: 'A' }; }
function openEditor(test = null) {
  state.editorIsNew = !test;
  state.editor = test ? clone(test) : { id: uid(), title: '', instructions: '', durationMinutes: 20, questions: [emptyQuestion()], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  state.view = 'editor';
  render();
  window.scrollTo({ top: 0 });
}
function renderQuestionEditor(question, index) {
  const optionsHtml = question.type === 'multiple' ? `<div class="question-options">${LETTERS.map(letter => {
    const option = question.options?.find(item => item.letter === letter) || { text: '' };
    return `<label class="option-editor"><input type="radio" name="correct-${escapeHtml(question.id)}" data-action="set-correct" data-qid="${escapeHtml(question.id)}" data-letter="${letter}" ${question.correct === letter ? 'checked' : ''} aria-label="Marcar alternativa ${letter} como correta"><span class="option-letter">${letter}</span><input type="text" data-option="${letter}" data-qid="${escapeHtml(question.id)}" value="${escapeHtml(option.text)}" placeholder="Texto da alternativa ${letter}" aria-label="Texto da alternativa ${letter}"></label>`;
  }).join('')}</div><p class="correct-hint"><strong>○</strong> Marque a alternativa correta no círculo. O gabarito não será incluído no link público.</p>` : `<div class="free-answer-preview">Resposta aberta · será revisada manualmente pelo avaliador.</div>`;
  return `<article class="question-card" data-question="${escapeHtml(question.id)}"><div class="question-card-head"><div class="question-identity"><span class="question-number">${String(index + 1).padStart(2, '0')}</span><span class="question-type">${question.type === 'multiple' ? 'MÚLTIPLA ESCOLHA · A–D' : 'RESPOSTA LIVRE'}</span></div><div class="test-actions"><button class="button ghost small" data-action="toggle-question-type" data-qid="${escapeHtml(question.id)}" type="button">Trocar tipo</button><button class="button ghost small" data-action="remove-question" data-qid="${escapeHtml(question.id)}" type="button" aria-label="Remover pergunta ${index + 1}">Remover</button></div></div><div class="question-card-body"><div class="field"><label for="prompt-${escapeHtml(question.id)}">Enunciado</label><textarea class="textarea" id="prompt-${escapeHtml(question.id)}" data-qprompt="${escapeHtml(question.id)}" placeholder="Escreva a pergunta de forma direta…">${escapeHtml(question.text)}</textarea></div>${optionsHtml}</div></article>`;
}
function renderEditor() {
  const quiz = state.editor;
  const isNew = state.editorIsNew;
  const content = `<div class="editor-top"><div><span class="eyebrow">${isNew ? 'NOVA AVALIAÇÃO' : 'EDITAR AVALIAÇÃO'}</span><h1>${isNew ? 'Vamos preparar o teste.' : escapeHtml(quiz.title || 'Editar teste')}</h1></div><button class="button ghost" type="button" data-action="navigate" data-view="dashboard">← Voltar</button></div><div class="editor-layout"><div class="editor-main"><section class="editor-card"><div class="card-heading"><div><h2>Informações do teste</h2><p>O básico para o participante saber o que esperar.</p></div><span class="pill">01 / CONFIGURAÇÃO</span></div><div class="field"><label for="quiz-title">Nome do teste</label><input class="input" id="quiz-title" data-editor-field="title" maxlength="90" value="${escapeHtml(quiz.title)}" placeholder="Ex.: Avaliação inicial — atendimento"></div><div class="field"><label for="quiz-instructions">Instruções para o participante <span style="font-weight:400;color:var(--muted)">(opcional)</span></label><textarea class="textarea" id="quiz-instructions" data-editor-field="instructions" maxlength="600" placeholder="Explique como responder, o que pode consultar e qualquer contexto importante…">${escapeHtml(quiz.instructions || '')}</textarea></div><div class="field-grid"><div class="field"><span class="field-label">Formato</span><div class="field-hint">Questões objetivas com gabarito e perguntas abertas na mesma avaliação.</div></div><div class="field"><label for="quiz-duration">Tempo total</label><div class="duration-input"><input class="input" id="quiz-duration" type="number" min="1" max="180" step="1" data-editor-field="durationMinutes" value="${Number(quiz.durationMinutes) || 20}"><span>min</span></div></div></div></section><section><div class="question-section-heading"><div><h2>Perguntas</h2><p>${quiz.questions.length} ${quiz.questions.length === 1 ? 'pergunta na sequência' : 'perguntas na sequência'}</p></div><button class="button secondary small" type="button" data-action="add-question"><span class="button-icon">＋</span>Adicionar pergunta</button></div><div class="question-stack">${quiz.questions.map(renderQuestionEditor).join('')}</div><button class="button secondary wide add-question-bottom" type="button" data-action="add-question"><span class="button-icon" aria-hidden="true">＋</span>Adicionar pergunta</button></section><div class="editor-savebar"><p>Salvo na sua conta. O link compartilhado não revela o gabarito.</p><div class="editor-save-actions"><button class="button secondary" type="button" data-action="save-editor">Salvar teste</button><button class="button primary" type="button" data-action="save-share"><span class="button-icon">↗</span>Salvar e compartilhar</button></div></div></div><aside class="editor-aside"><div class="editor-aside-card"><h3>Uma configuração pequena, mas suficiente.</h3><ul class="editor-checklist"><li><span class="check-dot">✓</span><span>Selecione múltipla escolha ou resposta livre em cada pergunta.</span></li><li><span class="check-dot">✓</span><span>Marque a resposta correta nas perguntas objetivas.</span></li><li><span class="check-dot">✓</span><span>O cronômetro vale para o teste todo e entrega ao chegar a zero.</span></li><li><span class="check-dot">✓</span><span>Faça uma prévia antes de copiar o link.</span></li></ul></div><div class="editor-aside-card"><h3>Gabarito protegido no link</h3><p>O arquivo/link enviado ao participante contém enunciados e alternativas, mas não as respostas corretas. O gabarito fica protegido na conta do avaliador.</p></div></aside></div>`;
  return shell(content, 'dashboard');
}
function updateEditorValue(target) {
  if (!state.editor) return;
  const field = target.dataset.editorField;
  if (field === 'durationMinutes') state.editor.durationMinutes = Math.max(1, Math.min(180, Number(target.value) || 1));
  if (field === 'title' || field === 'instructions') state.editor[field] = target.value;
  const questionPrompt = target.dataset.qprompt;
  if (questionPrompt) {
    const q = state.editor.questions.find(item => item.id === questionPrompt);
    if (q) q.text = target.value;
  }
  const optionLetter = target.dataset.option;
  const questionId = target.dataset.qid;
  if (optionLetter && questionId) {
    const q = state.editor.questions.find(item => item.id === questionId);
    if (q) {
      q.options ||= LETTERS.map(letter => ({ letter, text: '' }));
      const option = q.options.find(item => item.letter === optionLetter);
      if (option) option.text = target.value;
    }
  }
}
async function saveEditor() {
  const quiz = state.editor;
  if (!quiz) return null;
  quiz.title = quiz.title.trim();
  if (!quiz.title) { toast('Dê um nome ao teste antes de salvar.', 'error'); document.querySelector('#quiz-title')?.focus(); return null; }
  quiz.durationMinutes = Math.max(1, Math.min(180, Number(quiz.durationMinutes) || 1));
  quiz.updatedAt = new Date().toISOString();
  const saved = await saveQuiz(quiz);
  const index = state.tests.findIndex(item => item.id === quiz.id);
  if (index >= 0) state.tests[index] = saved; else state.tests.unshift(saved);
  state.editor = clone(saved);
  state.editorIsNew = false;
  return clone(saved);
}
function questionIssues(quiz) {
  if (!quiz.title?.trim()) return 'Dê um nome ao teste antes de continuar.';
  if (!quiz.questions?.length) return 'Adicione pelo menos uma pergunta.';
  const blank = quiz.questions.findIndex(q => !q.text?.trim());
  if (blank >= 0) return `Complete o enunciado da pergunta ${blank + 1}.`;
  const missingOption = quiz.questions.findIndex(q => q.type === 'multiple' && LETTERS.some(letter => !q.options?.find(item => item.letter === letter)?.text?.trim()));
  if (missingOption >= 0) return `Preencha as quatro alternativas da pergunta ${missingOption + 1}.`;
  return '';
}
function publicQuiz(quiz) {
  return { id: quiz.id, title: quiz.title, instructions: quiz.instructions || '', durationMinutes: quiz.durationMinutes, questions: quiz.questions.map(q => ({ id: q.id, type: q.type, text: q.text, options: q.type === 'multiple' ? q.options.map(o => ({ letter: o.letter, text: o.text })) : [] })) };
}
function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function validateQuiz(quiz) {
  return quiz && typeof quiz.id === 'string' && typeof quiz.title === 'string' && Array.isArray(quiz.questions) && quiz.questions.length > 0 && quiz.questions.every(q => typeof q.id === 'string' && typeof q.text === 'string' && ['multiple', 'free'].includes(q.type));
}
async function shareQuiz(quiz, button) {
  const issue = questionIssues(quiz);
  if (issue) { toast(issue, 'error'); return; }
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  if (!quiz.shareToken) throw new Error('Salve o teste na sua conta antes de compartilhar.');
  url.searchParams.set('test', quiz.shareToken);
  try {
    await navigator.clipboard.writeText(url.toString());
    if (button) {
      const original = button.innerHTML;
      button.textContent = 'Link copiado ✓'; button.classList.add('copied');
      setTimeout(() => { button.innerHTML = original; button.classList.remove('copied'); }, 2500);
    }
    toast('Link copiado. O gabarito não vai junto.');
  } catch {
    window.prompt('Copie o link do teste:', url.toString());
  }
}
async function saveEditorAndShare() {
  const quiz = await saveEditor();
  if (!quiz) return;
  state.view = 'editor';
  render();
  await shareQuiz(quiz);
}
function beginTest(quiz, preview = false) {
  const issue = questionIssues(quiz);
  if (issue) { toast(issue, 'error'); return; }
  state.activeQuiz = clone(quiz);
  state.previewMode = preview;
  state.shareToken = null; state.revision = null; state.delivery = ''; state.deliveryError = '';
  state.attempt = null;
  state.view = 'participant-intro';
  render();
  window.scrollTo({ top: 0 });
}
function startAttempt(form) {
  const name = new FormData(form).get('participant')?.toString().trim();
  if (!name) { form.querySelector('[name="participant"]')?.focus(); return; }
  const start = new Date();
  state.attempt = {
    id: uid(), quizId: state.activeQuiz.id, quizTitle: state.activeQuiz.title,
    participant: name, startedAt: start.toISOString(), deadline: start.getTime() + Number(state.activeQuiz.durationMinutes) * 60_000,
    submittedAt: null, submissionReason: null, responses: {}, events: [],
    quizSnapshot: publicQuiz(state.activeQuiz),
  };
  state.examIndex = 0;
  state.view = 'exam';
  upsertAttempt();
  render();
}
function upsertAttempt() {
  if (!state.attempt || state.previewMode) return;
  if (state.shareToken) {
    const pending = readStore(KEYS.pending, []).filter(item => item.attempt?.id !== state.attempt.id);
    pending.push({ token: state.shareToken, revision: state.revision, attempt: clone(state.attempt), examIndex: state.examIndex, view: state.view });
    state.localSaved = writeStore(KEYS.pending, pending);
  } else {
    const local = readStore(KEYS.attempts, []).filter(item => item.id !== state.attempt.id);
    local.unshift({ ...clone(state.attempt), examIndex: state.examIndex, view: state.view }); state.localSaved = writeStore(KEYS.attempts, local);
  }
}
function savedStatus() {
  if (state.previewMode) return '';
  if (!state.localSaved) return 'Não foi possível salvar. Mantenha esta página aberta e baixe o comprovante ao finalizar.';
  return navigator.onLine === false ? 'Respostas salvas neste navegador · Sem conexão. A entrega exige internet.' : '';
}
function updateSavedStatus() {
  const node = document.querySelector('#saved-status');
  if (node) { node.textContent = savedStatus(); node.classList.toggle('save-error', !state.localSaved); node.hidden = !savedStatus(); }
}
function restoreAttempt(saved) {
  const attempt = saved?.attempt;
  if (!isAttempt(attempt) || !validateQuiz(attempt.quizSnapshot) || !Number.isFinite(attempt.deadline)) return false;
  state.activeQuiz = attempt.quizSnapshot; state.attempt = attempt; state.revision = saved.revision ?? null;
  state.localSaved = true;
  state.examIndex = Math.max(0, Math.min(state.activeQuiz.questions.length - 1, Number.isInteger(saved.examIndex) ? saved.examIndex : 0));
  state.view = attempt.submittedAt ? 'thanks' : saved.view === 'review' ? 'review' : 'exam';
  state.delivery = attempt.submittedAt ? 'failed' : ''; state.deliveryError = attempt.submittedAt ? 'Há uma entrega pendente neste navegador.' : '';
  return true;
}
function recordFocusEvent(type) {
  if (!['exam', 'review'].includes(state.view) || state.previewMode || !state.attempt || state.attempt.submittedAt) return;
  const now = Date.now();
  const prior = [...state.attempt.events].reverse().find(item => item.type === type);
  if (prior && now - new Date(prior.at).getTime() < 1_300) return;
  state.attempt.events.push({ id: uid(), type, at: new Date(now).toISOString(), elapsedSeconds: Math.round((now - new Date(state.attempt.startedAt).getTime()) / 1000) });
  upsertAttempt();
}
function eventLabel(type) {
  return ({ tab_hidden: 'Aba ocultada ou página minimizada', window_blur: 'Janela perdeu o foco', outside_click: 'Clique fora da área do teste' })[type] || 'Sinal de foco';
}
function eventCounts(attempt) {
  const events = attempt.events || [];
  return { total: events.length, tabs: events.filter(e => e.type === 'tab_hidden').length, blur: events.filter(e => e.type === 'window_blur').length, clicks: events.filter(e => e.type === 'outside_click').length };
}
function updateExamIndicators() {
  if (!state.attempt || !['exam', 'review'].includes(state.view)) return;
  const now = Date.now();
  const remaining = Math.max(0, Math.ceil((state.attempt.deadline - now) / 1000));
  const clock = document.querySelector('#exam-clock');
  if (clock) {
    clock.querySelector('strong').textContent = formatTime(remaining);
    clock.classList.toggle('critical', remaining <= 60);
    clock.classList.toggle('warning', remaining <= 300 && remaining > 60);
  }
  updateSavedStatus();
  const answered = Object.keys(state.attempt.responses).filter(id => {
    const response = state.attempt.responses[id];
    return typeof response === 'string' ? response.trim().length > 0 : Boolean(response);
  }).length;
  const answeredNode = document.querySelector('#answered-count');
  if (answeredNode) answeredNode.textContent = `${answered} de ${state.activeQuiz.questions.length} respondidas`;
  const meter = document.querySelector('#exam-progress-percent');
  if (meter) meter.textContent = `${Math.round((answered / state.activeQuiz.questions.length) * 100)}%`;
  document.querySelectorAll('[data-jump]').forEach(button => {
    const q = state.activeQuiz.questions[Number(button.dataset.jump)];
    const answer = state.attempt.responses[q.id];
    const hasAnswer = typeof answer === 'string' ? answer.trim().length > 0 : Boolean(answer);
    button.classList.toggle('answered', hasAnswer);
    const current = Number(button.dataset.jump) === state.examIndex;
    button.classList.toggle('current', current);
    button.setAttribute('aria-current', current ? 'step' : 'false');
    const label = `Pergunta ${Number(button.dataset.jump) + 1} · ${hasAnswer ? 'Respondida' : 'Em branco'}${current ? ' · Atual' : ''}`;
    button.setAttribute('aria-label', label); button.setAttribute('title', label);
  });
}
function renderIntro() {
  const quiz = state.activeQuiz;
  const content = `<div class="participant-page"><header class="participant-top">${brand()}<span class="pill">${state.previewMode ? 'PRÉVIA' : 'AVALIAÇÃO'}</span></header><main class="participant-content"><div class="intro-meta"><span class="pill blue">${state.previewMode ? 'MODO DE PRÉVIA' : 'SESSÃO CRONOMETRADA'}</span><span class="mono-label">${quiz.questions.length} ${quiz.questions.length === 1 ? 'PERGUNTA' : 'PERGUNTAS'}</span></div><h1>${escapeHtml(quiz.title)}</h1><p>${escapeHtml(quiz.instructions || 'Leia cada pergunta com atenção e responda no seu ritmo. O tempo total aparece durante a avaliação.')}</p><section class="intro-card"><div class="intro-facts"><div class="intro-fact"><strong>${Number(quiz.durationMinutes)} min</strong><span>tempo total</span></div><div class="intro-fact"><strong>${quiz.questions.filter(q => q.type === 'multiple').length}</strong><span>objetivas</span></div><div class="intro-fact"><strong>${quiz.questions.filter(q => q.type === 'free').length}</strong><span>abertas</span></div></div><form id="participant-form"><div class="field"><label for="participant-name">Seu nome</label><input class="input" id="participant-name" name="participant" required maxlength="80" autocomplete="name" placeholder="Como podemos identificar sua resposta?"></div><button class="button primary wide" type="submit">Começar avaliação <span class="button-icon">→</span></button></form><div class="privacy-note"><strong>O que é registrado:</strong> mudanças de aba, perda de foco da janela e cliques fora da área do teste. Nenhuma imagem, áudio ou conteúdo de outras janelas é capturado. Esses sinais podem ter falso positivo e não provam uma intenção.</div></section></main></div>`;
  app.innerHTML = content;
}
function renderExam() {
  upsertAttempt();
  const quiz = state.activeQuiz;
  const question = quiz.questions[state.examIndex];
  const answer = state.attempt.responses[question.id] || '';
  const remaining = Math.max(0, Math.ceil((state.attempt.deadline - Date.now()) / 1000));
  const choices = question.type === 'multiple'
    ? `<div class="answer-list">${question.options.map(option => `<button class="answer-choice ${answer === option.letter ? 'selected' : ''}" data-action="select-answer" data-answer="${escapeHtml(option.letter)}" type="button" aria-pressed="${answer === option.letter}"><span class="option-letter">${escapeHtml(option.letter)}</span><span class="answer-choice-text">${escapeHtml(option.text)}</span><span class="selected-check" aria-hidden="true">✓</span></button>`).join('')}</div>`
    : `<div class="response-area"><label class="field-label" for="free-response">Sua resposta</label><textarea id="free-response" class="textarea" maxlength="5000" placeholder="Escreva sua resposta aqui…">${escapeHtml(answer)}</textarea></div>`;
  const content = `<div class="exam-page"><header class="exam-topline">${brand(true)}<span class="exam-title-mini">${escapeHtml(quiz.title)}</span><div class="exam-clock" id="exam-clock"><span class="clock-indicator"></span><strong>${formatTime(remaining)}</strong><span>restantes</span></div></header><main class="exam-stage"><section class="exam-card"><div class="exam-progress-head"><span>PERGUNTA ${String(state.examIndex + 1).padStart(2, '0')} / ${String(quiz.questions.length).padStart(2, '0')}</span><strong id="exam-progress-percent">0%</strong></div><div class="progress-segments" aria-label="Navegue entre as perguntas">${quiz.questions.map((q, index) => `<button class="progress-segment ${index === state.examIndex ? 'current' : ''}" data-jump="${index}" type="button" title="Ir para pergunta ${index + 1}" aria-label="Pergunta ${index + 1}">${index + 1}</button>`).join('')}</div><div class="navigation-details"><span id="answered-count" class="navigation-summary">${quiz.questions.filter(q => String(state.attempt.responses[q.id] || '').trim()).length} de ${quiz.questions.length} respondidas</span><div class="navigation-legend"><span><i class="legend-current" aria-hidden="true"></i>Atual</span><span><i class="legend-answered" aria-hidden="true"></i>Respondida</span><span><i class="legend-empty" aria-hidden="true"></i>Em branco</span></div></div><div class="question-kicker">${question.type === 'multiple' ? 'ESCOLHA UMA ALTERNATIVA' : 'RESPOSTA ABERTA'}</div><h1 class="exam-question">${escapeHtml(question.text)}</h1>${question.type === 'multiple' ? '<p class="exam-hint">Selecione a opção que melhor responde à pergunta.</p>' : '<p class="exam-hint">Responda com suas próprias palavras.</p>'}${choices}<p id="saved-status" ${savedStatus() ? '' : 'hidden'} class="save-status ${state.localSaved ? '' : 'save-error'}" role="status">${savedStatus()}</p><div class="exam-controls"><div class="exam-control-actions">${state.examIndex > 0 ? '<button class="button secondary" data-action="exam-previous" type="button">← Anterior</button>' : ''}${state.examIndex < quiz.questions.length - 1 ? '<button class="button primary" data-action="exam-next" type="button">Próxima pergunta →</button>' : '<button class="button primary" data-action="exam-submit" type="button">Revisar respostas →</button>'}</div></div></section></main><p class="exam-lower-note">O cronômetro corre continuamente. Se o tempo terminar, a avaliação será enviada automaticamente. Se precisar, use os números acima para ir direto a uma pergunta.</p></div>`;
  app.innerHTML = content;
  updateExamIndicators();
  startExamTimer();
}
function startExamTimer() {
  clearInterval(state.examTimer);
  state.examTimer = setInterval(() => {
    if (!state.attempt || !['exam', 'review'].includes(state.view)) return;
    updateExamIndicators();
    if (Date.now() >= state.attempt.deadline) finishAttempt('time');
  }, 500);
}
function renderReview() {
  upsertAttempt();
  const quiz = state.activeQuiz;
  const answered = quiz.questions.filter(q => String(state.attempt.responses[q.id] || '').trim()).length;
  const missing = quiz.questions.length - answered;
  const cards = quiz.questions.map((q, index) => {
    const answer = String(state.attempt.responses[q.id] || '');
    const option = q.type === 'multiple' ? q.options.find(o => o.letter === answer) : null;
    return `<article class="review-answer"><header><span class="question-kicker">PERGUNTA ${String(index+1).padStart(2,'0')} · ${q.type === 'multiple' ? 'OBJETIVA' : 'ABERTA'}</span><button class="button secondary small" data-action="review-edit" data-index="${index}" aria-label="Editar resposta da pergunta ${index+1}" type="button">Editar ↗</button></header><h2>${escapeHtml(q.text)}</h2><div class="review-response"><span class="review-response-label">SUA RESPOSTA</span><p>${answer.trim() ? (option ? '<span class="review-letter">'+escapeHtml(option.letter)+'</span>'+escapeHtml(option.text) : escapeHtml(answer)) : 'Sem resposta. Você pode voltar e responder antes de enviar.'}</p></div></article>`;
  }).join('');
  app.innerHTML = `<div class="exam-page review-page"><header class="exam-topline">${brand(true)}<span class="exam-title-mini">${escapeHtml(quiz.title)}</span><div id="exam-clock" class="exam-clock"><span class="clock-indicator"></span><strong></strong><span>restantes</span></div></header><main class="review-stage"><section class="review-hero"><span class="eyebrow">ÚLTIMA ETAPA · REVISÃO</span><h1 id="review-heading" tabindex="-1">Tudo pronto para enviar?</h1><p>Confira suas escolhas e o que escreveu. Ainda dá tempo de ajustar.</p><div class="review-summary"><span class="pill blue">${answered} de ${quiz.questions.length} respondidas</span><span class="pill">${escapeHtml(state.attempt.participant)}</span></div></section>${missing ? '<div class="review-warning" role="status"><strong>'+missing+' pergunta(s) sem resposta.</strong><span>Edite as perguntas abaixo ou envie com as respostas em branco.</span></div>' : ''}<p id="saved-status" ${savedStatus() ? '' : 'hidden'} class="save-status ${state.localSaved ? '' : 'save-error'}" role="status">${savedStatus()}</p><section class="review-answers" aria-label="Suas perguntas e respostas">${cards}</section><footer class="review-footer"><div><strong>Este é o envio final.</strong><p>Após enviar, suas respostas não poderão ser alteradas. O tempo continua correndo.</p></div><div class="exam-control-actions"><button class="button secondary" data-action="review-back" type="button">← Voltar à avaliação</button><button class="button primary review-send" data-action="review-send" type="button">Confirmar e enviar ↗</button></div></footer></main></div>`;
  updateExamIndicators(); startExamTimer();
}
async function finishAttempt(reason = 'manual') {
  if (!state.attempt || state.attempt.submittedAt) return;
  state.attempt.submittedAt = new Date().toISOString();
  state.attempt.submissionReason = reason;
  upsertAttempt();
  clearInterval(state.examTimer);
  state.view = 'thanks';
  state.delivery = state.previewMode ? 'preview' : state.shareToken ? 'sending' : 'local';
  render();
  window.scrollTo({ top: 0 });
  if (!state.previewMode && state.shareToken) await sendAttempt();
}
async function sendAttempt() {
  if (state.sending || state.previewMode || !state.shareToken || !state.attempt?.submittedAt) return;
  state.sending = true; state.delivery = 'sending'; state.deliveryError = ''; render();
  try {
    const accepted = await cloud.rpc('foco_submit', { p_token: state.shareToken, p_revision: state.revision, p_attempt: state.attempt });
    if (accepted !== true) throw new Error('A entrega não foi confirmada. Tente novamente.');
    state.delivery = 'sent';
    const pending = readStore(KEYS.pending, []).filter(item => item.attempt?.id !== state.attempt.id);
    try { if (pending.length) writeStore(KEYS.pending, pending); else localStorage.removeItem(KEYS.pending); } catch { /* The server already confirmed delivery; a retained draft can safely retry. */ }
  } catch (error) { state.delivery = 'failed'; state.deliveryError = error.message; }
  finally { state.sending = false; render(); }
}
function renderThanks() {
  const attempt = state.attempt;
  const actions = `${state.delivery === 'failed' ? '<button class="button primary" type="button" data-action="retry-submit">Tentar enviar novamente</button>' : ''}<button class="button secondary" type="button" data-action="download-attempt">Baixar comprovante de respostas</button>${state.previewMode ? '<button class="button secondary" type="button" data-action="go-dashboard">Voltar à prévia</button>' : ''}`;
  const storageMessage = state.previewMode
    ? 'Esta foi uma prévia; nenhuma tentativa foi adicionada aos resultados.'
    : state.delivery === 'sent' ? 'O avaliador já pode consultar suas respostas. O comprovante é opcional.'
    : state.delivery === 'sending' ? 'Enviando suas respostas. Aguarde a confirmação antes de fechar esta página.'
    : state.delivery === 'failed' ? `A entrega ainda não foi confirmada. ${state.deliveryError} ${state.localSaved ? 'Suas respostas foram mantidas neste navegador; tente novamente ou baixe o comprovante.' : 'Não foi possível salvar uma cópia neste navegador. Baixe o comprovante antes de fechar esta página.'}`
    : `Este é um link antigo, sem envio online. Baixe o comprovante e envie ao avaliador. ${state.localSaved ? '' : 'Não foi possível salvar uma cópia neste navegador. Baixe o comprovante antes de fechar esta página.'} Para próximas aplicações, peça um novo link.`;
  const content = `<div class="participant-page"><header class="participant-top">${brand()}<span class="pill">${state.delivery === 'sent' ? 'ENTREGA CONFIRMADA' : 'AVALIAÇÃO FINALIZADA'}</span></header><main class="thanks-content"><div class="thanks-mark ${state.delivery === 'sending' ? 'sending' : ''}" aria-hidden="true">${state.delivery === 'sent' || state.previewMode ? '✓' : '↗'}</div><span class="eyebrow">${attempt.submissionReason === 'time' ? 'TEMPO ENCERRADO' : 'RESPOSTAS REGISTRADAS'}</span><h1>Obrigado, ${escapeHtml(attempt.participant)}.</h1><p>${state.delivery === 'sent' ? 'Suas respostas foram entregues.' : 'Você finalizou a avaliação.'} O resultado e o gabarito não são exibidos nesta tela.</p><section class="thanks-card"><p role="status">${escapeHtml(storageMessage)} O comprovante abre no navegador e pode ser impresso ou salvo como PDF.</p><div class="thanks-actions">${actions}</div></section></main></div>`;
  return content;
}

function questionForAttempt(attempt, snapshotQuestion) {
  if (attempt.snapshotLocked) return snapshotQuestion;
  const test = state.tests.find(item => item.id === attempt.quizId);
  return test?.questions?.find(q => q.id === snapshotQuestion.id) || snapshotQuestion;
}
function answerText(questionSnapshot, answer) {
  if (!answer) return 'Sem resposta';
  if (questionSnapshot.type === 'multiple') {
    const option = questionSnapshot.options?.find(item => item.letter === answer);
    return option ? `${answer} — ${option.text}` : String(answer);
  }
  return String(answer);
}
function correctCount(attempt) {
  const questions = attempt.quizSnapshot?.questions || [];
  let correct = 0; let available = 0;
  for (const snapshot of questions) {
    if (snapshot.type !== 'multiple') continue;
    const q = questionForAttempt(attempt, snapshot);
    if (!q.correct) continue;
    available++;
    if (attempt.responses?.[snapshot.id] === q.correct) correct++;
  }
  return { correct, available };
}
function renderResults() {
  const list = sortAttempts();
  const content = `<section class="page-intro"><div><span class="eyebrow">REVISÃO COM CONTEXTO</span><h1>As respostas,<br><em>sem ruído.</em></h1><p>Veja o que foi respondido, revise as questões abertas e consulte os sinais de foco. As respostas enviadas pelo link aparecem aqui. Use Atualizar para buscar novas entregas.</p></div><aside class="hero-aside"><span class="aside-number">${String(list.length).padStart(2, '0')} / TENTATIVAS</span><strong>Resultados online</strong><p>As entregas ficam na sua conta. Exporte quando precisar de uma cópia.</p></aside></section>${list.length ? `${searchField('Buscar participante ou avaliação')}<div class="result-list">${list.map(attempt => {
    const counts = eventCounts(attempt);
    const score = correctCount(attempt);
    return `<article class="result-row" data-search="${escapeHtml(`${attempt.participant || ''} ${attempt.quizTitle || displayTestName(attempt.quizId)}`)}"><div><h3>${escapeHtml(attempt.participant || 'Participante')} <span class="pill">${score.available ? `${score.correct}/${score.available} OBJETIVAS` : 'SEM GABARITO LOCAL'}</span></h3><p>${escapeHtml(attempt.quizTitle || displayTestName(attempt.quizId))} · ${formatDate(attempt.submittedAt || attempt.startedAt)} · ${formatTime(elapsedSeconds(attempt))} · ${counts.total} ${counts.total === 1 ? 'sinal' : 'sinais'} de foco</p></div><div class="test-actions"><button class="button secondary small" data-action="open-attempt" data-id="${escapeHtml(attempt.id)}" type="button">Abrir revisão →</button><button class="button danger small" data-action="delete-attempt" data-id="${escapeHtml(attempt.id)}" type="button">Excluir resultado</button></div></article>`;
  }).join('')}</div>` : `<div class="empty-state"><div class="empty-symbol">◷</div><h3>Nenhuma tentativa por enquanto.</h3><p>Compartilhe um teste salvo na sua conta. As entregas dos participantes aparecerão aqui.</p><button class="button secondary" type="button" data-action="import-file">Importar arquivo JSON</button><input id="import-file" type="file" accept="application/json,.json" multiple hidden></div>`}<div class="page-footnote"><span aria-hidden="true">i</span><span><strong>Entrega automática.</strong> Links novos enviam respostas diretamente à sua conta. A importação JSON continua disponível para dados antigos e backups.</span></div>`;
  return shell(content, 'results', topActions());
}
function renderAttemptDetail() {
  const attempt = state.attempts.find(item => item.id === state.selectedAttemptId);
  if (!attempt) return renderResults();
  const snapshot = attempt.quizSnapshot || { questions: [] };
  const score = correctCount(attempt);
  const events = [...(attempt.events || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const answerPanel = snapshot.questions.map((question, index) => {
    const userAnswer = attempt.responses?.[question.id] || '';
    const correctQuestion = questionForAttempt(attempt, question);
    let status = '';
    if (question.type === 'multiple') {
      status = correctQuestion.correct
        ? `<span class="answer-status ${userAnswer === correctQuestion.correct ? 'correct' : 'incorrect'}">${userAnswer === correctQuestion.correct ? '✓ Correta' : userAnswer ? '× Incorreta' : '— Em branco'}${correctQuestion.correct ? ` · gabarito ${escapeHtml(correctQuestion.correct)}` : ''}</span>`
        : '<span class="answer-status">Gabarito indisponível neste relatório</span>';
    } else status = `<span class="answer-status">${userAnswer ? 'Revisão manual' : '— Em branco'}</span>`;
    return `<article class="response-item"><h3>${String(index + 1).padStart(2, '0')} · ${escapeHtml(question.text)}</h3><p>${escapeHtml(answerText(question, userAnswer))}</p>${status}</article>`;
  }).join('') || '<div class="no-events">Este relatório não contém o enunciado das perguntas.</div>';
  const eventPanel = events.length ? `<div class="event-list">${events.map(event => `<div class="event-row"><span class="event-mark"></span><div><strong>${escapeHtml(eventLabel(event.type))}</strong><span>${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(event.at))} · ${formatTime(event.elapsedSeconds)} decorridos</span></div></div>`).join('')}</div>` : '<div class="no-events">Nenhum sinal foi registrado durante esta tentativa.</div>';
  const content = `<div class="result-detail-top"><div><button class="button ghost small" data-action="navigate" data-view="results" type="button">← Todas as tentativas</button><h1>${escapeHtml(attempt.participant || 'Participante')}</h1><span class="mono-label">${escapeHtml(attempt.quizTitle || '')} · ${formatDate(attempt.submittedAt)}</span></div></div><div class="result-stats"><article class="result-stat"><span>Objetivas corretas</span><strong>${score.available ? `${score.correct}/${score.available}` : '—'}</strong></article><article class="result-stat"><span>Tempo utilizado</span><strong>${formatTime(elapsedSeconds(attempt))}</strong></article><article class="result-stat"><span>Sinais de foco</span><strong>${(attempt.events || []).length}</strong></article><article class="result-stat"><span>Respondidas</span><strong>${Object.values(attempt.responses || {}).filter(value => String(value).trim()).length}/${snapshot.questions.length}</strong></article></div><div class="result-detail-grid"><section class="detail-panel"><header class="detail-panel-head"><h2>Respostas</h2><p>A revisão usa o gabarito guardado no momento da entrega.</p></header>${answerPanel}</section><section><div class="detail-panel"><header class="detail-panel-head"><h2>Linha do tempo de foco</h2><p>${events.length} ${events.length === 1 ? 'ocorrência registrada' : 'ocorrências registradas'}</p></header>${eventPanel}</div><div class="results-disclaimer"><strong>Leia com cuidado.</strong> Uma aba oculta ou perda de foco pode acontecer por notificações, troca de janela ou outros motivos. É um sinal para contextualizar — não evidência conclusiva de fraude.</div></section></div>`;
  return shell(content, 'results');
}
function renderGuide() {
  const content = `<section class="page-intro"><div><span class="eyebrow">RÁPIDO PARA CRIAR · CLARO PARA REVISAR</span><h1>Pequeno por escolha.<br><em>Transparente por padrão.</em></h1><p>O Foco foi pensado para avaliações que acontecem de vez em quando. O avaliador entra com sua conta; os participantes respondem pelo link sem cadastro.</p></div><aside class="hero-aside"><span class="aside-number">Foco / 01</span><strong>Uma ferramenta de sessão.</strong><p>Monte, envie, revise. Seus dados continuam sob seu controle.</p></aside></section><section class="guide-grid"><article class="guide-card"><span class="guide-number">01 — MONTE</span><h3>Defina o essencial</h3><p>Escreva o nome, instruções, tempo total e perguntas. Cada questão pode ser objetiva (A, B, C, D) com gabarito ou resposta livre.</p></article><article class="guide-card"><span class="guide-number">02 — COMPARTILHE</span><h3>Copie o link</h3><p>O link abre a versão pública do teste, sem gabarito. Abra uma prévia para conferir o fluxo antes de enviar à pessoa.</p></article><article class="guide-card"><span class="guide-number">03 — REVISE</span><h3>Receba automaticamente</h3><p>O participante envia pelo link. Abra Resultados para consultar as entregas, revisar respostas e excluir tentativas.</p></article></section><section class="editor-card" style="margin-top:14px"><div class="card-heading"><div><h2>O que o registro de foco observa — e o que não observa</h2><p>Um limite importante do navegador, explicado sem promessas exageradas.</p></div><span class="pill blue">TRANSPARÊNCIA</span></div><p style="margin:0;color:var(--muted);font-size:12px;line-height:1.8">Durante uma avaliação são registrados a mudança de visibilidade da aba, o desfoque da janela do navegador e cliques fora do cartão de prova enquanto a página está aberta. O navegador não permite saber onde a pessoa clicou em outros aplicativos nem gravar o desktop. Esses sinais podem ocorrer por notificações, multitarefa ou comportamento normal; não demonstram intenção, cola ou fraude. A avaliação não usa câmera, microfone, gravação de tela ou captura de teclas.</p></section><div class="page-footnote"><span aria-hidden="true">↗</span><span><strong>Dados online.</strong> Testes e resultados ficam na sua conta. Durante a aplicação, respostas pendentes também ficam neste navegador para permitir reenvio se a conexão falhar.</span></div>`;
  return shell(content, 'guide');
}
function render() {
  clearInterval(state.examTimer);
  if (state.view === 'link-error') {
    app.innerHTML = `<main class="participant-page"><h1>Não foi possível abrir a avaliação.</h1><p role="alert">${escapeHtml(state.bootError)}</p><button class="button primary" type="button" data-action="retry-boot">Tentar novamente</button></main>`;
    return;
  }
  const participant = ['participant-intro', 'exam', 'review', 'thanks'].includes(state.view);
  if (state.loading && !participant) { app.innerHTML = renderLoading(); return; }
  if (!state.user && !participant) { app.innerHTML = renderLogin(); return; }
  if (state.view === 'dashboard') app.innerHTML = renderDashboard();
  else if (state.view === 'editor') app.innerHTML = renderEditor();
  else if (state.view === 'participant-intro') renderIntro();
  else if (state.view === 'exam') renderExam();
  else if (state.view === 'review') renderReview();
  else if (state.view === 'thanks') app.innerHTML = renderThanks();
  else if (state.view === 'results') app.innerHTML = state.selectedAttemptId ? renderAttemptDetail() : renderResults();
  else if (state.view === 'guide') app.innerHTML = renderGuide();
  else app.innerHTML = renderDashboard();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function fileSafe(value) { return String(value || 'foco').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'foco'; }
function receiptHtml(attempt) {
  const questions = attempt.quizSnapshot?.questions || [];
  const answers = questions.map((question, index) => `<article><span class="label">PERGUNTA ${index + 1}</span><h2>${escapeHtml(question.text)}</h2><div class="answer"><span class="label">SUA RESPOSTA</span><p>${escapeHtml(answerText(question, String(attempt.responses?.[question.id] || '').trim()))}</p></div></article>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Comprovante de respostas · ${escapeHtml(attempt.quizTitle)}</title><style>*{box-sizing:border-box}body{margin:0;background:#f6f5f1;color:#17221f;font:15px/1.7 system-ui,sans-serif}main{max-width:800px;margin:48px auto;padding:24px}header{text-align:center;margin-bottom:32px}.brand{display:flex;justify-content:center;align-items:center;gap:12px;font-size:24px;font-weight:800;letter-spacing:-.04em}.brand-mark{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;color:#fff;background:#405cf5;print-color-adjust:exact;-webkit-print-color-adjust:exact}.brand-mark svg{width:28px;height:28px}h1{font-size:32px;line-height:1.2}h2{font-size:18px;white-space:pre-wrap;overflow-wrap:anywhere}.meta{color:#68716d}.label{font-size:11px;letter-spacing:.08em;color:#68716d}article{background:#fff;border:1px solid #e3e3dc;border-radius:16px;padding:24px;margin:16px 0;break-inside:avoid}.answer{background:#edf0ff;border-radius:10px;padding:16px}.answer p{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}button{border:0;border-radius:10px;background:#405cf5;color:white;padding:14px 22px;font:inherit;cursor:pointer}footer{text-align:center;color:#68716d;font-size:12px;margin-top:28px}@media print{body{background:white}main{margin:0;max-width:none;padding:0}button{display:none}article{box-shadow:none}h1{font-size:26px}}</style></head><body><main><header><div class="brand">${brandMark()}<span>Foco</span></div><h1>Comprovante de respostas</h1><p>${escapeHtml(attempt.quizTitle)}</p><p class="meta">Participante: ${escapeHtml(attempt.participant)}<br>Finalizado em: ${escapeHtml(formatDate(attempt.submittedAt))}<br>Identificador: ${escapeHtml(attempt.id)}</p><button onclick="window.print()" type="button">Imprimir ou salvar como PDF</button></header>${answers}<footer>Este documento é uma cópia das respostas registradas. Não inclui notas ou gabarito e não confirma a entrega ao avaliador.</footer></main></body></html>`;
}
function downloadReceipt(attempt) {
  const blob = new Blob([receiptHtml(attempt)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `foco-comprovante-${fileSafe(attempt.participant)}.html`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function exportAttempt(attempt) {
  downloadJson(`foco-respostas-${fileSafe(attempt.participant)}.json`, { format: 'foco-attempt', version: 1, attempt });
}
function isAttempt(value) {
  return value && typeof value.id === 'string' && typeof value.quizId === 'string' && typeof value.participant === 'string' && value.responses && typeof value.responses === 'object' && Array.isArray(value.events);
}
function isQuizFile(value) { return value?.format === 'foco-quiz' && value.version === 1 && validateQuiz(value.quiz); }
async function importFiles(files) {
  const owner = state.user.id; const version = state.authVersion;
  let importedAttempts = 0; let importedTests = 0; let errors = 0;
  for (const file of files) {
    requireSameAccount(owner, version);
    try {
      const data = JSON.parse(await file.text());
      requireSameAccount(owner, version);
      if (isQuizFile(data)) {
        const incoming = data.quiz;
        if (!incoming.questions.every(q => q.type !== 'multiple' || q.options?.length === 4 || LETTERS.every(letter => q.options?.some(o => o.letter === letter)))) throw new Error('Alternativas incompletas');
        const current = state.tests.find(test => test.id === incoming.id);
        const saved = await saveQuiz({ ...incoming, ...(current?.shareToken ? { shareToken: current.shareToken } : {}) });
        state.tests = state.tests.filter(test => test.id !== saved.id); state.tests.unshift(saved);
        importedTests++;
      } else {
        const list = data.format === 'foco-results' && Array.isArray(data.attempts) ? data.attempts
          : data.format === 'foco-attempt' && isAttempt(data.attempt) ? [data.attempt]
          : isAttempt(data) ? [data] : [];
        if (!list.length) throw new Error('Formato não reconhecido');
        for (const item of list) {
          requireSameAccount(owner, version);
          if (!isAttempt(item)) { errors++; continue; }
          try { await storeImportedAttempt(item); importedAttempts++; } catch { errors++; }
        }
      }
    } catch { errors++; }
  }
  requireSameAccount(owner, version);
  await loadAccount();
  const parts = [];
  if (importedTests) parts.push(`${importedTests} ${importedTests === 1 ? 'teste importado' : 'testes importados'}`);
  if (importedAttempts) parts.push(`${importedAttempts} ${importedAttempts === 1 ? 'resultado importado' : 'resultados importados'}`);
  if (errors) parts.push(`${errors} arquivo(s) ignorado(s)`);
  toast(parts.length ? parts.join(' · ') : 'Nenhum dado compatível foi encontrado.', errors ? 'error' : '');
}
function navigateQuestion(index) {
  if (state.view !== 'exam' || state.questionAnimating) return;
  const next = Math.max(0, Math.min(state.activeQuiz.questions.length - 1, index));
  if (next === state.examIndex) return;
  const direction = next > state.examIndex ? 1 : -1;
  const card = document.querySelector('.exam-card');
  const animate = card?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const outgoing = animate ? card.cloneNode(true) : null;
  state.examIndex = next; render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (!outgoing) return;
  outgoing.classList.add('question-outgoing');
  outgoing.setAttribute('aria-hidden', 'true'); outgoing.inert = true;
  outgoing.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  const stage = document.querySelector('.exam-stage');
  const incoming = stage.querySelector('.exam-card');
  stage.append(outgoing);
  state.questionAnimating = true;
  const options = { duration: 250, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' };
  const exit = outgoing.animate([{ opacity: 1, transform: 'scale(1) translateY(0)' }, { opacity: 0, transform: `scale(.95) translateY(${-direction * 16}px)` }], options);
  const entry = incoming.animate([{ opacity: 0, transform: `translateY(${direction * 32}px) scale(.98)` }, { opacity: 1, transform: 'translateY(0) scale(1)' }], options);
  Promise.allSettled([exit.finished, entry.finished]).finally(() => { outgoing.remove(); entry.cancel(); state.questionAnimating = false; });
}
async function handleClick(event) {
  const actionButton = event.target.closest('[data-action]');
  const jump = event.target.closest('[data-jump]');
  if (jump && state.view === 'exam') { navigateQuestion(Number(jump.dataset.jump)); return; }
  if (!actionButton) return;
  const { action, id, view, qid, letter } = actionButton.dataset;
  if (action === 'navigate') { state.selectedAttemptId = null; await navigate(view); }
  else if (action === 'go-dashboard') {
    event.preventDefault();
    const url = new URL(window.location.href);
    url.searchParams.delete('test');
    url.searchParams.delete('take');
    url.hash = '';
    window.history.replaceState(null, '', url.toString());
    state.view = 'dashboard'; state.selectedAttemptId = null; render(); if (state.user) await loadAccount();
  }
  else if (action === 'refresh-results') await loadAccount();
  else if (action === 'migrate-local') await migrateLocal();
  else if (action === 'delete-attempt') await deleteAttempt(id);
  else if (action === 'retry-submit') await sendAttempt();
  else if (action === 'retry-boot') await boot();
  else if (action === 'logout') {
    state.authVersion++; state.user = null; state.tests = []; state.attempts = []; state.editor = null;
    state.selectedAttemptId = null; state.accountError = ''; state.view = 'dashboard'; state.loading = false; render();
    await cloud.signOut();
  }
  else if (action === 'new-test') openEditor();
  else if (action === 'edit-test') openEditor(state.tests.find(test => test.id === id));
  else if (action === 'add-question') { state.editor.questions.push(emptyQuestion()); render(); document.querySelector(`[data-qprompt="${CSS.escape(state.editor.questions.at(-1).id)}"]`)?.focus(); }
  else if (action === 'remove-question') {
    if (state.editor.questions.length === 1) { toast('Mantenha pelo menos uma pergunta no teste.', 'error'); return; }
    state.editor.questions = state.editor.questions.filter(question => question.id !== qid); render();
  }
  else if (action === 'toggle-question-type') {
    const question = state.editor.questions.find(item => item.id === qid);
    if (question) { question.type = question.type === 'multiple' ? 'free' : 'multiple'; question.options ||= LETTERS.map(l => ({ letter: l, text: '' })); question.correct ||= 'A'; render(); }
  }
  else if (action === 'set-correct') {
    const question = state.editor.questions.find(item => item.id === qid);
    if (question) question.correct = letter;
  }
  else if (action === 'save-editor') {
    if (await saveEditor()) { state.view = 'dashboard'; render(); toast('Teste salvo na sua conta.'); }
  }
  else if (action === 'save-share') await saveEditorAndShare();
  else if (action === 'share-test') await shareQuiz(state.tests.find(test => test.id === id), actionButton);
  else if (action === 'preview-test') beginTest(state.tests.find(test => test.id === id), true);
  else if (action === 'test-menu') {
    const panel = document.getElementById(actionButton.getAttribute('aria-controls'));
    if (!panel) return;
    const open = actionButton.getAttribute('aria-expanded') !== 'true';
    actionButton.setAttribute('aria-expanded', String(open));
    panel.inert = !open;
    panel.classList.toggle('is-open', open);
  }
  else if (action === 'duplicate-test') {
    const original = state.tests.find(test => test.id === id);
    if (original) { const copy = clone(original); copy.id = uid(); delete copy.shareToken; copy.title = `${copy.title.slice(0, 82)} — cópia`; copy.isExample = false; copy.createdAt = copy.updatedAt = new Date().toISOString(); state.tests.unshift(await saveQuiz(copy)); render(); toast('Cópia criada.'); }
  }
  else if (action === 'delete-test') {
    if (window.confirm('Excluir este teste da sua conta? O link deixará de funcionar. Tentativas já registradas continuam salvas.')) {
      const owner = state.user.id; const version = state.authVersion;
      const deleted = await cloud.request(`/rest/v1/foco_tests?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      requireSameAccount(owner, version);
      if (!deleted?.length) throw new Error('O teste não foi excluído. Atualize a lista e tente novamente.');
      state.tests = state.tests.filter(test => test.id !== id); render(); toast('Teste excluído.');
    }
  }
  else if (action === 'export-test') {
    const quiz = state.tests.find(test => test.id === id);
    if (quiz) downloadJson(`foco-teste-${fileSafe(quiz.title)}.json`, { format: 'foco-quiz', version: 1, quiz });
  }
  else if (action === 'import-file') document.querySelector('#import-file')?.click();
  else if (action === 'export-results') downloadJson('foco-resultados.json', { format: 'foco-results', version: 1, exportedAt: new Date().toISOString(), attempts: state.attempts });
  else if (action === 'open-attempt') { state.selectedAttemptId = id; render(); window.scrollTo({ top: 0 }); }
  else if (action === 'download-attempt') { if (state.attempt) downloadReceipt(state.attempt); }
  else if (action === 'download-attempt-by-id') { const attempt = state.attempts.find(item => item.id === id); if (attempt) exportAttempt(attempt); }
  else if (action === 'select-answer') {
    if (!state.attempt || state.attempt.submittedAt) return;
    const question = state.activeQuiz.questions[state.examIndex];
    state.attempt.responses[question.id] = actionButton.dataset.answer;
    upsertAttempt();
    document.querySelectorAll('.answer-choice').forEach(button => {
      const selected = button.dataset.answer === actionButton.dataset.answer;
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    });
    updateExamIndicators();
  }
  else if (action === 'exam-previous') navigateQuestion(state.examIndex - 1);
  else if (action === 'exam-next') navigateQuestion(state.examIndex + 1);
  else if (action === 'exam-submit' && state.view === 'exam') { state.view = 'review'; render(); window.scrollTo({top:0}); document.querySelector('#review-heading')?.focus(); }
  else if (action === 'review-edit' && state.view === 'review') { state.examIndex = Number(actionButton.dataset.index); state.view = 'exam'; render(); window.scrollTo({top:0}); }
  else if (action === 'review-back' && state.view === 'review') { state.view = 'exam'; render(); window.scrollTo({top:0}); }
  else if (action === 'review-send' && state.view === 'review') await finishAttempt(Date.now() >= state.attempt.deadline ? 'time' : 'manual');
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  if (button && ['save-editor','save-share','duplicate-test','delete-test','delete-attempt','migrate-local','retry-submit','review-send','share-test'].includes(button.dataset.action)) {
    button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true');
  }
  handleClick(event).catch(error => {
    if (state.user && !cloud.user) { state.user = null; state.tests = []; state.attempts = []; state.editor = null; render(); }
    toast(error.message, 'error');
  }).finally(() => { if (button) { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); } });
});
document.addEventListener('input', event => {
  if (event.target.id === 'list-search') filterList(event.target.value);
  if (state.view === 'editor' && (event.target.matches('[data-editor-field]') || event.target.matches('[data-qprompt]') || event.target.matches('[data-option]'))) updateEditorValue(event.target);
  if (state.view === 'exam' && event.target.id === 'free-response' && state.attempt) {
    const question = state.activeQuiz.questions[state.examIndex];
    state.attempt.responses[question.id] = event.target.value;
    upsertAttempt();
    updateExamIndicators();
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'import-file' && event.target.files?.length) importFiles([...event.target.files]).catch(error => toast(error.message, 'error'));
  if (event.target.matches('[data-action="set-correct"]') && state.view === 'editor') {
    const question = state.editor.questions.find(item => item.id === event.target.dataset.qid);
    if (question) question.correct = event.target.dataset.letter;
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'participant-form') { event.preventDefault(); startAttempt(event.target); }
  if (event.target.id === 'login-form') {
    event.preventDefault();
    const form = event.target; const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true');
    try {
      const fields = new FormData(form);
      state.user = await cloud.signIn(String(fields.get('email')).trim(), String(fields.get('password')));
      state.authVersion++; state.tests = []; state.attempts = []; state.view = 'dashboard';
      form.reset(); await loadAccount();
    } catch (error) {
      const errorNode = form.querySelector('#login-error');
      if (errorNode) errorNode.textContent = error.status === 400 ? 'E-mail ou senha inválidos. Confira se a conta foi criada e confirmada no Supabase.' : error.message;
    } finally { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) recordFocusEvent('tab_hidden'); });
window.addEventListener('blur', () => recordFocusEvent('window_blur'));
document.addEventListener('pointerdown', event => {
  if (state.view === 'exam' && !state.previewMode && !event.target.closest('.exam-card, [data-action="toggle-theme"]')) recordFocusEvent('outside_click');
});

async function boot() {
  state.authVersion++; state.user = null; state.tests = []; state.attempts = []; state.editor = null;
  const version = state.authVersion;
  state.loading = true; state.accountError = ''; state.bootError = ''; state.view = 'dashboard'; render();
  const params = new URLSearchParams(window.location.search);
  const token = params.get('test'); const encoded = params.get('take');
  try {
    if (token || encoded) {
      state.previewMode = false;
      if (token) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) throw new Error('Link inválido. Peça um novo link ao avaliador.');
        state.shareToken = token;
        const pending = readStore(KEYS.pending, []).filter(item => item.token === token).at(-1);
        if (restoreAttempt(pending)) {
          // The saved snapshot keeps the original questions and deadline.
        } else {
          const shared = await cloud.rpc('foco_public_test', { p_token: token });
          if (version !== state.authVersion) return;
          if (!shared || !validateQuiz(shared.quiz)) throw new Error('Avaliação indisponível. Peça um novo link ao avaliador.');
          state.activeQuiz = shared.quiz; state.revision = shared.revision; state.attempt = null; state.view = 'participant-intro';
        }
      } else {
        const shared = decodeBase64Url(encoded);
        if (!validateQuiz(shared)) throw new Error('Link antigo inválido. Peça um novo link ao avaliador.');
        state.activeQuiz = shared; state.shareToken = null; state.revision = null; state.attempt = null; state.view = 'participant-intro';
        const local = readStore(KEYS.attempts, []).filter(item => item.quizId === shared.id && !item.submittedAt).at(0);
        restoreAttempt(local ? { attempt: local, examIndex: local.examIndex, view: local.view } : null);
      }
    } else {
      const user = await cloud.restore();
      if (version !== state.authVersion) return;
      state.user = user;
      if (state.user) { await loadAccount(); return; }
    }
  } catch (error) {
    if (version !== state.authVersion) return;
    if (token || encoded) { state.bootError = error.message; state.view = 'link-error'; }
    else state.accountError = error.message;
  }
  state.loading = false;
  if (state.attempt && ['exam', 'review'].includes(state.view) && Date.now() >= state.attempt.deadline) { await finishAttempt('time'); return; }
  render();
}
window.addEventListener('storage', event => {
  if (event.key === 'foco.auth.v1' && !['exam','review','thanks','participant-intro'].includes(state.view)) void boot();
});
window.addEventListener('online', updateSavedStatus);
window.addEventListener('offline', updateSavedStatus);
void boot();
