'use strict';

/*
 * 대회(CK) — 1년에 두어 번 열리는 팀 대항전.
 *  - 대회 하나 = tournaments 테이블 1행 (id + data jsonb). 팀·선수·대진을 통째로 담는다.
 *  - 경기 결과는 따로 저장하지 않는다. 대진의 각 경기에 '내전 기록 id' 를 연결해 두고,
 *    볼 때마다 그 기록의 승패와 팀 명단을 대조해 세트 스코어를 계산한다.
 *    (내전 기록을 고치거나 지우면 대진 결과도 따라간다)
 * 테이블이 없으면 메모리에서만 동작한다 — sql/tournaments.sql 을 Supabase 에서 실행.
 */
const sb = require('./supabase');
const store = require('../store');
const { displayMember } = require('./members');
const { LINE_ORDER } = require('./scales');

const TABLE = 'tournaments';
const STAGES = ['예선', '결승', '3·4위전'];
const STATUSES = ['예정', '진행중', '종료'];
const BEST_OF = [1, 3, 5];
const TEAM_COLORS = ['#1E9DE3', '#E84057', '#2ECC8F', '#E0A335', '#9B6BF2', '#0AC8B9', '#F2792B', '#C8AA6E'];
const MAX_TEAMS = 8;
const MAX_PLAYERS = 10;
const MAX_MATCHES = 30;
const MAX_GAMES = 7;
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const WHEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;   // datetime-local 값 그대로 (KST 로 본다)

let list = null;        // 대회 문서 배열 (만든 순)
let persisted = true;   // tournaments 테이블을 쓸 수 있는지
let loading = null;

function defaultDoc() {
  return {
    id: 'ck4',
    name: '협곡단 CK 4회',
    subtitle: '',
    status: '예정',
    visible: true,
    teams: [1, 2, 3, 4].map((n, i) => ({ id: 't' + n, name: `${n}팀`, color: TEAM_COLORS[i], players: [] })),
    matches: [
      { id: 'm1', stage: '예선', label: '예선 1경기', teamA: 't1', teamB: 't2', bestOf: 3, scheduledAt: null, winner: null, games: [] },
      { id: 'm2', stage: '예선', label: '예선 2경기', teamA: 't3', teamB: 't4', bestOf: 3, scheduledAt: null, winner: null, games: [] },
      { id: 'm3', stage: '결승', label: '결승', teamA: 'W:m1', teamB: 'W:m2', bestOf: 3, scheduledAt: null, winner: null, games: [] },
    ],
    createdAt: new Date().toISOString(),
  };
}

async function load() {
  if (list) return list;
  if (!loading) {
    loading = (async () => {
      let rows = [];
      try {
        rows = (await sb.select(TABLE, '', '*', 'created_at.asc')) || [];
      } catch (e) {
        persisted = false;
        console.warn('  ⚠ tournaments 테이블을 읽지 못해 대회(CK) 정보가 저장되지 않습니다. Supabase 에서 sql/tournaments.sql 을 실행하세요.');
        console.warn('    ' + e.message);
      }
      list = rows.filter((r) => r.data && typeof r.data === 'object').map((r) => ({ ...r.data, id: r.id }));
      // 처음에는 4팀 · 예선 2경기 · 결승 틀을 하나 만들어 둔다 (관리자 화면에서 바로 고칠 수 있게)
      if (!list.length) {
        const d = defaultDoc();
        list.push(d);
        await persist(d);
      }
      return list;
    })();
  }
  return loading;
}

/* DB 저장 — 실패하면 사유 문자열을 돌려준다(메모리에는 이미 반영된 상태) */
async function persist(doc) {
  if (!persisted) return 'tournaments 테이블이 없어 서버 메모리에만 저장했습니다(재시작하면 사라집니다). sql/tournaments.sql 을 Supabase 에서 실행하세요.';
  try {
    await sb.upsert(TABLE, { id: doc.id, data: doc, created_at: doc.createdAt, updated_at: new Date().toISOString() });
    return null;
  } catch (e) {
    console.error('[DB write error] tournaments:', e.message);
    if (/42501|row-level security/i.test(e.message)) {
      return 'tournaments 테이블의 RLS 에 막혀 DB 에 저장되지 않았습니다. Supabase 에서 실행하세요: alter table public.tournaments disable row level security;';
    }
    return 'DB 저장에 실패했습니다: ' + e.message;
  }
}

/* ── 입력 검증 ── */
const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

function sanitize(body, id, createdAt) {
  const errors = [];
  const b = body || {};

  const name = str(b.name, 60);
  if (!name) errors.push('대회 이름을 입력하세요.');

  // 팀
  const rawTeams = Array.isArray(b.teams) ? b.teams.slice(0, MAX_TEAMS) : [];
  const teamIds = new Set();
  const seenMembers = new Map();   // memberId → 팀 이름 (한 선수가 두 팀에 들어가는 실수 방지)
  const teams = rawTeams.map((t, i) => {
    let tid = t && ID_RE.test(String(t.id || '')) ? String(t.id) : '';
    while (!tid || teamIds.has(tid)) tid = 't' + Math.random().toString(36).slice(2, 8);
    teamIds.add(tid);
    const tname = str(t && t.name, 30) || `${i + 1}팀`;
    const color = t && /^#[0-9a-fA-F]{6}$/.test(String(t.color || '')) ? String(t.color) : TEAM_COLORS[i % TEAM_COLORS.length];
    const players = [];
    (Array.isArray(t && t.players) ? t.players : []).forEach((p) => {
      if (!p || typeof p !== 'object') return;
      const lane = LINE_ORDER.includes(p.lane) ? p.lane : null;
      if (p.memberId != null && p.memberId !== '') {
        const mid = Number(p.memberId);
        const m = Number.isInteger(mid) ? displayMember(mid) : null;
        if (!m) { errors.push(`${tname}: 존재하지 않는 단원 id(${p.memberId}).`); return; }
        if (seenMembers.has(mid)) { errors.push(`${m.name} 단원이 ${seenMembers.get(mid)} 과(와) ${tname} 에 중복으로 들어 있습니다.`); return; }
        seenMembers.set(mid, tname);
        players.push({ memberId: mid, lane });
      } else {
        const pname = str(p.name, 30);
        if (pname) players.push({ name: pname, lane });   // 빈 자리는 버린다
      }
    });
    if (players.length > MAX_PLAYERS) errors.push(`${tname}: 선수는 최대 ${MAX_PLAYERS}명까지 등록할 수 있습니다.`);
    return { id: tid, name: tname, color, players };
  });

  // 대진
  const rawMatches = Array.isArray(b.matches) ? b.matches.slice(0, MAX_MATCHES) : [];
  const matchIds = new Set();
  const withIds = rawMatches.map((m) => {
    let mid = m && ID_RE.test(String(m.id || '')) ? String(m.id) : '';
    while (!mid || matchIds.has(mid)) mid = 'm' + Math.random().toString(36).slice(2, 8);
    matchIds.add(mid);
    return { raw: m || {}, id: mid };
  });
  const seenGames = new Set();
  const matches = withIds.map(({ raw, id: mid }, i) => {
    const label = str(raw.label, 40) || `${i + 1}경기`;
    // 자리: 팀 id, 또는 'W:경기id' / 'L:경기id' (그 경기의 승자·패자가 올라온다)
    const slot = (v) => {
      if (v == null || v === '') return null;
      const s = String(v);
      if (teamIds.has(s)) return s;
      const ref = /^([WL]):(.+)$/.exec(s);
      if (ref && matchIds.has(ref[2]) && ref[2] !== mid) return s;
      errors.push(`${label}: 팀 지정이 올바르지 않습니다.`);
      return null;
    };
    const teamA = slot(raw.teamA);
    const teamB = slot(raw.teamB);
    if (teamA && teamA === teamB) errors.push(`${label}: 양쪽에 같은 팀이 들어 있습니다.`);
    const when = str(raw.scheduledAt, 16);
    if (when && !WHEN_RE.test(when)) errors.push(`${label}: 일정 형식이 올바르지 않습니다.`);
    const games = [];
    (Array.isArray(raw.games) ? raw.games : []).forEach((g) => {
      const gid = g && g.matchId != null ? String(g.matchId) : '';
      if (!gid) return;
      if (seenGames.has(gid)) { errors.push(`${label}: 같은 내전 기록(${gid})이 두 번 연결되어 있습니다.`); return; }
      if (!store.findMatch(gid)) { errors.push(`${label}: 내전 기록 ${gid} 을(를) 찾을 수 없습니다. 삭제된 기록이면 연결을 해제하세요.`); return; }
      seenGames.add(gid);
      games.push({ matchId: gid, winner: g.winner === 'A' || g.winner === 'B' ? g.winner : null });
    });
    if (games.length > MAX_GAMES) errors.push(`${label}: 세트는 최대 ${MAX_GAMES}개까지 연결할 수 있습니다.`);
    return {
      id: mid,
      stage: STAGES.includes(raw.stage) ? raw.stage : '예선',
      label,
      teamA,
      teamB,
      bestOf: BEST_OF.includes(Number(raw.bestOf)) ? Number(raw.bestOf) : 3,
      scheduledAt: when && WHEN_RE.test(when) ? when : null,
      winner: raw.winner === 'A' || raw.winner === 'B' ? raw.winner : null,
      games,
    };
  });

  if (errors.length) return { errors };
  return {
    errors: [],
    doc: {
      id,
      name,
      subtitle: str(b.subtitle, 200),
      status: STATUSES.includes(b.status) ? b.status : '예정',
      visible: b.visible !== false,
      teams,
      matches,
      createdAt: createdAt || new Date().toISOString(),
    },
  };
}

/* ── 결과 계산 ── */
function view(doc) {
  const teamById = new Map(doc.teams.map((t) => [t.id, t]));
  const matchById = new Map(doc.matches.map((m) => [m.id, m]));
  const memberIdsOf = (teamId) => {
    const t = teamById.get(teamId);
    return t ? t.players.filter((p) => p.memberId != null).map((p) => Number(p.memberId)) : [];
  };

  const done = new Map();
  function resolveSlot(ref, stack) {
    if (!ref) return { teamId: null, label: '미정' };
    if (teamById.has(ref)) return { teamId: ref, label: teamById.get(ref).name };
    const r = /^([WL]):(.+)$/.exec(ref);
    const src = r && matchById.get(r[2]);
    if (!src || stack.has(src.id)) return { teamId: null, label: '미정' };
    const res = resolveMatch(src, stack);
    const label = `${src.label} ${r[1] === 'W' ? '승자' : '패자'}`;
    if (!res.winner) return { teamId: null, label };
    const wId = res.winner === 'A' ? res.a.teamId : res.b.teamId;
    const lId = res.winner === 'A' ? res.b.teamId : res.a.teamId;
    const teamId = r[1] === 'W' ? wId : lId;
    return { teamId, label: teamId && teamById.has(teamId) ? teamById.get(teamId).name : label };
  }

  function resolveMatch(m, stack) {
    if (done.has(m.id)) return done.get(m.id);
    const next = new Set(stack).add(m.id);
    const a = resolveSlot(m.teamA, next);
    const b = resolveSlot(m.teamB, next);
    const aIds = new Set(memberIdsOf(a.teamId));
    const bIds = new Set(memberIdsOf(b.teamId));
    const cnt = (side, ids) => side.filter((p) => !p.mercenary && ids.has(Number(p.id))).length;

    let aWins = 0, bWins = 0;
    const games = [];
    m.games.forEach((g) => {
      const mt = store.findMatch(g.matchId);
      if (!mt) return;   // 지워진 기록 — 공개 화면에서는 빼고, 관리자 화면이 연결 해제를 안내한다
      // A팀이 어느 진영이었는지: 양 팀 명단이 블루/레드에 몇 명씩 있는지로 판단
      const blueScore = cnt(mt.blue, aIds) + cnt(mt.red, bIds);
      const redScore = cnt(mt.red, aIds) + cnt(mt.blue, bIds);
      const detected = blueScore > redScore ? 'blue' : redScore > blueScore ? 'red' : null;
      let winner = g.winner;   // 관리자가 직접 정한 값이 우선
      if (!winner && detected) winner = (detected === 'blue') === mt.blueWin ? 'A' : 'B';
      const aSide = winner ? ((winner === 'A') === mt.blueWin ? 'blue' : 'red') : detected;
      if (winner === 'A') aWins++; else if (winner === 'B') bWins++;
      // memberId 는 화면에서 단원 상세로 넘어가는 링크용 (용병은 null)
      const names = (side) => side.map((p) => ({ memberId: p.mercenary ? null : Number(p.id), name: p.name, lane: p.lane || null }));
      games.push({
        matchId: String(mt.id),
        date: mt.date.toISOString(),
        dur: mt.dur || null,
        mode: mt.mode || '협곡',
        blueWin: mt.blueWin,
        winner: winner || null,
        manual: !!g.winner,
        aSide,
        hasDetails: !!store.getMatchDetails(mt.id),
        blue: names(mt.blue),
        red: names(mt.red),
      });
    });
    games.sort((x, y) => new Date(x.date) - new Date(y.date));

    const need = Math.ceil(m.bestOf / 2);
    let winner = m.winner;
    if (!winner) winner = aWins >= need && aWins > bWins ? 'A' : bWins >= need && bWins > aWins ? 'B' : null;
    const out = {
      id: m.id, stage: m.stage, label: m.label, bestOf: m.bestOf, scheduledAt: m.scheduledAt,
      a, b, aWins, bWins, winner,
      manualWinner: !!m.winner,
      status: winner ? 'done' : games.length ? 'live' : 'scheduled',
      games,
      missingGames: m.games.length - games.length,
    };
    done.set(m.id, out);
    return out;
  }

  const matches = doc.matches.map((m) => resolveMatch(m, new Set()));

  // 예선 순위 — 세트가 아니라 '경기(시리즈)' 승패 기준, 동률이면 세트 득실
  const table = new Map(doc.teams.map((t) => [t.id, { teamId: t.id, wins: 0, losses: 0, setWins: 0, setLosses: 0 }]));
  matches.filter((m) => m.stage === '예선').forEach((m) => {
    const ra = table.get(m.a.teamId), rb = table.get(m.b.teamId);
    if (ra) { ra.setWins += m.aWins; ra.setLosses += m.bWins; }
    if (rb) { rb.setWins += m.bWins; rb.setLosses += m.aWins; }
    if (!m.winner) return;
    const w = m.winner === 'A' ? ra : rb, l = m.winner === 'A' ? rb : ra;
    if (w) w.wins++;
    if (l) l.losses++;
  });
  const standings = [...table.values()].sort((x, y) =>
    y.wins - x.wins || x.losses - y.losses ||
    (y.setWins - y.setLosses) - (x.setWins - x.setLosses) || y.setWins - x.setWins);

  // 우승팀 = 마지막 결승 경기의 승자
  const final = matches.filter((m) => m.stage === '결승' && m.winner).pop();
  const championId = final ? (final.winner === 'A' ? final.a.teamId : final.b.teamId) : null;

  return {
    id: doc.id,
    name: doc.name,
    subtitle: doc.subtitle || '',
    status: doc.status,
    visible: doc.visible !== false,
    teams: doc.teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      players: t.players.map((p) => {
        if (p.memberId == null) return { name: p.name, lane: p.lane || null, mercenary: true };
        const m = displayMember(p.memberId);
        return { memberId: p.memberId, name: m ? m.name : `#${p.memberId}`, tier: m ? m.tier : null, nick: m ? m.nick : null, lane: p.lane || null };
      }),
    })),
    matches,
    standings,
    championId,
  };
}

/* ── 조회 · 변경 ── */
async function all() { return load(); }
async function get(id) { return (await load()).find((d) => d.id === id) || null; }
/* 메인 화면에 띄울 대회 — '메인 노출' 이 켜진 것 중 가장 나중에 만든 것 */
async function featured() {
  const docs = await load();
  return [...docs].reverse().find((d) => d.visible !== false) || null;
}

async function create(body) {
  const docs = await load();
  let id;
  do { id = 'ck_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); } while (docs.some((d) => d.id === id));
  const base = defaultDoc();
  const { errors, doc } = sanitize({ ...base, ...(body || {}), teams: base.teams, matches: base.matches }, id);
  if (errors.length) return { errors };
  docs.push(doc);
  return { errors: [], doc, warning: await persist(doc) };
}

async function save(id, body) {
  const docs = await load();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return { notFound: true };
  const { errors, doc } = sanitize(body, id, docs[idx].createdAt);
  if (errors.length) return { errors };
  docs[idx] = doc;
  return { errors: [], doc, warning: await persist(doc) };
}

async function remove(id) {
  const docs = await load();
  const idx = docs.findIndex((d) => d.id === id);
  if (idx < 0) return { notFound: true };
  if (docs.length === 1) return { errors: ['마지막 대회는 삭제할 수 없습니다. 메인 화면에서 숨기려면 "메인 노출" 을 끄세요.'] };
  docs.splice(idx, 1);
  if (persisted) {
    try { await sb.del(TABLE, `id=eq.${encodeURIComponent(id)}`); } catch (e) { console.error('[DB write error] tournaments:', e.message); }
  }
  return { errors: [] };
}

function isPersisted() { return persisted; }

module.exports = { all, get, featured, create, save, remove, view, isPersisted, STAGES, STATUSES, BEST_OF };
