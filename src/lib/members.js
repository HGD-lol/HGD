'use strict';

const { SEASON_YEAR } = require('./scales');

/*
 * 단원 데이터 — data/members.json 에서 직접 로드/저장.
 * members / pool 은 같은 배열 인스턴스를 유지한 채 내용만 교체한다(다른 모듈의 참조 보존).
 * 삭제는 소프트(hidden=true) — 과거 매치가 이름을 계속 해석할 수 있게 슬롯을 남긴다.
 */
const members = [];      // 전체(숨김 포함)
const pool = [];         // 활동 풀(예비·숨김 제외)
const byId = new Map();

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

  memberList.forEach(raw => {
    const m = buildFromObj(raw);
    members.push(m);
    byId.set(m.id, m);
    if (!m.hidden && m.role !== '예비') pool.push(m);
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
    hidden: m.hidden,
  };
}

function memberById(id) {
  return byId.get(Number(id));
}
/* 숨김 제외 활동 명단 */
function activeMembers() {
  return members.filter(m => !m.hidden);
}
/* 다음 사용 가능한 ID */
function nextId() {
  if (!members.length) return 0;
  return Math.max(...members.map(m => m.id)) + 1;
}

module.exports = { members, pool, byId, memberById, activeMembers, loadMembers, toStoredMember, nextId };
