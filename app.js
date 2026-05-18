/* ===========================================================
   YUJINITIME — 타이머 + 시간표 standalone
   =========================================================== */

'use strict';

const STORAGE_KEY = 'yujinitime-v1';
const BACKUP_KEY = 'yujinitime-backups-v1';
const BACKUP_MAX = 24; // rolling 24개 (약 6시간치 — 15분마다 1개)
const VERSION = 1;

// ============= SUPABASE CONFIG =============
// 공개 키 — RLS로 보호되니 노출 OK
const SUPABASE_URL = 'https://mopeirfaxfojkrkswntf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_JzBgsQJr6ZvOtFzZP3YZqA_1FzGXAHW';
const CLOUD_TABLE = 'yujinitime_state';
let supa = null;
let currentSession = null;
let cloudReady = false;
let skipCloud = false;

let viewedDate = null;
let weeklyOffset = 0;

function curDate() { return viewedDate || todayStr(); }
function setViewedDate(d) {
  viewedDate = d;
  if (state && state.meta) {
    state.meta.lastViewedDate = d;
    saveState();
  }
}

// ---------------- DEFAULT STATE ----------------
const DEFAULT_STATE = {
  version: VERSION,
  timerPresets: {
    money: [
      { name: '메일 확인',     color: '#F0DC8C' },
      { name: '발주 견적',     color: '#F5BB7C' },
      { name: '인디자인',      color: '#E58A52' },
      { name: '기타',          color: '#CF4500' },
      { name: '투자공부',      color: '#F5BB7C' },
      { name: '제품 제작',     color: '#E58A52' }
    ],
    promote: [
      { name: '모닝라이팅', color: '#98B5D4' },
      { name: '인스타',    color: '#6485BC' },
      { name: '블로그',    color: '#3860BE' },
      { name: 'SNS',      color: '#98B5D4' },
      { name: '기타',      color: '#6485BC' }
    ],
    life: [
      { name: '기상', color: '#DAE8B8' },
      { name: '식사', color: '#B0CC8A' },
      { name: '휴식', color: '#B5ADA0' },
      { name: '운동', color: '#7A9F65' },
      { name: '독서', color: '#4A7060' },
      { name: '글쓰기', color: '#B0CC8A' },
      { name: '취침', color: '#B5ADA0' },
      { name: '기타', color: '#7A9F65' }
    ]
  },
  // timeBlocks[date] = [{ hour, slot, span, type, label }]
  timeBlocks: {},
  // dailyGoals[date] = "오늘의 목표 텍스트"
  dailyGoals: {},
  timer: {
    running: false,
    startedAt: null,
    accumulated: 0,
    currentLabel: '',
    currentCategory: 'money',
    currentColor: '#CF4500'
  },
  meta: {
    lastViewedDate: null,
    currentPage: 'daily'
  }
};

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// 색 hex → 카테고리
function colorToCategory(hex) {
  if (!hex) return 'money';
  const norm = String(hex).toLowerCase();
  const list = (typeof PASTEL_COLORS !== 'undefined') ? PASTEL_COLORS : [];
  const c = list.find(p => p.hex.toLowerCase() === norm);
  if (!c) return 'money';
  if (c.family === 'warm') return 'money';
  if (c.family === 'blue') return 'promote';
  if (c.family === 'green') return 'life';
  return 'money';
}

function normalizeTimerPresets(presets) {
  if (!presets || typeof presets !== 'object') return null;
  const DEFAULT_COLOR_BY_CAT = { money: '#CF4500', promote: '#3860BE', life: '#4A7060' };
  const out = {};
  ['money', 'promote', 'life'].forEach(cat => {
    out[cat] = (presets[cat] || []).map(p => {
      if (typeof p === 'string') {
        return { name: p, color: DEFAULT_COLOR_BY_CAT[cat] };
      }
      if (p && typeof p === 'object') {
        return { name: p.name || '', color: p.color || DEFAULT_COLOR_BY_CAT[cat] };
      }
      return null;
    }).filter(p => p && p.name);
  });
  return out;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged = Object.assign({}, deepClone(DEFAULT_STATE), parsed);
      merged.timeBlocks = parsed.timeBlocks || {};
      merged.dailyGoals = parsed.dailyGoals || {};
      merged.timer = Object.assign({}, deepClone(DEFAULT_STATE.timer), parsed.timer || {});
      merged.timerPresets = Object.assign({}, deepClone(DEFAULT_STATE.timerPresets), parsed.timerPresets || {});
      merged.timerPresets = normalizeTimerPresets(merged.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
      merged.meta = Object.assign({}, deepClone(DEFAULT_STATE.meta), parsed.meta || {});
      return merged;
    }
  } catch (e) {
    console.warn('Failed to load state:', e);
  }
  return deepClone(DEFAULT_STATE);
}

let lastAutoBackupAt = 0;
function pushAutoBackup(snapshot) {
  try {
    const now = Date.now();
    if (now - lastAutoBackupAt < 15 * 60 * 1000) return; // 15분에 1번
    lastAutoBackupAt = now;
    const raw = localStorage.getItem(BACKUP_KEY);
    let ring = [];
    try { ring = raw ? JSON.parse(raw) : []; } catch (e) { ring = []; }
    if (!Array.isArray(ring)) ring = [];
    ring.unshift({ ts: now, state: snapshot });
    if (ring.length > BACKUP_MAX) ring = ring.slice(0, BACKUP_MAX);
    localStorage.setItem(BACKUP_KEY, JSON.stringify(ring));
  } catch (e) { /* 용량 초과는 무시 — 최신 main save가 더 중요 */ }
}

function getAutoBackups() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    const ring = raw ? JSON.parse(raw) : [];
    return Array.isArray(ring) ? ring : [];
  } catch (e) { return []; }
}

function restoreFromAutoBackup(ts) {
  const ring = getAutoBackups();
  const entry = ring.find(x => x.ts === ts);
  if (!entry) return false;
  state = Object.assign({}, deepClone(DEFAULT_STATE), entry.state);
  state.timerPresets = normalizeTimerPresets(state.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
  saveState();
  renderDaily();
  return true;
}

function saveState() {
  try {
    const snapshot = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, snapshot);
    pushAutoBackup(JSON.parse(snapshot));
  } catch (e) {
    console.warn('Save failed:', e);
  }
  if (cloudReady && currentSession && !skipCloud) cloudSyncDebounced();
}

// ============= SUPABASE AUTH + SYNC =============
async function initCloud() {
  if (!window.supabase) {
    console.warn('Supabase SDK 미로드 — 오프라인 모드');
    return;
  }
  // 사용자가 "이 기기에서만" 골랐는지 확인
  if (localStorage.getItem('yujinitime-skip-cloud') === '1') {
    skipCloud = true;
    return;
  }
  supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'yujinitime-auth' // wealthy-life와 분리
    }
  });
  const { data: { session } } = await supa.auth.getSession();
  currentSession = session;
  cloudReady = true;

  supa.auth.onAuthStateChange(async (event, session) => {
    currentSession = session;
    if (event === 'SIGNED_IN') {
      hideLogin();
      await pullFromCloud();
      renderDaily();
      toast('☁ 클라우드 동기 활성 — 어디서나 같은 데이터');
    } else if (event === 'SIGNED_OUT') {
      showLogin();
    }
  });

  if (!currentSession) {
    showLogin();
  } else {
    await pullFromCloud();
    renderDaily();
  }
}

function showLogin() {
  const ov = document.getElementById('login-overlay');
  if (ov) ov.removeAttribute('hidden');
}
function hideLogin() {
  const ov = document.getElementById('login-overlay');
  if (ov) ov.setAttribute('hidden', '');
}

async function sendMagicLink() {
  const email = document.getElementById('login-email').value.trim();
  const status = document.getElementById('login-status');
  const btn = document.getElementById('login-btn');
  if (!email) {
    status.textContent = '이메일을 입력해줘.';
    status.className = 'login-status error';
    return;
  }
  btn.disabled = true; btn.textContent = '보내는 중...';
  status.className = 'login-status'; status.textContent = '';
  try {
    const { error } = await supa.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin,
        shouldCreateUser: true
      }
    });
    if (error) {
      status.className = 'login-status error';
      status.textContent = `오류: ${error.message}`;
      btn.disabled = false; btn.textContent = '매직 링크 받기 →';
    } else {
      status.innerHTML = `📬 <em>${email}</em>로 매직 링크 보냈어.<br>메일함 (스팸함도) 확인하고 링크 클릭.`;
      btn.disabled = false; btn.textContent = '다시 보내기';
    }
  } catch (e) {
    status.className = 'login-status error';
    status.textContent = `네트워크 오류: ${e.message}`;
    btn.disabled = false; btn.textContent = '매직 링크 받기 →';
  }
}

function skipCloudSync() {
  if (!confirm('로그인 없이 이 기기에서만 쓸까? 회사컴 ↔ 집컴 동기 안 됨.')) return;
  localStorage.setItem('yujinitime-skip-cloud', '1');
  skipCloud = true;
  hideLogin();
}

async function pullFromCloud() {
  if (!supa || !currentSession) return;
  showSyncIndicator('syncing', '동기 중...');
  try {
    const { data, error } = await supa
      .from(CLOUD_TABLE)
      .select('state, updated_at')
      .eq('user_id', currentSession.user.id)
      .maybeSingle();
    if (error) {
      // 테이블이 없으면 안내
      if (String(error.message).toLowerCase().includes('does not exist') ||
          String(error.code) === '42P01' ||
          String(error.message).toLowerCase().includes('schema cache')) {
        showSyncIndicator('error', '⚠ 테이블 없음 — Supabase에서 SQL 실행 필요');
        setTimeout(hideSyncIndicator, 6000);
        return;
      }
      throw error;
    }
    if (data && data.state && Object.keys(data.state).length > 0) {
      state = Object.assign({}, deepClone(DEFAULT_STATE), data.state);
      state.timerPresets = Object.assign({}, deepClone(DEFAULT_STATE.timerPresets), state.timerPresets || {});
      state.timerPresets = normalizeTimerPresets(state.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
      state.timeBlocks = state.timeBlocks || {};
      state.dailyGoals = state.dailyGoals || {};
      state.meta = Object.assign({}, deepClone(DEFAULT_STATE.meta), state.meta || {});
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
      showSyncIndicator('synced', '동기 완료');
    } else {
      // 클라우드 비어있음 — 로컬 데이터 푸시
      await pushToCloud();
      showSyncIndicator('synced', '첫 동기 완료');
    }
  } catch (e) {
    showSyncIndicator('error', '동기 오류 (오프라인 모드)');
  }
  setTimeout(hideSyncIndicator, 2500);
}

let cloudPushTimeout = null;
function cloudSyncDebounced() {
  clearTimeout(cloudPushTimeout);
  cloudPushTimeout = setTimeout(pushToCloud, 1500);
}

async function pushToCloud() {
  if (!supa || !currentSession) return;
  showSyncIndicator('syncing', '저장 중...');
  try {
    const { error } = await supa
      .from(CLOUD_TABLE)
      .upsert({
        user_id: currentSession.user.id,
        state: state,
        updated_at: new Date().toISOString()
      });
    if (error) throw error;
    showSyncIndicator('synced', '클라우드 저장됨');
    setTimeout(hideSyncIndicator, 1500);
  } catch (e) {
    showSyncIndicator('error', '저장 실패 (재시도 중)');
    setTimeout(hideSyncIndicator, 2500);
  }
}

function showSyncIndicator(cls, text) {
  const i = document.getElementById('sync-indicator');
  if (!i) return;
  i.className = 'sync-indicator show ' + cls;
  i.textContent = text;
}
function hideSyncIndicator() {
  const i = document.getElementById('sync-indicator');
  if (i) i.className = 'sync-indicator';
}

async function cloudLogout() {
  if (!supa) return;
  await supa.auth.signOut();
  toast('로그아웃 — 매직링크로 다시 들어와');
}

let state = loadState();

// ---------------- UTILITIES ----------------
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtNavDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dows = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return `${y} · ${m} · ${d} · ${dows[date.getDay()]}`;
}
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function pad(n) { return String(n).padStart(2, '0'); }
function getWeekOfMonth(d) {
  const date = new Date(d);
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Math.floor((date.getDate() + offset - 1) / 7) + 1;
}
function formatHM(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}분`;
}

// ---------------- TOAST ----------------
function toast(message, ms = 2200) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = el('div', 'toast');
  t.innerHTML = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------------- MODAL ----------------
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.removeAttribute('hidden');
  setTimeout(() => {
    const inp = m.querySelector('input, textarea');
    if (inp) inp.focus();
  }, 30);
}
function closeAllModals() {
  $$('.modal-overlay').forEach(m => m.setAttribute('hidden', ''));
}

// ---------------- ROUTER ----------------
function setPage(name) {
  if (typeof clearHourlySelection === 'function') clearHourlySelection();
  $$('.page').forEach(p => {
    if (p.dataset.page === name) p.removeAttribute('hidden');
    else p.setAttribute('hidden', '');
  });
  $$('.tabs a').forEach(a => {
    a.classList.toggle('active', a.dataset.tab === name);
  });
  const r = pageRenderers[name];
  if (r) r();
  state.meta.currentPage = name;
  window.scrollTo({ top: 0 });
}
function getPageFromHash() {
  let h = (window.location.hash || '#daily').replace('#', '');
  h = h.split('?')[0].split('&')[0];
  const valid = ['daily','weekly'];
  return valid.includes(h) ? h : 'daily';
}
function initRouter() {
  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      e.preventDefault();
      setPage(tab.dataset.tab);
      window.location.hash = '#' + tab.dataset.tab;
    }
  });
  setPage(getPageFromHash());
}

// =================================================================
// DAILY PAGE
// =================================================================
function renderDaily() {
  if (!viewedDate) viewedDate = state.meta.lastViewedDate || todayStr();
  renderDailyDateNav();
  renderDailyGoal();
  renderTimerPanel();
  renderTimerPresets();
  renderHourlyTable();
  renderPalette();
}

function renderDailyGoal() {
  const today = curDate();
  const goal = (state.dailyGoals && state.dailyGoals[today]) || '';
  const disp = $('#goal-display');
  const box = $('#goal-edit-box');
  if (!disp || !box) return;
  if (goal) {
    disp.textContent = goal;
    disp.classList.remove('empty');
  } else {
    disp.textContent = '아직 안 적음 — ✎ 눌러서 적기';
    disp.classList.add('empty');
  }
  disp.removeAttribute('hidden');
  box.setAttribute('hidden', '');
}

function openGoalEditor() {
  const today = curDate();
  const goal = (state.dailyGoals && state.dailyGoals[today]) || '';
  const disp = $('#goal-display');
  const box = $('#goal-edit-box');
  const inp = $('#goal-input');
  if (!disp || !box || !inp) return;
  inp.value = goal;
  disp.setAttribute('hidden', '');
  box.removeAttribute('hidden');
  setTimeout(() => inp.focus(), 30);
}

function saveDailyGoal() {
  const today = curDate();
  const inp = $('#goal-input');
  if (!inp) return;
  const v = inp.value.trim();
  if (!state.dailyGoals) state.dailyGoals = {};
  if (v) state.dailyGoals[today] = v;
  else delete state.dailyGoals[today];
  saveState();
  renderDailyGoal();
  toast('<em>목표 저장</em>');
}

function cancelDailyGoal() {
  renderDailyGoal();
}

function renderDailyDateNav() {
  const today = todayStr();
  const cur = curDate();
  const dateObj = new Date(cur);
  const lbl = $('#dn-label');
  if (lbl) lbl.textContent = fmtNavDate(dateObj);
  const nav = document.querySelector('.daily-date-nav');
  if (nav) {
    nav.classList.toggle('past', cur < today);
    nav.classList.toggle('future', cur > today);
  }
  const navDate = $('#nav-date');
  if (navDate) navDate.textContent = fmtNavDate(new Date());
}

function dayOffset(offset) {
  const d = new Date(curDate());
  d.setDate(d.getDate() + offset);
  setViewedDate(fmtDate(d));
  renderDaily();
}
function dayToday() {
  setViewedDate(todayStr());
  renderDaily();
}

// =================================================================
// TIMER PANEL
// =================================================================
let timerInterval = null;

function renderTimerPanel() {
  updateTimerDisplay();
  const labelEl = $('#tp-task-label');
  if (labelEl) labelEl.textContent = state.timer.currentLabel || '대기 중...';
  const catLabels = { money: '💰 돈', promote: '📣 알림', life: '🌱 삶' };
  const catEl = $('#tp-cat-pick');
  if (catEl) {
    catEl.textContent = catLabels[state.timer.currentCategory] || '💰 돈';
    if (state.timer.currentColor) catEl.style.background = state.timer.currentColor + '22';
  }
  const taskInput = $('#tp-task-input');
  if (taskInput && document.activeElement !== taskInput) {
    taskInput.value = state.timer.currentLabel || '';
  }
  renderTimerColorRow();
  const btn = $('#btn-timer-start');
  if (btn) {
    btn.textContent = state.timer.running ? '■ 정지' : '▶ 시작';
    btn.classList.toggle('running', state.timer.running);
  }
  const disp = $('#tp-display');
  if (disp) disp.classList.toggle('running', state.timer.running);
}

function renderTimerColorRow() {
  const row = $('#tp-color-row');
  if (!row) return;
  row.innerHTML = '';
  const currentColor = (state.timer.currentColor || '').toLowerCase();
  let prevFam = null;
  PASTEL_COLORS.forEach(c => {
    if (prevFam && c.family && c.family !== prevFam) {
      row.appendChild(el('span', 'sw-gap'));
    }
    prevFam = c.family;
    const sw = el('span', 'sw');
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.dataset.color = c.hex;
    if (c.family) sw.dataset.family = c.family;
    if (c.hex.toLowerCase() === currentColor) sw.classList.add('selected');
    sw.addEventListener('click', () => {
      state.timer.currentColor = c.hex;
      state.timer.currentCategory = colorToCategory(c.hex);
      saveState();
      renderTimerPanel();
    });
    row.appendChild(sw);
  });
}

function renderTimerPresets() {
  const row = $('#tp-presets-row');
  if (!row) return;
  row.innerHTML = '';
  ['money', 'promote', 'life'].forEach(cat => {
    (state.timerPresets[cat] || []).forEach(p => {
      const name = p && p.name ? p.name : '';
      const color = p && p.color ? p.color : '#B5ADA0';
      if (!name) return;
      const b = el('button', 'tp-preset-btn');
      b.textContent = name;
      b.dataset.cat = cat;
      b.dataset.name = name;
      b.dataset.color = color;
      b.style.color = color;
      b.style.borderColor = color + '55';
      b.addEventListener('click', () => {
        state.timer.currentLabel = name;
        state.timer.currentCategory = colorToCategory(color);
        state.timer.currentColor = color;
        if ($('#tp-task-input')) $('#tp-task-input').value = name;
        saveState();
        renderTimerPanel();
        if (!state.timer.running) startTimer();
      });
      row.appendChild(b);
    });
  });
}

// ---------------- Preset Edit Modal ----------------
function openPresetsModal() {
  const list = $('#preset-edit-list');
  list.innerHTML = '';
  const cats = [
    { id: 'money', name: '💰 돈을 번다' },
    { id: 'promote', name: '📣 나를 알린다' },
    { id: 'life', name: '🌱 삶을 산다' }
  ];
  cats.forEach(c => {
    const sec = el('div', 'preset-cat-section');
    sec.innerHTML = `
      <div class="preset-cat-title">${c.name}</div>
      <div class="preset-cat-list" data-cat="${c.id}"></div>
      <input type="text" placeholder="추가할 항목 → Enter" data-cat-input="${c.id}" />
    `;
    const tagList = sec.querySelector('.preset-cat-list');
    (state.timerPresets[c.id] || []).forEach((p, i) => {
      const name = (typeof p === 'string') ? p : (p && p.name) || '';
      const color = (typeof p === 'object' && p) ? (p.color || '#CF4500') : '#CF4500';
      const tag = el('span', 'preset-tag');
      tag.draggable = true;
      tag.dataset.cat = c.id;
      tag.dataset.idx = i;
      tag.innerHTML = `
        <span class="grip">⋮⋮</span>
        <span class="preset-color-sw" data-action="preset-pick-color" data-cat="${c.id}" data-idx="${i}" style="background:${color}" title="색 변경"></span>
        <span class="preset-name" contenteditable="true" data-cat="${c.id}" data-idx="${i}">${escapeHtml(name)}</span>
        <span class="x" data-cat="${c.id}" data-idx="${i}">×</span>
      `;
      tagList.appendChild(tag);
    });
    // 이름 인라인 편집
    tagList.querySelectorAll('.preset-name').forEach(span => {
      span.addEventListener('blur', () => {
        const cat = span.dataset.cat;
        const idx = Number(span.dataset.idx);
        const v = span.textContent.trim();
        const arr = state.timerPresets[cat];
        if (arr && arr[idx] !== undefined) {
          if (v) {
            if (typeof arr[idx] === 'string') arr[idx] = { name: v, color: '#CF4500' };
            else arr[idx].name = v;
          } else arr.splice(idx, 1);
          saveState();
          renderTimerPresets();
        }
      });
      span.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault(); span.blur();
        }
      });
      span.addEventListener('mousedown', (e) => e.stopPropagation());
      span.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    });
    // 색 swatch 클릭
    tagList.querySelectorAll('.preset-color-sw').forEach(sw => {
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        showPresetColorPicker(sw);
      });
    });
    // 드래그 정렬
    let dragSrc = null;
    tagList.querySelectorAll('.preset-tag').forEach(t => {
      t.addEventListener('dragstart', (e) => {
        dragSrc = { cat: t.dataset.cat, idx: Number(t.dataset.idx) };
        t.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      t.addEventListener('dragend', () => { t.style.opacity = ''; });
      t.addEventListener('dragover', (e) => {
        e.preventDefault();
        t.style.outline = '2px solid var(--signal)';
      });
      t.addEventListener('dragleave', () => { t.style.outline = ''; });
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        t.style.outline = '';
        if (!dragSrc || dragSrc.cat !== c.id) return;
        const targetIdx = Number(t.dataset.idx);
        if (dragSrc.idx === targetIdx) return;
        const arr = state.timerPresets[c.id];
        const moved = arr.splice(dragSrc.idx, 1)[0];
        arr.splice(targetIdx, 0, moved);
        saveState();
        openPresetsModal();
        renderTimerPresets();
      });
    });
    const input = sec.querySelector('input');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        const v = input.value.trim();
        if (!v) return;
        if (!state.timerPresets[c.id]) state.timerPresets[c.id] = [];
        const defaultColor = c.id === 'money' ? '#CF4500' : c.id === 'promote' ? '#3860BE' : '#4A7060';
        state.timerPresets[c.id].push({ name: v, color: defaultColor });
        saveState();
        openPresetsModal();
        renderTimerPresets();
      }
    });
    list.appendChild(sec);
  });
  list.querySelectorAll('.x').forEach(x => {
    x.addEventListener('click', () => {
      const cat = x.dataset.cat;
      const idx = Number(x.dataset.idx);
      state.timerPresets[cat].splice(idx, 1);
      saveState();
      openPresetsModal();
      renderTimerPresets();
    });
  });
  openModal('modal-presets');
}

function showPresetColorPicker(swatchEl) {
  document.querySelectorAll('.preset-color-popup').forEach(p => p.remove());
  const cat = swatchEl.dataset.cat;
  const idx = Number(swatchEl.dataset.idx);
  const popup = el('div', 'preset-color-popup');
  let prevFam = null;
  PASTEL_COLORS.forEach(c => {
    if (prevFam && c.family && c.family !== prevFam) {
      popup.appendChild(el('span', 'sw-gap'));
    }
    prevFam = c.family;
    const sw = el('span', 'sw');
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const arr = state.timerPresets[cat];
      if (!arr || !arr[idx]) return;
      if (typeof arr[idx] === 'string') arr[idx] = { name: arr[idx], color: c.hex };
      else arr[idx].color = c.hex;
      saveState();
      popup.remove();
      openPresetsModal();
      renderTimerPresets();
    });
    popup.appendChild(sw);
  });
  const rect = swatchEl.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.top = (rect.bottom + 4) + 'px';
  popup.style.left = rect.left + 'px';
  popup.style.zIndex = 200;
  document.body.appendChild(popup);
  setTimeout(() => {
    document.addEventListener('click', function dismiss() {
      popup.remove();
      document.removeEventListener('click', dismiss);
    }, { once: true });
  }, 0);
}

function setupTaskInput() {
  const inp = $('#tp-task-input');
  if (!inp) return;
  inp.addEventListener('input', () => {
    state.timer.currentLabel = inp.value;
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (inp.value.trim()) {
        state.timer.currentLabel = inp.value.trim();
        saveState();
        if (!state.timer.running) startTimer();
      }
    }
  });
}

function clearTimer() {
  if (state.timer.running) stopTimer();
  state.timer.currentLabel = '';
  state.timer.accumulated = 0;
  if ($('#tp-task-input')) $('#tp-task-input').value = '';
  saveState();
  renderTimerPanel();
}

function updateTimerDisplay() {
  let elapsed = state.timer.accumulated;
  if (state.timer.running && state.timer.startedAt) {
    elapsed += Date.now() - state.timer.startedAt;
  }
  const totalSec = Math.floor(elapsed / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  const display = $('#tp-display');
  if (display) display.textContent = `${h} : ${m} : ${s}`;
}

function startTimer() {
  if (state.timer.running) {
    stopTimer();
    return;
  }
  state.timer.running = true;
  state.timer.startedAt = Date.now();
  saveState();
  renderTimerPanel();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimerDisplay, 1000);
  toast('<em>타이머 시작</em> — 자동으로 시간표에 기록돼.');
}

function stopTimer() {
  if (!state.timer.running) return;
  const elapsed = Date.now() - state.timer.startedAt;
  state.timer.accumulated += elapsed;
  state.timer.running = false;
  state.timer.startedAt = null;
  attributeTimerToHourly(state.timer.accumulated, state.timer.currentCategory, state.timer.currentLabel, state.timer.currentColor);
  state.timer.accumulated = 0;
  saveState();
  renderTimerPanel();
  renderHourlyTable();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  toast(`<em>${formatHM(elapsed)}</em> 기록됨`);
}

function attributeTimerToHourly(durationMs, category, label, colorHex) {
  const today = todayStr();
  if (!state.timeBlocks[today]) state.timeBlocks[today] = [];
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  const now = new Date();
  const startTime = new Date(now.getTime() - durationMs);
  const roundDown = (d) => {
    const c = new Date(d);
    c.setSeconds(0); c.setMilliseconds(0);
    c.setMinutes(Math.floor(c.getMinutes() / 10) * 10);
    return c;
  };
  const startRounded = roundDown(startTime);
  const startHour = startRounded.getHours();
  const startSlot = Math.floor(startRounded.getMinutes() / 10);
  const totalSlots = Math.max(1, Math.ceil(minutes / 10));
  const blockType = (colorHex && colorHex.startsWith('#')) ? colorHex : category;
  const icon = category === 'money' ? '💰 ' : category === 'promote' ? '📣 ' : '🌱 ';
  const fullLabel = (label || '몰입').startsWith(icon.trim()) ? label : icon + (label || '몰입');

  let remaining = totalSlots;
  let h = startHour;
  let s = startSlot;
  while (remaining > 0) {
    const slotsInThisHour = Math.min(6 - s, remaining);
    state.timeBlocks[today] = state.timeBlocks[today].filter(b => {
      if (b.hour !== h) return true;
      const bStart = b.slot;
      const bEnd = b.slot + (b.span || 1);
      return !(bStart < s + slotsInThisHour && bEnd > s);
    });
    state.timeBlocks[today].push({
      hour: h, slot: s, span: slotsInThisHour, type: blockType, label: fullLabel
    });
    remaining -= slotsInThisHour;
    s = 0;
    h = (h + 1) % 24;
  }
}

// =================================================================
// HOURLY TABLE
// =================================================================
const PASTEL_COLORS = [
  { name: '노랑',     hex: '#F0DC8C', family: 'warm' },
  { name: '연주황',   hex: '#F5BB7C', family: 'warm' },
  { name: '주황',     hex: '#E58A52', family: 'warm' },
  { name: '빨강',     hex: '#CF4500', family: 'warm' },
  { name: '연하늘',   hex: '#CBDEEC', family: 'blue' },
  { name: '하늘',     hex: '#98B5D4', family: 'blue' },
  { name: '진청',     hex: '#6485BC', family: 'blue' },
  { name: '남색',     hex: '#3860BE', family: 'blue' },
  { name: '라임',     hex: '#DAE8B8', family: 'green' },
  { name: '연두',     hex: '#B0CC8A', family: 'green' },
  { name: '풀잎',     hex: '#7A9F65', family: 'green' },
  { name: '진녹',     hex: '#4A7060', family: 'green' },
  { name: '회색',     hex: '#B5ADA0', family: 'gray' }
];

function renderHourlyTable() {
  const grid = $('#tt-grid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.appendChild(el('div', 'hh', ''));
  ['00','10','20','30','40','50'].forEach(t => grid.appendChild(el('div', 'ch', ':' + t)));
  const hours = [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5];
  const today = curDate();
  const blocks = state.timeBlocks[today] || [];

  hours.forEach(hour => {
    grid.appendChild(el('div', 'hr', String(hour).padStart(2, '0')));
    for (let slot = 0; slot < 6; slot++) {
      const cell = el('div', 'cell-c empty');
      cell.dataset.hour = hour;
      cell.dataset.slot = slot;
      const owning = blocks.find(b => b.hour === hour && b.slot <= slot && (b.slot + b.span) > slot);
      if (owning) {
        cell.classList.remove('empty');
        const isFirst = owning.slot === slot;
        if (owning.type === 'money') cell.style.background = 'var(--money)';
        else if (owning.type === 'promote') cell.style.background = 'var(--promote)';
        else if (owning.type === 'life') cell.style.background = 'var(--life)';
        else if (owning.type && owning.type.startsWith('#')) {
          cell.style.background = owning.type;
          cell.style.color = '#4D4030';
        } else {
          cell.style.background = owning.type;
          cell.style.color = 'rgba(255,255,255,0.95)';
        }
        if (isFirst && owning.label) {
          const labelSpan = el('span', 'lbl-overflow');
          labelSpan.textContent = owning.label;
          labelSpan.style.maxWidth = `${(owning.span || 1) * 80 - 8}px`;
          cell.appendChild(labelSpan);
        }
      }
      grid.appendChild(cell);
    }
  });
  setupHourlyDragSelect();
}

let hourlyActiveSelection = null;

function setupHourlyDragSelect() {
  const grid = $('#tt-grid');
  if (!grid) return;
  let dragStart = null;
  let dragging = false;
  let lastEnd = null;
  let didMove = false;

  function cellCoord(cell) {
    return { hour: Number(cell.dataset.hour), slot: Number(cell.dataset.slot) };
  }
  function asMin(c) { return c.hour * 60 + c.slot * 10; }
  function clearPreview() {
    $$('#tt-grid .cell-c').forEach(c => c.classList.remove('drag-preview', 'selected'));
    hourlyActiveSelection = null;
    hideHourlyActionBar();
  }
  function showPreview(start, end, asSelection) {
    $$('#tt-grid .cell-c').forEach(c => c.classList.remove('drag-preview', 'selected'));
    const startMin = Math.min(asMin(start), asMin(end));
    const endMin = Math.max(asMin(start), asMin(end));
    const cls = asSelection ? 'selected' : 'drag-preview';
    $$('#tt-grid .cell-c').forEach(c => {
      const m = asMin(cellCoord(c));
      if (m >= startMin && m <= endMin) c.classList.add(cls);
    });
  }
  grid.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.cell-c');
    if (!cell) return;
    e.preventDefault();
    clearPreview();
    dragStart = cellCoord(cell);
    lastEnd = dragStart;
    dragging = true;
    didMove = false;
    showPreview(dragStart, dragStart);
  });
  grid.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const cell = e.target.closest('.cell-c');
    if (!cell) return;
    const c = cellCoord(cell);
    if (lastEnd && asMin(c) === asMin(lastEnd)) return;
    if (asMin(c) !== asMin(dragStart)) didMove = true;
    lastEnd = c;
    showPreview(dragStart, c);
  });
  function finishDrag() {
    if (!dragging || !dragStart) return;
    dragging = false;
    const startMin = Math.min(asMin(dragStart), asMin(lastEnd));
    const endMin = Math.max(asMin(dragStart), asMin(lastEnd));
    const startHour = Math.floor(startMin / 60);
    const startSlot = (startMin % 60) / 10;
    const endHour = Math.floor(endMin / 60);
    const endSlot = (endMin % 60) / 10;
    if (!didMove) {
      setTimeout(clearPreview, 100);
      openHourlyModal(startHour, startSlot, endHour, endSlot);
    } else {
      hourlyActiveSelection = { startHour, startSlot, endHour, endSlot };
      showPreview({ hour: startHour, slot: startSlot }, { hour: endHour, slot: endSlot }, true);
      showHourlyActionBar();
    }
    dragStart = null;
    lastEnd = null;
  }
  grid.addEventListener('mouseup', finishDrag);
  grid.addEventListener('mouseleave', () => {
    if (dragging) {
      dragging = false;
      if (didMove && dragStart && lastEnd) {
        finishDrag();
      } else {
        clearPreview();
      }
    }
  });
}

function showHourlyActionBar() {
  let bar = document.getElementById('hourly-action-bar');
  if (!bar) {
    bar = el('div', 'hourly-action-bar');
    bar.id = 'hourly-action-bar';
    bar.innerHTML = `
      <span class="hab-hint">${countSelectedCells()}칸 선택됨 — <kbd>Enter</kbd> 채우기 · <kbd>Backspace</kbd> 지우기 · <kbd>Esc</kbd> 취소</span>
      <button class="hab-fill" data-action="hourly-fill-selection">채우기</button>
      <button class="hab-erase" data-action="hourly-erase-selection">지우기</button>
      <button class="hab-clear" data-action="hourly-clear-selection">취소</button>
    `;
    const grid = $('#tt-grid');
    grid?.parentNode?.insertBefore(bar, grid);
  } else {
    bar.querySelector('.hab-hint').innerHTML = `${countSelectedCells()}칸 선택됨 — <kbd>Enter</kbd> 채우기 · <kbd>Backspace</kbd> 지우기 · <kbd>Esc</kbd> 취소`;
  }
  bar.classList.add('show');
}
function hideHourlyActionBar() {
  const bar = document.getElementById('hourly-action-bar');
  if (bar) bar.classList.remove('show');
}
function countSelectedCells() {
  if (!hourlyActiveSelection) return 0;
  const { startHour, startSlot, endHour, endSlot } = hourlyActiveSelection;
  return (endHour * 6 + endSlot) - (startHour * 6 + startSlot) + 1;
}
function fillHourlySelection() {
  if (!hourlyActiveSelection) return;
  const { startHour, startSlot, endHour, endSlot } = hourlyActiveSelection;
  openHourlyModal(startHour, startSlot, endHour, endSlot);
}
function eraseHourlySelection() {
  if (!hourlyActiveSelection) return;
  const n = countSelectedCells();
  if (!confirm(`선택한 ${n}칸 (${(n * 10)}분) 을 모두 지울까요?`)) return;
  const { startHour, startSlot, endHour, endSlot } = hourlyActiveSelection;
  const date = curDate();
  if (!state.timeBlocks[date]) state.timeBlocks[date] = [];
  const startMin = startHour * 60 + startSlot * 10;
  const endMin = endHour * 60 + endSlot * 10 + 10;
  const newBlocks = [];
  state.timeBlocks[date].forEach(b => {
    const bStart = b.hour * 60 + b.slot * 10;
    const bEnd = bStart + (b.span || 1) * 10;
    if (bEnd <= startMin || bStart >= endMin) {
      newBlocks.push(b);
      return;
    }
    if (bStart < startMin) {
      const cutSpan = Math.floor((startMin - bStart) / 10);
      if (cutSpan > 0) newBlocks.push(Object.assign({}, b, { span: cutSpan }));
    }
    if (bEnd > endMin) {
      const newStart = endMin;
      const nh = Math.floor(newStart / 60);
      const ns = (newStart % 60) / 10;
      const newSpan = Math.floor((bEnd - endMin) / 10);
      if (newSpan > 0) newBlocks.push(Object.assign({}, b, { hour: nh, slot: ns, span: newSpan }));
    }
  });
  state.timeBlocks[date] = newBlocks;
  saveState();
  renderHourlyTable();
  clearHourlySelection();
  toast(`<em>${n}칸 지움.</em>`);
}
function clearHourlySelection() {
  hourlyActiveSelection = null;
  $$('#tt-grid .cell-c').forEach(c => c.classList.remove('selected', 'drag-preview'));
  hideHourlyActionBar();
}

document.addEventListener('keydown', (e) => {
  if (!hourlyActiveSelection) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.getAttribute('contenteditable') === 'true')) return;
  if (document.querySelector('.modal-overlay:not([hidden])')) return;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    eraseHourlySelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    fillHourlySelection();
  } else if (e.key === 'Escape') {
    clearHourlySelection();
  }
});

function renderPalette() {
  const row = $('#palette-row');
  if (!row) return;
  row.innerHTML = '';
  let prevFam = null;
  PASTEL_COLORS.forEach(c => {
    if (prevFam && c.family && c.family !== prevFam) {
      row.appendChild(el('span', 'sw-gap'));
    }
    prevFam = c.family;
    const sw = el('span', 'sw');
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.dataset.color = c.hex;
    sw.dataset.name = c.name;
    if (c.family) sw.dataset.family = c.family;
    row.appendChild(sw);
  });
}

let hourlyPickContext = null;
function openHourlyModal(startHour, startSlot, endHour, endSlot) {
  if (endHour == null) { endHour = startHour; endSlot = startSlot; }
  hourlyPickContext = { startHour, startSlot, endHour, endSlot };
  const today = curDate();
  const blocks = state.timeBlocks[today] || [];
  const owning = blocks.find(b => b.hour === startHour && b.slot <= startSlot && (b.slot + b.span) > startSlot);
  $('#modal-hourly-title').textContent = `${pad(startHour)}:${pad(startSlot * 10)} — ${pad(endHour)}:${pad((endSlot + 1) * 10 % 60)}${(endSlot+1>=6) ? ' (' + pad((endHour+1)%24) + ':00)' : ''}`;
  $('#modal-hourly-start').value = `${pad(startHour)}:${pad(startSlot * 10)}`;
  const endTotalMin = endHour * 60 + (endSlot + 1) * 10;
  const endHr = Math.floor(endTotalMin / 60) % 24;
  const endMn = endTotalMin % 60;
  $('#modal-hourly-end').value = `${pad(endHr)}:${pad(endMn)}`;
  $('#modal-hourly-label').value = owning ? (owning.label || '') : '';

  const presetRow = $('#modal-hourly-presets');
  if (presetRow) {
    presetRow.innerHTML = '';
    ['money', 'promote', 'life'].forEach(cat => {
      (state.timerPresets[cat] || []).forEach(p => {
        if (!p || !p.name) return;
        const b = el('button', 'modal-preset-chip');
        b.textContent = p.name;
        b.dataset.color = p.color || '#CF4500';
        b.style.color = p.color;
        b.style.borderColor = (p.color || '#CCC') + '66';
        b.addEventListener('click', () => {
          $('#modal-hourly-label').value = p.name;
          $$('#modal-hourly-pastel .sw').forEach(s => {
            s.classList.toggle('selected', s.dataset.color && s.dataset.color.toLowerCase() === (p.color || '').toLowerCase());
          });
          $$('#modal-hourly-presets .modal-preset-chip').forEach(c => c.classList.remove('active'));
          b.classList.add('active');
        });
        presetRow.appendChild(b);
      });
    });
  }

  const pastel = $('#modal-hourly-pastel');
  pastel.innerHTML = '';
  let prevFam = null;
  PASTEL_COLORS.forEach(c => {
    if (prevFam && c.family && c.family !== prevFam) {
      pastel.appendChild(el('span', 'sw-gap'));
    }
    prevFam = c.family;
    const sw = el('span', 'sw');
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.dataset.color = c.hex;
    if (c.family) sw.dataset.family = c.family;
    if (owning && owning.type && owning.type.toLowerCase() === c.hex.toLowerCase()) sw.classList.add('selected');
    sw.addEventListener('click', () => {
      $$('#modal-hourly-pastel .sw').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      $$('#modal-hourly-presets .modal-preset-chip').forEach(c => c.classList.remove('active'));
    });
    pastel.appendChild(sw);
  });
  openModal('modal-hourly');
}

function saveHourlyCell() {
  if (!hourlyPickContext) return;
  const presetActive = $('#modal-hourly-presets .modal-preset-chip.active');
  const pastelSel = $('#modal-hourly-pastel .sw.selected');
  let color;
  if (presetActive) color = presetActive.dataset.color;
  else if (pastelSel) color = pastelSel.dataset.color;
  else { toast('자주 하는 일 또는 색을 골라줘.'); return; }
  const label = $('#modal-hourly-label').value.trim();
  const startStr = $('#modal-hourly-start').value || '00:00';
  const endStr = $('#modal-hourly-end').value || '00:00';
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  let startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  startMin = Math.floor(startMin / 10) * 10;
  endMin = Math.ceil(endMin / 10) * 10;
  if (endMin <= startMin) endMin = startMin + 10;
  const totalSlots = (endMin - startMin) / 10;
  const startHour = Math.floor(startMin / 60);
  const startSlot = (startMin % 60) / 10;
  const today = curDate();
  if (!state.timeBlocks[today]) state.timeBlocks[today] = [];
  let remaining = totalSlots;
  let h = startHour;
  let s = startSlot;
  while (remaining > 0) {
    const slotsInThisHour = Math.min(6 - s, remaining);
    state.timeBlocks[today] = state.timeBlocks[today].filter(b => {
      if (b.hour !== h) return true;
      const bStart = b.slot;
      const bEnd = b.slot + (b.span || 1);
      return !(bStart < s + slotsInThisHour && bEnd > s);
    });
    state.timeBlocks[today].push({
      hour: h, slot: s, span: slotsInThisHour, type: color, label, custom: true
    });
    remaining -= slotsInThisHour;
    s = 0;
    h = (h + 1) % 24;
  }
  saveState();
  closeAllModals();
  renderHourlyTable();
  hourlyPickContext = null;
  clearHourlySelection();
}

function eraseHourlyCell() {
  if (!hourlyPickContext) return;
  const { startHour, startSlot, endHour, endSlot } = hourlyPickContext;
  const today = curDate();
  if (!state.timeBlocks[today]) state.timeBlocks[today] = [];
  const startMin = startHour * 60 + startSlot * 10;
  const endMin = endHour * 60 + (endSlot + 1) * 10;
  state.timeBlocks[today] = state.timeBlocks[today].filter(b => {
    const bStart = b.hour * 60 + b.slot * 10;
    const bEnd = bStart + (b.span || 1) * 10;
    return !(bStart < endMin && bEnd > startMin);
  });
  saveState();
  closeAllModals();
  renderHourlyTable();
  hourlyPickContext = null;
  clearHourlySelection();
}

// =================================================================
// WEEKLY PAGE — 7일 시간표
// =================================================================
function renderWeekly() {
  const today = new Date();
  const monday = getMonday(addDays(today, weeklyOffset * 7));
  const sunday = addDays(monday, 6);
  const range = `${monday.getMonth()+1}월 ${getWeekOfMonth(monday)}주차 · ${pad(monday.getMonth()+1)}.${pad(monday.getDate())} — ${pad(sunday.getMonth()+1)}.${pad(sunday.getDate())}`;
  $('#weekly-range').textContent = range;
  renderWeeklyHourly(monday);
}

function renderWeeklyHourly(monday) {
  const cont = $('#weekly-hourly');
  if (!cont) return;
  cont.innerHTML = `<div class="wh-title">7-DAY HOURLY · 일주일치 시간 한눈에</div>`;
  const table = el('div', 'wh-table');
  const dows = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
  table.appendChild(el('div', 'wh-corner', ''));
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const dateStr = fmtDate(date);
    const isToday = dateStr === todayStr();
    const head = el('div', 'wh-day-head' + (isToday ? ' today' : ''));
    const goal = (state.dailyGoals && state.dailyGoals[dateStr]) || '';
    const goalHtml = goal
      ? `<span class="dgoal">${escapeHtml(goal)}</span>`
      : `<span class="dgoal empty">목표 없음</span>`;
    head.innerHTML = `${dows[i]}<span class="dn">${date.getDate()}</span>${goalHtml}`;
    table.appendChild(head);
  }
  const hours = [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5];
  hours.forEach(hour => {
    table.appendChild(el('div', 'wh-hr', String(hour).padStart(2, '0')));
    for (let i = 0; i < 7; i++) {
      const date = addDays(monday, i);
      const dateStr = fmtDate(date);
      const blocks = state.timeBlocks[dateStr] || [];
      const hourBlocks = blocks.filter(b => b.hour === hour);
      let dominantType = 'empty';
      let label = '';
      let totalSlots = 0;
      let typeCounts = {};
      hourBlocks.forEach(b => {
        const cnt = (b.span || 1);
        typeCounts[b.type] = (typeCounts[b.type] || 0) + cnt;
        totalSlots += cnt;
        if (!label && b.label) label = b.label;
      });
      let max = 0;
      Object.entries(typeCounts).forEach(([t, c]) => {
        if (c > max) { max = c; dominantType = t; }
      });
      const cell = el('div', 'wh-cell');
      if (totalSlots > 0) {
        if (dominantType === 'money') cell.classList.add('money');
        else if (dominantType === 'promote') cell.classList.add('promote');
        else if (dominantType === 'life') cell.classList.add('life');
        else if (dominantType && dominantType.startsWith('#')) {
          cell.style.background = dominantType;
          cell.style.color = '#4D4030';
        }
        cell.style.opacity = Math.min(1, 0.55 + (totalSlots / 6) * 0.45);
        if (label) {
          cell.textContent = label.length > 14 ? label.slice(0, 13) + '…' : label;
          cell.title = label;
        }
      } else {
        cell.classList.add('empty');
      }
      table.appendChild(cell);
    }
  });
  cont.appendChild(table);

  const legend = el('div', 'tt-legend');
  legend.style.marginTop = '12px';
  legend.innerHTML = `
    <div class="lg"><span class="sw-mini" style="background:var(--money)"></span>돈</div>
    <div class="lg"><span class="sw-mini" style="background:var(--promote)"></span>알림</div>
    <div class="lg"><span class="sw-mini" style="background:var(--life)"></span>삶</div>
    <div class="lg" style="opacity:0.6">투명도 = 그 시간대 채워진 비율</div>
  `;
  cont.appendChild(legend);
}

// =================================================================
// EXPORT / IMPORT
// =================================================================
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `yujinitime-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('<em>백업 다운로드 완료</em>');
}
function importData() {
  $('#import-file').click();
}
function openBackupsModal() {
  const list = $('#backup-list');
  const ring = getAutoBackups();
  list.innerHTML = '';
  if (ring.length === 0) {
    list.innerHTML = `<div class="backup-empty">아직 자동 백업 없음. 시간표를 채우면 15분마다 자동 저장돼.</div>`;
  } else {
    ring.forEach(entry => {
      const d = new Date(entry.ts);
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const mins = Math.floor((Date.now() - entry.ts) / 60000);
      const ago = mins < 60 ? `${mins}분 전` : mins < 1440 ? `${Math.floor(mins/60)}시간 전` : `${Math.floor(mins/1440)}일 전`;
      const days = Object.keys(entry.state?.timeBlocks || {}).length;
      const row = el('div', 'backup-row');
      row.innerHTML = `
        <div class="bk-meta">
          <span class="bk-time">${dateStr}</span>
          <span class="bk-sub">${ago} · 시간표 ${days}일치</span>
        </div>
        <button data-ts="${entry.ts}">복원</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        if (!confirm(`${dateStr} 시점으로 되돌릴까? 현재 데이터는 사라져.`)) return;
        if (restoreFromAutoBackup(entry.ts)) {
          closeAllModals();
          toast('<em>복원 완료</em>');
        } else {
          toast('복원 실패');
        }
      });
      list.appendChild(row);
    });
  }
  openModal('modal-backups');
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed || typeof parsed !== 'object') throw new Error('잘못된 형식');
      if (!confirm('현재 데이터를 덮어쓸까요? (취소하면 기존 데이터 유지)')) return;
      state = Object.assign({}, deepClone(DEFAULT_STATE), parsed);
      state.timerPresets = normalizeTimerPresets(state.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
      saveState();
      renderDaily();
      toast('<em>복원 완료</em>');
    } catch (err) {
      toast('복원 실패 — JSON 파일 확인해줘');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// =================================================================
// PAGE RENDERERS + EVENTS
// =================================================================
const pageRenderers = {
  daily: renderDaily,
  weekly: renderWeekly
};

function setupEventDelegation() {
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    switch (action) {
      case 'timer-start': startTimer(); break;
      case 'timer-clear': clearTimer(); break;
      case 'edit-presets': openPresetsModal(); break;
      case 'modal-close': closeAllModals(); hourlyPickContext = null; clearHourlySelection(); break;
      case 'save-hourly': saveHourlyCell(); break;
      case 'erase-hourly': eraseHourlyCell(); break;
      case 'hourly-fill-selection': fillHourlySelection(); break;
      case 'hourly-erase-selection': eraseHourlySelection(); break;
      case 'hourly-clear-selection': clearHourlySelection(); break;
      case 'day-prev': dayOffset(-1); break;
      case 'day-next': dayOffset(1); break;
      case 'day-today': dayToday(); break;
      case 'week-prev': weeklyOffset--; renderWeekly(); break;
      case 'week-next': weeklyOffset++; renderWeekly(); break;
      case 'week-today': weeklyOffset = 0; renderWeekly(); break;
      case 'export-data': exportData(); break;
      case 'import-data': importData(); break;
      case 'auto-backups': openBackupsModal(); break;
      case 'edit-goal': openGoalEditor(); break;
      case 'save-goal': saveDailyGoal(); break;
      case 'cancel-goal': cancelDailyGoal(); break;
      case 'skip-login': skipCloudSync(); break;
    }
  });

  // Modal overlay click outside = close
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', e => {
      if (e.target === ov) {
        closeAllModals();
        hourlyPickContext = null;
        clearHourlySelection();
      }
    });
  });

  // Esc closes modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.querySelector('.modal-overlay:not([hidden])')) {
      closeAllModals();
      hourlyPickContext = null;
    }
  });

  // Import file change
  const imp = $('#import-file');
  if (imp) imp.addEventListener('change', handleImportFile);

  // Goal: display 클릭 시 편집 모드
  const disp = $('#goal-display');
  if (disp) disp.addEventListener('click', () => openGoalEditor());
  // ⌘/Ctrl+Enter 로 저장
  const goalInp = $('#goal-input');
  if (goalInp) goalInp.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      saveDailyGoal();
    }
  });

  // 로그인 폼
  const lf = document.getElementById('login-form');
  if (lf) lf.addEventListener('submit', e => { e.preventDefault(); sendMagicLink(); });
}

// =================================================================
// INIT
// =================================================================
function init() {
  setupEventDelegation();
  setupTaskInput();
  initRouter();
  // Resume timer interval if running
  if (state.timer.running && state.timer.startedAt) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerDisplay, 1000);
  }
  // Cloud sync 시작 (Supabase SDK 로드 후)
  initCloud().catch(e => console.warn('cloud init failed:', e));
}

document.addEventListener('DOMContentLoaded', init);
