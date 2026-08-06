'use strict';

const fs = require('fs');
const path = require('path');

const sb = require('./lib/supabase');
const { buildMatch, toStored } = require('./lib/match');
const { computeStats } = require('./lib/stats');
const { loadMembers, toStoredMember, memberById, members, nextId } = require('./lib/members');

/* ── JSON 파일 (폴백 전용) ── */
const DATA_DIR = path.join(__dirname, '..', 'data');
const MATCH_FILE = path.join(DATA_DIR, 'matches.json');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const DASH_CONFIG_FILE = path.join(DATA_DIR, 'dashboard-config.json');

let userMatches = [];
let pendingMatches = [];
let dashConfig = { title: '협곡단 내전 기록실', description: '단원 명단과 티어, 내전 전적을 한곳에서.', season: '2026 Split 2' };
let rosterInfo = { source: 'uninitialized', count: 0 };
let cachedAll = null;
let cachedStats = null;
let cachedStatsRift = null;
let cachedStatsAram = null;
let _useDb = false; // Supabase 연결 여부

/* ── 유틸 ── */
function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function invalidate() { cachedAll = null; cachedStats = null; cachedStatsRift = null; cachedStatsAram = null; }

/* ── DB ↔ App 변환 ── */
function toDbMatch(m) {
  return {
    id: m.id,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    dur: m.dur || null,
    mode: m.mode || '협곡',
    blue_win: m.blueWin,
    mvp_id: m.mvpId || null,
    blue: m.blue.map(p => ({ id: p.id, lane: p.lane || null })),
    red: m.red.map(p => ({ id: p.id, lane: p.lane || null })),
  };
}
function fromDbMatch(row) {
  return { id: row.id, date: new Date(row.date), dur: row.dur, mode: row.mode, blueWin: row.blue_win, mvpId: row.mvp_id, blue: row.blue, red: row.red };
}
function toDbPending(p) {
  return { id: p.id, date: p.date, mode: p.mode || '협곡', player_ids: p.playerIds };
}
function fromDbPending(row) {
  return { id: row.id, date: row.date, mode: row.mode, playerIds: row.player_ids };
}

/* DB 쓰기 (실패 시 로그만, 앱 안 죽음) */
function dbWrite(fn) { return fn().catch(e => console.error('[DB write error]', e.message)); }

/* ── JSON 로드/저장 (폴백) ── */
function loadUserJson() {
  const raw = readJson(MATCH_FILE, []);
  return Array.isArray(raw) ? raw.map(m => buildMatch({ ...m, date: new Date(m.date) })) : [];
}
function saveUserJson() { ensureDir(); fs.writeFileSync(MATCH_FILE, JSON.stringify(userMatches.map(toStored), null, 2), 'utf8'); }
function saveMembersJson() { ensureDir(); fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members.map(toStoredMember), null, 2), 'utf8'); }
function savePendingJson() { ensureDir(); fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingMatches, null, 2), 'utf8'); }
function saveDashConfigJson() { ensureDir(); fs.writeFileSync(DASH_CONFIG_FILE, JSON.stringify(dashConfig, null, 2), 'utf8'); }

/* ── Google Sheets → 가져오기 ── */
async function importFromSheet() {
  const { loadRosterRows } = require('./lib/roster-source');
  const r = await loadRosterRows();
  const memberList = r.rows.map((row, i) => ({
    id: i, name: row[0], birth: row[1], nick: row[2] || '', tier: row[3] || '언랭',
    main: row[4] ? String(row[4]).split(',').map(s => s.trim()).filter(Boolean) : [],
    sub: row[5] ? String(row[5]).split(',').map(s => s.trim()).filter(Boolean) : [],
    role: row[6] || '단원', hidden: false,
  }));
  loadMembers(memberList);
  if (_useDb) { await dbWrite(() => sb.upsert('members', memberList)); }
  else { saveMembersJson(); }
  invalidate();
  rosterInfo = { source: r.source, count: memberList.length, fetchedAt: new Date().toISOString() };
  return rosterInfo;
}

/* ══════════════════════════════════════
   부팅: Supabase 우선 → JSON 폴백
   ══════════════════════════════════════ */
async function init() {
  try {
    const [sbMembers, sbMatches, sbPending, sbConfig] = await Promise.all([
      sb.select('members', '', '*', 'id.asc'),
      sb.select('matches', '', '*', 'date.desc'),
      sb.select('pending', '', '*', 'date.desc'),
      sb.select('dashboard_config', 'id=eq.1'),
    ]);
    _useDb = true;
    console.log('  ✓ Supabase 연결 성공');

    // 단원
    if (sbMembers && sbMembers.length > 0) {
      loadMembers(sbMembers);
      rosterInfo = { source: 'supabase', count: members.length };
    } else {
      // DB 테이블은 있지만 비어있음 → JSON에서 마이그레이션 시도
      const jsonMembers = readJson(MEMBERS_FILE, null);
      if (jsonMembers && jsonMembers.length) {
        loadMembers(jsonMembers);
        await dbWrite(() => sb.upsert('members', jsonMembers));
        rosterInfo = { source: 'supabase(migrated)', count: members.length };
      } else {
        await importFromSheet();
      }
    }

    // 내전 기록
    if (sbMatches && sbMatches.length > 0) {
      userMatches = sbMatches.map(row => buildMatch(fromDbMatch(row)));
    } else {
      userMatches = loadUserJson();
      // JSON 데이터가 있으면 DB로 마이그레이션
      if (userMatches.length) {
        await dbWrite(() => sb.upsert('matches', userMatches.map(m => toDbMatch(toStored(m)))));
      }
    }

    // 대기 내전
    if (sbPending && sbPending.length > 0) {
      pendingMatches = sbPending.map(fromDbPending);
    } else {
      pendingMatches = readJson(PENDING_FILE, []);
      if (pendingMatches.length) {
        await dbWrite(() => sb.upsert('pending', pendingMatches.map(toDbPending)));
      }
    }

    // 대시보드 설정
    if (sbConfig && sbConfig.length > 0) {
      const c = sbConfig[0];
      dashConfig = { title: c.title, description: c.description, season: c.season };
    } else {
      dashConfig = readJson(DASH_CONFIG_FILE, dashConfig);
      await dbWrite(() => sb.upsert('dashboard_config', [{ id: 1, ...dashConfig }]));
    }

  } catch (e) {
    console.warn('  ⚠ Supabase 연결 실패 → JSON 파일 모드:', e.message);
    _useDb = false;

    const saved = readJson(MEMBERS_FILE, null);
    if (saved && Array.isArray(saved) && saved.length > 0) {
      loadMembers(saved);
      rosterInfo = { source: 'json', count: saved.length };
    } else {
      await importFromSheet();
    }
    userMatches = loadUserJson();
    pendingMatches = readJson(PENDING_FILE, []);
    dashConfig = readJson(DASH_CONFIG_FILE, dashConfig);
  }

  invalidate();
  return rosterInfo;
}

/* ── 조회 ── */
function allMatches() { if (!cachedAll) cachedAll = [...userMatches].sort((a, b) => b.date - a.date); return cachedAll; }
function stats(mode) {
  if (!mode) { if (!cachedStats) cachedStats = computeStats(allMatches()); return cachedStats; }
  if (mode === '협곡') { if (!cachedStatsRift) cachedStatsRift = computeStats(allMatches(), '협곡'); return cachedStatsRift; }
  if (mode === '칼바람') { if (!cachedStatsAram) cachedStatsAram = computeStats(allMatches(), '칼바람'); return cachedStatsAram; }
  return computeStats(allMatches(), mode);
}
function findMatch(id) { return allMatches().find(m => String(m.id) === String(id)) || null; }

/* ── 매치 변경 ── */
function addUserMatch(match) {
  userMatches.unshift(match);
  if (_useDb) dbWrite(() => sb.insert('matches', toDbMatch(toStored(match))));
  else saveUserJson();
  invalidate();
  return match;
}
function replaceUserMatch(id, match) {
  const idx = userMatches.findIndex(m => String(m.id) === String(id));
  if (idx < 0) return false;
  userMatches[idx] = match;
  if (_useDb) dbWrite(() => sb.update('matches', `id=eq.${id}`, toDbMatch(toStored(match))));
  else saveUserJson();
  invalidate();
  return true;
}
function deleteUserMatch(id) {
  const before = userMatches.length;
  userMatches = userMatches.filter(m => String(m.id) !== String(id));
  if (userMatches.length === before) return false;
  if (_useDb) dbWrite(() => sb.del('matches', `id=eq.${id}`));
  else saveUserJson();
  invalidate();
  return true;
}

/* ── 대기 매치 ── */
function addPending(p) {
  pendingMatches.unshift(p);
  if (_useDb) dbWrite(() => sb.insert('pending', toDbPending(p)));
  else savePendingJson();
  return p;
}
function getPending() { return pendingMatches; }
function findPending(id) { return pendingMatches.find(p => String(p.id) === String(id)) || null; }
function deletePending(id) {
  const before = pendingMatches.length;
  pendingMatches = pendingMatches.filter(p => String(p.id) !== String(id));
  if (pendingMatches.length === before) return false;
  if (_useDb) dbWrite(() => sb.del('pending', `id=eq.${id}`));
  else savePendingJson();
  return true;
}

/* ── 대시보드 설정 ── */
function getDashConfig() { return { ...dashConfig }; }
function setDashConfig(cfg) {
  dashConfig = { ...dashConfig, ...cfg };
  if (_useDb) dbWrite(() => sb.update('dashboard_config', 'id=eq.1', dashConfig));
  else saveDashConfigJson();
  return dashConfig;
}

/* ── 단원 관리 ── */
function editMember(id, patch) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx] = { ...stored[idx], ...patch };
  loadMembers(stored);
  if (_useDb) dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, stored[idx]));
  else saveMembersJson();
  invalidate();
  return true;
}
function addMember(obj) {
  const id = nextId();
  const newMember = { id, ...obj, hidden: false };
  const stored = members.map(toStoredMember);
  stored.push(newMember);
  loadMembers(stored);
  if (_useDb) dbWrite(() => sb.insert('members', newMember));
  else saveMembersJson();
  invalidate();
  return id;
}
function removeMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx].hidden = true;
  loadMembers(stored);
  if (_useDb) dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, { hidden: true }));
  else saveMembersJson();
  invalidate();
  return true;
}
function restoreMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx].hidden = false;
  loadMembers(stored);
  if (_useDb) dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, { hidden: false }));
  else saveMembersJson();
  invalidate();
  return true;
}

function counts() { return { matches: allMatches().length, userMatches: userMatches.length, pending: pendingMatches.length }; }
function roster() { return rosterInfo; }
function isDbMode() { return _useDb; }

module.exports = {
  init, importFromSheet, isDbMode,
  allMatches, stats, findMatch,
  addUserMatch, replaceUserMatch, deleteUserMatch,
  addPending, getPending, findPending, deletePending,
  getDashConfig, setDashConfig,
  editMember, addMember, removeMember, restoreMember,
  counts, roster,
};
