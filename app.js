/* ─────────────────────────────────────────
   ...left  ·  app.js
   Supabase-backed savings goals app
───────────────────────────────────────── */

'use strict';

// ─── Supabase setup ───────────────────────────────────────────
let supabase = null;

const SUPABASE_URL_KEY = 'dotleft_supabase_url';
const SUPABASE_KEY_KEY = 'dotleft_supabase_key';

function initSupabase(url, key) {
  supabase = window.supabase.createClient(url, key);
  return supabase;
}

function loadSupabaseConfig() {
  const url = localStorage.getItem(SUPABASE_URL_KEY);
  const key = localStorage.getItem(SUPABASE_KEY_KEY);
  if (url && key) { initSupabase(url, key); return true; }
  return false;
}

// ─── State ────────────────────────────────────────────────────
let currentGoal = null;   // goal object being viewed
let editingGoalId = null; // id when editing
let goals = [];
let selectedEmoji = '🎯';
let activeFilter = 'all';
let currentUser = null;

// ─── Screen navigation ────────────────────────────────────────
const screens = {
  auth:    document.getElementById('screen-auth'),
  home:    document.getElementById('screen-home'),
  goal:    document.getElementById('screen-goal'),
  profile: document.getElementById('screen-profile'),
};

function showScreen(name, slideFromRight = false) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  const el = screens[name];
  if (slideFromRight) {
    el.classList.add('slide-from-right');
    requestAnimationFrame(() => {
      el.classList.add('active');
      setTimeout(() => el.classList.remove('slide-from-right'), 300);
    });
  } else {
    el.classList.add('active');
  }
}

// ─── Toast ────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 250);
  }, 2400);
}

// ─── Format helpers ───────────────────────────────────────────
function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtShort(n) {
  const v = Number(n || 0);
  if (v >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000)    return '$' + (v / 1000).toFixed(1) + 'k';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function daysLeft(d) {
  if (!d) return null;
  const diff = new Date(d + 'T00:00:00') - new Date();
  return Math.ceil(diff / 86400000);
}

// ─── Emoji palette ────────────────────────────────────────────
const EMOJIS = ['🎯','🏠','🚗','✈️','🎒','💻','📱','🎓','💍','🛡️','⛵','🎮','🎸','🏋️','🌍','🐾','🏡','🎁','💊','🍕'];

function buildEmojiGrid() {
  const grid = document.getElementById('emoji-grid');
  grid.innerHTML = '';
  EMOJIS.forEach(e => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-btn' + (e === selectedEmoji ? ' selected' : '');
    btn.textContent = e;
    btn.addEventListener('click', () => {
      selectedEmoji = e;
      document.getElementById('goal-icon-custom').value = '';
      grid.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    grid.appendChild(btn);
  });
}

// ─── Goal CRUD ────────────────────────────────────────────────
async function fetchGoals() {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: true });
  if (error) { console.error(error); return; }
  goals = data || [];
  renderGoals();
  updateSummary();
}

async function createGoal(payload) {
  const { data, error } = await supabase
    .from('goals')
    .insert([{ ...payload, user_id: currentUser.id, saved_amount: 0 }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateGoal(id, payload) {
  const { data, error } = await supabase
    .from('goals')
    .update(payload)
    .eq('id', id)
    .eq('user_id', currentUser.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteGoalById(id) {
  // delete transactions first
  await supabase.from('transactions').delete().eq('goal_id', id);
  const { error } = await supabase.from('goals').delete().eq('id', id).eq('user_id', currentUser.id);
  if (error) throw error;
}

async function addDeposit(goalId, amount) {
  const { data: txn, error: txnErr } = await supabase
    .from('transactions')
    .insert([{ goal_id: goalId, amount, user_id: currentUser.id }])
    .select()
    .single();
  if (txnErr) throw txnErr;

  // update saved_amount on the goal
  const goal = goals.find(g => g.id === goalId);
  const newSaved = Number(goal.saved_amount) + Number(amount);
  const nowDone = newSaved >= Number(goal.target_amount);
  const updated = await updateGoal(goalId, { saved_amount: newSaved, completed: nowDone });
  return { txn, updated };
}

async function fetchTransactions(goalId) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('goal_id', goalId)
    .order('created_at', { ascending: false });
  if (error) return [];
  return data || [];
}

// ─── Render ───────────────────────────────────────────────────
function applyFilter(list) {
  switch (activeFilter) {
    case 'completed':   return list.filter(g => g.completed);
    case 'uncompleted': return list.filter(g => !g.completed);
    case 'easy':        return [...list].sort((a, b) => Number(a.target_amount) - Number(b.target_amount));
    case 'hard':        return [...list].sort((a, b) => Number(b.target_amount) - Number(a.target_amount));
    default:            return list;
  }
}

function renderGoals() {
  const list = document.getElementById('goals-list');
  const empty = document.getElementById('empty-state');
  const filtered = applyFilter(goals);

  // clear old cards (keep empty-state node)
  list.querySelectorAll('.goal-card').forEach(c => c.remove());

  if (filtered.length === 0) {
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  filtered.forEach((g, i) => {
    const card = buildGoalCard(g, i);
    list.appendChild(card);
  });
}

function buildGoalCard(g, idx) {
  const saved  = Number(g.saved_amount || 0);
  const target = Number(g.target_amount || 1);
  const pct    = Math.min(100, Math.round((saved / target) * 100));
  const done   = g.completed;
  const dl     = daysLeft(g.deadline);

  const card = document.createElement('div');
  card.className = 'goal-card';
  card.style.animationDelay = (idx * 40) + 'ms';

  let badgeClass = 'badge-active';
  let badgeText  = dl != null ? (dl > 0 ? dl + 'd left' : 'Overdue') : 'No deadline';
  if (done) { badgeClass = 'badge-done'; badgeText = 'Completed ✓'; }
  else if (dl != null && dl <= 0) { badgeClass = 'badge-overdue'; }

  card.innerHTML = `
    <div class="goal-card-top">
      <div class="goal-card-icon">${g.icon || '🎯'}</div>
      <div class="goal-card-info">
        <div class="goal-card-name">${escHtml(g.name)}</div>
        <div class="goal-card-meta">
          <span>${g.deadline ? 'Due ' + fmtDate(g.deadline) : 'No deadline'}</span>
        </div>
      </div>
      <span class="goal-card-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="goal-progress-row">
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill${done ? ' done' : ''}" style="width:0%"></div>
      </div>
      <span class="progress-pct">${pct}%</span>
    </div>
    <div class="goal-amounts-row">
      <span class="goal-amount-text"><strong>${fmtShort(saved)}</strong> saved</span>
      <span class="goal-amount-text">of <strong>${fmtShort(target)}</strong></span>
    </div>
  `;

  // animate progress bar
  requestAnimationFrame(() => {
    setTimeout(() => {
      const bar = card.querySelector('.progress-bar-fill');
      if (bar) bar.style.width = pct + '%';
    }, 80 + idx * 40);
  });

  card.addEventListener('click', () => openGoalDetail(g));
  return card;
}

function updateSummary() {
  const totalSaved = goals.reduce((s, g) => s + Number(g.saved_amount || 0), 0);
  const completed  = goals.filter(g => g.completed).length;
  document.getElementById('summary-total').textContent = fmtShort(totalSaved);
  document.getElementById('summary-goals').textContent = goals.length;
  document.getElementById('summary-done').textContent  = completed;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Goal detail ──────────────────────────────────────────────
async function openGoalDetail(g) {
  currentGoal = g;
  const saved  = Number(g.saved_amount || 0);
  const target = Number(g.target_amount || 1);
  const pct    = Math.min(100, Math.round((saved / target) * 100));
  const circumference = 2 * Math.PI * 80; // 502.65

  document.getElementById('goal-screen-icon').textContent = g.icon || '🎯';
  document.getElementById('goal-detail-name').textContent = g.name;
  document.getElementById('goal-detail-deadline').textContent = g.deadline
    ? 'Due ' + fmtDate(g.deadline)
    : 'No deadline set';
  document.getElementById('ring-pct').textContent = pct + '%';
  document.getElementById('detail-saved').textContent     = fmt(saved);
  document.getElementById('detail-remaining').textContent = fmt(Math.max(0, target - saved));
  document.getElementById('detail-target').textContent    = fmt(target);
  document.getElementById('deposit-amount').value = '';

  // Set ring color based on completion
  const ringFill = document.getElementById('ring-fill');
  ringFill.style.stroke = g.completed ? 'var(--gold)' : 'var(--accent)';

  showScreen('goal', true);

  // animate ring after transition
  setTimeout(() => {
    const offset = circumference - (pct / 100) * circumference;
    ringFill.style.strokeDashoffset = offset;
  }, 100);

  // load transactions
  await renderTransactions(g.id);
}

async function renderTransactions(goalId) {
  const list = document.getElementById('transactions-list');
  list.innerHTML = '<p class="no-transactions">Loading…</p>';
  const txns = await fetchTransactions(goalId);
  if (txns.length === 0) {
    list.innerHTML = '<p class="no-transactions">No deposits yet.</p>';
    return;
  }
  list.innerHTML = '';
  txns.forEach(t => {
    const item = document.createElement('div');
    item.className = 'transaction-item';
    const d = new Date(t.created_at);
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    item.innerHTML = `
      <span class="transaction-amount">+${fmt(t.amount)}</span>
      <span class="transaction-date">${dateStr}</span>
    `;
    list.appendChild(item);
  });
}

// ─── Modal ────────────────────────────────────────────────────
function openModal(editing = false) {
  const modal = document.getElementById('modal-goal');
  const title = document.getElementById('modal-goal-title');
  const err   = document.getElementById('goal-form-error');
  err.classList.add('hidden');

  buildEmojiGrid();

  if (editing && currentGoal) {
    editingGoalId = currentGoal.id;
    title.textContent = 'Edit goal';
    document.getElementById('goal-name').value     = currentGoal.name;
    document.getElementById('goal-target').value   = currentGoal.target_amount;
    document.getElementById('goal-deadline').value = currentGoal.deadline || '';
    selectedEmoji = currentGoal.icon || '🎯';
    document.getElementById('goal-icon-custom').value = '';
    buildEmojiGrid(); // rebuild with correct selection
  } else {
    editingGoalId = null;
    title.textContent = 'New goal';
    document.getElementById('goal-name').value     = '';
    document.getElementById('goal-target').value   = '';
    document.getElementById('goal-deadline').value = '';
    selectedEmoji = '🎯';
    document.getElementById('goal-icon-custom').value = '';
    buildEmojiGrid();
  }

  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-goal').classList.add('hidden');
}

// ─── Auth ─────────────────────────────────────────────────────
async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  const err   = document.getElementById('auth-error');
  err.classList.add('hidden');

  if (!email || !pass) { err.textContent = 'Please fill in all fields.'; err.classList.remove('hidden'); return; }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
  if (error) { err.textContent = error.message; err.classList.remove('hidden'); return; }
  currentUser = data.user;
  onAuthSuccess();
}

async function handleSignup() {
  const email = document.getElementById('signup-email').value.trim();
  const pass  = document.getElementById('signup-password').value;
  const err   = document.getElementById('signup-error');
  err.classList.add('hidden');

  if (!email || !pass) { err.textContent = 'Please fill in all fields.'; err.classList.remove('hidden'); return; }
  if (pass.length < 6)  { err.textContent = 'Password must be at least 6 characters.'; err.classList.remove('hidden'); return; }

  const { data, error } = await supabase.auth.signUp({ email, password: pass });
  if (error) { err.textContent = error.message; err.classList.remove('hidden'); return; }

  if (data.user && !data.user.identities?.length) {
    err.textContent = 'Email already registered. Please sign in.';
    err.classList.remove('hidden');
    return;
  }

  showToast('Account created! Check your email to confirm.');
}

async function handleSignout() {
  await supabase.auth.signOut();
  currentUser = null;
  goals = [];
  showScreen('auth');
}

async function onAuthSuccess() {
  await fetchGoals();
  showScreen('home');
  const email = currentUser?.email || '';
  document.getElementById('profile-email').textContent = email;
  document.getElementById('profile-avatar').textContent = email.charAt(0).toUpperCase() || '◎';
}

// ─── SVG gradient for ring ────────────────────────────────────
function injectRingGradient() {
  const svg = document.querySelector('.ring-svg');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2D6A4F"/>
      <stop offset="100%" stop-color="#52B788"/>
    </linearGradient>
  `;
  svg.prepend(defs);
}

// ─── Supabase Config flow ─────────────────────────────────────
function showConfigModal() {
  document.getElementById('modal-config').classList.remove('hidden');
}
function hideConfigModal() {
  document.getElementById('modal-config').classList.add('hidden');
}

// ─── Wire events ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  injectRingGradient();

  // Check config
  if (!loadSupabaseConfig()) {
    showConfigModal();
  } else {
    await checkSession();
  }

  // Config save
  document.getElementById('btn-config-save').addEventListener('click', async () => {
    const url = document.getElementById('config-url').value.trim();
    const key = document.getElementById('config-key').value.trim();
    const err = document.getElementById('config-error');
    err.classList.add('hidden');

    if (!url || !key) {
      err.textContent = 'Both fields are required.';
      err.classList.remove('hidden');
      return;
    }
    try {
      initSupabase(url, key);
      // quick test
      const { error } = await supabase.from('goals').select('id').limit(1);
      if (error && error.code !== 'PGRST116') throw error;
      localStorage.setItem(SUPABASE_URL_KEY, url);
      localStorage.setItem(SUPABASE_KEY_KEY, key);
      hideConfigModal();
      await checkSession();
    } catch (e) {
      err.textContent = 'Could not connect. Check your credentials.';
      err.classList.remove('hidden');
    }
  });

  // Auth tabs
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('btn-login').addEventListener('click', handleLogin);
  document.getElementById('btn-signup').addEventListener('click', handleSignup);

  // Add goal
  document.getElementById('btn-add-goal').addEventListener('click', () => openModal(false));

  // Filter chips
  document.getElementById('filter-row').addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderGoals();
  });

  // Back from goal
  document.getElementById('btn-back-home').addEventListener('click', () => {
    showScreen('home');
    fetchGoals(); // refresh
  });

  // Edit goal
  document.getElementById('btn-edit-goal').addEventListener('click', () => openModal(true));

  // Deposit
  document.getElementById('btn-deposit').addEventListener('click', async () => {
    const input = document.getElementById('deposit-amount');
    const amount = parseFloat(input.value);
    if (!amount || amount <= 0) { showToast('Enter a valid amount.'); return; }
    try {
      const { updated } = await addDeposit(currentGoal.id, amount);
      currentGoal = updated;
      // update goal in list
      const idx = goals.findIndex(g => g.id === updated.id);
      if (idx !== -1) goals[idx] = updated;
      input.value = '';
      // refresh detail view
      await openGoalDetail(currentGoal);
      showToast('Deposit added!');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  });

  // Delete goal
  document.getElementById('btn-delete-goal').addEventListener('click', async () => {
    if (!confirm(`Delete "${currentGoal?.name}"? This cannot be undone.`)) return;
    try {
      await deleteGoalById(currentGoal.id);
      goals = goals.filter(g => g.id !== currentGoal.id);
      currentGoal = null;
      showScreen('home');
      renderGoals();
      updateSummary();
      showToast('Goal deleted.');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  });

  // Modal cancel
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-goal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-goal')) closeModal();
  });

  // Modal save
  document.getElementById('btn-modal-save').addEventListener('click', async () => {
    const name     = document.getElementById('goal-name').value.trim();
    const target   = parseFloat(document.getElementById('goal-target').value);
    const deadline = document.getElementById('goal-deadline').value || null;
    const custom   = document.getElementById('goal-icon-custom').value.trim();
    const icon     = custom || selectedEmoji;
    const err      = document.getElementById('goal-form-error');
    err.classList.add('hidden');

    if (!name)         { err.textContent = 'Goal name is required.';       err.classList.remove('hidden'); return; }
    if (!target || target <= 0) { err.textContent = 'Enter a valid target amount.'; err.classList.remove('hidden'); return; }

    const payload = { name, target_amount: target, deadline, icon };

    try {
      if (editingGoalId) {
        const updated = await updateGoal(editingGoalId, payload);
        const idx = goals.findIndex(g => g.id === editingGoalId);
        if (idx !== -1) goals[idx] = updated;
        currentGoal = updated;
        closeModal();
        await openGoalDetail(currentGoal);
        renderGoals();
        updateSummary();
        showToast('Goal updated!');
      } else {
        const created = await createGoal({ ...payload, completed: false });
        goals.push(created);
        closeModal();
        renderGoals();
        updateSummary();
        showToast('Goal created!');
      }
    } catch (e) {
      err.textContent = 'Error: ' + e.message;
      err.classList.remove('hidden');
    }
  });

  // Custom emoji input
  document.getElementById('goal-icon-custom').addEventListener('input', e => {
    if (e.target.value.trim()) {
      document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
    }
  });

  // Profile navigation
  document.getElementById('btn-footer-profile').addEventListener('click', () => showScreen('profile', true));
  document.getElementById('btn-back-from-profile').addEventListener('click', () => showScreen('home'));
  document.getElementById('btn-signout').addEventListener('click', handleSignout);
});

// ─── Session check ────────────────────────────────────────────
async function checkSession() {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  if (data?.session?.user) {
    currentUser = data.session.user;
    await onAuthSuccess();
  } else {
    showScreen('auth');
  }
  // Listen for auth changes
  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session && screens.home.classList.contains('active')) {
      showScreen('auth');
    }
  });
}
