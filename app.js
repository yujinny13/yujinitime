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
    ],
    friends: [
      { name: '친구', color: '#F0A6BD' },
      { name: '가족', color: '#E472A0' },
      { name: '데이트', color: '#C13B6F' }
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
  if (c.family === 'pink') return 'friends';
  return 'money';
}

function normalizeTimerPresets(presets) {
  if (!presets || typeof presets !== 'object') return null;
  const DEFAULT_COLOR_BY_CAT = { money: '#CF4500', promote: '#3860BE', life: '#4A7060', friends: '#E472A0' };
  const out = {};
  ['money', 'promote', 'life', 'friends'].forEach(cat => {
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

// ============= UNDO STACK =============
const UNDO_MAX = 30;
let undoStack = [];
let isApplyingUndo = false;

function pushUndo(label) {
  if (isApplyingUndo) return;
  try {
    undoStack.push({ state: JSON.parse(JSON.stringify(state)), label: label || '편집', ts: Date.now() });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  } catch (e) {}
}

function undo() {
  if (undoStack.length === 0) {
    toast('되돌릴 게 없어');
    return;
  }
  const prev = undoStack.pop();
  isApplyingUndo = true;
  state = Object.assign({}, deepClone(DEFAULT_STATE), prev.state);
  state.timerPresets = normalizeTimerPresets(state.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
  saveState();
  isApplyingUndo = false;
  renderCurrentPage();
  toast(`↶ <em>${prev.label}</em> 되돌림`);
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
  // 클라우드 pull 완료 전엔 절대 push 안 함 (race condition 방지)
  if (cloudReady && currentSession && !skipCloud && cloudPullDone) cloudSyncDebounced();
}

// ============= SUPABASE AUTH + SYNC =============
async function initCloud() {
  // Nav UI 항상 업데이트
  updateNavCloudUI();

  if (!window.supabase) {
    console.warn('Supabase SDK 미로드 — 오프라인 모드');
    setCloudStatus('local', '로컬 모드');
    return;
  }
  // "이 기기에서만" 골랐는지 확인 — skip이어도 supa는 만들어둠 (나중에 풀고 로그인 가능하게)
  const isSkipping = localStorage.getItem('yujinitime-skip-cloud') === '1';
  supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'yujinitime-auth'
    }
  });
  if (isSkipping) {
    skipCloud = true;
    updateNavCloudUI();
    return;
  }

  const { data: { session } } = await supa.auth.getSession();
  currentSession = session;
  cloudReady = true;

  supa.auth.onAuthStateChange(async (event, session) => {
    currentSession = session;
    updateNavCloudUI();
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
  updateNavCloudUI();
}

function updateNavCloudUI() {
  const loginBtn = document.getElementById('cloud-login-btn');
  const statusBtn = document.getElementById('cloud-status-btn');
  if (!loginBtn || !statusBtn) return;
  // skip 모드 or 로그인 안 됨 → 로그인 버튼 보이기
  if (skipCloud || (!currentSession && cloudReady)) {
    loginBtn.removeAttribute('hidden');
    statusBtn.setAttribute('hidden', '');
  } else if (currentSession) {
    loginBtn.setAttribute('hidden', '');
    statusBtn.removeAttribute('hidden');
    // 마지막 동기 시각
    const ts = lastSyncAt ? formatTimeAgo(lastSyncAt) : '대기';
    statusBtn.textContent = '☁ ' + ts;
  } else {
    loginBtn.setAttribute('hidden', '');
    statusBtn.setAttribute('hidden', '');
  }
}

function setCloudStatus(cls, text) {
  const statusBtn = document.getElementById('cloud-status-btn');
  if (statusBtn) {
    statusBtn.className = 'tab-tool cloud-status-btn ' + cls;
    if (text) {
      statusBtn.textContent = '☁ ' + text;
      statusBtn.removeAttribute('hidden');
    }
  }
}

function formatTimeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + '분 전';
  const h = Math.floor(min / 60);
  if (h < 24) return h + '시간 전';
  return Math.floor(h / 24) + '일 전';
}

let lastSyncAt = null;

function openCloudLogin() {
  // skip 모드 해제하고 로그인 화면 보여주기
  localStorage.removeItem('yujinitime-skip-cloud');
  skipCloud = false;
  if (!supa) {
    // Supabase 초기화 안 됐으면 페이지 리로드
    location.reload();
    return;
  }
  cloudReady = true;
  showLogin();
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

// 편집 잠금 — 클라우드 pull 완료 전 push 막기
let cloudPullDone = false;

async function pullFromCloud() {
  if (!supa || !currentSession) return;
  cloudPullDone = false;
  showSyncIndicator('syncing', '동기 중...');
  setCloudStatus('syncing', '동기 중');
  try {
    const { data, error } = await supa
      .from(CLOUD_TABLE)
      .select('state, updated_at')
      .eq('user_id', currentSession.user.id)
      .maybeSingle();
    if (error) {
      if (String(error.message).toLowerCase().includes('does not exist') ||
          String(error.code) === '42P01' ||
          String(error.message).toLowerCase().includes('schema cache')) {
        showSyncIndicator('error', '⚠ 테이블 없음 — Supabase에서 SQL 실행 필요');
        setCloudStatus('error', '테이블 없음');
        setTimeout(hideSyncIndicator, 6000);
        return;
      }
      throw error;
    }
    if (data && data.state && Object.keys(data.state).length > 0) {
      // 클라우드 데이터 있음 → 무조건 클라우드 우선 (로컬 덮어쓰기)
      state = Object.assign({}, deepClone(DEFAULT_STATE), data.state);
      state.timerPresets = Object.assign({}, deepClone(DEFAULT_STATE.timerPresets), state.timerPresets || {});
      state.timerPresets = normalizeTimerPresets(state.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
      state.timeBlocks = state.timeBlocks || {};
      state.dailyGoals = state.dailyGoals || {};
      state.meta = Object.assign({}, deepClone(DEFAULT_STATE.meta), state.meta || {});
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
      lastSyncAt = Date.now();
      showSyncIndicator('synced', '동기 완료');
      setCloudStatus('synced', formatTimeAgo(lastSyncAt));
    } else {
      // 클라우드 비어있음 — 자동 push 안 함 (사용자 confirm 받음)
      const hasLocal = Object.keys(state.timeBlocks || {}).length > 0 || Object.keys(state.dailyGoals || {}).length > 0;
      if (hasLocal) {
        const ok = confirm('☁ 클라우드가 비어있어. 이 기기의 로컬 데이터를 클라우드에 올릴까?\n\n(취소 누르면 클라우드는 비어있고 이 기기 데이터로만 작업 — 위험)');
        if (ok) {
          await pushToCloud();
          showSyncIndicator('synced', '첫 동기 완료');
          setCloudStatus('synced', '방금');
          lastSyncAt = Date.now();
        } else {
          showSyncIndicator('error', '클라우드 비어있음 — push 안 함');
          setCloudStatus('local', '동기 안 됨');
        }
      } else {
        // 로컬도 비어있으면 그냥 빈 상태에서 시작
        showSyncIndicator('synced', '클라우드 비어있음 — 새로 시작');
        setCloudStatus('synced', '시작');
      }
    }
  } catch (e) {
    showSyncIndicator('error', '동기 오류 — ' + (e.message || ''));
    setCloudStatus('error', '오류');
  }
  cloudPullDone = true;
  updateNavCloudUI();
  setTimeout(hideSyncIndicator, 2500);
}

let cloudPushTimeout = null;
function cloudSyncDebounced() {
  clearTimeout(cloudPushTimeout);
  cloudPushTimeout = setTimeout(pushToCloud, 1500);
}
function cloudSyncImmediate() {
  clearTimeout(cloudPushTimeout);
  return pushToCloud();
}

async function pushToCloud() {
  if (!supa || !currentSession) return;
  // pull 안 끝났으면 push 안 함 (race 방지)
  if (!cloudPullDone) {
    console.warn('Push 보류 — 클라우드 pull 미완료');
    return;
  }
  showSyncIndicator('syncing', '저장 중...');
  setCloudStatus('syncing', '저장 중');
  try {
    const { error } = await supa
      .from(CLOUD_TABLE)
      .upsert({
        user_id: currentSession.user.id,
        state: state,
        updated_at: new Date().toISOString()
      });
    if (error) throw error;
    lastSyncAt = Date.now();
    showSyncIndicator('synced', '클라우드 저장됨');
    setCloudStatus('synced', formatTimeAgo(lastSyncAt));
    setTimeout(hideSyncIndicator, 1500);
  } catch (e) {
    showSyncIndicator('error', '저장 실패 — ' + (e.message || ''));
    setCloudStatus('error', '저장 실패');
    setTimeout(hideSyncIndicator, 3000);
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
function toast(message, ms = 2200, opts = {}) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = el('div', 'toast');
  t.innerHTML = message;
  if (opts.undoable) {
    const btn = el('button', 'toast-undo');
    btn.textContent = '↶ 실행 취소';
    btn.addEventListener('click', () => { undo(); t.remove(); });
    t.appendChild(btn);
    ms = 5000; // 실행 취소 가능한 토스트는 좀 더 길게
  }
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
  pushUndo('목표 편집');
  if (!state.dailyGoals) state.dailyGoals = {};
  if (v) state.dailyGoals[today] = v;
  else delete state.dailyGoals[today];
  saveState();
  renderDailyGoal();
  toast('<em>목표 저장</em>', 5000, { undoable: true });
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
  if (disp) {
    disp.classList.toggle('running', state.timer.running);
    // 현재 색 표시
    if (state.timer.currentColor && state.timer.running) {
      disp.style.color = state.timer.currentColor;
    } else {
      disp.style.color = '';
    }
  }
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
  ['money', 'promote', 'life', 'friends'].forEach(cat => {
    (state.timerPresets[cat] || []).forEach(p => {
      const name = p && p.name ? p.name : '';
      const color = p && p.color ? p.color : '#B5ADA0';
      if (!name) return;
      const b = el('button', 'tp-preset-btn');
      b.textContent = name;
      b.dataset.cat = cat;
      b.dataset.name = name;
      b.dataset.color = color;
      // 글씨는 검정으로 통일, 배경에 옅은 색
      b.style.color = '#1F1B16';
      b.style.background = color + '33';
      b.style.borderColor = color + '88';
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
    { id: 'money', name: '🟠 일' },
    { id: 'promote', name: '🔵 알림' },
    { id: 'life', name: '🟢 삶' },
    { id: 'friends', name: '🩷 친구 / 가족' }
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
        const defaultColor = c.id === 'money' ? '#CF4500' : c.id === 'promote' ? '#3860BE' : c.id === 'life' ? '#4A7060' : '#E472A0';
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
  pushUndo('타이머 종료 (시간표 자동 추가)');
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
  toast(`<em>${formatHM(elapsed)}</em> 기록됨`, 5000, { undoable: true });
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
  const fullLabel = label || '몰입';

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
  { name: '연분홍',   hex: '#F8D1DD', family: 'pink' },
  { name: '분홍',     hex: '#F0A6BD', family: 'pink' },
  { name: '진분홍',   hex: '#E472A0', family: 'pink' },
  { name: '자주',     hex: '#C13B6F', family: 'pink' },
  { name: '회색',     hex: '#B5ADA0', family: 'gray' }
];

function isMobile() { return window.innerWidth <= 768; }

function renderHourlyTable() {
  const grid = $('#tt-grid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.appendChild(el('div', 'hh', ''));
  ['00','10','20','30','40','50'].forEach(t => grid.appendChild(el('div', 'ch', ':' + t)));
  // 모바일: 6-23시 (18시간), 데스크톱: 24시간
  const hours = isMobile()
    ? [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]
    : [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5];
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
  pushUndo(`${n}칸 지움`);
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
  toast(`<em>${n}칸 지움</em>`, 5000, { undoable: true });
}
function clearHourlySelection() {
  hourlyActiveSelection = null;
  $$('#tt-grid .cell-c').forEach(c => c.classList.remove('selected', 'drag-preview'));
  hideHourlyActionBar();
}

document.addEventListener('keydown', (e) => {
  // ⌘/Ctrl + Z = 실행 취소 (어디서나 작동, 입력칸 제외)
  const ae = document.activeElement;
  const inInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.getAttribute('contenteditable') === 'true');
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !inInput) {
    e.preventDefault();
    undo();
    return;
  }
  if (!hourlyActiveSelection) return;
  if (inInput) return;
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
  // 기존 블록 클릭 → 그 블록의 진짜 시작/끝으로 시간 설정 (수정 시 원본 보존)
  // 빈 칸 클릭/드래그 → 사용자가 고른 범위
  let displayStartHour, displayStartMin, displayEndHour, displayEndMin;
  if (owning) {
    const realStartMin = owning.hour * 60 + owning.slot * 10;
    const realEndMin = realStartMin + (owning.span || 1) * 10;
    displayStartHour = Math.floor(realStartMin / 60) % 24;
    displayStartMin = realStartMin % 60;
    displayEndHour = Math.floor(realEndMin / 60) % 24;
    displayEndMin = realEndMin % 60;
    // hourlyPickContext도 진짜 범위로 업데이트 (저장/지우기 정확히)
    hourlyPickContext = {
      startHour: owning.hour,
      startSlot: owning.slot,
      endHour: Math.floor((realEndMin - 10) / 60) % 24,
      endSlot: ((realEndMin - 10) % 60) / 10
    };
  } else {
    displayStartHour = startHour;
    displayStartMin = startSlot * 10;
    const endTotalMin = endHour * 60 + (endSlot + 1) * 10;
    displayEndHour = Math.floor(endTotalMin / 60) % 24;
    displayEndMin = endTotalMin % 60;
  }
  $('#modal-hourly-title').textContent = `${pad(displayStartHour)}:${pad(displayStartMin)} — ${pad(displayEndHour)}:${pad(displayEndMin)}`;
  $('#modal-hourly-start').value = `${pad(displayStartHour)}:${pad(displayStartMin)}`;
  $('#modal-hourly-end').value = `${pad(displayEndHour)}:${pad(displayEndMin)}`;
  $('#modal-hourly-label').value = owning ? (owning.label || '') : '';

  const presetRow = $('#modal-hourly-presets');
  if (presetRow) {
    presetRow.innerHTML = '';
    ['money', 'promote', 'life', 'friends'].forEach(cat => {
      (state.timerPresets[cat] || []).forEach(p => {
        if (!p || !p.name) return;
        const b = el('button', 'modal-preset-chip');
        b.textContent = p.name;
        b.dataset.color = p.color || '#CF4500';
        b.style.color = '#1F1B16';
        b.style.background = (p.color || '#CCC') + '33';
        b.style.borderColor = (p.color || '#CCC') + '88';
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
  pushUndo('시간표 입력');
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
  toast(`<em>${label || '시간 블록'}</em> 저장됨`, 5000, { undoable: true });
}

function eraseHourlyCell() {
  if (!hourlyPickContext) return;
  pushUndo('시간 블록 지움');
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
  toast('<em>시간 블록 지움</em>', 5000, { undoable: true });
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

// 라벨 정규화: 괄호 () 앞 + 첫 단어로 그룹
function normalizeLabel(label) {
  if (!label) return '(빈칸)';
  // "다이어리 제작 (구성품)" → "다이어리 제작"
  let s = String(label).replace(/\s*[\(（][^\)）]*[\)）]\s*/g, '').trim();
  if (!s) s = String(label).trim();
  // 첫 단어 (공백 기준)
  const first = s.split(/\s+/)[0];
  // "메일 확인" + "메일 답장" → "메일"
  // 단, 첫 단어가 너무 짧으면 (1글자) 그대로 유지
  return first.length >= 2 ? first : s;
}

function renderWeeklyHourly(monday) {
  const cont = $('#weekly-hourly');
  if (!cont) return;
  cont.innerHTML = `<div class="wh-title">7-DAY HOURLY · 일주일치 시간 한눈에 (10분 단위)</div>`;
  // 가로 스크롤 가능한 컨테이너
  const scroll = el('div', 'wh-scroll');
  const table = el('div', 'wh-detail-table');
  const dows = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
  // 24개 헤더 (시간) + 데이터
  // 그리드: 시간 라벨 32px + 7일 (각 day는 6 slot)
  // 총 컬럼: 1 (시간) + 7*1 = 8 (각 day는 한 컬럼 안에 6 slot을 나누어 가짐)
  // → 더 간단하게: 각 day마다 6 slot 컬럼 = 시간 + 42 슬롯
  // 가로 폭 매우 넓어짐. 대신 셀 작게.

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

  // 시간: 모바일은 6-23시, 데스크톱은 24시간
  const hours = isMobile()
    ? [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]
    : [6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,0,1,2,3,4,5];

  hours.forEach(hour => {
    table.appendChild(el('div', 'wh-hr', String(hour).padStart(2, '0')));
    for (let i = 0; i < 7; i++) {
      const date = addDays(monday, i);
      const dateStr = fmtDate(date);
      const blocks = state.timeBlocks[dateStr] || [];
      // 각 일 셀 안에 6 미니슬롯
      const dayCell = el('div', 'wh-day-cell');
      for (let slot = 0; slot < 6; slot++) {
        const owning = blocks.find(b => b.hour === hour && b.slot <= slot && (b.slot + b.span) > slot);
        const mini = el('div', 'wh-mini-slot');
        if (owning) {
          const isFirst = owning.slot === slot;
          if (owning.type === 'money') mini.style.background = 'var(--money)';
          else if (owning.type === 'promote') mini.style.background = 'var(--promote)';
          else if (owning.type === 'life') mini.style.background = 'var(--life)';
          else if (owning.type === 'friends') mini.style.background = 'var(--friends)';
          else if (owning.type && owning.type.startsWith('#')) {
            mini.style.background = owning.type;
          }
          if (isFirst && owning.label) {
            const lbl = el('span', 'wh-mini-label');
            lbl.textContent = owning.label;
            lbl.style.maxWidth = `${(owning.span || 1) * 28}px`;
            mini.appendChild(lbl);
            mini.title = owning.label;
          }
        }
        dayCell.appendChild(mini);
      }
      table.appendChild(dayCell);
    }
  });
  scroll.appendChild(table);
  cont.appendChild(scroll);

  // 원형 차트 (라벨별 시간 누적)
  renderWeeklyStats(monday, cont);
}

function renderWeeklyStats(monday, parent) {
  // 일주일치 모든 timeBlocks 모아서 라벨별 분단위 합
  const labelMinutes = {};
  const labelColor = {}; // 대표 색
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const dateStr = fmtDate(date);
    const blocks = state.timeBlocks[dateStr] || [];
    blocks.forEach(b => {
      const minutes = (b.span || 1) * 10;
      const grp = normalizeLabel(b.label);
      labelMinutes[grp] = (labelMinutes[grp] || 0) + minutes;
      if (!labelColor[grp]) {
        labelColor[grp] = (b.type && b.type.startsWith('#'))
          ? b.type
          : (b.type === 'money' ? '#CF4500'
             : b.type === 'promote' ? '#3860BE'
             : b.type === 'life' ? '#4A7060'
             : b.type === 'friends' ? '#E472A0'
             : '#B5ADA0');
      }
    });
  }
  const entries = Object.entries(labelMinutes).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [_, m]) => s + m, 0);
  if (total === 0) {
    const empty = el('div', 'wh-stats-empty', '아직 채워진 시간 없음 — 시간표를 채우면 통계 보여줘.');
    parent.appendChild(empty);
    return;
  }
  const statsBox = el('div', 'wh-stats');
  statsBox.innerHTML = `<div class="wh-stats-title cor">WEEKLY · 라벨별 시간 분포</div>`;

  // SVG 도넛 차트
  const size = 220;
  const r = 70;
  const stroke = 28;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  let segs = '';
  entries.forEach(([label, mins]) => {
    const frac = mins / total;
    const len = frac * circ;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${labelColor[label]}" stroke-width="${stroke}" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"><title>${escapeHtml(label)}: ${formatHours(mins)}</title></circle>`;
    offset += len;
  });
  const chartWrap = el('div', 'wh-chart-wrap');
  chartWrap.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${segs}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="Sofia Sans" font-size="22" font-weight="500" fill="#1F1B16">${formatHours(total)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-family="Sofia Sans" font-size="10" fill="#696969" letter-spacing="0.1em">TOTAL · 합계</text>
    </svg>
  `;
  const legendBox = el('div', 'wh-chart-legend');
  entries.forEach(([label, mins]) => {
    const pct = Math.round(mins / total * 100);
    const row = el('div', 'wh-legend-row');
    row.innerHTML = `
      <span class="wh-legend-sw" style="background:${labelColor[label]}"></span>
      <span class="wh-legend-label">${escapeHtml(label)}</span>
      <span class="wh-legend-time">${formatHours(mins)} · ${pct}%</span>
    `;
    legendBox.appendChild(row);
  });
  statsBox.appendChild(chartWrap);
  statsBox.appendChild(legendBox);
  parent.appendChild(statsBox);
}

function formatHours(min) {
  if (min < 60) return min + '분';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
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
      case 'cloud-login': openCloudLogin(); break;
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
let resizeTimeout = null;
let wasMobile = isMobile();
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    const nowMobile = isMobile();
    if (nowMobile !== wasMobile) {
      wasMobile = nowMobile;
      const page = state.meta.currentPage || 'daily';
      if (page === 'daily') renderHourlyTable();
      else if (page === 'weekly') renderWeekly();
    }
  }, 200);
}

function init() {
  setupEventDelegation();
  setupTaskInput();
  initRouter();
  window.addEventListener('resize', handleResize);
  // Resume timer interval if running
  if (state.timer.running && state.timer.startedAt) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerDisplay, 1000);
  }
  // Cloud sync 시작 (Supabase SDK 로드 후)
  initCloud().catch(e => console.warn('cloud init failed:', e));
  // 1분마다 동기 시각 업데이트
  setInterval(updateNavCloudUI, 60000);

  // 탭 다시 켜면 클라우드에서 최신 받아옴 (다른 기기 변경사항 즉시 반영)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && cloudReady && currentSession && !skipCloud && cloudPullDone) {
      pullFromCloud().then(() => renderCurrentPage());
    }
  });

  // 탭/창 닫기 전 push 즉시 flush (debounce 무시)
  window.addEventListener('beforeunload', () => {
    if (cloudReady && currentSession && !skipCloud && cloudPullDone && cloudPushTimeout) {
      clearTimeout(cloudPushTimeout);
      // sendBeacon 같은 건 Supabase upsert에 적용 어려움 — 동기 fetch 시도
      try {
        navigator.sendBeacon && navigator.sendBeacon(
          `${SUPABASE_URL}/rest/v1/${CLOUD_TABLE}`,
          new Blob([JSON.stringify({ user_id: currentSession.user.id, state, updated_at: new Date().toISOString() })], { type: 'application/json' })
        );
      } catch(e) {}
    }
  });

  // 30초마다 강제 풀 (다른 기기 변경 자동 반영)
  setInterval(() => {
    if (!document.hidden && cloudReady && currentSession && !skipCloud && cloudPullDone) {
      pullFromCloudGently();
    }
  }, 30000);
}

function renderCurrentPage() {
  const page = state.meta.currentPage || 'daily';
  const r = pageRenderers[page];
  if (r) r();
}

// 부드러운 pull — 클라우드가 더 새로우면 로컬 덮어쓰기, 아니면 무시
async function pullFromCloudGently() {
  if (!supa || !currentSession) return;
  try {
    const { data, error } = await supa
      .from(CLOUD_TABLE)
      .select('state, updated_at')
      .eq('user_id', currentSession.user.id)
      .maybeSingle();
    if (error || !data || !data.state) return;
    const cloudTs = new Date(data.updated_at).getTime();
    // 우리 마지막 push/pull보다 최신이면 적용
    if (lastSyncAt && cloudTs > lastSyncAt + 2000) {
      state = Object.assign({}, deepClone(DEFAULT_STATE), data.state);
      state.timerPresets = normalizeTimerPresets(state.timerPresets) || deepClone(DEFAULT_STATE.timerPresets);
      state.timeBlocks = state.timeBlocks || {};
      state.dailyGoals = state.dailyGoals || {};
      state.meta = Object.assign({}, deepClone(DEFAULT_STATE.meta), state.meta || {});
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
      lastSyncAt = Date.now();
      setCloudStatus('synced', '방금 (다른 기기)');
      updateNavCloudUI();
      renderCurrentPage();
      toast('☁ 다른 기기의 변경 사항 반영됨');
    }
  } catch(e) {}
}

document.addEventListener('DOMContentLoaded', init);
