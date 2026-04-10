// ─── Imports ─────────────────────────────────────────────────────────────────
import { initializeApp }           from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  onSnapshot, arrayUnion, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// ─── Config (fill in after EmailJS setup) ────────────────────────────────────
const EMAILJS_PUBLIC_KEY  = 'YOUR_PUBLIC_KEY';
const EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';
const EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';
const TREASURER_EMAIL     = 'jd.ccclv@gmail.com';

// ─── Denominations ────────────────────────────────────────────────────────────
// valueCents = denomination value in integer cents (avoids floating-point drift)
const DENOMINATIONS = {
  bills: [
    { key: 'b100', label: '$100',   valueCents: 10000 },
    { key: 'b50',  label: '$50',    valueCents:  5000 },
    { key: 'b20',  label: '$20',    valueCents:  2000 },
    { key: 'b10',  label: '$10',    valueCents:  1000 },
    { key: 'b5',   label: '$5',     valueCents:   500 },
    { key: 'b2',   label: '$2',     valueCents:   200 },
    { key: 'b1',   label: '$1',     valueCents:   100 },
  ],
  coins: [
    { key: 'c100', label: '$1.00',  valueCents:   100 },
    { key: 'c50',  label: '$0.50',  valueCents:    50 },
    { key: 'c25',  label: '$0.25',  valueCents:    25 },
    { key: 'c10',  label: '$0.10',  valueCents:    10 },
    { key: 'c5',   label: '$0.05',  valueCents:     5 },
    { key: 'c1',   label: '$0.01',  valueCents:     1 },
  ],
};
const ALL_DENOMS = [...DENOMINATIONS.bills, ...DENOMINATIONS.coins];

// ─── Firebase Init ───────────────────────────────────────────────────────────
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ─── App State ────────────────────────────────────────────────────────────────
let currentUser        = null;   // { id, name }
let sessionId          = null;   // YYYY-MM-DD string
let unsubscribeSession = null;   // Firestore onSnapshot cleanup fn
let countScreenBuilt   = false;  // denomination rows rendered once
let saveTimer          = null;   // debounce handle for count autosave
let lastSessionData    = null;   // latest snapshot for email / comparison
let submitInProgress   = false;  // prevents double-submit

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getProfiles() {
  return JSON.parse(localStorage.getItem('churchCounter_profiles') || '[]');
}

function saveProfiles(profiles) {
  localStorage.setItem('churchCounter_profiles', JSON.stringify(profiles));
}

async function registerUser(name, pin, pinConfirm) {
  name = name.trim();
  if (!name)                        return { ok: false, err: 'Please enter your name.' };
  if (!/^\d{4}$/.test(pin))        return { ok: false, err: 'PIN must be exactly 4 digits.' };
  if (pin !== pinConfirm)           return { ok: false, err: 'PINs do not match.' };
  const profiles = getProfiles();
  if (profiles.some(p => p.name.toLowerCase() === name.toLowerCase()))
    return { ok: false, err: 'That name is already registered on this device.' };
  const pinHash = await hashPin(pin);
  profiles.push({ id: crypto.randomUUID(), name, pinHash });
  saveProfiles(profiles);
  return { ok: true };
}

async function loginUser(name, pin) {
  if (!name) return { ok: false, err: 'Please select your name.' };
  if (!pin)  return { ok: false, err: 'Please enter your PIN.' };
  const profile = getProfiles().find(p => p.name === name);
  if (!profile) return { ok: false, err: 'Profile not found.' };
  const pinHash = await hashPin(pin);
  if (pinHash !== profile.pinHash) return { ok: false, err: 'Incorrect PIN. Try again.' };
  return { ok: true, user: { id: profile.id, name: profile.name } };
}

function storeCurrentUser(user) {
  sessionStorage.setItem('churchCounter_user', JSON.stringify(user));
}
function loadCurrentUser() {
  const s = sessionStorage.getItem('churchCounter_user');
  return s ? JSON.parse(s) : null;
}
function clearCurrentUser() {
  sessionStorage.removeItem('churchCounter_user');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════════════════

function getTodayId() {
  // en-CA gives YYYY-MM-DD in local time (avoids UTC midnight flip)
  return new Date().toLocaleDateString('en-CA');
}

async function getOrCreateSession(sid) {
  const ref = doc(db, 'sessions', sid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, { status: 'waiting', submittedAt: null, counters: {}, checks: [] });
  }
  return ref;
}

async function joinSession(sid, user) {
  const ref = doc(db, 'sessions', sid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    const ids = Object.keys(data.counters || {});
    // Block a third person from joining
    if (ids.length >= 2 && !ids.includes(user.id)) {
      return { ok: false, err: 'This session already has 2 counters. Please wait until next Sunday.' };
    }
  }
  await updateDoc(ref, {
    [`counters.${user.id}`]: { name: user.name, locked: false, counts: null },
  });
  return { ok: true };
}

function subscribeToSession(sid, onUpdate) {
  const ref = doc(db, 'sessions', sid);
  return onSnapshot(ref, snap => {
    if (snap.exists()) onUpdate(snap.data());
  }, err => {
    console.error('Firestore error:', err);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COUNTS — math helpers
// ═══════════════════════════════════════════════════════════════════════════════

function formatCents(cents) {
  const abs = Math.abs(cents);
  const str = (abs / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + str;
}

function computeCashCents(counts) {
  return ALL_DENOMS.reduce((sum, d) => sum + (counts[d.key] || 0) * d.valueCents, 0);
}

function buildCountsFromForm() {
  const counts = {};
  ALL_DENOMS.forEach(d => {
    const v = parseInt(document.getElementById(`qty-${d.key}`)?.value || '0', 10);
    counts[d.key] = isNaN(v) || v < 0 ? 0 : v;
  });
  return counts;
}

function prefillCountsToForm(counts) {
  ALL_DENOMS.forEach(d => {
    const el = document.getElementById(`qty-${d.key}`);
    if (el) el.value = counts[d.key] ?? 0;
  });
  updateLocalTotals();
}

async function saveMyCount(counts) {
  await updateDoc(doc(db, 'sessions', sessionId), {
    [`counters.${currentUser.id}.counts`]: counts,
  });
}

async function lockMyCount() {
  clearTimeout(saveTimer);
  const counts = buildCountsFromForm();
  await saveMyCount(counts);
  await updateDoc(doc(db, 'sessions', sessionId), {
    [`counters.${currentUser.id}.locked`]: true,
  });
}

async function unlockMyCount() {
  await updateDoc(doc(db, 'sessions', sessionId), {
    [`counters.${currentUser.id}.locked`]: false,
  });
  countScreenBuilt = false; // rebuild table on next render
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION DATA HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function getCounterIds(data) { return Object.keys(data.counters || {}); }

function bothPresent(data) { return getCounterIds(data).length === 2; }

function bothLocked(data) {
  const ids = getCounterIds(data);
  return ids.length === 2 && ids.every(id => data.counters[id].locked);
}

function getDenomMismatches(data) {
  const ids = getCounterIds(data);
  if (ids.length < 2) return ALL_DENOMS.map(d => d.key);
  const cA = data.counters[ids[0]].counts || {};
  const cB = data.counters[ids[1]].counts || {};
  return ALL_DENOMS.filter(d => (cA[d.key] || 0) * d.valueCents !== (cB[d.key] || 0) * d.valueCents)
                   .map(d => d.key);
}

function allMatch(data) { return getDenomMismatches(data).length === 0; }

function allChecksConfirmed(data) {
  const checks = data.checks || [];
  return checks.length > 0 && checks.every(c => c.confirmedBy);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

async function addCheck(checkNumber, amountStr) {
  const amount = Math.round(parseFloat(amountStr) * 100);
  if (!checkNumber.trim()) return { ok: false, err: 'Enter a check number.' };
  if (isNaN(amount) || amount <= 0) return { ok: false, err: 'Enter a valid amount.' };
  await updateDoc(doc(db, 'sessions', sessionId), {
    checks: arrayUnion({
      id: crypto.randomUUID(),
      checkNumber: checkNumber.trim(),
      amount,
      addedBy: currentUser.id,
      confirmedBy: null,
    }),
  });
  return { ok: true };
}

async function confirmCheck(checkId) {
  await runTransaction(db, async tx => {
    const ref  = doc(db, 'sessions', sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Session not found');
    const checks = snap.data().checks.map(c =>
      c.id === checkId ? { ...c, confirmedBy: currentUser.id } : c
    );
    tx.update(ref, { checks });
  });
}

async function removeCheck(checkId) {
  await runTransaction(db, async tx => {
    const ref  = doc(db, 'sessions', sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Session not found');
    const checks = snap.data().checks.filter(c => c.id !== checkId);
    tx.update(ref, { checks });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

function buildEmailParams(data) {
  const ids = getCounterIds(data);
  const ctrA = data.counters[ids[0]];
  const ctrB = data.counters[ids[1]];
  const counts = ctrA.counts || {};

  const dateLabel = new Date(sessionId + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const params = {
    date: dateLabel,
    counter_a_name: ctrA.name,
    counter_b_name: ctrB.name,
    to_email: TREASURER_EMAIL,
  };

  let cashCents = 0;
  ALL_DENOMS.forEach(d => {
    const qty   = counts[d.key] || 0;
    const total = qty * d.valueCents;
    cashCents  += total;
    params[`${d.key}_qty`]   = qty;
    params[`${d.key}_total`] = formatCents(total);
  });
  params.cash_total = formatCents(cashCents);

  const checks = data.checks || [];
  let checkCents = 0;
  checks.forEach(c => { checkCents += c.amount; });
  params.checks_list  = checks.length
    ? checks.map(c => `#${c.checkNumber}  ${formatCents(c.amount)}`).join('\n')
    : '(none)';
  params.checks_total = formatCents(checkCents);
  params.grand_total  = formatCents(cashCents + checkCents);

  return params;
}

async function submitOffering() {
  if (submitInProgress) return;
  submitInProgress = true;
  showEl('compare-error', false);

  // Init EmailJS lazily
  if (typeof emailjs === 'undefined') {
    showErrorIn('compare-error', 'EmailJS library not loaded. Check your internet connection.');
    submitInProgress = false;
    return;
  }
  emailjs.init(EMAILJS_PUBLIC_KEY);

  const params = buildEmailParams(lastSessionData);
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, params);
    await updateDoc(doc(db, 'sessions', sessionId), {
      status: 'submitted',
      submittedAt: serverTimestamp(),
    });
    // The onSnapshot will fire and transition to submitted screen
  } catch (err) {
    console.error('EmailJS error:', err);
    showErrorIn('compare-error', 'Email failed to send. Check your EmailJS settings, then try again.');
    submitInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const SCREENS = ['screen-profile', 'screen-lobby', 'screen-count', 'screen-compare', 'screen-submitted'];

function showScreen(id) {
  SCREENS.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
}

function showEl(id, visible) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', !visible);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showErrorIn(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearErrorIn(id) {
  showEl(id, false);
}

function formatDateLabel(sid) {
  return new Date(sid + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: PROFILE SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function setupProfileScreen() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.getElementById('tab-login').classList.toggle('hidden', target !== 'login');
      document.getElementById('tab-register').classList.toggle('hidden', target !== 'register');
      clearErrorIn('login-error');
      clearErrorIn('register-error');
    });
  });

  populateNameDropdown();

  // Sign in
  document.getElementById('btn-signin').addEventListener('click', async () => {
    clearErrorIn('login-error');
    const name = document.getElementById('login-name-select').value;
    const pin  = document.getElementById('login-pin').value;
    const btn  = document.getElementById('btn-signin');
    btn.disabled = true;
    const result = await loginUser(name, pin);
    btn.disabled = false;
    if (!result.ok) { showErrorIn('login-error', result.err); return; }
    document.getElementById('login-pin').value = '';
    await startSession(result.user);
  });

  // Allow Enter key on PIN input
  document.getElementById('login-pin').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-signin').click();
  });

  // Register
  document.getElementById('btn-register').addEventListener('click', async () => {
    clearErrorIn('register-error');
    const name    = document.getElementById('register-name').value;
    const pin     = document.getElementById('register-pin').value;
    const confirm = document.getElementById('register-pin-confirm').value;
    const btn     = document.getElementById('btn-register');
    btn.disabled  = true;
    const result  = await registerUser(name, pin, confirm);
    btn.disabled  = false;
    if (!result.ok) { showErrorIn('register-error', result.err); return; }
    // Clear form, switch to login, pre-select new name
    document.getElementById('register-name').value        = '';
    document.getElementById('register-pin').value         = '';
    document.getElementById('register-pin-confirm').value = '';
    populateNameDropdown();
    document.querySelector('[data-tab="login"]').click();
    const sel = document.getElementById('login-name-select');
    sel.value = name;
  });
}

function populateNameDropdown() {
  const sel = document.getElementById('login-name-select');
  const profiles = getProfiles();
  sel.innerHTML = '<option value="">— Select your name —</option>' +
    profiles.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: LOBBY SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function renderLobby(data) {
  setText('lobby-date', formatDateLabel(sessionId));
  const ids = getCounterIds(data);
  const list = document.getElementById('lobby-counters');
  list.innerHTML = '';

  const slots = [ids[0] || null, ids[1] || null];
  slots.forEach(id => {
    const div  = document.createElement('div');
    div.className = 'lobby-counter-item';
    const dot  = document.createElement('span');
    dot.className = 'lobby-counter-dot' + (id ? '' : ' waiting');
    const name = document.createElement('span');
    name.textContent = id ? data.counters[id].name : 'Waiting…';
    div.appendChild(dot);
    div.appendChild(name);
    if (id === currentUser.id) {
      const you = document.createElement('span');
      you.className = 'lobby-counter-you';
      you.textContent = '(you)';
      div.appendChild(you);
    }
    list.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: COUNT SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function buildDenomTable() {
  ['bills', 'coins'].forEach(section => {
    const container = document.getElementById(`${section}-rows`);
    container.innerHTML = DENOMINATIONS[section].map(d => `
      <div class="denom-row" data-key="${d.key}">
        <span class="denom-label">${d.label}</span>
        <input type="number" id="qty-${d.key}" class="qty-input"
               min="0" step="1" value="0" inputmode="numeric">
        <span class="denom-row-total" id="total-${d.key}">$0.00</span>
      </div>
    `).join('');
  });
}

function setupCountInputListeners() {
  ALL_DENOMS.forEach(d => {
    const el = document.getElementById(`qty-${d.key}`);
    if (!el) return;
    el.addEventListener('input', () => {
      // Update this row's total immediately
      const qty   = parseInt(el.value || '0', 10) || 0;
      const total = qty * d.valueCents;
      const tEl   = document.getElementById(`total-${d.key}`);
      if (tEl) tEl.textContent = formatCents(total);
      updateLocalTotals();
      // Debounce-save to Firestore
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveMyCount(buildCountsFromForm()), 800);
    });
    // Highlight all text on focus for quick re-entry
    el.addEventListener('focus', () => el.select());
  });
}

function updateLocalTotals() {
  let billsCents = 0, coinsCents = 0;
  DENOMINATIONS.bills.forEach(d => {
    const qty = parseInt(document.getElementById(`qty-${d.key}`)?.value || '0', 10) || 0;
    const tot = qty * d.valueCents;
    billsCents += tot;
    const tEl = document.getElementById(`total-${d.key}`);
    if (tEl) tEl.textContent = formatCents(tot);
  });
  DENOMINATIONS.coins.forEach(d => {
    const qty = parseInt(document.getElementById(`qty-${d.key}`)?.value || '0', 10) || 0;
    const tot = qty * d.valueCents;
    coinsCents += tot;
    const tEl = document.getElementById(`total-${d.key}`);
    if (tEl) tEl.textContent = formatCents(tot);
  });
  setText('bills-total', formatCents(billsCents));
  setText('coins-total', formatCents(coinsCents));
  setText('cash-total',  formatCents(billsCents + coinsCents));
}

function setCountInputsEnabled(enabled) {
  ALL_DENOMS.forEach(d => {
    const el = document.getElementById(`qty-${d.key}`);
    if (el) el.disabled = !enabled;
  });
  document.getElementById('btn-add-check').disabled  = !enabled;
  document.getElementById('check-number-input').disabled = !enabled;
  document.getElementById('check-amount-input').disabled = !enabled;
}

function renderCountScreen(data) {
  const myId    = currentUser.id;
  const ids     = getCounterIds(data);
  const otherId = ids.find(id => id !== myId);
  const myData  = data.counters[myId];
  const other   = otherId ? data.counters[otherId] : null;

  // Header
  setText('count-user-name', myData.name);
  const badge = document.getElementById('other-counter-badge');
  if (other) {
    badge.textContent  = other.locked ? `${other.name}: Locked ✓` : `${other.name}: Counting…`;
    badge.className    = 'other-badge' + (other.locked ? ' locked' : '');
  }

  // Build table only on first visit (preserves input values)
  if (!countScreenBuilt) {
    buildDenomTable();
    setupCountInputListeners();
    if (myData.counts) prefillCountsToForm(myData.counts);
    else updateLocalTotals();
    countScreenBuilt = true;
  }

  // Lock state
  const isLocked = myData.locked;
  showEl('btn-lock',         !isLocked);
  showEl('lock-waiting-msg',  isLocked);
  setCountInputsEnabled(!isLocked);

  // Check list (always refresh — comes from Firestore)
  renderCheckList(data.checks || [], myId);
  updateCheckTotal(data.checks || []);
}

function renderCheckList(checks, myId) {
  const container = document.getElementById('check-list');
  if (!checks.length) {
    container.innerHTML = '<p class="empty-msg">No checks added yet.</p>';
    return;
  }
  container.innerHTML = checks.map(c => {
    const isMine      = c.addedBy === myId;
    const isConfirmed = !!c.confirmedBy;
    const canConfirm  = !isMine && !isConfirmed;

    return `
      <div class="check-item ${isConfirmed ? 'confirmed' : ''}" data-id="${escHtml(c.id)}">
        <span class="check-num">#${escHtml(c.checkNumber)}</span>
        <span class="check-amount">${formatCents(c.amount)}</span>
        ${isConfirmed
          ? `<span class="check-status-tag tag-confirmed">✓ Confirmed</span>`
          : isMine
            ? `<span class="check-status-tag tag-pending">Awaiting confirmation</span>`
            : ''}
        ${canConfirm
          ? `<button class="btn-confirm-check" data-id="${escHtml(c.id)}">Confirm</button>`
          : ''}
        ${isMine && !isConfirmed
          ? `<button class="btn-remove-check" data-id="${escHtml(c.id)}">✕</button>`
          : ''}
      </div>`;
  }).join('');

  container.querySelectorAll('.btn-confirm-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await confirmCheck(btn.dataset.id); }
      catch (e) { btn.disabled = false; console.error(e); }
    });
  });
  container.querySelectorAll('.btn-remove-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this check?')) return;
      btn.disabled = true;
      try { await removeCheck(btn.dataset.id); }
      catch (e) { btn.disabled = false; console.error(e); }
    });
  });
}

function updateCheckTotal(checks) {
  const cents = checks.reduce((s, c) => s + c.amount, 0);
  setText('checks-total-count', formatCents(cents));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: COMPARE SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function renderCompareScreen(data) {
  const ids  = getCounterIds(data);
  const ctrA = data.counters[ids[0]];
  const ctrB = data.counters[ids[1]];
  const cA   = ctrA.counts || {};
  const cB   = ctrB.counts || {};

  setText('compare-date', formatDateLabel(sessionId));

  // Counter name headers
  ['cmp-name-a', 'cmp-name-a-coins'].forEach(id => setText(id, ctrA.name));
  ['cmp-name-b', 'cmp-name-b-coins'].forEach(id => setText(id, ctrB.name));

  const mismatches = getDenomMismatches(data);

  // Summary banner
  const summaryEl = document.getElementById('compare-summary');
  if (mismatches.length === 0) {
    summaryEl.textContent = '✓ All denominations match!';
    summaryEl.className   = 'compare-summary all-match';
  } else {
    summaryEl.textContent = `${mismatches.length} mismatch${mismatches.length > 1 ? 'es' : ''} — please recount highlighted rows`;
    summaryEl.className   = 'compare-summary has-mismatch';
  }

  // Denomination rows
  function buildRows(denomList, tbodyId) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = denomList.map(d => {
      const qA = cA[d.key] || 0, qB = cB[d.key] || 0;
      const tA = qA * d.valueCents, tB = qB * d.valueCents;
      const ok = tA === tB;
      return `
        <tr class="${ok ? 'row-match' : 'row-mismatch'}">
          <td>${d.label}</td>
          <td>${qA}</td><td>${formatCents(tA)}</td>
          <td>${qB}</td><td>${formatCents(tB)}</td>
          <td class="match-cell">${ok ? '✓' : '✗'}</td>
        </tr>`;
    }).join('');
  }
  buildRows(DENOMINATIONS.bills, 'compare-bills-body');
  buildRows(DENOMINATIONS.coins, 'compare-coins-body');

  // Bills subtotal foot
  const billsCentsA = DENOMINATIONS.bills.reduce((s, d) => s + (cA[d.key] || 0) * d.valueCents, 0);
  const billsCentsB = DENOMINATIONS.bills.reduce((s, d) => s + (cB[d.key] || 0) * d.valueCents, 0);
  const billsOk     = billsCentsA === billsCentsB;
  setText('cmp-bills-total-a', formatCents(billsCentsA));
  setText('cmp-bills-total-b', formatCents(billsCentsB));
  setText('cmp-bills-match',   billsOk ? '✓' : '✗');
  document.getElementById('compare-bills-foot').className = billsOk ? 'subtotal-row row-match' : 'subtotal-row row-mismatch';

  // Coins subtotal foot
  const coinsCentsA = DENOMINATIONS.coins.reduce((s, d) => s + (cA[d.key] || 0) * d.valueCents, 0);
  const coinsCentsB = DENOMINATIONS.coins.reduce((s, d) => s + (cB[d.key] || 0) * d.valueCents, 0);
  const coinsOk     = coinsCentsA === coinsCentsB;
  setText('cmp-coins-total-a', formatCents(coinsCentsA));
  setText('cmp-coins-total-b', formatCents(coinsCentsB));
  setText('cmp-coins-match',   coinsOk ? '✓' : '✗');
  document.getElementById('compare-coins-foot').className = coinsOk ? 'subtotal-row row-match' : 'subtotal-row row-mismatch';

  // Cash totals row
  const totalA = computeCashCents(cA), totalB = computeCashCents(cB);
  const totOk  = totalA === totalB;
  document.getElementById('compare-cash-totals').innerHTML = `
    <div class="cash-entry">
      <span class="cash-label">${escHtml(ctrA.name)}</span>
      <span class="cash-val">${formatCents(totalA)}</span>
    </div>
    <span class="match-icon ${totOk ? 'ok' : 'bad'}">${totOk ? '=' : '≠'}</span>
    <div class="cash-entry">
      <span class="cash-label">${escHtml(ctrB.name)}</span>
      <span class="cash-val">${formatCents(totalB)}</span>
    </div>`;

  // Checks (read-only view)
  const checks    = data.checks || [];
  const checkList = document.getElementById('compare-check-list');
  if (!checks.length) {
    checkList.innerHTML = '<p class="empty-msg">No checks were recorded.</p>';
  } else {
    checkList.innerHTML = checks.map(c => `
      <div class="check-item ${c.confirmedBy ? 'confirmed' : ''}">
        <span class="check-num">#${escHtml(c.checkNumber)}</span>
        <span class="check-amount">${formatCents(c.amount)}</span>
        <span class="check-status-tag ${c.confirmedBy ? 'tag-confirmed' : 'tag-pending'}">
          ${c.confirmedBy ? '✓ Confirmed' : '⚠ Not confirmed'}
        </span>
      </div>`).join('');
  }

  const checkCents  = checks.reduce((s, c) => s + c.amount, 0);
  const grandCents  = totalA + checkCents;   // cash matches so either counter works
  setText('compare-checks-total', formatCents(checkCents));
  setText('compare-grand-total',  formatCents(grandCents));

  // Submit / status
  const canSubmit = mismatches.length === 0 && allChecksConfirmed(data);
  showEl('btn-submit', canSubmit);
  const statusEl = document.getElementById('submit-status-msg');
  if (canSubmit) {
    statusEl.textContent = '';
  } else if (mismatches.length > 0) {
    statusEl.textContent = 'Resolve all mismatches before submitting.';
  } else if (checks.length > 0 && !allChecksConfirmed(data)) {
    statusEl.textContent = 'All checks must be confirmed before submitting.';
  } else if (checks.length === 0) {
    statusEl.textContent = 'No checks were recorded. Confirm this is correct, then all denomination counts must match to submit.';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: SUBMITTED SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

function renderSubmittedScreen(data) {
  const ids     = getCounterIds(data);
  const names   = ids.map(id => data.counters[id].name);
  const cA      = data.counters[ids[0]].counts || {};
  const checks  = data.checks || [];
  const cash    = computeCashCents(cA);
  const chkSum  = checks.reduce((s, c) => s + c.amount, 0);

  setText('submitted-date',        formatDateLabel(sessionId));
  setText('submitted-counters',    names.join(' & '));
  setText('submitted-grand-total', formatCents(cash + chkSum));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN STATE MACHINE — driven by Firestore onSnapshot
// ═══════════════════════════════════════════════════════════════════════════════

function handleSessionUpdate(data) {
  lastSessionData = data;

  if (data.status === 'submitted') {
    showScreen('screen-submitted');
    renderSubmittedScreen(data);
    return;
  }

  if (!bothPresent(data)) {
    showScreen('screen-lobby');
    renderLobby(data);
    return;
  }

  if (bothLocked(data)) {
    submitInProgress = false; // reset so retry works after error
    showScreen('screen-compare');
    renderCompareScreen(data);
    return;
  }

  showScreen('screen-count');
  renderCountScreen(data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION START (after login)
// ═══════════════════════════════════════════════════════════════════════════════

async function startSession(user) {
  currentUser = user;
  storeCurrentUser(user);
  sessionId   = getTodayId();

  showScreen('screen-lobby');
  setText('lobby-date', formatDateLabel(sessionId));

  try {
    await getOrCreateSession(sessionId);
    const joinResult = await joinSession(sessionId, user);
    if (!joinResult.ok) {
      clearCurrentUser();
      currentUser = null;
      showScreen('screen-profile');
      showErrorIn('login-error', joinResult.err);
      return;
    }
  } catch (e) {
    clearCurrentUser();
    currentUser = null;
    showScreen('screen-profile');
    showErrorIn('login-error', 'Could not connect to Firebase. Check your internet and config.');
    console.error(e);
    return;
  }

  // Subscribe to live updates
  if (unsubscribeSession) unsubscribeSession();
  unsubscribeSession = subscribeToSession(sessionId, handleSessionUpdate);
}

function signOut() {
  if (unsubscribeSession) { unsubscribeSession(); unsubscribeSession = null; }
  clearTimeout(saveTimer);
  clearCurrentUser();
  currentUser      = null;
  sessionId        = null;
  lastSessionData  = null;
  countScreenBuilt = false;
  submitInProgress = false;
  showScreen('screen-profile');
  populateNameDropdown();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY HELPER
// ═══════════════════════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {

  // Sunday warning
  if (new Date().getDay() !== 0) {
    document.getElementById('sunday-banner').classList.remove('hidden');
  }

  // Online/offline indicator
  function updateOnlineBanner() {
    document.getElementById('offline-banner').classList.toggle('hidden', navigator.onLine);
  }
  window.addEventListener('online',  updateOnlineBanner);
  window.addEventListener('offline', updateOnlineBanner);
  updateOnlineBanner();

  // Profile screen setup
  setupProfileScreen();

  // Sign-out buttons
  document.getElementById('btn-signout-lobby').addEventListener('click', signOut);
  document.getElementById('btn-signout-count').addEventListener('click', signOut);

  // Lock button
  document.getElementById('btn-lock').addEventListener('click', async () => {
    clearErrorIn('count-error');
    const btn = document.getElementById('btn-lock');
    btn.disabled = true;
    try { await lockMyCount(); }
    catch (e) {
      showErrorIn('count-error', 'Could not lock your count. Check connection and try again.');
      btn.disabled = false;
    }
  });

  // Add check
  document.getElementById('btn-add-check').addEventListener('click', async () => {
    const numEl = document.getElementById('check-number-input');
    const amtEl = document.getElementById('check-amount-input');
    const btn   = document.getElementById('btn-add-check');
    btn.disabled = true;
    const result = await addCheck(numEl.value, amtEl.value);
    btn.disabled = false;
    if (!result.ok) { alert(result.err); return; }
    numEl.value = '';
    amtEl.value = '';
    numEl.focus();
  });

  // Allow Enter on check fields
  document.getElementById('check-amount-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-add-check').click();
  });

  // Unlock
  document.getElementById('btn-unlock').addEventListener('click', async () => {
    if (!confirm('Unlock your count and return to entry? Your previous entries will be kept.')) return;
    const btn = document.getElementById('btn-unlock');
    btn.disabled = true;
    try {
      await unlockMyCount();
      countScreenBuilt = false;
    } catch (e) {
      btn.disabled = false;
      showErrorIn('compare-error', 'Could not unlock. Try again.');
    }
  });

  // Submit
  document.getElementById('btn-submit').addEventListener('click', async () => {
    if (!confirm('Submit this offering count? An email will be sent to the treasurer.')) return;
    document.getElementById('btn-submit').disabled = true;
    await submitOffering();
    document.getElementById('btn-submit').disabled = false;
  });

  // Done / sign out from submitted screen
  document.getElementById('btn-done').addEventListener('click', signOut);

  // Attempt to rejoin an in-progress session (e.g. after accidental page refresh)
  const savedUser = loadCurrentUser();
  if (savedUser) {
    await startSession(savedUser);
  } else {
    showScreen('screen-profile');
  }
});
