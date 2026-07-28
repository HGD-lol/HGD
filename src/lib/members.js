'use strict';

const { SEASON_YEAR } = require('./scales');

/*
 * 단원 데이터 = 시트 기반 로스터(setRoster) + 관리자 오버레이(setOverlay).
 * members / pool 은 같은 배열 인스턴스를 유지한 채 내용만 교체한다(다른 모듈의 참조 보존).
 * id 는 안정적으로 유지된다:
 *   - 시트 단원 : 행 인덱스 (0..)
 *   - 추가 단원 : ADDED_BASE(1000)+순번
 * 삭제는 소프트(hidden=true) — 과거 매치가 이름을 계속 해석할 수 있게 슬롯을 남긴다.
 */
const members = [];      // 전체(숨김 포함)
const pool = [];         // 활동 풀(예비·숨김 제외)
const byId = new Map();

const ADDED_BASE = 1000;
const COL = { name: 0, birth: 1, nick: 2, tier: 3, main: 4, sub: 5, role: 6 };

let _rows = [];
let _overlay = { edits: {}, added: [], removed: [] };

/* RAW 행 → 단원 객체 */
function buildMember(r, id) {
  const mainRaw = r[4] ? String(r[4]).split(',') : [];
  const subRaw = r[5] ? String(r[5]).split(',') : [];
  return {
    id,
    name: r[0],
    birth: r[1],
    age: SEASON_YEAR - Number(r[1]),
    nick: r[2] || '',
    tier: r[3] || '언랭',
    main: r[4] ? String(r[4]).split(',').map((s) => s.trim()) : [],
    sub: r[5] ? String(r[5]).split(',').map((s) => s.trim()) : [],
    role: r[6] || '단원',
    lines: [...new Set([...mainRaw, ...subRaw].map((s) => s.trim()).filter((x) => x && x !== '올라이너'))],
    allLaner: String(r[5]).trim() === '올라이너',
    added: id >= ADDED_BASE,
    hidden: false,
  };
}

function normLineValue(v) {
  return Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v);
}
function rawFromObj(a) {
  return [
    a.name,
    Number(a.birth) || SEASON_YEAR,
    a.nick || '',
    a.tier || '언랭',
    normLineValue(a.main),
    normLineValue(a.sub),
    a.role || '단원',
  ];
}
function applyPatchToRow(row, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in COL)) continue;
    if (k === 'main' || k === 'sub') row[COL[k]] = normLineValue(v);
    else if (k === 'birth') row[COL[k]] = Number(v);
    else row[COL[k]] = v;
  }
}

function rebuild() {
  members.length = 0;
  pool.length = 0;
  byId.clear();

  const finalRows = _rows.map((r, i) => ({ id: i, row: r.slice() }));
  // 편집
  for (const [id, patch] of Object.entries(_overlay.edits || {})) {
    const t = finalRows.find((x) => x.id === Number(id));
    if (t) applyPatchToRow(t.row, patch);
  }
  // 추가
  (_overlay.added || []).forEach((a, i) => finalRows.push({ id: ADDED_BASE + i, row: rawFromObj(a) }));

  const removed = new Set((_overlay.removed || []).map(Number));
  finalRows.forEach(({ id, row }) => {
    const m = buildMember(row, id);
    m.hidden = removed.has(id);
    members.push(m);
    byId.set(id, m);
    if (!m.hidden && m.role !== '예비') pool.push(m);
  });
  return members;
}

/* 시트 기반 로스터 교체 */
function setRoster(rows) {
  _rows = rows.map((r) => r.slice());
  return rebuild();
}
/* 관리자 오버레이 교체 */
function setOverlay(overlay) {
  _overlay = { edits: {}, added: [], removed: [], ...(overlay || {}) };
  return rebuild();
}

function memberById(id) {
  return byId.get(Number(id));
}
/* 숨김 제외 활동 명단 */
function activeMembers() {
  return members.filter((m) => !m.hidden);
}

module.exports = { members, pool, byId, memberById, activeMembers, setRoster, setOverlay, ADDED_BASE };
