// ─── Imports ─────────────────────────────────────────────────────────────────
import { initializeApp }           from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  onSnapshot, arrayUnion, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// ─── Config (fill in after EmailJS setup) ────────────────────────────────────
const EMAILJS_PUBLIC_KEY  = 'xIicYRDTu2HLulENo';
const EMAILJS_SERVICE_ID  = 'service_nwil4a1';
const EMAILJS_TEMPLATE_ID = 'template_gukzkye';
const TREASURER_EMAIL     = 'imetthomas@gmail.com';
const THOMAS_PHONE        = '7024965338'; 

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
let currentUser        = null;   // { id, name, deviceToken }
let sessionId          = null;   // YYYY-MM-DD string
let unsubscribeSession = null;   // Firestore onSnapshot cleanup fn
let countScreenBuilt   = false;  // denomination rows rendered once
let saveTimer          = null;   // debounce handle for count autosave
let lastSessionData    = null;   // latest snapshot for email / comparison
let submitInProgress   = false;  // prevents double-submit
let lastSeenReset      = 0;      // tracks resetCount so other device's reset triggers rebuild

// ═══════════════════════════════════════════════════════════════════════════════
// USER SESSION STORAGE (page-refresh rejoin)
// ═══════════════════════════════════════════════════════════════════════════════

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
  const ref  = doc(db, 'sessions', sid);
  const snap = await getDoc(ref);
  const data = snap.exists() ? snap.data() : { counters: {} };
  const ids  = Object.keys(data.counters || {});
  const existing = data.counters?.[user.id];

  if (existing) {
    // This user's slot already exists in the session.
    // Block if another device is already active (different deviceToken).
    if (existing.deviceToken && existing.deviceToken !== user.deviceToken) {
      return {
        ok: false,
        err: `${user.name} is already signed in on another device. Sign out there first, then try again.`,
      };
    }
    // Same device rejoining (page refresh) — refresh token only, keep counts & locked intact.
    await updateDoc(ref, { [`counters.${user.id}.deviceToken`]: user.deviceToken });
    return { ok: true };
  }

  // New user — block a third person from joining.
  if (ids.length >= 2) {
    return { ok: false, err: 'This session already has 2 counters. Please wait until next Sunday.' };
  }

  await updateDoc(ref, {
    [`counters.${user.id}`]: {
      name: user.name, locked: false, counts: null, deviceToken: user.deviceToken,
    },
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
    const raw = (document.getElementById(`qty-${d.key}`)?.value || '').replace(/[^0-9]/g, '');
    counts[d.key] = parseInt(raw, 10) || 0;
  });
  return counts;
}

function prefillCountsToForm(counts) {
  ALL_DENOMS.forEach(d => {
    const el = document.getElementById(`qty-${d.key}`);
    if (el) el.value = counts[d.key] != null && counts[d.key] !== 0 ? counts[d.key] : '';
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
    [`counters.${currentUser.id}.locked`]:     true,
    [`counters.${currentUser.id}.lockedOnce`]: true,  // never cleared on unlock
  });
}

async function unlockMyCount() {
  await updateDoc(doc(db, 'sessions', sessionId), {
    [`counters.${currentUser.id}.locked`]: false,
  });
  countScreenBuilt = false; // rebuild table on next render
}

async function resetSession() {
  const ref  = doc(db, 'sessions', sessionId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  const data    = snap.data();
  const ids     = getCounterIds(data);
  const newReset = (data.resetCount || 0) + 1;

  // Clear counts, checks, and locks — keep both counters in the session
  const update = { checks: [], status: 'counting', resetCount: newReset };
  ids.forEach(id => {
    update[`counters.${id}.locked`]     = false;
    update[`counters.${id}.counts`]     = null;
    update[`counters.${id}.lockedOnce`] = false;
  });

  clearTimeout(saveTimer);
  await updateDoc(ref, update);
  // onSnapshot fires on both devices; renderCountScreen detects resetCount change and rebuilds
}

async function clearSession() {
  // Wipe all counters and checks — any open tab will be kicked back to name entry
  await setDoc(doc(db, 'sessions', sessionId), {
    status: 'waiting',
    submittedAt: null,
    counters: {},
    checks: [],
    resetCount: 0,
  });
  // Sign out locally — the onSnapshot will also trigger signOut on any other open tab
  signOut();
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


function allChecksConfirmed(data) {
  const checks = data.checks || [];
  // No checks = nothing to confirm; treat as fully confirmed
  return checks.length === 0 || checks.every(c => c.confirmedBy);
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

async function flagCheck(checkId) {
  // Confirming counter flags the check as wrong — sends it back to the enterer for correction
  await runTransaction(db, async tx => {
    const ref  = doc(db, 'sessions', sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Session not found');
    const checks = snap.data().checks.map(c =>
      c.id === checkId ? { ...c, flagged: true, confirmedBy: null } : c
    );
    tx.update(ref, { checks });
  });
}

async function editCheck(checkId, newCheckNumber, newAmountStr) {
  const newAmount = Math.round(parseFloat(newAmountStr) * 100);
  if (!newCheckNumber.trim()) return { ok: false, err: 'Enter a check number.' };
  if (isNaN(newAmount) || newAmount <= 0) return { ok: false, err: 'Enter a valid amount.' };
  await runTransaction(db, async tx => {
    const ref  = doc(db, 'sessions', sessionId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Session not found');
    const checks = snap.data().checks.map(c =>
      c.id === checkId
        ? { ...c, checkNumber: newCheckNumber.trim(), amount: newAmount, flagged: false, confirmedBy: null }
        : c
    );
    tx.update(ref, { checks });
  });
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

function buildEmailHtml(data) {
  const ids    = getCounterIds(data);
  const ctrA   = data.counters[ids[0]];
  const ctrB   = data.counters[ids[1]];
  const counts = ctrA.counts || {};
  const checks = data.checks || [];

  const dateLabel = new Date(sessionId + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const C_PRIMARY = '#2d5a8e';
  const C_PRIMARY_LT = '#eef3fa';
  const C_SUCCESS = '#1e7a3c';
  const C_BG = '#f5f5f0';
  const C_BORDER = '#d0cdc5';
  const C_MUTED = '#666666';

  const tableStyle = 'width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:14px;';
  const thStyle    = `background:${C_PRIMARY_LT};color:${C_PRIMARY};font-weight:bold;font-size:12px;padding:6px 10px;text-align:left;border-bottom:2px solid ${C_PRIMARY};`;
  const thRStyle   = `background:${C_PRIMARY_LT};color:${C_PRIMARY};font-weight:bold;font-size:12px;padding:6px 10px;text-align:right;border-bottom:2px solid ${C_PRIMARY};`;
  const tdStyle    = 'padding:6px 10px;border-bottom:1px solid #eae8e3;color:#1a1a1a;';
  const tdRStyle   = 'padding:6px 10px;border-bottom:1px solid #eae8e3;color:#1a1a1a;text-align:right;';
  const tdMuted    = `padding:6px 10px;border-bottom:1px solid #eae8e3;color:${C_MUTED};`;
  const tdMutedR   = `padding:6px 10px;border-bottom:1px solid #eae8e3;color:${C_MUTED};text-align:right;`;
  const subStyle   = `background:${C_PRIMARY_LT};color:${C_PRIMARY};font-weight:bold;padding:7px 10px;border-top:2px solid ${C_PRIMARY};`;
  const subRStyle  = `background:${C_PRIMARY_LT};color:${C_PRIMARY};font-weight:bold;padding:7px 10px;border-top:2px solid ${C_PRIMARY};text-align:right;`;
  const secLabel   = `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:11px;font-weight:bold;text-transform:uppercase;color:${C_MUTED};letter-spacing:0.5px;padding:18px 0 4px;border-bottom:1px solid ${C_BORDER};margin-bottom:0;`;

  function denomRows(denoms) {
    return denoms.map((d, i) => {
      const qty   = counts[d.key] || 0;
      const total = qty * d.valueCents;
      const bg    = i % 2 === 1 ? 'background:#faf9f7;' : '';
      return `<tr style="${bg}">
        <td style="${tdStyle}">${d.label}</td>
        <td style="${qty > 0 ? tdRStyle : tdMutedR}">${qty > 0 ? qty : '—'}</td>
        <td style="${qty > 0 ? tdRStyle : tdMutedR}">${formatCents(total)}</td>
      </tr>`;
    }).join('');
  }

  let billCents = 0;
  DENOMINATIONS.bills.forEach(d => { billCents += (counts[d.key] || 0) * d.valueCents; });
  let coinCents = 0;
  DENOMINATIONS.coins.forEach(d => { coinCents += (counts[d.key] || 0) * d.valueCents; });
  const cashCents  = billCents + coinCents;
  const checkCents = checks.reduce((s, c) => s + c.amount, 0);
  const grandTotal = cashCents + checkCents;

  let checksBody = '';
  if (checks.length === 0) {
    checksBody = `<tr><td colspan="2" style="${tdMuted}">No checks recorded.</td></tr>`;
  } else {
    checksBody = checks.map((c, i) => {
      const bg = i % 2 === 1 ? 'background:#faf9f7;' : '';
      return `<tr style="${bg}">
        <td style="${tdStyle}">#${c.checkNumber}</td>
        <td style="${tdRStyle}">${formatCents(c.amount)}</td>
      </tr>`;
    }).join('');
    checksBody += `<tr>
      <td style="${subStyle}">Checks Subtotal</td>
      <td style="${subRStyle}">${formatCents(checkCents)}</td>
    </tr>`;
  }

  return `
<div style="background:${C_BG};padding:24px;max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">

  <!-- Header -->
  <div style="background:${C_PRIMARY};border-radius:8px 8px 0 0;padding:20px 24px;">
    <div style="font-size:20px;font-weight:bold;color:#ffffff;">Offering Count Sheet</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.8);margin-top:4px;">${dateLabel}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.7);margin-top:2px;">Counted by: ${ctrA.name} &amp; ${ctrB.name}</div>
  </div>

  <!-- Bills -->
  <p style="${secLabel}">Bills</p>
  <table style="${tableStyle}">
    <thead><tr>
      <th style="${thStyle}">Denomination</th>
      <th style="${thRStyle}">Qty</th>
      <th style="${thRStyle}">Total</th>
    </tr></thead>
    <tbody>
      ${denomRows(DENOMINATIONS.bills)}
      <tr>
        <td style="${subStyle}">Bills Subtotal</td>
        <td style="${subRStyle}"></td>
        <td style="${subRStyle}">${formatCents(billCents)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Coins -->
  <p style="${secLabel}">Coins</p>
  <table style="${tableStyle}">
    <thead><tr>
      <th style="${thStyle}">Denomination</th>
      <th style="${thRStyle}">Qty</th>
      <th style="${thRStyle}">Total</th>
    </tr></thead>
    <tbody>
      ${denomRows(DENOMINATIONS.coins)}
      <tr>
        <td style="${subStyle}">Coins Subtotal</td>
        <td style="${subRStyle}"></td>
        <td style="${subRStyle}">${formatCents(coinCents)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Cash total bar -->
  <table style="${tableStyle}margin-top:4px;">
    <tbody><tr>
      <td style="background:${C_PRIMARY};color:#fff;font-weight:bold;font-size:15px;padding:10px 12px;border-radius:0;">Cash Total</td>
      <td style="background:${C_PRIMARY};color:#fff;font-weight:bold;font-size:15px;padding:10px 12px;text-align:right;">${formatCents(cashCents)}</td>
    </tr></tbody>
  </table>

  <!-- Checks -->
  <p style="${secLabel}">Checks</p>
  <table style="${tableStyle}">
    <thead><tr>
      <th style="${thStyle}">Check #</th>
      <th style="${thRStyle}">Amount</th>
    </tr></thead>
    <tbody>${checksBody}</tbody>
  </table>

  <!-- Grand total bar -->
  <table style="${tableStyle}margin-top:4px;">
    <tbody><tr>
      <td style="background:${C_SUCCESS};color:#fff;font-weight:bold;font-size:15px;padding:10px 12px;border-radius:0;">Grand Total</td>
      <td style="background:${C_SUCCESS};color:#fff;font-weight:bold;font-size:15px;padding:10px 12px;text-align:right;">${formatCents(grandTotal)}</td>
    </tr></tbody>
  </table>

  <!-- Footer -->
  <p style="text-align:center;font-size:11px;color:${C_MUTED};margin-top:20px;">Cornerstone Community Church — For internal use only</p>

</div>`;
}

function buildEmailParams(data) {
  const ids  = getCounterIds(data);
  const ctrA = data.counters[ids[0]];

  const dateLabel = new Date(sessionId + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return {
    date:             dateLabel,
    counter_a_name:   ctrA.name,
    to_email:         TREASURER_EMAIL,
    html_content:     buildEmailHtml(data),
  };
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
  console.log('[EmailJS] sending with service:', EMAILJS_SERVICE_ID, 'template:', EMAILJS_TEMPLATE_ID);
  console.log('[EmailJS] params:', params);
  try {
    const response = await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, params);
    console.log('[EmailJS] success:', response);
    await updateDoc(doc(db, 'sessions', sessionId), {
      status: 'submitted',
      submittedAt: serverTimestamp(),
    });
    // The onSnapshot will fire and transition to submitted screen
  } catch (err) {
    console.error('[EmailJS] error status:', err?.status, 'text:', err?.text, 'full:', err);
    const detail = err?.text || err?.message || JSON.stringify(err);
    showErrorIn('compare-error', `Email failed: ${detail}`);
    submitInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const SCREENS = ['screen-profile', 'screen-lobby', 'screen-count', 'screen-compare', 'screen-submitted'];
let activeScreen = null;

function showScreen(id) {
  SCREENS.forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
  if (id !== activeScreen) {
    activeScreen = id;
    if (id === 'screen-compare') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
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
        <input type="text" id="qty-${d.key}" class="qty-input"
               inputmode="numeric" pattern="[0-9]*" placeholder="0">
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
      // Strip any non-digit characters typed in
      el.value = el.value.replace(/[^0-9]/g, '');
      const qty   = parseInt(el.value || '0', 10) || 0;
      const total = qty * d.valueCents;
      const tEl   = document.getElementById(`total-${d.key}`);
      if (tEl) tEl.textContent = formatCents(total);
      updateLocalTotals();
      // Debounce-save to Firestore
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveMyCount(buildCountsFromForm()), 800);
    });
    // Select all on focus so typing immediately replaces the current value
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
  // Keep grand total in sync as cash changes
  const checkEl = document.getElementById('checks-total-count');
  const checkCents = checkEl ? parseCents(checkEl.textContent) : 0;
  setText('count-grand-total', formatCents(billsCents + coinsCents + checkCents));
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

  // Build table on first visit OR when the other device triggered a reset
  const sessionReset = data.resetCount || 0;
  if (!countScreenBuilt || sessionReset > lastSeenReset) {
    lastSeenReset = sessionReset;
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

  // Mismatch highlights on qty inputs — show when I am unlocked and the other counter
  // is still locked (correction phase). Highlight only the quantity box background.
  const otherData    = otherId ? data.counters[otherId] : null;
  // Show mismatch highlights only in correction phase: both counters have
  // locked at least once (lockedOnce flag) and I am currently unlocked to fix.
  // lockedOnce is immune to the debounce auto-save that sets counts != null mid-typing.
  const inCorrection = !isLocked && !!myData?.lockedOnce && !!otherData?.lockedOnce;
  const mismatched   = inCorrection ? new Set(getDenomMismatches(data)) : new Set();
  ALL_DENOMS.forEach(d => {
    const el = document.getElementById(`qty-${d.key}`);
    if (el) el.classList.toggle('mismatch', mismatched.has(d.key));
  });

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
    const isFlagged   = !!c.flagged;
    const canConfirm  = !isMine && !isConfirmed && !isFlagged;
    const canFlag     = !isMine && !isConfirmed && !isFlagged;

    // Enterer sees inline edit form when flagged
    if (isMine && isFlagged) {
      return `
        <div class="check-item flagged" data-id="${escHtml(c.id)}">
          <span class="check-status-tag tag-flagged">⚠ Flagged — please correct</span>
          <div class="check-edit-row">
            <input type="text" class="check-num-field edit-num" value="${escHtml(c.checkNumber)}" maxlength="20" placeholder="Check #">
            <input type="number" class="check-amt-field edit-amt" value="${(c.amount / 100).toFixed(2)}" min="0" step="0.01" placeholder="0.00">
            <button class="btn-secondary btn-sm btn-save-check" data-id="${escHtml(c.id)}">Save</button>
            <button class="btn-remove-check" data-id="${escHtml(c.id)}">Delete</button>
          </div>
        </div>`;
    }

    return `
      <div class="check-item ${isConfirmed ? 'confirmed' : isFlagged ? 'flagged' : ''}" data-id="${escHtml(c.id)}">
        <span class="check-num">#${escHtml(c.checkNumber)}</span>
        <span class="check-amount">${formatCents(c.amount)}</span>
        ${isConfirmed
          ? `<span class="check-status-tag tag-confirmed">✓ Confirmed</span>`
          : isFlagged
            ? `<span class="check-status-tag tag-flagged">⚠ Flagged</span>`
            : isMine
              ? `<span class="check-status-tag tag-pending">Awaiting confirmation</span>`
              : ''}
        ${canConfirm
          ? `<button class="btn-confirm-check" data-id="${escHtml(c.id)}">Confirm</button>`
          : ''}
        ${canFlag
          ? `<button class="btn-flag-check" data-id="${escHtml(c.id)}">Flag as Wrong</button>`
          : ''}
        ${isMine && !isConfirmed && !isFlagged
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

  container.querySelectorAll('.btn-flag-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Flag this check as wrong? The other counter will be asked to correct it.')) return;
      btn.disabled = true;
      try { await flagCheck(btn.dataset.id); }
      catch (e) { btn.disabled = false; console.error(e); }
    });
  });

  container.querySelectorAll('.btn-save-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row    = btn.closest('.check-item');
      const numVal = row.querySelector('.edit-num').value;
      const amtVal = row.querySelector('.edit-amt').value;
      btn.disabled = true;
      const result = await editCheck(btn.dataset.id, numVal, amtVal);
      if (!result.ok) { alert(result.err); btn.disabled = false; }
    });
  });

  container.querySelectorAll('.btn-remove-check').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this check?')) return;
      btn.disabled = true;
      try { await removeCheck(btn.dataset.id); }
      catch (e) { btn.disabled = false; console.error(e); }
    });
  });
}

function updateCheckTotal(checks) {
  const checkCents = checks.reduce((s, c) => s + c.amount, 0);
  setText('checks-total-count', formatCents(checkCents));
  // Grand total = live cash total + checks total
  const cashEl = document.getElementById('cash-total');
  const cashCents = cashEl ? parseCents(cashEl.textContent) : 0;
  setText('count-grand-total', formatCents(cashCents + checkCents));
}

function parseCents(str) {
  // Convert "$1,234.56" back to integer cents
  return Math.round(parseFloat(str.replace(/[$,]/g, '') || '0') * 100);
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

  // Checks — allow confirmation and flagging from compare screen
  const checks    = data.checks || [];
  const checkList = document.getElementById('compare-check-list');
  if (!checks.length) {
    checkList.innerHTML = '<p class="empty-msg">No checks were recorded.</p>';
  } else {
    checkList.innerHTML = checks.map(c => {
      const isConfirmed = !!c.confirmedBy;
      const isFlagged   = !!c.flagged;
      const isMine      = c.addedBy === currentUser.id;
      const canConfirm  = !isMine && !isConfirmed && !isFlagged;
      const canFlag     = !isMine && !isConfirmed && !isFlagged;

      // Enterer sees edit form when their check is flagged
      if (isMine && isFlagged) {
        return `
          <div class="check-item flagged" data-id="${escHtml(c.id)}">
            <span class="check-status-tag tag-flagged">⚠ Flagged — please correct</span>
            <div class="check-edit-row">
              <input type="text" class="check-num-field edit-num" value="${escHtml(c.checkNumber)}" maxlength="20" placeholder="Check #" inputmode="numeric" pattern="[0-9]*">
              <input type="text" class="check-amt-field edit-amt" value="${(c.amount / 100).toFixed(2)}" inputmode="decimal" pattern="[0-9.]*" placeholder="0.00">
              <button class="btn-secondary btn-sm btn-save-check" data-id="${escHtml(c.id)}">Save</button>
              <button class="btn-remove-check" data-id="${escHtml(c.id)}">Delete</button>
            </div>
          </div>`;
      }

      return `
        <div class="check-item ${isConfirmed ? 'confirmed' : isFlagged ? 'flagged' : ''}" data-id="${escHtml(c.id)}">
          <span class="check-num">#${escHtml(c.checkNumber)}</span>
          <span class="check-amount">${formatCents(c.amount)}</span>
          ${isConfirmed
            ? `<span class="check-status-tag tag-confirmed">✓ Confirmed</span>`
            : isFlagged
              ? `<span class="check-status-tag tag-flagged">⚠ Flagged</span>`
              : isMine
                ? `<span class="check-status-tag tag-pending">Awaiting confirmation</span>`
                : ''}
          ${canConfirm ? `<button class="btn-confirm-check" data-id="${escHtml(c.id)}">Confirm</button>` : ''}
          ${canFlag    ? `<button class="btn-flag-check"    data-id="${escHtml(c.id)}">Flag as Wrong</button>` : ''}
        </div>`;
    }).join('');

    checkList.querySelectorAll('.btn-confirm-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await confirmCheck(btn.dataset.id); }
        catch (e) { btn.disabled = false; console.error(e); }
      });
    });

    checkList.querySelectorAll('.btn-flag-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Flag this check as wrong? The other counter will be asked to correct it.')) return;
        btn.disabled = true;
        try { await flagCheck(btn.dataset.id); }
        catch (e) { btn.disabled = false; console.error(e); }
      });
    });

    checkList.querySelectorAll('.btn-save-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row    = btn.closest('.check-item');
        const numVal = row.querySelector('.edit-num').value;
        const amtVal = row.querySelector('.edit-amt').value;
        btn.disabled = true;
        const result = await editCheck(btn.dataset.id, numVal, amtVal);
        if (!result.ok) { alert(result.err); btn.disabled = false; }
      });
    });

    checkList.querySelectorAll('.btn-remove-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this check?')) return;
        btn.disabled = true;
        try { await deleteCheck(btn.dataset.id); }
        catch (e) { btn.disabled = false; console.error(e); }
      });
    });
  }

  const checkCents  = checks.reduce((s, c) => s + c.amount, 0);
  const grandCents  = totalA + checkCents;   // cash matches so either counter works
  setText('compare-checks-total', formatCents(checkCents));
  setText('compare-grand-total',  formatCents(grandCents));

  // Submit / unlock / status
  // canSubmit requires both locked, no mismatches, and all checks confirmed
  const canSubmit = bothLocked(data) && mismatches.length === 0 && allChecksConfirmed(data);
  const myLocked  = data.counters[currentUser.id]?.locked;
  // Show Unlock whenever I'm locked and we can't submit yet
  // (covers: mismatches exist, OR the other counter already unlocked to fix)
  const unlockBtn = document.getElementById('btn-unlock');
  unlockBtn.disabled = false;  // always re-enable on each render — prevents stuck state
  showEl('btn-unlock', myLocked && !canSubmit);
  showEl('btn-submit', canSubmit);
  const statusEl = document.getElementById('submit-status-msg');
  if (canSubmit) {
    statusEl.textContent = '';
  } else if (mismatches.length > 0) {
    statusEl.textContent = 'Resolve all mismatches before submitting.';
  } else if (checks.length > 0 && !allChecksConfirmed(data)) {
    statusEl.textContent = 'All checks must be confirmed before submitting.';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI: SUBMITTED SCREEN
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// COUNT SHEET IMAGE
// ═══════════════════════════════════════════════════════════════════════════════

// Returns a Promise<Blob> of the count sheet PNG
async function generateCountImageBlob(data) {
  const ids    = getCounterIds(data);
  const ctrA   = data.counters[ids[0]];
  const ctrB   = data.counters[ids[1]];
  const countsA = ctrA.counts || {};
  const checks  = data.checks || [];

  // ── Canvas setup ──────────────────────────────────────────────────────────
  const W     = 800;
  const PAD   = 40;
  const COL1  = 200;  // denomination label column width
  const COL2  = 100;  // qty column


  // Estimate height: header + bills + coins + checks + footer
  const ROW_H   = 28;
  const SEC_GAP = 20;
  const BILLS_N = DENOMINATIONS.bills.length;
  const COINS_N = DENOMINATIONS.coins.length;
  const CHK_N   = checks.length || 1;
  const estimatedH = 320 + (BILLS_N + COINS_N + CHK_N) * ROW_H + SEC_GAP * 8 + 120;

  const canvas  = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = estimatedH;
  const ctx     = canvas.getContext('2d');

  // ── Colours / fonts ────────────────────────────────────────────────────────
  const C_BG      = '#f5f5f0';
  const C_PRIMARY = '#2d5a8e';
  const C_PRIMARY_LT = '#eef3fa';
  const C_SUCCESS = '#1e7a3c';
  const C_BORDER  = '#d0cdc5';
  const C_TEXT    = '#1a1a1a';
  const C_MUTED   = '#666';
  const C_WHITE   = '#ffffff';

  const F_TITLE  = `bold 22px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const F_HEAD   = `bold 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const F_BODY   = `14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const F_BOLD   = `bold 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const F_SMALL  = `12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const F_TOTAL  = `bold 16px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

  // ── Helpers ────────────────────────────────────────────────────────────────
  let y = 0;

  function fillRect(x, fy, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, fy, w, h);
  }
  function hLine(fy, x1 = 0, x2 = W, color = C_BORDER) {
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(x1, fy); ctx.lineTo(x2, fy); ctx.stroke();
  }
  function text(str, x, fy, font = F_BODY, color = C_TEXT, align = 'left') {
    ctx.font      = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(str, x, fy);
    ctx.textAlign = 'left';
  }

  function drawDenomTableHeader(fy) {
    fillRect(PAD, fy, W - PAD * 2, 24, C_PRIMARY_LT);
    text('Denomination', PAD + 8,          fy + 16, F_HEAD, C_PRIMARY);
    text('Qty',          PAD + COL1 + 8,   fy + 16, F_HEAD, C_PRIMARY);
    text('Total',        PAD + COL1 + COL2 + 8, fy + 16, F_HEAD, C_PRIMARY);
    hLine(fy + 24, PAD, W - PAD, C_PRIMARY);
    return fy + 24;
  }

  function drawDenomRow(fy, label, qty, totalCents, shade) {
    if (shade) fillRect(PAD, fy, W - PAD * 2, ROW_H, '#faf9f7');
    text(label,             PAD + 8,          fy + 19, F_BODY, C_TEXT);
    text(qty > 0 ? String(qty) : '—', PAD + COL1 + 8, fy + 19, F_BODY, qty > 0 ? C_TEXT : C_MUTED);
    text(formatCents(totalCents), PAD + COL1 + COL2 + 8, fy + 19, F_BODY, qty > 0 ? C_TEXT : C_MUTED);
    hLine(fy + ROW_H, PAD, W - PAD, '#eae8e3');
    return fy + ROW_H;
  }

  function drawSubtotalRow(fy, label, totalCents) {
    fillRect(PAD, fy, W - PAD * 2, ROW_H, C_PRIMARY_LT);
    text(label,              PAD + 8, fy + 19, F_BOLD, C_PRIMARY);
    text(formatCents(totalCents), PAD + COL1 + COL2 + 8, fy + 19, F_BOLD, C_PRIMARY);
    hLine(fy + ROW_H, PAD, W - PAD, C_PRIMARY);
    return fy + ROW_H;
  }

  function drawTotalBar(fy, label, totalCents, color = C_PRIMARY) {
    fillRect(PAD, fy, W - PAD * 2, 36, color);
    text(label,              PAD + 12, fy + 23, F_TOTAL, C_WHITE);
    text(formatCents(totalCents), W - PAD - 12, fy + 23, F_TOTAL, C_WHITE, 'right');
    return fy + 36;
  }

  function sectionTitle(fy, label) {
    text(label.toUpperCase(), PAD, fy + 13, `bold 10px -apple-system, sans-serif`, C_MUTED);
    hLine(fy + 16, PAD, W - PAD, C_BORDER);
    return fy + 22;
  }

  // ── Background ─────────────────────────────────────────────────────────────
  fillRect(0, 0, W, estimatedH, C_BG);

  // ── Header banner ──────────────────────────────────────────────────────────
  fillRect(0, 0, W, 110, C_PRIMARY);

  // Load & draw logo
  const logoImg = await new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'CornerstoneLogo.jpg';
  });

  const LOGO_H = 70;
  const LOGO_W = logoImg ? Math.round(logoImg.width * (LOGO_H / logoImg.height)) : 0;
  if (logoImg) {
    // White rounded bg behind logo
    ctx.save();
    ctx.beginPath();
    const lx = PAD, ly = 20, lr = 8;
    ctx.roundRect(lx, ly, LOGO_W + 16, LOGO_H + 8, lr);
    ctx.fillStyle = C_WHITE;
    ctx.fill();
    ctx.restore();
    ctx.drawImage(logoImg, lx + 8, ly + 4, LOGO_W, LOGO_H);
  }

  const textX = logoImg ? PAD + LOGO_W + 32 : PAD;
  text('Offering Count Sheet', textX, 52, F_TITLE, C_WHITE);
  text(formatDateLabel(sessionId), textX, 74, F_BODY, 'rgba(255,255,255,0.8)');
  text(`Counted by: ${ctrA.name} & ${ctrB.name}`, textX, 96, F_SMALL, 'rgba(255,255,255,0.75)');

  y = 130;

  // ── Bills ──────────────────────────────────────────────────────────────────
  y = sectionTitle(y, 'Bills');
  y = drawDenomTableHeader(y);
  let billCents = 0;
  DENOMINATIONS.bills.forEach((d, i) => {
    const qty   = countsA[d.key] || 0;
    const total = qty * d.valueCents;
    billCents  += total;
    y = drawDenomRow(y, d.label, qty, total, i % 2 === 1);
  });
  y = drawSubtotalRow(y, 'Bills Subtotal', billCents);
  y += SEC_GAP;

  // ── Coins ──────────────────────────────────────────────────────────────────
  y = sectionTitle(y, 'Coins');
  y = drawDenomTableHeader(y);
  let coinCents = 0;
  DENOMINATIONS.coins.forEach((d, i) => {
    const qty   = countsA[d.key] || 0;
    const total = qty * d.valueCents;
    coinCents  += total;
    y = drawDenomRow(y, d.label, qty, total, i % 2 === 1);
  });
  y = drawSubtotalRow(y, 'Coins Subtotal', coinCents);
  y += SEC_GAP / 2;

  // ── Cash total bar ─────────────────────────────────────────────────────────
  y = drawTotalBar(y, 'Cash Total', billCents + coinCents);
  y += SEC_GAP;

  // ── Checks ─────────────────────────────────────────────────────────────────
  y = sectionTitle(y, 'Checks');
  if (checks.length === 0) {
    text('No checks recorded.', PAD + 8, y + 18, F_BODY, C_MUTED);
    y += 30;
  } else {
    // Header
    fillRect(PAD, y, W - PAD * 2, 24, C_PRIMARY_LT);
    text('Check #',  PAD + 8,        y + 16, F_HEAD, C_PRIMARY);
    text('Amount',   W - PAD - 8,    y + 16, F_HEAD, C_PRIMARY, 'right');
    hLine(y + 24, PAD, W - PAD, C_PRIMARY);
    y += 24;
    let checkCents = 0;
    checks.forEach((c, i) => {
      if (i % 2 === 1) fillRect(PAD, y, W - PAD * 2, ROW_H, '#faf9f7');
      text(`#${c.checkNumber}`, PAD + 8,     y + 19, F_BODY, C_TEXT);
      text(formatCents(c.amount), W - PAD - 8, y + 19, F_BODY, C_TEXT, 'right');
      hLine(y + ROW_H, PAD, W - PAD, '#eae8e3');
      checkCents += c.amount;
      y += ROW_H;
    });
    const totalCheckCents = checks.reduce((s, c) => s + c.amount, 0);
    y = drawSubtotalRow(y, 'Checks Subtotal', totalCheckCents);
  }
  y += SEC_GAP / 2;

  // ── Grand total ────────────────────────────────────────────────────────────
  const grandTotal = billCents + coinCents + checks.reduce((s, c) => s + c.amount, 0);
  y = drawTotalBar(y, 'Grand Total', grandTotal, C_SUCCESS);
  y += SEC_GAP;

  // ── Footer ─────────────────────────────────────────────────────────────────
  text('Cornerstone Community Church — For internal use only',
       W / 2, y + 14, F_SMALL, C_MUTED, 'center');
  y += 30;

  // Trim canvas to actual content height
  const finalCanvas = document.createElement('canvas');
  finalCanvas.width  = W;
  finalCanvas.height = y;
  finalCanvas.getContext('2d').drawImage(canvas, 0, 0);

  // Return blob of final canvas
  return new Promise(resolve => finalCanvas.toBlob(resolve, 'image/png'));
}

async function downloadCountImage(data) {
  const blob = await generateCountImageBlob(data);
  const file = new File([blob], `offering-count-${sessionId}.png`, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Offering Count Sheet' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  // Fallback: open in new tab — right-click / long-press to save
  window.open(URL.createObjectURL(blob), '_blank');
}

async function textThomas(data) {
  // Copy Thomas's number synchronously — iOS drops the user-activation flag on the
  // first `await`, so the async clipboard API fails even at the top of the function.
  // execCommand('copy') is synchronous and always fires within the gesture.
  try {
    const ta = document.createElement('textarea');
    ta.value = THOMAS_PHONE;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (_) {}

  const blob = await generateCountImageBlob(data);
  const file = new File([blob], `offering-count-${sessionId}.png`, { type: 'image/png' });

  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return;

  try {
    await navigator.share({
      files: [file],
      title: 'Offering Count Sheet',
    });
  } catch (e) {
    // AbortError = user closed share sheet; ignore
  }
}

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

  // If this device's user was evicted (counters wiped), kick back to name entry
  if (currentUser && !data.counters?.[currentUser.id]) {
    signOut();
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

  // Correction phase: both counters have previously saved counts (both were locked at
  // least once) but one unlocked to fix a mismatch. The still-locked counter stays on
  // the compare screen so they can also unlock if needed.
  // Initial phase (one locked, other hasn't locked yet): fall through to count screen.
  const ids2 = getCounterIds(data);
  const allLockedOnce = ids2.length === 2 &&
    ids2.every(id => !!data.counters[id]?.lockedOnce);
  if (currentUser && data.counters[currentUser.id]?.locked && allLockedOnce) {
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
  // Reuse id/deviceToken on page-refresh rejoin; generate fresh ones on new join.
  const id          = user.id          || crypto.randomUUID();
  const deviceToken = user.deviceToken || crypto.randomUUID();
  currentUser = { id, name: user.name, deviceToken };
  storeCurrentUser(currentUser);
  sessionId   = getTodayId();

  showScreen('screen-lobby');
  setText('lobby-date', formatDateLabel(sessionId));

  try {
    await getOrCreateSession(sessionId);
    const joinResult = await joinSession(sessionId, currentUser);
    if (!joinResult.ok) {
      clearCurrentUser();
      currentUser = null;
      showScreen('screen-profile');
      showErrorIn('entry-error', joinResult.err);
      return;
    }
  } catch (e) {
    console.error('[startSession] Firebase error:', e);
    clearCurrentUser();
    currentUser = null;
    showScreen('screen-profile');
    showErrorIn('entry-error', 'Firebase error: ' + e.message);
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
  lastSeenReset    = 0;
  showScreen('screen-profile');
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


  // Online/offline indicator
  function updateOnlineBanner() {
    document.getElementById('offline-banner').classList.toggle('hidden', navigator.onLine);
  }
  window.addEventListener('online',  updateOnlineBanner);
  window.addEventListener('offline', updateOnlineBanner);
  updateOnlineBanner();

  // Name entry — join session
  const btnJoin = document.getElementById('btn-join');
  document.getElementById('entry-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') btnJoin.click();
  });
  btnJoin.addEventListener('click', async () => {
    const name = document.getElementById('entry-name').value.trim();
    if (!name) { showErrorIn('entry-error', 'Please enter your name.'); return; }
    clearErrorIn('entry-error');
    btnJoin.disabled = true;
    try {
      await startSession({ name });
    } catch (e) {
      console.error('Unhandled error in startSession:', e);
      showErrorIn('entry-error', 'Unexpected error: ' + e.message);
    }
    btnJoin.disabled = false;
  });

  // Start Over buttons
  document.getElementById('btn-signout-lobby').addEventListener('click', signOut);
  document.getElementById('btn-signout-count').addEventListener('click', signOut);

  // Lock button
  document.getElementById('btn-lock').addEventListener('click', async () => {
    clearErrorIn('count-error');
    const btn = document.getElementById('btn-lock');
    btn.disabled = true;
    try {
      await lockMyCount();
    } catch (e) {
      showErrorIn('count-error', 'Could not lock your count. Check connection and try again.');
    }
    btn.disabled = false;
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
      showErrorIn('compare-error', 'Could not unlock. Try again.');
    }
    btn.disabled = false;
  });

  // Submit
  document.getElementById('btn-submit').addEventListener('click', async () => {
    if (!confirm('Submit this offering count? An email will be sent to Thomas.')) return;
    document.getElementById('btn-submit').disabled = true;
    await submitOffering();
    document.getElementById('btn-submit').disabled = false;
  });

  // Reset session (count screen and compare screen share one handler)
  async function handleReset() {
    if (!confirm('Reset the entire count session?\n\nThis will clear ALL entered quantities, checks, and locks for both counters. This cannot be undone.')) return;
    const btn = document.getElementById('btn-reset-count') || document.getElementById('btn-reset-compare');
    if (btn) btn.disabled = true;
    try { await resetSession(); }
    catch (e) {
      showErrorIn('count-error', 'Could not reset the session. Check connection and try again.');
      if (btn) btn.disabled = false;
    }
  }
  document.getElementById('btn-reset-count').addEventListener('click', handleReset);
  document.getElementById('btn-reset-compare').addEventListener('click', handleReset);

  // Clear all counters — evicts everyone including open tabs
  async function handleClear() {
    if (!confirm('Clear all counters?\n\nThis will remove all participants and reset the session completely. Anyone with the page open will be sent back to the name entry screen.')) return;
    try { await clearSession(); }
    catch (e) { alert('Could not clear session. Check connection and try again.'); }
  }
  document.getElementById('btn-clear-profile').addEventListener('click', async () => {
    if (!confirm('Clear all counters?\n\nThis will remove all participants and reset today\'s session completely. Anyone with the page open will be sent back to the name entry screen.')) return;
    try {
      // sessionId may not be set yet — derive it directly
      const sid = getTodayId();
      await setDoc(doc(db, 'sessions', sid), {
        status: 'waiting', submittedAt: null, counters: {}, checks: [], resetCount: 0,
      });
    } catch (e) { alert('Could not clear session. Check connection and try again.'); }
  });
  document.getElementById('btn-clear-lobby').addEventListener('click', handleClear);
  document.getElementById('btn-clear-count').addEventListener('click', handleClear);
  document.getElementById('btn-clear-compare').addEventListener('click', handleClear);

  // Done / sign out from submitted screen
  document.getElementById('btn-done').addEventListener('click', signOut);

  // Download count sheet image
  document.getElementById('btn-download-image').addEventListener('click', () => downloadCountImage(lastSessionData));

  // Text Thomas — only shown on mobile where Web Share with files is supported
  {
    const testBlob = new Blob([''], { type: 'image/png' });
    const testFile = new File([testBlob], 'test.png', { type: 'image/png' });
    if (!navigator.canShare || !navigator.canShare({ files: [testFile] })) {
      const btn = document.getElementById('btn-text-thomas');
      if (btn) btn.style.display = 'none';
    }
  }
  document.getElementById('btn-text-thomas').addEventListener('click', () => textThomas(lastSessionData));

  // Attempt to rejoin an in-progress session (e.g. after accidental page refresh)
  const savedUser = loadCurrentUser();
  if (savedUser) {
    await startSession(savedUser);
  } else {
    showScreen('screen-profile');
  }
});
