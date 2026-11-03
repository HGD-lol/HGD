'use strict';

const { SEASON_YEAR, TIER_RANK } = require('./scales');

/*
 * 단원 데이터 — Supabase members 행에서 로드/저장.
 * members / pool 은 같은 배열 인스턴스를 유지한 채 내용만 교체한다(다른 모듈의 참조 보존).
 * 삭제는 소프트(hidden=true) — 과거 매치가 이름을 계속 해석할 수 있게 슬롯을 남긴다.
 * 완전삭제는 묘비(role='삭제') — 명단·풀·통계에서는 빠지되 이름/티어는 남겨 과거 기록을 해석한다.
 *
 * 계정(부계정 포함)은 accounts 배열이 원본이다.
 *   accounts : [{ nick, puuid, tier, rank, lp, fetchedAt }]  — tier/rank/lp 는 솔로랭크, fetchedAt 은 마지막 조회 시각
 *   nicks    : 닉네임 문자열만 뽑은 파생값 (검색·표시용)
 *   nick     : 대표 계정 닉네임 = accounts[0].nick
 *   solo*    : 계정 중 가장 높은 솔로랭크(부계정이 더 높으면 그쪽)
 *   tier     : 실제로 쓰는 티어 — 관리자가 고른 baseTier 가 우선, 언랭이면 라이엇에서 받은 soloTier, 그것도 없으면 언랭
 *   baseTier : 시트/관리자가 직접 넣은 티어 (DB members.tier 에 저장되는 값)
 * 명단·경매·밸런서·대시보드가 모두 m.tier 를 보므로, 여기서 한 번만 바꾸면 전 화면에 적용된다.
 * DB 에는 members.nicks(jsonb) 한 칸에 accounts 배열을 통째로 넣는다.
 * 예전 형식(문자열 배열, 또는 nick 문자열 하나)도 읽을 때 자동으로 계정 객체로 올라간다.
 */
const DELETED_ROLE = '삭제';   // 완전삭제 표식 (ROLES 에 없는 값이라 관리자 입력으로는 만들 수 없다)

const members = [];      // 전체(숨김 포함, 묘비 제외)
const pool = [];         // 활동 풀(예비·숨김 제외)
const byId = new Map();
const deletedById = new Map();   // 완전삭제된 단원(묘비) — 이름 해석 전용
const byNick = new Map();        // 정규화된 닉네임 → 단원 (부계정 포함, 묘비 제외)
const byPuuid = new Map();       // PUUID → 단원 (라이엇 기록 매칭용)

/* 닉네임 비교용 키 — 대소문자·공백 차이는 같은 닉으로 본다 */
function normNick(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
}

/* 숫자 필드 — 빈 값은 0 이 아니라 '모름'(null) 이다 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/* 계정 한 건 정규화 — 문자열이면 닉네임만 있는 계정으로 본다 */
function buildAccount(raw) {
  if (raw && typeof raw === 'object') {
    return {
      nick: String(raw.nick == null ? '' : raw.nick).trim(),
      puuid: raw.puuid ? String(raw.puuid).trim() : null,
      tier: raw.tier || null,          // 솔로랭크 티어 (한글 표기, 언랭 포함)
      rank: raw.rank || null,          // 세부 등급 I~IV (마스터 이상은 null)
      lp: numOrNull(raw.lp),           // 솔로랭크 LP
      fetchedAt: raw.fetchedAt ? String(raw.fetchedAt) : null,   // 라이엇에서 마지막으로 확인한 시각(ISO)
    };
  }
  return { nick: String(raw == null ? '' : raw).trim(), puuid: null, tier: null, rank: null, lp: null, fetchedAt: null };
}

/* 세부 등급 비교값 — 마스터 이상은 등급이 없어 가장 높게 본다 */
const DIV_RANK = { I: 4, II: 3, III: 2, IV: 1 };

/* 계정 하나의 솔로랭크 비교값 (티어 → 세부 등급 → LP). 언랭/미조회는 -1 */
function accountRankScore(a) {
  if (!a || !a.tier || a.tier === '언랭') return -1;
  const div = a.rank ? (DIV_RANK[a.rank] || 0) : 5;
  return (TIER_RANK[a.tier] || 0) * 1e6 + div * 1e4 + (a.lp || 0);
}

/* 계정 중 가장 높은 솔로랭크 계정 — 대표 계정보다 부계정이 높으면 부계정이 나온다 */
function bestAccount(accounts) {
  let best = null;
  (accounts || []).forEach((a) => { if (accountRankScore(a) > accountRankScore(best)) best = a; });
  return accountRankScore(best) >= 0 ? best : null;
}

/* 계정 입력 → 계정 배열. 배열(문자열/객체)·쉼표 문자열 모두 받고 빈 값과 중복 닉은 버린다 */
function parseAccounts(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\n]/);
  const out = [];
  const seen = new Set();
  list.forEach((v) => {
    const acc = buildAccount(v);
    if (!acc.nick) return;
    const key = normNick(acc.nick);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(acc);
  });
  return out;
}

/* 닉네임 문자열만 필요할 때 */
function parseNicks(raw) {
  return parseAccounts(raw).map((a) => a.nick);
}

/* 저장된 단원 객체 → 내부 단원 객체 */
function buildFromObj(m) {
  const mainArr = Array.isArray(m.main) ? m.main : (m.main ? String(m.main).split(',').map(s => s.trim()).filter(Boolean) : []);
  const subArr = Array.isArray(m.sub) ? m.sub : (m.sub ? String(m.sub).split(',').map(s => s.trim()).filter(Boolean) : []);
  // accounts(새) → nicks(DB 컬럼) → nick(제일 오래된 형식) 순으로 살아있는 값을 쓴다
  const rawAcc = (Array.isArray(m.accounts) && m.accounts.length) ? m.accounts
    : ((Array.isArray(m.nicks) ? m.nicks.length : m.nicks) ? m.nicks : m.nick);
  const accounts = parseAccounts(rawAcc);
  const best = bestAccount(accounts);   // 솔로랭크 표기는 대표가 아니라 '가장 높은 계정' 기준
  const anyFetched = accounts.find(a => a.tier);   // 조회는 했지만 전 계정이 언랭인 경우
  const baseTier = m.tier || '언랭';    // 관리자가 직접 고른 티어 — 이 값이 최우선이다
  const soloTier = best ? best.tier : (anyFetched ? '언랭' : null);   // 계정 중 최고 솔로랭크 (미조회면 null)
  return {
    id: m.id,
    name: m.name,
    birth: m.birth,
    age: SEASON_YEAR - Number(m.birth),
    nick: accounts.length ? accounts[0].nick : '',   // 대표 닉 — 카드·칩 등 한 줄만 보여주는 자리
    nicks: accounts.map(a => a.nick),                // 검색·표시용 문자열 목록
    accounts,                                        // 부계정 포함 전체 (puuid, tier, rank, lp, fetchedAt)
    soloTier,                                        // 계정 중 최고 솔로랭크 (미조회면 null)
    soloRank: best ? best.rank : null,
    soloLp: best ? best.lp : null,
    soloNick: best ? best.nick : (anyFetched ? anyFetched.nick : null),   // 그 티어가 나온 계정 — 대표와 다를 수 있다
    // 관리자가 고른 티어 → 라이엇 조회 티어 → 언랭 (전 화면 공통)
    tier: baseTier !== '언랭' ? baseTier : (soloTier || '언랭'),
    baseTier,                            // 관리자 화면에서 직접 고치는 값
    main: mainArr,
    sub: subArr,
    role: m.role || '단원',
    joined: m.joined || null,       // 가입날짜 'YYYY-MM-DD' (모르면 null)
    lines: [...new Set([...mainArr, ...subArr].filter(x => x && x !== '올라이너'))],
    allLaner: subArr.includes('올라이너') || (typeof m.sub === 'string' && m.sub.trim() === '올라이너'),
    hidden: !!m.hidden,
  };
}

/* 단원 배열로 전체 리빌드 */
function loadMembers(memberList) {
  members.length = 0;
  pool.length = 0;
  byId.clear();
  byNick.clear();
  byPuuid.clear();

  deletedById.clear();

  memberList.forEach(raw => {
    if (raw && raw.role === DELETED_ROLE) return;   // 묘비는 명단에 넣지 않는다
    const m = buildFromObj(raw);
    members.push(m);
    byId.set(m.id, m);
    // 같은 닉/PUUID 를 두 단원이 들고 있으면 먼저 등록된 쪽이 이긴다 (입력 단계에서 막는다)
    m.accounts.forEach(a => {
      const k = normNick(a.nick);
      if (!byNick.has(k)) byNick.set(k, m);
      // 태그 없이 게임네임만으로도 매칭되게 (예: '청호한#999' → '청호한' 으로도 찾을 수 있다)
      const hashIdx = k.lastIndexOf('#');
      if (hashIdx > 0) {
        const nameOnly = k.slice(0, hashIdx);
        if (!byNick.has(nameOnly)) byNick.set(nameOnly, m);
      }
      if (a.puuid && !byPuuid.has(a.puuid)) byPuuid.set(a.puuid, m);
    });
    if (!m.hidden && m.role !== '예비') pool.push(m);
  });

  memberList.forEach(raw => {
    if (!raw || raw.role !== DELETED_ROLE) return;
    const m = buildFromObj(raw);
    if (byId.has(m.id)) return;                     // 살아있는 단원과 id 가 겹치면 묘비를 버린다
    deletedById.set(m.id, { ...m, deleted: true });
  });

  return members;
}

/* 저장용 직렬화 (age, lines, allLaner 등 파생 필드 제외) — DB 컬럼과 1:1 */
function toStoredMember(m) {
  const accounts = parseAccounts((Array.isArray(m.accounts) && m.accounts.length) ? m.accounts : (m.nicks || m.nick));
  return {
    id: m.id,
    name: m.name,
    birth: m.birth,
    nick: accounts.length ? accounts[0].nick : '',   // 대표 닉 — 시트/예전 화면 호환용으로 계속 채워둔다
    nicks: accounts,                                 // members.nicks(jsonb) = 계정 배열
    tier: m.baseTier != null ? m.baseTier : m.tier,  // 저장은 항상 수동 티어 (파생 티어를 덮어쓰지 않게)
    main: m.main,
    sub: m.sub,
    role: m.role,
    joined: m.joined || null,
    hidden: m.hidden,
  };
}

function memberById(id) {
  return byId.get(Number(id));
}
/* 닉네임(부계정 포함)으로 단원 찾기 — 대소문자·공백 무시 */
function memberByNick(nick) {
  return byNick.get(normNick(nick)) || null;
}
/* PUUID 로 단원 찾기 — 라이엇 전적을 단원에 붙일 때 쓴다 */
function memberByPuuid(puuid) {
  return puuid ? (byPuuid.get(String(puuid).trim()) || null) : null;
}
/* 이름 표시용 조회 — 완전삭제된 단원(묘비)까지 찾는다. 명단 검증에는 memberById 를 써야 한다. */
function displayMember(id) {
  return byId.get(Number(id)) || deletedById.get(Number(id)) || null;
}
/* 완전삭제된 단원(묘비) 목록 */
function deletedMembers() {
  return [...deletedById.values()];
}
/* 숨김 제외 활동 명단 */
function activeMembers() {
  return members.filter(m => !m.hidden);
}
/* 다음 사용 가능한 ID — 묘비 id 까지 피한다(재사용하면 과거 기록이 엉뚱한 사람 이름이 된다) */
function nextId() {
  const ids = [...members.map(m => m.id), ...deletedById.keys()];
  if (!ids.length) return 0;
  return Math.max(...ids) + 1;
}

module.exports = {
  members, pool, byId, deletedById, byNick, byPuuid,
  memberById, memberByNick, memberByPuuid, displayMember, deletedMembers, activeMembers,
  loadMembers, buildFromObj, toStoredMember, nextId, normNick, parseNicks, parseAccounts, bestAccount, DELETED_ROLE,
};
