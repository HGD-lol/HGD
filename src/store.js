'use strict';

const sb = require('./lib/supabase');
const { buildMatch, toStored } = require('./lib/match');
const { computeStats } = require('./lib/stats');
const { loadMembers, buildFromObj, toStoredMember, memberById, members, nextId, deletedMembers, parseAccounts, normNick, DELETED_ROLE } = require('./lib/members');

let userMatches = [];
let pendingDraft = null;   // 내전 등록 화면에서 선택 중인 초안 (pending 테이블 1행)
let seasons = [];
let dashConfig = { title: '협곡단 내전 기록실', description: '단원 명단과 티어, 내전 전적을 한곳에서.', season: '2026 Split 2', matchRegistrationEnabled: true };
let rosterInfo = { source: 'uninitialized', count: 0 };
let lastVisitAt = null;    // 마지막으로 누군가 메인 화면을 연 시각 (dashboard_config.last_visit_at 에 보관)
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
  // 시트 닉네임 칸은 하나뿐이라 부계정은 관리자 화면에서만 늘어난다 — 기존 닉을 들고 와 시트 닉 뒤에 합친다.
  // (시트 칸에 쉼표로 여러 개 적어도 그대로 부계정으로 들어온다)
  const prevAccounts = new Map(members.map(m => [m.name, m.accounts]));
  const memberList = r.rows.map((row, i) => {
    const prev = prevAccounts.get(row[0]) || [];
    // 시트 닉과 같은 계정은 기존 것을 그대로 써서 PUUID·조회 시각을 잃지 않는다
    const sheet = parseAccounts(row[2]).map(a => prev.find(p => normNick(p.nick) === normNick(a.nick)) || a);
    const nicks = parseAccounts([...sheet, ...prev]);
    return {
      id: i, name: row[0], birth: row[1], nick: nicks.length ? nicks[0].nick : '', nicks, tier: row[3] || '언랭',
      main: row[4] ? String(row[4]).split(',').map(s => s.trim()).filter(Boolean) : [],
      sub: row[5] ? String(row[5]).split(',').map(s => s.trim()).filter(Boolean) : [],
      role: row[6] || '단원', joined: prevJoined.get(row[0]) || null, hidden: false,
    };
  });
  // 완전삭제된 단원(묘비)은 시트에 없지만 과거 기록의 이름 해석에 필요하다 — 그대로 들고 간다.
  const tombs = deletedMembers().map(toStoredMember).filter(t => !memberList.some(m => m.id === t.id));
  loadMembers([...memberList, ...tombs]);
  await dbWrite(() => sb.upsert('members', memberList.map(dbMember)));
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
    hasNicksColumn = Object.prototype.hasOwnProperty.call(sbMembers[0], 'nicks');
    if (!hasNicksColumn) {
      console.warn('  ⚠ members.nicks 컬럼이 없어 부계정 닉네임이 저장되지 않습니다. Supabase 에서 실행하세요:');
      console.warn("    alter table public.members add column if not exists nicks jsonb not null default '[]'::jsonb;");
    }
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
    // 컬럼이 아직 없으면 undefined — 그때는 이번 기동부터 다시 쌓인다
    lastVisitAt = c.last_visit_at || null;
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
  // 수정 요청 본문에는 시즌이 없다 — 원래 시즌을 유지한다(안 그러면 시즌 필터에서 사라진다)
  if (!match.seasonId) match.seasonId = userMatches[idx].seasonId || null;
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
/* 저장용 전체 스냅샷 — 살아있는 단원 뒤에 묘비를 붙인다(앞쪽 인덱스는 members 와 동일). */
function storedMembers() {
  return [...members.map(toStoredMember), ...deletedMembers().map(toStoredMember)];
}

/*
 * members.nicks(부계정 닉네임) 컬럼이 아직 없는 DB 를 위한 안전장치.
 * 없는 컬럼을 보내면 PostgREST 가 400 을 내고 저장이 통째로 조용히 실패하므로,
 * 부팅 때 컬럼 유무를 보고 없으면 대표 닉(nick)만 보낸다.
 */
let hasNicksColumn = true;
function nicksPersisted() { return hasNicksColumn; }
function dbMember(obj) {
  if (hasNicksColumn) return obj;
  const { nicks, ...rest } = obj;
  return rest;
}

function editMember(id, patch) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = storedMembers();
  stored[idx] = toStoredMember(buildFromObj({ ...stored[idx], ...patch }));
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, dbMember(stored[idx])));
  invalidate();
  return true;
}
function addMember(obj) {
  const id = nextId();
  const newMember = toStoredMember(buildFromObj({ id, ...obj, hidden: false }));
  const stored = storedMembers();
  stored.push(newMember);
  loadMembers(stored);
  dbWrite(() => sb.insert('members', dbMember(newMember)));
  invalidate();
  return id;
}
function removeMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = storedMembers();
  stored[idx].hidden = true;
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${Number(id)}`, { hidden: true }));
  invalidate();
  return true;
}
/*
 * 완전삭제 = 묘비화. 행을 지우지 않고 role 만 '삭제'로 바꾼다.
 * 명단·풀·통계·순위에서는 사라지지만, 과거 내전 기록은 계속 이름을 해석할 수 있다.
 */
function permanentDeleteMember(id) {
  const num = Number(id);
  const idx = members.findIndex(x => x.id === num);
  if (idx < 0) return false;
  const stored = storedMembers();
  stored[idx] = { ...stored[idx], role: DELETED_ROLE, hidden: true };
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${num}`, dbMember(stored[idx])));
  invalidate();
  return true;
}
/* 복원 — 숨김 단원은 물론 묘비도 되살린다(직책은 '예비'로 돌려놓는다). */
function restoreMember(id) {
  const num = Number(id);
  const stored = storedMembers();
  const idx = stored.findIndex(x => x.id === num);
  if (idx < 0) return false;
  stored[idx] = { ...stored[idx], hidden: false };
  if (stored[idx].role === DELETED_ROLE) stored[idx].role = '예비';
  loadMembers(stored);
  dbWrite(() => sb.update('members', `id=eq.${num}`, dbMember(stored[idx])));
  invalidate();
  return true;
}

/*
 * 방문 기록 — '직전' 방문 시각을 돌려주고 지금으로 갱신한다.
 * 지금 보고 있는 사람 자신의 접속이 아니라 그 앞 사람의 접속 시각을 보여주기 위해서다.
 */
function touchVisit() {
  const prev = lastVisitAt;
  lastVisitAt = new Date().toISOString();
  dbWrite(() => sb.update('dashboard_config', 'id=eq.1', { last_visit_at: lastVisitAt }));
  return prev;
}

function counts() { return { matches: allMatches().length, userMatches: userMatches.length, pending: pendingDraft ? 1 : 0 }; }
function roster() { return rosterInfo; }

module.exports = {
  init, importFromSheet,
  allMatches, stats, findMatch,
  addUserMatch, replaceUserMatch, deleteUserMatch,
  getPending, savePending, clearPending,
  getDashConfig, setDashConfig,
  editMember, addMember, removeMember, permanentDeleteMember, restoreMember, nicksPersisted,
  touchVisit,
  getSeasons, getCurrentSeason, createSeason,
  counts, roster,
};
