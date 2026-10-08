import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const data = new Map();
const root = { innerHTML: '' };
const calls = [];
let fail = false;
let examTick;
const cloud = {
  user: { id: 'owner' }, restore: async () => null,
  request: async (path, options = {}) => {
    calls.push({ path, ...options });
    if (fail) throw new Error('offline');
    if (options.method === 'POST' && path.includes('foco_tests')) return [{ ...options.body, share_token: 'token' }];
    if (options.method === 'DELETE') return [{ id: 'attempt' }];
    return [];
  },
  rpc: async (name, body) => { calls.push({ name, body }); if (fail) throw new Error('offline'); return true; },
};
const element = () => ({ className: '', textContent: '', setAttribute() {}, remove() {}, focus() {} });
const context = vm.createContext({
  createCloud: () => cloud, SUPABASE_URL: 'https://example.supabase.co', SUPABASE_KEY: 'public',
  document: { documentElement: { dataset: { theme: 'light' } }, querySelector: selector => selector === '#app' ? root : null, querySelectorAll: () => [], addEventListener() {}, createElement: element, body: { append() {} } },
  localStorage: { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) },
  window: { location: { href: 'http://localhost/', search: '' }, scrollTo() {}, confirm: () => true, addEventListener() {} },
  navigator: { clipboard: { writeText: async () => {} } }, crypto: webcrypto,
  URL, URLSearchParams, TextEncoder, TextDecoder, Date, Intl, console,
  setTimeout: () => 1, clearTimeout() {}, setInterval: callback => { examTick = callback; return 1; }, clearInterval() {},
});
const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/void boot\(\);\s*$/, '');
vm.runInContext(source, context);
const run = code => vm.runInContext(code, context);
assert.equal(run("elapsedSeconds({startedAt:'2026-10-07T18:06:52Z',submittedAt:'2026-10-07T19:09:12Z',quizSnapshot:{durationMinutes:45}})"), 2700, 'late finalization must not inflate exam duration');
assert.equal(run("elapsedSeconds({startedAt:'2026-10-07T18:06:52Z',submittedAt:'2026-10-07T18:16:52Z',quizSnapshot:{durationMinutes:45}})"), 600, 'early submissions keep their actual duration');
run('render()');
assert.match(root.innerHTML, /login-form/, 'evaluator must sign in');
assert.match(root.innerHTML, /toggle-theme/);
run('state.loading = true; render()');
assert.match(root.innerHTML, /loader-orbit/);
assert.match(root.innerHTML, /aria-busy="true"/);
run('state.loading = false');
run("state.user = { id: 'owner' }; state.tests = []; state.attempts = []; openEditor(); state.editor.title = 'Teste';");
await run('saveEditor()');
assert.equal(run('state.tests.length'), 1);
assert.ok(calls.some(call => call.path?.includes('foco_tests') && call.method === 'POST'));
fail = true;
run("state.editor.title = 'Alterado'");
await assert.rejects(run('saveEditor()'), /offline/);
assert.equal(run('state.tests[0].title'), 'Teste', 'failed save must preserve stored quiz');
run("state.activeQuiz = state.tests[0]; state.previewMode = false; state.shareToken = 'token'; state.revision = 'rev'; state.attempt = { id: 'attempt', quizId: state.activeQuiz.id, participant: 'Pessoa', startedAt: new Date().toISOString(), submittedAt: null, submissionReason: null, responses: {}, events: [], quizSnapshot: publicQuiz(state.activeQuiz) }; state.view = 'exam';");
await run("finishAttempt('manual')");
assert.equal(run('state.delivery'), 'failed');
assert.doesNotMatch(root.innerHTML, /Suas respostas foram entregues/);
assert.ok(data.get('foco.pending.v1'), 'failed delivery needs durable local copy');
fail = false;
await run('sendAttempt()');
assert.equal(run('state.delivery'), 'sent');
assert.equal(data.has('foco.pending.v1'), false);
const submissions = calls.filter(call => call.name === 'foco_submit');
assert.equal(submissions.length, 2);
assert.equal(submissions[0].body.p_attempt.id, submissions[1].body.p_attempt.id, 'retry must reuse ID');
run("state.attempts = [{ id: 'attempt', participant: 'Pessoa' }];");
fail = true;
await assert.rejects(run("deleteAttempt('attempt')"), /offline/);
assert.equal(run('state.attempts.length'), 1, 'failed delete must not hide result');
fail = false;
await run("deleteAttempt('attempt')");
assert.equal(run('state.attempts.length'), 0);
const beforePreview = calls.filter(call => call.name === 'foco_submit').length;
run("state.previewMode = true; state.attempt.submittedAt = null;");
await run("finishAttempt('manual')");
assert.equal(calls.filter(call => call.name === 'foco_submit').length, beforePreview, 'preview must not submit');
run("state.tests = [{id: 'quiz', questions: [{id: 'q', correct: 'B'}]}]");
assert.equal(run("questionForAttempt({quizId:'quiz',snapshotLocked:true},{id:'q',correct:'A'}).correct"), 'A');
const previousRequest = cloud.request;
let finishSave;
cloud.request = () => new Promise(resolve => { finishSave = resolve; });
run("state.previewMode = false; state.view = 'dashboard'; state.tests = []; openEditor(); state.editor.title = 'Conta anterior';");
const staleSave = run('saveEditor()');
run("state.authVersion++; state.user = {id:'another-owner'}; state.tests = [];");
finishSave([{ quiz: { id: 'old', title: 'Conta anterior' }, share_token: 'old-token' }]);
await assert.rejects(staleSave, /conta mudou/);
assert.equal(run('state.tests.length'), 0, 'late saves must not put another account data in the list');
cloud.request = previousRequest;
run("state.user = {id:'owner'}; state.previewMode = false; state.view = 'thanks'; state.delivery = 'failed'; state.localSaved = false;");
run('render()');
assert.match(root.innerHTML, /Não foi possível salvar uma cópia/);
run("state.user = null; state.previewMode = true; state.activeQuiz = EXAMPLE; state.attempt = {id:'review', participant:'Pessoa', deadline:Date.now()+60000, responses:{'ex-q1':'A', 'ex-q3':'<texto>\\nSegunda linha'}, events:[], submittedAt:null}; state.view = 'exam';");
await run("handleClick({target:{closest: selector => selector === '[data-action]' ? {dataset:{action:'exam-submit'}} : null}})");
assert.equal(run('state.view'), 'review');
assert.equal(run('state.attempt.submittedAt'), null, 'review must not submit');
assert.match(root.innerHTML, /Usar frases diretas/);
assert.match(root.innerHTML, /&lt;texto&gt;/);
assert.match(root.innerHTML, /Sem resposta/);
assert.doesNotMatch(root.innerHTML, /login-form/);
await run("handleClick({target:{closest: selector => selector === '[data-action]' ? {dataset:{action:'review-edit', index:'2'}} : null}})");
assert.equal(run('state.examIndex'), 2);
assert.equal(run('state.view'), 'exam');
assert.equal(run("state.attempt.responses['ex-q3']"), '<texto>\nSegunda linha');
run("state.view = 'review'; render(); recordFocusEvent('window_blur')");
assert.equal(run('state.attempt.events.length'), 0, 'preview does not track focus');
await run("handleClick({target:{closest: selector => selector === '[data-action]' ? {dataset:{action:'review-send'}} : null}})");
assert.equal(run('state.view'), 'thanks');
assert.ok(run('state.attempt.submittedAt'));
run("state.previewMode = false; state.shareToken = null; state.attempt.submittedAt = null; state.attempt.deadline = Date.now() - 1; state.view = 'review'; render(); recordFocusEvent('window_blur')");
assert.equal(run('state.attempt.events.length'), 1, 'review must keep tracking focus');
examTick();
assert.equal(run('state.view'), 'thanks');
assert.equal(run('state.attempt.submissionReason'), 'time', 'review must submit when time expires');
assert.equal(run('new Date(state.attempt.submittedAt).getTime()'), run('state.attempt.deadline'), 'automatic finalization must record the deadline even after browser suspension');
console.log('Foco: persistência, envio e revisão de respostas OK');

const receipt = run("receiptHtml({id:'receipt', participant:'<Pessoa>', quizTitle:'Teste', submittedAt:new Date().toISOString(), responses:{q:'B',free:'<script>alert(1)</script>'}, quizSnapshot:{questions:[{id:'q',text:'Escolha',type:'multiple',options:[{letter:'B',text:'Alternativa selecionada'}],correct:'A'},{id:'free',text:'Explique',type:'free'},{id:'empty',text:'Sem preenchimento',type:'free'}]}})");
assert.match(receipt, /Alternativa selecionada/);
assert.match(receipt, /&lt;Pessoa&gt;/);
assert.match(receipt, /&lt;script&gt;/);
assert.match(receipt, /Sem resposta/);
assert.doesNotMatch(receipt, /correct|window.alert|Entrega confirmada/);
assert.match(receipt, /Imprimir ou salvar como PDF/);
console.log('Comprovante legível e conteúdo escapado OK');

const resumeToken = '12345678-1234-1234-1234-123456789abc';
run("state.previewMode=false; state.shareToken='12345678-1234-1234-1234-123456789abc'; state.revision='original'; state.activeQuiz=EXAMPLE; state.attempt={id:'resume',quizId:EXAMPLE.id,participant:'Pessoa',startedAt:new Date().toISOString(),deadline:Date.now()+60000,submittedAt:null,responses:{'ex-q3':'Resposta preservada'},events:[],quizSnapshot:publicQuiz(EXAMPLE)}; state.examIndex=2; state.view='review'; upsertAttempt();");
const originalDeadline = run('state.attempt.deadline');
context.window.location.search = '?test=' + resumeToken;
const originalRpc = cloud.rpc;
cloud.rpc = async (name, body) => name === 'foco_public_test' ? JSON.parse(run('JSON.stringify({quiz:publicQuiz(EXAMPLE),revision:"original",attempt:state.attempt})')) : originalRpc(name, body);
await run('boot()');
assert.equal(run('state.view'), 'review');
assert.equal(run('state.examIndex'), 2);
assert.equal(run('state.attempt.deadline'), originalDeadline);
assert.equal(run("state.attempt.responses['ex-q3']"), 'Resposta preservada');
assert.doesNotMatch(root.innerHTML, /Respostas salvas neste navegador|sinais? de foco registrado|Sinal registrado/);
const originalSetItem = context.localStorage.setItem;
context.localStorage.setItem = () => { throw new Error('storage full'); };
run('render()');
assert.match(root.innerHTML, /Não foi possível salvar/);
console.log('Retomada preserva respostas, posição e prazo; status de salvamento OK');

context.localStorage.setItem = originalSetItem;
context.navigator.onLine = false;
run('render()');
assert.match(root.innerHTML, /Sem conexão/);
context.navigator.onLine = true;
run('state.attempt.deadline=Date.now()-1; upsertAttempt()');
await run('boot()');
assert.equal(run('state.view'), 'thanks');
assert.equal(run('state.attempt.submissionReason'), 'time');
assert.equal(run('state.attempt.id'), 'resume');
console.log('Falha de armazenamento, modo offline e retomada com prazo vencido OK');

context.atob = value => Buffer.from(value, 'base64').toString('binary');
run("state.shareToken=null; state.previewMode=false; state.activeQuiz=EXAMPLE; state.attempt={id:'legacy-resume',quizId:EXAMPLE.id,participant:'Pessoa',startedAt:new Date().toISOString(),deadline:Date.now()+60000,submittedAt:null,responses:{'ex-q1':'A'},events:[],quizSnapshot:publicQuiz(EXAMPLE)}; state.examIndex=1; state.view='exam'; upsertAttempt();");
const legacyDeadline = run('state.attempt.deadline');
context.window.location.search = '?take=' + Buffer.from(run('JSON.stringify(publicQuiz(EXAMPLE))')).toString('base64url');
await run('boot()');
assert.equal(run('state.view'), 'exam');
assert.equal(run('state.examIndex'), 1);
assert.equal(run('state.attempt.deadline'), legacyDeadline);
assert.equal(run("state.attempt.responses['ex-q1']"), 'A');
console.log('Retomada de links antigos OK');

run("state.previewMode=true; state.activeQuiz=EXAMPLE; state.attempt.responses={'ex-q1':'A','ex-q3':'   '}; state.examIndex=1; state.view='exam'; render();");
assert.match(root.innerHTML, /data-jump="0"[^>]*>1</);
assert.match(root.innerHTML, /id="answered-count" class="navigation-summary"/);
const navButtons = [0,1,2].map(index => ({dataset:{jump:String(index)}, classes:{}, attrs:{}, classList:{toggle(name,value){this.owner.classes[name]=value;}}, setAttribute(name,value){this.attrs[name]=value;}}));
navButtons.forEach(button => {button.classList.owner=button;});
const oldQueryAll=context.document.querySelectorAll;
context.document.querySelectorAll=selector => selector === '[data-jump]' ? navButtons : [];
run('updateExamIndicators()');
assert.equal(navButtons[0].classes.answered,true);
assert.equal(navButtons[1].classes.current,true);
assert.equal(navButtons[1].attrs['aria-current'],'step');
assert.match(navButtons[2].attrs['aria-label'],/Em branco/);
await run("handleClick({target:{closest: selector => selector === '[data-jump]' ? {dataset:{jump:'2'}} : null}})");
assert.equal(run('state.examIndex'),2);
context.document.querySelectorAll=oldQueryAll;
console.log('Navegação numerada, estados acessíveis e salto direto OK');

const originalToast = run('toast');
let focusToast = false;
context.testToast = () => { focusToast = true; };
run("toast=testToast; state.previewMode=false; state.view='exam'; state.attempt.submittedAt=null; state.attempt.events=[]; recordFocusEvent('outside_click'); render();");
assert.equal(run('state.attempt.events.length'),1);
assert.equal(focusToast,false);
assert.doesNotMatch(root.innerHTML,/Sinal registrado|sinal de foco registrado|sinais de foco registrados|Suas respostas são salvas durante/);
context.restoreToast=originalToast;run('toast=restoreToast');
console.log('Eventos registrados sem avisos ao participante; alertas de salvamento preservados OK');

let preventedHomeClick = false;
context.preventHomeClick = () => { preventedHomeClick = true; };
context.window.history = { replaceState(_state, _title, value) {
  const url = new URL(value);
  context.window.location.href = url.href;
  context.window.location.search = url.search;
} };
for (const query of ['test=12345678-1234-1234-1234-123456789abc', 'take=legacy']) {
  context.window.location.href = 'http://localhost/?' + query + '#';
  context.window.location.search = '?' + query;
  run("state.user=null; state.view='participant-intro'; state.loading=false;");
  preventedHomeClick = false;
  await run("handleClick({preventDefault:preventHomeClick,target:{closest:selector => selector === '[data-action]' ? {dataset:{action:'go-dashboard'}} : null}})");
  assert.equal(context.window.location.href, 'http://localhost/', 'home must clear the public exam URL');
  assert.equal(preventedHomeClick, true, 'logo must prevent the default hash navigation');
  assert.match(root.innerHTML, /login-form/);
  await run('boot()');
  assert.equal(run('state.view'), 'dashboard', 'reload must stay at evaluator home');
}
console.log('Logo limpa links de prova atuais e antigos; recarregar mantém o início OK');

assert.equal(run("searchText('AVALIAÇÃO')"), 'avaliacao');
const searchRows=[{dataset:{search:'Avaliação de suporte'}},{dataset:{search:'Lucas Escouto'}}];
const searchStatus={textContent:''};
const priorQuery=context.document.querySelector, priorQueryAll=context.document.querySelectorAll;
context.document.querySelector=selector => selector === '#search-count' ? searchStatus : priorQuery(selector);
context.document.querySelectorAll=selector => selector === '[data-search]' ? searchRows : priorQueryAll(selector);
run("filterList('avaliacao')");
assert.equal(searchRows[0].hidden,false);assert.equal(searchRows[1].hidden,true);
run("filterList('inexistente')");assert.match(searchStatus.textContent,/Nenhum resultado/);
run("filterList('')");assert.ok(searchRows.every(row=>!row.hidden));
context.document.querySelector=priorQuery;context.document.querySelectorAll=priorQueryAll;
const copyButton={innerHTML:'Copiar link',textContent:'',classList:{add(){},remove(){}}};
context.copyButton=copyButton;
await run("shareQuiz({...EXAMPLE,shareToken:'12345678-1234-1234-1234-123456789abc'},copyButton)");
assert.equal(copyButton.textContent,'Link copiado ✓');
run("state.tests=[EXAMPLE];state.user={id:'owner'};state.view='dashboard';render()");
assert.match(root.innerHTML,/Buscar avaliações/);assert.match(root.innerHTML,/test-card-icon/);
console.log('Busca sem acentos, filtros, cards e confirmação de cópia OK');

run("state.previewMode=true; state.view='exam'; state.activeQuiz=EXAMPLE; state.examIndex=0; state.questionAnimating=false; navigateQuestion(1)");
assert.equal(run('state.examIndex'),1);
run('navigateQuestion(0)');assert.equal(run('state.examIndex'),0);
run('state.questionAnimating=true; navigateQuestion(2)');assert.equal(run('state.examIndex'),0);
run('state.questionAnimating=false; navigateQuestion(99)');assert.equal(run('state.examIndex'),2);
console.log('Navegação de cards: avanço, retorno, limites e bloqueio de cliques rápidos OK');

const scrolls=[];
context.window.scrollTo=options=>scrolls.push(options);
run("state.view='exam'; state.examIndex=0; navigateQuestion(1); navigateQuestion(0); navigateQuestion(2)");
assert.equal(scrolls.length,3);
assert.ok(scrolls.every(options=>options.top===0 && options.behavior==='instant'));
console.log('Avançar, voltar e saltar pergunta retornam ao início da página OK');

const disclosure={inert:true,classList:{toggle(name,value){disclosure.open=value;}}};
const disclosureButton={dataset:{action:'test-menu'},attrs:{'aria-controls':'extra-demo','aria-expanded':'false'},getAttribute(name){return this.attrs[name];},setAttribute(name,value){this.attrs[name]=value;}};
context.document.getElementById=id=>id==='extra-demo'?disclosure:null;
context.disclosureButton=disclosureButton;
const disclosureEvent="({target:{closest:selector=>selector==='[data-action]'?disclosureButton:null}})";
await run('handleClick('+disclosureEvent+')');
assert.equal(disclosure.open,true);assert.equal(disclosure.inert,false);assert.equal(disclosureButton.attrs['aria-expanded'],'true');
await run('handleClick('+disclosureEvent+')');
assert.equal(disclosure.open,false);assert.equal(disclosure.inert,true);assert.equal(disclosureButton.attrs['aria-expanded'],'false');
console.log('Painel expansível: abertura, fechamento e acessibilidade OK');

// The server owns identity and time even after local data is cleared.
context.FormData = class { get() { return 'Pessoa'; } };
const serverAttempt = JSON.parse(run('JSON.stringify({id:"individual",quizId:EXAMPLE.id,participant:"Pessoa",startedAt:new Date().toISOString(),deadline:Date.now()+60000,submittedAt:null,responses:{},events:[],quizSnapshot:publicQuiz(EXAMPLE)})'));
cloud.rpc = async (name, body) => {
  calls.push({name,body});
  if (name === 'foco_start' || name === 'foco_public_test') return {quiz:serverAttempt.quizSnapshot,revision:'server-revision',attempt:serverAttempt};
  return true;
};
run('state.shareToken="12345678-1234-1234-1234-123456789abc"; state.previewMode=false; state.attempt=null; state.activeQuiz={id:"intro",title:"Teste",durationMinutes:1,questionCount:3,multipleCount:2,freeCount:1}; renderIntro()');
assert.match(root.innerHTML,/3 PERGUNTAS/);
const form = {querySelector: () => ({disabled:false})};
context.participantForm = form;
await run('startAttempt(participantForm)');
assert.equal(run('state.attempt.id'),'individual');
assert.equal(run('state.revision'),'server-revision');
data.delete('foco.pending.v1');
context.window.location.search='?test=12345678-1234-1234-1234-123456789abc';
await run('boot()');
assert.equal(run('state.attempt.deadline'),serverAttempt.deadline);
assert.equal(run('state.attempt.id'),'individual');
cloud.rpc = async () => {throw new Error('Esta avaliação já foi finalizada.');};
await run('boot()');
assert.equal(run('state.view'),'link-error');
assert.match(root.innerHTML,/já foi finalizada/);
console.log('Link individual: início no servidor, retomada sem dados locais e bloqueio após entrega OK');
