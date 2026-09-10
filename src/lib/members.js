'use strict';

const { SEASON_YEAR } = require('./scales');

/*
 * 단원 데이터 — data/members.json 에서 직접 로드/저장.
 * members / pool 은 같은 배열 인스턴스를 유지한 채 내용만 교체한다(다른 모듈의 참조 보존).
 * 삭제는 소프트(hidden=true) — 과거 매치가 이름을 계속 해석할 수 있게 슬롯을 남긴다.
 * 완전삭제는 묘비(role='삭제') — 명단·풀·통계에서는 빠지되 이름/티어는 남겨 과거 기록을 해석한다.
 */
const DELETED_ROLE = '삭제';   // 완전삭제 표식 (ROLES 에 없는 값이라 관리자 입력으로는 만들 수 없다)

const members = [];      // 전체(숨김 포함, 묘비 제외)
const pool = [];         // 활동 풀(예비·숨김 제외)
const byId = new Map();
const deletedById = new Map();   // 완전삭제된 단원(묘비) — 이름 해석 전용

/* 저장된 단원 객체 → 내부 단원 객체 */
function buildFromObj(m) {
  const mainArr = Array.isArray(m.main) ? m.main : (m.main ? String(m.main).split(',').map(s => s.trim()).filter(Boolean) : []);
  const subArr = Array.isArray(m.sub) ? m.sub : (m.sub ? String(m.sub).split(',').map(s => s.trim()).filter(Boolean) : []);
  return {
    id: m.id,
    name: m.name,
    birth: m.birth,
    age: SEASON_YEAR - Number(m.birth),
    nick: m.nick || '',
    tier: m.tier || '언랭',
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

  deletedById.clear();

  memberList.forEach(raw => {
    if (raw && raw.role === DELETED_ROLE) return;   // 묘비는 명단에 넣지 않는다
    const m = buildFromObj(raw);
    members.push(m);
    byId.set(m.id, m);
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

/* 저장용 직렬화 (age, lines, allLaner 등 파생 필드 제외) */
function toStoredMember(m) {
  return {
    id: m.id,
    name: m.name,
    birth: m.birth,
    nick: m.nick,
    tier: m.tier,
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
  members, pool, byId, deletedById,
  memberById, displayMember, deletedMembers, activeMembers,
  loadMembers, toStoredMember, nextId, DELETED_ROLE,
};
