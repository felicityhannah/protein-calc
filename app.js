import { CONFIG } from './config.js';
import { FOODS, calculateTarget, convertWeightDisplay, buildMealExample, localDate, validateFoodEntry, readLegacyProfiles, makeDemoData, summarizeHistory } from './core.js';
import { createCloudStore } from './cloud.js';
import { LANGUAGES, translate } from './i18n.js';
import { getGuideOffer, buildGuideEmail } from './guide.js';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const DEMO_KEY = 'proneed_demo_v2';
const state = { lang: readPreference('proneed_language', 'en'), page: 'calculator', tab: 'today', diet: 'mixed', result: null, calculated: false, user: null, data: makeDemoData(), authMode: 'signin', demo: true, syncing: false, cloudLoaded: false, pendingGoal: null };
let cloud, cloudError, toastTimer, generation = 0, refreshSequence = 0, syncTimer, demoWritable = true;
let busy = false, analyticsReady = false, lastLocalDay = localDate();
let logRenderKey = '', pendingFood = null;
const pendingMeals = new Map();
let selectedGuideEdition = null;
const guideContactEmail = CONFIG.guideSupportEmail || 'felicityahawhale@gmail.com';
const foodKeys = { chicken:'foodChicken', tuna:'foodTuna', eggs:'foodEggs', yogurt:'foodYogurt', cottage:'foodCottage', tofu:'foodTofu', lentils:'foodLentils', chickpeas:'foodChickpeas', edamame:'foodEdamame', oats:'foodOats', milk:'foodMilk', peanut:'foodPeanut' };
const foodById = new Map(FOODS.map(food => [food.id, food]));
const t = (key, vars) => translate(state.lang, key, vars);
const locale = () => LANGUAGES.find(language => language.id === state.lang)?.htmlLang || 'en';
const number = value => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(value);
const node = (tag, className, text) => { const result = document.createElement(tag); if (className) result.className = className; if (text != null) result.textContent = text; return result; };

function readPreference(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePreference(key, value) { try { localStorage.setItem(key, value); } catch { /* Optional preferences do not block the calculator. */ } }
function message(id, text = '', error = true) { const target = $(id); target.textContent = text; target.hidden = !text; if (error) target.setAttribute('role', 'alert'); }
function toast(text, error = false) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500); }
function showDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog) { dialog.close(); }
function foodName(food) {
  const translated = t(foodKeys[food.id]);
  const states = { cooked:'foodCooked', drained:'foodDrained', dry:'foodDry', 'as sold':'foodAsSold' };
  const preparation = t(states[food.state] || 'foodAsSold');
  return `${translated} (${preparation}${food.id === 'edamame' ? `, ${t('foodShelled')}` : ''})`;
}

function loadDemo() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (!raw) return makeDemoData();
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.entries) || !Number.isFinite(value.goal) || value.goal < 40 || value.goal > 500) throw new Error('Invalid demo data');
    const entries = value.entries.map(entry => ({ ...validateFoodEntry(entry), id:String(entry.id), ts:Number(entry.ts) || Date.now() }));
    return { goal:value.goal, entries, isDemo:true };
  } catch { demoWritable = false; return makeDemoData(); }
}
let demoData = loadDemo();
state.data = structuredClone(demoData);

function saveDemo(next) {
  if (!demoWritable) throw new Error(t('storageError'));
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(next)); }
  catch { throw new Error(t('storageError')); }
  demoData = structuredClone(next);
  state.data = next;
}

function renderLanguages() {
  $('language-buttons').replaceChildren(...LANGUAGES.map(language => {
    const button = node('button', state.lang === language.id ? 'active' : '', language.label);
    button.type = 'button'; button.lang = language.htmlLang; button.dataset.language = language.id; button.setAttribute('aria-pressed', String(state.lang === language.id));
    button.addEventListener('click', () => { state.lang = language.id; writePreference('proneed_language', state.lang); applyLanguage(); $('language-buttons').querySelector(`[data-language="${language.id}"]`).focus({preventScroll:true}); });
    return button;
  }));
}

function applyLanguage() {
  if (!LANGUAGES.some(language => language.id === state.lang)) state.lang = 'en';
  document.documentElement.lang = LANGUAGES.find(language => language.id === state.lang).htmlLang;
  all('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.querySelector('.skip-link').textContent = t('skipToCalculator');
  all('[data-close-dialog]').forEach(button => button.setAttribute('aria-label', t('close')));
  renderLanguages(); renderResult(); renderMeals(); renderPresets(); renderTracker(); renderAccount(); renderLegacy(); renderGuideOffer();
  if ($('info-dialog').open) showInfo($('info-dialog').dataset.content);
}

function calculate(userAction = false) {
  try {
    const form = new FormData($('calculator-form'));
    const result = calculateTarget({ weight:form.get('weight'), unit:form.get('unit'), age:form.get('age'), goal:form.get('goal'), meals:form.get('meals') });
    state.result = result;
    state.calculated ||= userAction;
    message('calc-error'); $('weight').removeAttribute('aria-invalid'); $('age').removeAttribute('aria-invalid');
    renderResult(); renderMeals();
    if (userAction) track('calculation_complete');
  } catch (error) {
    const weight = Number($('weight').value) * ($('unit').value === 'kg' ? 1 : .45359237);
    const age = Number($('age').value);
    const weightInvalid = !$('weight').value.trim() || !Number.isFinite(weight) || weight < 20 || weight > 300;
    const ageInvalid = !$('age').value.trim() || !Number.isInteger(age) || age < 18 || age > 100;
    message('calc-error', t(weightInvalid ? 'invalidWeight' : ageInvalid ? 'invalidAge' : 'invalidInput'));
    $('weight').setAttribute('aria-invalid', String(weightInvalid)); $('age').setAttribute('aria-invalid', String(ageInvalid));
    if (userAction) (weightInvalid ? $('weight') : $('age')).focus();
  }
}

function renderResult() {
  if (!state.result) return;
  const result = state.result;
  $('result-target').textContent = number(result.target);
  $('result-range').textContent = `${number(result.min)}–${number(result.max)} g`;
  $('result-meal').textContent = `${number(result.perMeal)} g`;
  $('result-calories').textContent = `${number(result.proteinCalories)} kcal`;
  $('result-kind').textContent = t(state.calculated ? 'personalizedResult' : 'exampleCalculation');
  $('method-numbers').textContent = `${number(result.weightKg)} kg × ${number(result.perKg)} g/kg = ${number(result.target)} g. ${t('methodSelection')}`;
}

let mealExample;
function renderMeals() {
  if (!state.result) return;
  mealExample = buildMealExample(state.result.target, { diet:state.diet, meals:state.result.meals });
  $('meal-cards').style.gridTemplateColumns = '';
  $('meal-cards').classList.toggle('three-meals', mealExample.meals.length === 3);
  const emoji = { breakfast:'🥣', lunch:'🍗', dinner:'🫛', snack:'🧀' };
  $('meal-cards').replaceChildren(...mealExample.meals.map(meal => {
    const card = node('article', 'meal-card');
    const top = node('div', 'meal-card-top');
    top.append(node('span', 'meal-emoji', state.diet === 'vegetarian' && meal.id === 'lunch' ? '🧊' : emoji[meal.id]), node('span', 'meal-protein', `${number(meal.protein)} g`));
    const list = node('ul', 'meal-items');
    meal.items.forEach(item => { const food = foodById.get(item.foodId); const row = node('li'); row.append(node('span', '', foodName(food)), node('span', '', `${number(item.amount)} ${food.unit}`)); list.append(row); });
    const add = node('button', 'meal-add', `＋ ${t('logMeal')}`); add.type = 'button'; add.addEventListener('click', () => logMeal(meal));
    card.append(top, node('h3', '', t(meal.id)), list, add); return card;
  }));
  $('meal-total').textContent = `${number(mealExample.totalProtein)} g`;
  all('[data-diet]').forEach(button => { const active = button.dataset.diet === state.diet; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  const footnote = $('meal-cards').nextElementSibling.querySelector('p');
  footnote.textContent = `${t('portionNote')} ${t('mealCompleteness')}`;
}

function showPage(page, scroll = true) {
  state.page = page;
  $('calculator-page').hidden = page !== 'calculator'; $('tracker-page').hidden = page !== 'tracker';
  all('[data-page]').forEach(button => { const active = button.dataset.page === page; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  if (page === 'tracker') { renderTracker(); track('tracker_open'); if (state.user) refreshCloud(); }
  if (scroll) window.scrollTo({ top:0, behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

function renderPresets() {
  $('food-presets').replaceChildren(...FOODS.filter(food => food.unit === 'g').slice(0, 8).map(food => {
    const button = node('button', 'preset-button', `${food.emoji} ${t(foodKeys[food.id])}`); button.type = 'button';
    button.addEventListener('click', () => { $('food-name').value = foodName(food); $('food-amount').value = food.serving; $('food-protein').value = food.p100; previewFood(); $('food-amount').focus(); }); return button;
  }));
}

function previewFood() {
  const amount = Number($('food-amount').value), density = Number($('food-protein').value);
  const valid = $('food-amount').value !== '' && $('food-protein').value !== '' && Number.isFinite(amount) && Number.isFinite(density) && amount >= .1 && amount <= 2000 && density >= 0 && density <= 100;
  $('food-preview').textContent = valid ? `${number(Math.round(amount * density / 10) / 10)} g` : '— g';
}

function renderTracker() {
  $('tracker-mode').textContent = t(state.user ? 'cloudBadge' : 'demoBadge');
  $('tracker-notice-text').textContent = t(state.user ? cloudError ? 'cloudDisconnected' : 'syncedAccount' : 'demoNotice');
  $('tracker-signin').hidden = Boolean(state.user);
  $('sync-button').hidden = !state.user;
  $('sync-status').textContent = t(state.user ? state.syncing ? 'syncing' : 'synced' : 'localOnly');
  if (cloudError && state.user) $('sync-status').textContent = t('syncFailed');
  const date = new Date();
  $('today-label').textContent = new Intl.DateTimeFormat(locale(), { weekday:'short', month:'short', day:'numeric' }).format(date);
  const todayEntries = state.data.entries.filter(entry => entry.date === localDate(date));
  const consumed = Math.round(todayEntries.reduce((sum, entry) => sum + entry.protein, 0) * 10) / 10;
  const remaining = Math.max(0, state.data.goal - consumed), percentage = Math.round(consumed / state.data.goal * 100);
  $('tracker-consumed').textContent = number(consumed);
  $('tracker-remaining').textContent = remaining > 0 ? `${number(remaining)} g` : t('goalReached');
  $('tracker-progress-bar').style.width = `${Math.min(100, percentage)}%`;
  $('tracker-progress').setAttribute('aria-valuemax', state.data.goal); $('tracker-progress').setAttribute('aria-valuenow', Math.min(consumed, state.data.goal));
  $('tracker-percentage').textContent = `${percentage}%`;
  $('tracker-goal-caption').textContent = `${number(state.data.goal)} g`;
  const renderKey = JSON.stringify([state.user?.id || 'demo',state.lang,localDate(date),todayEntries]);
  if (renderKey !== logRenderKey) {
  const focusedEntry = document.activeElement?.dataset.entryId;
  $('food-entries').replaceChildren();
  if (!todayEntries.length) $('food-entries').append(node('p', 'empty-state', t('noEntries')));
  todayEntries.slice().sort((a,b) => (b.ts || 0) - (a.ts || 0)).forEach(entry => {
    const row = node('div', 'food-entry'), text = node('div', 'food-entry-text');
    text.append(node('strong', '', entry.food), node('small', '', `${number(entry.amount)} g · ${number(entry.p100)} g / 100 g`));
    const remove = node('button', 'icon-button', '×'); remove.type = 'button'; remove.dataset.entryId = entry.id; remove.setAttribute('aria-label', `${t('removeEntry')}: ${entry.food}`); remove.addEventListener('click', () => removeFood(entry.id));
    row.append(text, node('span', 'food-entry-protein', `${number(entry.protein)} g`), remove); $('food-entries').append(row);
  });
  logRenderKey = renderKey;
  if (focusedEntry) {
    const matching = [...$('food-entries').querySelectorAll('button')].find(button => button.dataset.entryId === focusedEntry);
    (matching || $('food-entries').querySelector('button') || $('food-name')).focus({preventScroll:true});
  }
  }
  if (document.activeElement !== $('settings-goal')) $('settings-goal').value = state.data.goal;
  const history = summarizeHistory(state.data.entries, state.data.goal, 7, date);
  $('history-average').textContent = `${number(history.average)} g`;
  $('history-met').textContent = `${history.daysMet} / 7`;
  $('history-average').nextElementSibling.textContent = t('averageSevenDays');
  const chartMax = Math.max(state.data.goal, ...history.days.map(day => day.protein));
  $('history-chart').replaceChildren(...history.days.map(day => {
    const element = node('div', 'history-day');
    const track = node('div', 'history-bar-track'), bar = node('div', `history-bar${day.goalMet ? ' met' : ''}`);
    bar.style.height = `${Math.max(day.protein ? 2 : 0, day.protein / chartMax * 100)}%`; track.append(bar);
    const label = new Intl.DateTimeFormat(locale(), { weekday:'short' }).format(new Date(`${day.date}T12:00:00`));
    element.append(node('strong', '', `${number(day.protein)}g`), track, node('span', '', label)); element.title = `${day.date}: ${number(day.protein)} g`; return element;
  }));
  all('[data-tracker-tab]').forEach(button => { const active = button.dataset.trackerTab === state.tab; button.classList.toggle('active',active); button.setAttribute('aria-pressed',String(active)); });
  ['today','history','settings'].forEach(tab => { $(`tracker-${tab}`).hidden = tab !== state.tab; });
}

function renderLegacy() {
  const legacy = readLegacyProfiles({ getItem:key => localStorage.getItem(key) });
  const selected = $('legacy-profile').value;
  $('legacy-profile').replaceChildren(...legacy.profiles.map((profile,index) => { const option = node('option','',profile.name); option.value = index; return option; }));
  if ([...$('legacy-profile').options].some(option => option.value === selected)) $('legacy-profile').value = selected;
  $('legacy-import-controls').hidden = !legacy.profiles.length || Boolean(legacy.error);
  $('legacy-info').textContent = legacy.error ? t('legacyReadError') : legacy.skippedEntries ? t('legacySkipped',{count:legacy.skippedEntries}) : legacy.warnings.length ? t('legacyProfileWarning') : legacy.profiles.length ? '' : t('noLegacyData');
}

async function mutate(operation, localChange, successMessage = '') {
  if (busy) return false;
  if (state.user && !state.cloudLoaded) { toast(t('cloudDisconnected'),true); return false; }
  busy = true;
  const currentGeneration = generation;
  all('#food-form button[type=submit],#goal-form button[type=submit],.meal-add,#save-target,#import-button,#confirm-clear-button').forEach(button => { button.disabled = true; });
  try {
    if (state.user) {
      await operation();
      if (generation !== currentGeneration) return false;
      // The write is committed. A later read failure must not invite a duplicate retry.
      const next = structuredClone(state.data); localChange(next); state.data = next; renderTracker();
      await refreshCloud();
      if (generation !== currentGeneration) return false;
      if (cloudError) { toast(t('savedRefreshFailed'),true); return true; }
    }
    else { const next = structuredClone(state.data); localChange(next); saveDemo(next); renderTracker(); }
    if (successMessage) toast(successMessage);
    return true;
  } catch (error) { toast(t(state.user ? 'saveFailed' : 'storageError'), true); return false; }
  finally { busy = false; all('#food-form button[type=submit],#goal-form button[type=submit],.meal-add,#save-target,#import-button,#confirm-clear-button').forEach(button => { button.disabled = false; }); }
}

async function addFood(event) {
  event.preventDefault();
  let entry;
  try {
    const valid = validateFoodEntry({ food:$('food-name').value, amount:$('food-amount').value, p100:$('food-protein').value });
    const signature = JSON.stringify([state.user?.id || 'demo', valid]);
    if (pendingFood?.signature !== signature) pendingFood = {signature, id:crypto.randomUUID(), ts:Date.now()};
    entry = { ...valid, id:pendingFood.id, ts:pendingFood.ts }; message('food-error');
  }
  catch { message('food-error',t('invalidFood')); return; }
  if (await mutate(() => cloud.addEntry(entry), next => { if(!next.entries.some(row=>row.id===entry.id))next.entries.push(entry); }, t('addedToLog'))) { pendingFood=null; $('food-form').reset(); previewFood(); track('food_logged'); }
}

async function logMeal(meal) {
  const signature=JSON.stringify([state.user?.id||'demo',localDate(),state.lang,meal]);
  if(!pendingMeals.has(signature)) {
    const now = Date.now();
    pendingMeals.set(signature,meal.items.map((item,index) => { const food = foodById.get(item.foodId); return { ...validateFoodEntry({ food:foodName(food), amount:item.amount, p100:food.p100 }), id:crypto.randomUUID(), ts:now + index }; }));
  }
  const entries=pendingMeals.get(signature);
  showPage('tracker'); state.tab = 'today'; renderTracker();
  if (await mutate(() => cloud.addEntries(entries), next => { next.entries.push(...entries.filter(entry=>!next.entries.some(row=>row.id===entry.id))); }, t('addedToLog'))) {pendingMeals.delete(signature);track('food_logged');}
}

async function removeFood(id) { await mutate(() => cloud.deleteEntry(id), next => { next.entries = next.entries.filter(entry => entry.id !== id); }, t('removedFromLog')); }

async function saveTarget() {
  const target = state.result?.target;
  if (!target || target < 40 || target > 500) { toast(t('targetBounds'),true); return; }
  if (!state.user) { state.pendingGoal = target; openAuth('signin'); return; }
  await mutate(() => cloud.saveGoal(target), next => { next.goal = target; }, t('savedGoal',{goal:target}));
}

async function refreshCloud(throwErrors = false) {
  if (!state.user) return;
  const currentGeneration = generation, request = ++refreshSequence;
  state.syncing = true; renderTracker();
  try {
    const data = await cloud.load();
    if (generation !== currentGeneration || request !== refreshSequence) return;
    state.data = data; state.cloudLoaded = true; cloudError = null; renderTracker();
  } catch (error) { if (generation === currentGeneration && request === refreshSequence) { cloudError = error; renderTracker(); } if (throwErrors) throw error; }
  finally { if (generation === currentGeneration && request === refreshSequence) { state.syncing = false; renderTracker(); } }
}

async function authChanged(user, event) {
  const changed = state.user?.id !== user?.id;
  if (changed) { generation++; state.user = user; state.demo = !user; state.cloudLoaded=false; state.syncing=false; cloudError=null; pendingFood=null;pendingMeals.clear();state.data = user ? {goal:120,entries:[]} : structuredClone(demoData); $('food-form').reset();previewFood();message('food-error'); }
  else state.user = user;
  renderAccount(); renderTracker();
  if (event === 'PASSWORD_RECOVERY') openAuth('update');
  if (user && (changed || ['SIGNED_IN','INITIAL_SESSION'].includes(event))) {
    const authGeneration=generation;
    await refreshCloud();
    if(generation!==authGeneration || state.user?.id!==user.id)return;
    if (event === 'SIGNED_IN') {
      if ($('account-dialog').open && state.authMode !== 'update') $('account-dialog').close();
      if (state.pendingGoal != null) { const target = state.pendingGoal; state.pendingGoal = null; await mutate(() => cloud.saveGoal(target), next => {next.goal=target;}, t('savedGoal',{goal:target})); }
    }
  }
}

function renderAccount() {
  const accountSpan = $('account-button').querySelector('[data-i18n]');
  accountSpan.textContent = t(state.user ? 'signOut' : 'signIn');
  const configured = Boolean(cloud?.configured);
  $('account-config-notice').hidden = configured;
  all('#auth-form input,#auth-form button').forEach(control => { control.disabled = !configured; });
  $('forgot-button').disabled = !configured;
  const mode = state.authMode;
  $('auth-tabs').hidden = ['reset','update'].includes(mode);
  $('auth-email-field').hidden = mode === 'update'; $('auth-password-field').hidden = mode === 'reset';
  $('forgot-button').hidden = mode !== 'signin';
  $('auth-email').required = mode !== 'update'; $('auth-password').required = mode !== 'reset';
  $('auth-password').minLength = mode === 'signin' ? 1 : 12;
  $('auth-password').maxLength = 128;
  $('auth-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('auth-password-label').textContent = t(mode === 'update' ? 'newPassword' : 'password');
  $('auth-password').nextElementSibling.hidden = mode === 'signin';
  $('auth-submit').textContent = t({signin:'signIn',signup:'createAccount',reset:'resetPassword',update:'updatePassword'}[mode]);
  all('[data-auth-mode]').forEach(button => button.classList.toggle('active',button.dataset.authMode === mode));
}

function openAuth(mode = 'signin') { state.authMode = mode; message('auth-error'); message('auth-success','',false); renderAccount(); showDialog('account-dialog'); }

async function submitAuth(event) {
  event.preventDefault();
  const email = $('auth-email').value.trim(), password = $('auth-password').value, mode = state.authMode;
  message('auth-error'); message('auth-success','',false);
  if (mode !== 'update' && (!email || !$('auth-email').validity.valid)) { message('auth-error',t('invalidEmail')); return; }
  if (mode !== 'reset' && (password.length < (mode === 'signin' ? 1 : 12) || password.length > 128)) { message('auth-error',t('invalidPassword')); return; }
  $('auth-submit').disabled = true;
  try {
    if (mode === 'signup') { const result = await cloud.signUp(email,password); if (result.needsEmailConfirmation) message('auth-success',t('confirmationSent'),false); else { $('account-dialog').close(); toast(t('signedIn')); } }
    else if (mode === 'signin') { await cloud.signIn(email,password); $('account-dialog').close(); toast(t('signedIn')); }
    else if (mode === 'reset') { await cloud.requestPasswordReset(email); message('auth-success',t('resetSent'),false); }
    else { await cloud.updatePassword(password); $('account-dialog').close(); toast(t('passwordUpdated')); }
    $('auth-password').value = '';
  } catch (error) { message('auth-error',t(error.code==='email_not_confirmed'?'confirmationSent':String(error.code||'').includes('rate_limit')?'emailRateLimit':'accountError')); }
  finally { $('auth-submit').disabled = !cloud?.configured; }
}

function renderGuideOffer() {
  if (getGuideOffer(CONFIG)) return;
  const section = $('guide');
  section.querySelector('[data-i18n="guideBadge"]').textContent = t('guideCheckoutPaused',{email:guideContactEmail});
  section.querySelector('[data-i18n="guideButton"]').textContent = t('contact');
}

function renderGuideCheckout(body) {
  const offer = getGuideOffer(CONFIG);
  $('info-title').textContent = t('guideTitle');
  body.append(node('p','guide-price',t('guidePrice')),node('p','',t('guideIncludes')));
  body.append(node('p','muted small',t('guideScope')));
  if (!offer) {
    body.append(node('p','notice',t('guideCheckoutPaused',{email:guideContactEmail})));
    return;
  }
  const field = node('div','field guide-edition-field'), label = node('label','',t('guideLanguage')), edition = node('select');
  label.htmlFor = 'guide-edition'; edition.id = 'guide-edition';
  for (const [value,text] of [['en','English'],['zh','繁體中文'],['both',t('guideBoth')]]) {
    const option = node('option','',text); option.value = value; edition.append(option);
  }
  edition.value = selectedGuideEdition || (state.lang === 'zh' ? 'zh' : 'en');
  field.append(label,edition); body.append(field);
  const terms = node('div','guide-terms');
  terms.append(node('p','',t('guideDelivery')),node('p','',t('guideRefund',{email:offer.supportEmail})),node('p','small muted',t('guideManualNote')));
  body.append(terms);
  const payment = node('div','field guide-payment');
  const recipientLabel = node('label','',t('guideRecipient'));
  recipientLabel.htmlFor = 'guide-paypal-email';
  const recipient = node('input','guide-recipient');
  recipient.id = 'guide-paypal-email'; recipient.type = 'text'; recipient.value = offer.payPalEmail;
  recipient.readOnly = true; recipient.spellcheck = false; recipient.autocomplete = 'off';
  const copy = node('button','button button-outline button-full',t('guideCopyEmail'));
  copy.type = 'button';
  const copyStatus = node('p','small guide-copy-status');
  copyStatus.setAttribute('role','status'); copyStatus.setAttribute('aria-live','polite');
  copy.addEventListener('click',async () => {
    copyStatus.textContent = '';
    try {
      await navigator.clipboard.writeText(offer.payPalEmail);
      copyStatus.textContent = t('guideEmailCopied');
    } catch {
      recipient.focus(); recipient.select();
      copyStatus.textContent = t('guideCopyEmailFallback');
    }
  });
  const paymentSteps = node('ol','guide-payment-steps');
  paymentSteps.append(node('li','',t('guidePaymentStep1')),node('li','',t('guidePaymentStep2',{email:offer.payPalEmail})),node('li','',t('guidePaymentStep3')));
  payment.append(recipientLabel,recipient,copy,copyStatus,paymentSteps);
  body.append(payment);
  const pay = node('a','button button-primary button-full guide-pay-link',t('guideCheckout'));
  pay.href = offer.checkoutUrl; pay.target = '_blank'; pay.rel = 'noopener noreferrer';
  pay.setAttribute('aria-describedby','guide-paypal-note');
  const payNote = node('p','small muted',t('guideOpenPayPal')); payNote.id = 'guide-paypal-note';
  body.append(pay,payNote);
  const afterPayment = node('div','guide-after-payment');
  afterPayment.append(node('h3','',t('guideOrderDetails')),node('p','',t('guideAfterPayment',{email:offer.supportEmail})));
  const email = node('a','button button-outline button-full',t('guideEmailButton'));
  function updateEmail() {
    const language = {en:'English',zh:'繁體中文',both:'English + 繁體中文'}[edition.value];
    email.href = buildGuideEmail(offer,t('guideEmailSubject'),t('guideEmailBody',{language}));
  }
  edition.addEventListener('change',() => { selectedGuideEdition = edition.value; updateEmail(); }); updateEmail();
  afterPayment.append(email);
  const support = node('a','guide-support-link',offer.supportEmail); support.href = `mailto:${offer.supportEmail}`;
  afterPayment.append(support,node('p','small muted',t('guidePrivacy')));
  body.append(afterPayment);
}

function showInfo(content) {
  $('info-dialog').dataset.content = content;
  const body = $('info-content'); body.replaceChildren();
  if (content === 'privacy') {
    $('info-title').textContent = t('privacyTitle'); body.append(node('p','',t('privacyBody')));
    body.append(node('p','',t('demoNotice')));
    body.append(node('p','',t('guidePrivacy')));
    const source = node('a','','Supabase privacy information ↗'); source.href='https://supabase.com/privacy'; source.target='_blank'; source.rel='noopener noreferrer'; body.append(source);
  } else if (content === 'analytics') {
    $('info-title').textContent = t('analyticsChoice'); body.append(node('p','',t('privacyBody')));
    for (const choice of ['enable','disable']) { const button = node('button',`button ${choice === 'enable' ? 'button-primary' : 'button-outline'}`,t(choice === 'enable' ? 'analyticsEnable' : 'analyticsDisable')); button.type='button'; button.addEventListener('click',() => { writePreference('proneed_analytics',choice === 'enable' ? 'yes':'no'); if (choice === 'enable') initAnalytics(); else if (CONFIG.analyticsId) window[`ga-disable-${CONFIG.analyticsId}`]=true; $('info-dialog').close(); }); body.append(button,document.createTextNode(' ')); }
  } else {
    renderGuideCheckout(body);
  }
  showDialog('info-dialog');
}

function initAnalytics() {
  if (!/^G-[A-Z0-9]+$/.test(CONFIG.analyticsId || '') || readPreference('proneed_analytics','no') !== 'yes' || ['localhost','127.0.0.1',''].includes(location.hostname)) return;
  window[`ga-disable-${CONFIG.analyticsId}`] = false;
  if (analyticsReady) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function(){ window.dataLayer.push(arguments); };
  window.gtag('js',new Date());
  window.gtag('config',CONFIG.analyticsId,{ send_page_view:false, page_location:location.origin+location.pathname, allow_google_signals:false, allow_ad_personalization_signals:false });
  const script = document.createElement('script'); script.src=`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(CONFIG.analyticsId)}`; script.async=true; document.head.append(script); analyticsReady=true;
}
function track(event) { if (analyticsReady && readPreference('proneed_analytics','no') === 'yes' && ['calculation_complete','tracker_open','food_logged','guide_view'].includes(event)) window.gtag('event',event,{language:state.lang,page_location:location.origin+location.pathname}); }

function bindEvents() {
  $('calculator-form').addEventListener('submit',event => { event.preventDefault(); calculate(true); });
  let previousUnit = $('unit').value;
  $('unit').addEventListener('change',() => { const next = $('unit').value; $('weight').value=convertWeightDisplay($('weight').value,previousUnit,next); previousUnit=next; $('weight-unit-label').textContent = next === 'kg' ? 'kg':'lb'; $('weight').min=next==='kg'?20:44.1; $('weight').max=next==='kg'?300:661.38; });
  all('[data-diet]').forEach(button => button.addEventListener('click',() => { state.diet=button.dataset.diet; renderMeals(); }));
  all('[data-page]').forEach(button => button.addEventListener('click',() => showPage(button.dataset.page)));
  document.querySelector('.brand').addEventListener('click',event => { event.preventDefault(); showPage('calculator'); });
  all('[data-tracker-tab]').forEach(button => button.addEventListener('click',() => { state.tab=button.dataset.trackerTab; renderTracker(); renderLegacy(); }));
  all('[data-close-dialog]').forEach(button => button.addEventListener('click',() => {const dialog=button.closest('dialog');if(dialog.id==='account-dialog')state.pendingGoal=null;closeDialog(dialog);}));
  all('dialog').forEach(dialog => dialog.addEventListener('click',event => { if(event.target===dialog) {const r=dialog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom){if(dialog.id==='account-dialog')state.pendingGoal=null;dialog.close();}} }));
  $('account-dialog').addEventListener('cancel',()=>{state.pendingGoal=null;});
  $('account-dialog').addEventListener('close',()=>{$('auth-password').value='';});
  $('account-button').addEventListener('click',async() => { if(!state.user){openAuth();return;} try{await cloud.signOut(); state.pendingGoal=null; await authChanged(null,'SIGNED_OUT');}catch(error){toast(t('accountError'),true);} });
  $('tracker-signin').addEventListener('click',() => openAuth()); $('save-target').addEventListener('click',saveTarget);
  all('[data-auth-mode]').forEach(button => button.addEventListener('click',() => openAuth(button.dataset.authMode)));
  $('forgot-button').addEventListener('click',() => openAuth('reset')); $('auth-form').addEventListener('submit',submitAuth);
  $('demo-button').addEventListener('click',() => { $('account-dialog').close(); showPage('tracker'); if(state.pendingGoal!=null&&!state.user){const target=state.pendingGoal;state.pendingGoal=null;mutate(()=>{},next=>{next.goal=target;},t('demoSaved'));} });
  $('food-form').addEventListener('submit',addFood); ['food-amount','food-protein'].forEach(id => $(id).addEventListener('input',previewFood));
  $('sync-button').addEventListener('click',() => refreshCloud());
  $('goal-form').addEventListener('submit',async event => { event.preventDefault(); const goal=Number($('settings-goal').value); if(!$('settings-goal').value.trim()||!Number.isFinite(goal)||goal<40||goal>500||!Number.isInteger(goal)){message('settings-error',t('targetBounds'));return;} message('settings-error'); await mutate(()=>cloud.saveGoal(goal),next=>{next.goal=goal;},t('savedGoal',{goal})); });
  $('export-button').addEventListener('click',() => { const blob=new Blob([JSON.stringify({format:'proneed-export-v2',exportedAt:new Date().toISOString(),demo:!state.user,goal:state.data.goal,entries:state.data.entries},null,2)],{type:'application/json'});const href=URL.createObjectURL(blob),link=node('a');link.href=href;link.download=`proneed-${localDate()}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),1000); });
  $('clear-button').addEventListener('click',() => { $('confirm-dialog').querySelector('p').textContent=t(state.user?'confirmClear':'clearDemoOnly'); showDialog('confirm-dialog'); });
  $('confirm-clear-button').addEventListener('click',async() => { if(await mutate(()=>cloud.clearEntries(),next=>{next.entries=[];}))$('confirm-dialog').close(); });
  $('import-button').addEventListener('click',async() => { if(!state.user){toast(t('legacyRequiresAccount'));openAuth();return;}const legacy=readLegacyProfiles({getItem:key=>localStorage.getItem(key)}),profile=legacy.profiles[Number($('legacy-profile').value)];if(!profile)return;let imported=0;const done=await mutate(async()=>{const result=await cloud.importEntries(profile.entries,profile.name);imported=result.imported;},()=>{});if(done&&!cloudError)toast(t('importDone',{count:imported})); });
  $('privacy-button').addEventListener('click',() => showInfo('privacy')); $('analytics-button').addEventListener('click',() => showInfo('analytics')); $('guide-button').addEventListener('click',() => {showInfo('guide');track('guide_view');});
  document.addEventListener('visibilitychange',() => {if(!document.hidden){checkDay();if(state.user)refreshCloud();}}); window.addEventListener('focus',() => {checkDay();if(state.user)refreshCloud();});
  window.addEventListener('pageshow',event=>{if(event.persisted){checkDay();if(state.user)refreshCloud();}});
}

function checkDay() { const day=localDate(); if(day!==lastLocalDay){lastLocalDay=day;renderTracker();} }

async function init() {
  try { cloud=createCloudStore(CONFIG,{onAuthChange:(user,event)=>{authChanged(user,event).catch(error=>toast(error.message,true));}}); }
  catch(error){cloudError=error;cloud={configured:false,init:async()=>null};}
  bindEvents(); calculate(); applyLanguage(); initAnalytics();
  if(!demoWritable)toast(t('saveFailed')+' '+t('originalUntouched'),true);
  try { const session=await cloud.init();if(session?.user&&!state.user)await authChanged(session.user,'INITIAL_SESSION'); }
  catch(error){cloudError=error;toast(t('cloudDisconnected'),true);}
  syncTimer=setInterval(()=>{checkDay();if(!document.hidden&&state.user&&!busy)refreshCloud();},20000);
  window.addEventListener('pagehide',event=>{if(!event.persisted){clearInterval(syncTimer);cloud?.dispose?.();}});
}
init().catch(error=>{console.error('ProNeed initialization failed.',error);toast(t('errorGeneric'),true);});
