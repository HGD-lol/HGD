'use strict';

const sb = require('./lib/supabase');
const { buildMatch, toStored } = require('./lib/match');
const { computeStats } = require('./lib/stats');
const { loadMembers, toStoredMember, memberById, members, nextId } = require('./lib/members');

let userMatches = [];
let pendingDraft = null;   // 내전 등록 화면에서 선택 중인 초안 (pending 테이블 1행)
let seasons = [];
let dashConfig = { title: '협곡단 내전 기록실', description: '단원 명단과 티어, 내전 전적을 한곳에서.', season: '2026 Split 2', matchRegistrationEnabled: true };
let rosterInfo = { source: 'uninitialized', count: 0 };
let cachedAll = null;
let cachedStats = null;
let cachedStatsRift = null;
let cachedStatsAram = null;

/* ── 유틸 ── */
function invalidate() { cachedAll = null; cachedStats = null; cachedStatsRift = null; cachedStatsAram = null; }

/* DB 쓰기 (실패 시 로그만, 앱 안 죽음) */
function dbWrite(fn) { return fn().catch(e => console.error('[DB write error]', e.message)); }

/* ── DB ↔ App 변환 ── */
function toDbMatch(m) {
  const dbPlayer = (p) => {
    const out = { id: p.id, lane: p.lane || null };
    if (p.mercenary) { out.mercenary = true; out.name = p.name; out.tier = p.tier; }
    return out;
  };
  return {
    id: m.id,
    date: m.date instanceof Date ? m.date.toISOString() : m.date,
    dur: m.dur || null,
    mode: m.mode || '협곡',
    blue_win: m.blueWin,
    mvp_id: m.mvpId || null,
    blue: m.blue.map(dbPlayer),
    red: m.red.map(dbPlayer),
    season_id: m.seasonId || null,
  };
}
function fromDbMatch(row) {
  return { id: row.id, date: new Date(row.date), dur: row.dur, mode: row.mode, blueWin: row.blue_win, mvpId: row.mvp_id, blue: row.blue, red: row.red, seasonId: row.season_id || null };
}
function toDbPending(p) {
  return {
    id: p.id,
    date: p.date,
    mode: p.mode || '협곡',
    // 선택된 단원이 없으면(전원 용병) NULL — 이름은 mercenaries 에 따로 들어간다
    player_ids: p.playerIds && p.playerIds.length ? p.playerIds : null,
    mercenaries: p.mercenaries || [],
  };
}
function fromDbPending(row) {
  return {
    id: row.id,
    date: row.date,
    mode: row.mode || '협곡',
    playerIds: row.player_ids || [],
    mercenaries: row.mercenaries || [],
  };
}
function toDbSeason(s) {
  return { id: s.id, name: s.name, is_current: !!s.isCurrent, created_at: s.createdAt };
}
function fromDbSeason(row) {
  return { id: row.id, name: row.name, isCurrent: !!row.is_current, createdAt: row.created_at };
}

/* ── Google Sheets → 가져오기 ── */
async function importFromSheet() {
  const { loadRosterRows } = require('./lib/roster-source');
  const r = await loadRosterRows();
  // 시트에는 가입날짜 열이 없다 — 이미 저장된 값을 덮어쓰지 않게 들고 온다.
  // id 는 시트 행 순서로 다시 매겨지므로 이름을 키로 잇는다.
  const prevJoined = new Map(members.map(m => [m.name, m.joined || null]));
  const memberList = r.rows.map((row, i) => ({
    id: i, name: row[0], birth: row[1], nick: row[2] || '', tier: row[3] || '언랭',
    main: row[4] ? String(row[4]).split(',').map(s => s.trim()).filter(Boolean) : [],
    sub: row[5] ? String(row[5]).split(',').map(s => s.trim()).filter(Boolean) : [],
    role: row[6] || '단원', joined: prevJoined.get(row[0]) || null, hidden: false,
  }));
  loadMembers(memberList);
  await dbWrite(() => sb.upsert('members', memberList));
  invalidate();
  rosterInfo = { source: r.source, count: memberList.length, fetchedAt: new Date().toISOString() };
  return rosterInfo;
}

/* ══════════════════════════════════════
   부팅: Supabase 전용
   ══════════════════════════════════════ */
async function init() {
  const [sbMembers, sbMatches, sbPending, sbConfig, sbSeasons] = await Promise.all([
    sb.select('members', '', '*', 'id.asc'),
    sb.select('matches', '', '*', 'date.desc'),
    sb.select('pending', '', '*', 'date.desc'),
    sb.select('dashboard_config', 'id=eq.1'),
    sb.select('seasons', '', '*', 'created_at.asc'),
  ]);
  console.log('  ✓ Supabase 연결 성공');

  // 단원
  if (sbMembers && sbMembers.length > 0) {
    loadMembers(sbMembers);
    rosterInfo = { source: 'supabase', count: members.length };
  } else {
    await importFromSheet();
  }

  // 내전 기록
  if (sbMatches && sbMatches.length > 0) {
    userMatches = sbMatches.map(row => buildMatch(fromDbMatch(row)));
  }

  // 대기 내전 — 선택 중인 초안 1건 (예전 데이터가 여러 건이면 최신 것만 쓴다)
  if (sbPending && sbPending.length > 0) {
    pendingDraft = fromDbPending(sbPending[0]);
  }

  // 대시보드 설정
  if (sbConfig && sbConfig.length > 0) {
    const c = sbConfig[0];
    dashConfig = { title: c.title, description: c.description, season: c.season, matchRegistrationEnabled: c.match_registration_enabled !== false };
  }

  // 시즌
  if (sbSeasons && sbSeasons.length > 0) {
    seasons = sbSeasons.map(fromDbSeason);
  }
  await ensureDefaultSeason();

  invalidate();
  return rosterInfo;
}

/* ── 시즌 관리 ── */
function getSeasons() { return seasons; }
function getCurrentSeason() { return seasons.find(s => s.isCurrent) || seasons[0] || null; }

async function ensureDefaultSeason() {
  if (seasons.length === 0) {
    const def = { id: 's_default', name: dashConfig.season || '시즌 1', isCurrent: true, createdAt: new Date().toISOString() };
    seasons.push(def);
    await dbWrite(() => sb.insert('seasons', toDbSeason(def)));
  }
  // 기존 매치 중 seasonId가 없는 것은 첫 번째 시즌에 배정
  const defaultId = seasons[0].id;
  const needUpdate = userMatches.filter(m => !m.seasonId);
  needUpdate.forEach(m => { m.seasonId = defaultId; });
  // DB에도 반영
  if (needUpdate.length > 0) {
    for (const m of needUpdate) {
      await dbWrite(() => sb.update('matches', `id=eq.${m.id}`, { season_id: defaultId }));
    }
  }
}

async function createSeason(name) {
  // 기존 시즌 모두 비활성화
  seasons.forEach(s => { s.isCurrent = false; });
  await dbWrite(() => sb.update('seasons', 'is_current=eq.true', { is_current: false }));

  const newSeason = { id: 's_' + Date.now(), name, isCurrent: true, createdAt: new Date().toISOString() };
  seasons.push(newSeason);
  await dbWrite(() => sb.insert('seasons', toDbSeason(newSeason)));

  // 대시보드 시즌 이름도 업데이트
  setDashConfig({ season: name });
  invalidate();
  return newSeason;
}

/* ── 조회 ── */
function allMatches(seasonId) {
  if (!cachedAll) cachedAll = [...userMatches].sort((a, b) => b.date - a.date);
  if (seasonId) return cachedAll.filter(m => m.seasonId === seasonId);
  return cachedAll;
}
function stats(mode, seasonId) {
  if (seasonId) return computeStats(allMatches(seasonId), mode || undefined);
  if (!mode) { if (!cachedStats) cachedStats = computeStats(allMatches()); return cachedStats; }
  if (mode === '협곡') { if (!cachedStatsRift) cachedStatsRift = computeStats(allMatches(), '협곡'); return cachedStatsRift; }
  if (mode === '칼바람') { if (!cachedStatsAram) cachedStatsAram = computeStats(allMatches(), '칼바람'); return cachedStatsAram; }
  return computeStats(allMatches(), mode);
}
function findMatch(id) { return allMatches().find(m => String(m.id) === String(id)) || null; }

/* ── 매치 변경 ── */
function addUserMatch(match) {
  const cur = getCurrentSeason();
  if (cur && !match.seasonId) match.seasonId = cur.id;
  userMatches.unshift(match);
  dbWrite(() => sb.insert('matches', toDbMatch(toStored(match))));
  invalidate();
  return match;
}
function replaceUserMatch(id, match) {
  const idx = userMatches.findIndex(m => String(m.id) === String(id));
  if (idx < 0) return false;
  userMatches[idx] = match;
  dbWrite(() => sb.update('matches', `id=eq.${id}`, toDbMatch(toStored(match))));
  invalidate();
  return true;
}
function deleteUserMatch(id) {
  const before = userMatches.length;
  userMatches = userMatches.filter(m => String(m.id) !== String(id));
  if (userMatches.length === before) return false;
  dbWrite(() => sb.del('matches', `id=eq.${id}`));
  invalidate();
  return true;
}

/* ── 대기 내전 (내전 등록 화면에서 선택 중인 초안) ──
   pending 테이블에는 항상 최대 1행만 둔다. 선택이 바뀔 때마다 그 행을 통째로 덮어쓰고,
   내전 기록이 저장되면(POST /api/matches) 행을 지운다. */
const ALL_PENDING = 'id=not.is.null';   // PostgREST 는 전체 대상 삭제에도 필터가 필요

function getPending() { return pendingDraft; }

function savePending({ mode, playerIds, mercenaries }) {
  pendingDraft = {
    id: (pendingDraft && pendingDraft.id) || 'draft',
    date: new Date().toISOString(),
    mode: mode || '협곡',
    playerIds: playerIds || [],
    mercenaries: mercenaries || [],
  };
  dbWrite(() => sb.upsert('pending', toDbPending(pendingDraft)));
  return pendingDraft;
}

function clearPending() {
  if (!pendingDraft) return false;
  pendingDraft = null;
  dbWrite(() => sb.del('pending', ALL_PENDING));
  return true;
}

/* ── 대시보드 설정 ── */
function getDashConfig() { return { ...dashConfig }; }
function setDashConfig(cfg) {
  dashConfig = { ...dashConfig, ...cfg };
  const dbCfg = { title: dashConfig.title, description: dashConfig.description, season: dashConfig.season, match_registration_enabled: dashConfig.matchRegistrationEnabled !== false };
  dbWrite(() => sb.update('dashboard_config', 'id=eq.1', dbCfg));
  return dashConfig;
}

/* ── 단원 관리 ── */
function editMember(id, patch) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx] = { ...stored[idx], ...patch };
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, stored[idx]));
  invalidate();
  return true;
}
function addMember(obj) {
  const id = nextId();
  const newMember = { id, ...obj, hidden: false };
  const stored = members.map(toStoredMember);
  stored.push(newMember);
  loadMembers(stored);
  dbWrite(() => sb.insert('members', newMember));
  invalidate();
  return id;
}
function removeMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx].hidden = true;
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, { hidden: true }));
  invalidate();
  return true;
}
function permanentDeleteMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember).filter(m => m.id !== Number(id));
  loadMembers(stored);
  dbWrite(() => sb.del('members', `id=eq.${Number(id)}`));
  invalidate();
  return true;
}
function restoreMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx].hidden = false;
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, { hidden: false }));
  invalidate();
  return true;
}

function counts() { return { matches: allMatches().length, userMatches: userMatches.length, pending: pendingDraft ? 1 : 0 }; }
function roster() { return rosterInfo; }

module.exports = {
  init, importFromSheet,
  allMatches, stats, findMatch,
  addUserMatch, replaceUserMatch, deleteUserMatch,
  getPending, savePending, clearPending,
  getDashConfig, setDashConfig,
  editMember, addMember, removeMember, permanentDeleteMember, restoreMember,
  getSeasons, getCurrentSeason, createSeason,
  counts, roster,
};
