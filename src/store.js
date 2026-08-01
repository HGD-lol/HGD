'use strict';

const fs = require('fs');
const path = require('path');

const { buildMatch, toStored } = require('./lib/match');
const { computeStats } = require('./lib/stats');
const { loadMembers, toStoredMember, memberById, members, nextId } = require('./lib/members');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MATCH_FILE = path.join(DATA_DIR, 'matches.json');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const DASH_CONFIG_FILE = path.join(DATA_DIR, 'dashboard-config.json');

let userMatches = [];
let pendingMatches = [];
let dashConfig = { title: '협곡단 내전 기록실', description: '단원 명단과 티어, 내전 전적을 한곳에서. 소환사의 협곡, 블루팀과 레드팀의 모든 대전을 기록합니다.', season: '2026 Split 2' };
let rosterInfo = { source: 'uninitialized', count: 0 };
let cachedAll = null;
let cachedStats = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/* ── 단원 JSON ── */
function loadMembersFile() {
  return readJson(MEMBERS_FILE, null);
}
function saveMembers() {
  ensureDir();
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members.map(toStoredMember), null, 2), 'utf8');
}

/* ── Google Sheets → JSON 가져오기 ── */
async function importFromSheet() {
  const { loadRosterRows } = require('./lib/roster-source');
  const r = await loadRosterRows();
  const memberList = r.rows.map((row, i) => ({
    id: i,
    name: row[0],
    birth: row[1],
    nick: row[2] || '',
    tier: row[3] || '언랭',
    main: row[4] ? String(row[4]).split(',').map(s => s.trim()).filter(Boolean) : [],
    sub: row[5] ? String(row[5]).split(',').map(s => s.trim()).filter(Boolean) : [],
    role: row[6] || '단원',
    hidden: false,
  }));
  loadMembers(memberList);
  saveMembers();
  invalidate();
  rosterInfo = { source: r.source, count: memberList.length, fetchedAt: new Date().toISOString() };
  return rosterInfo;
}

/* ── 사용자 매치 ── */
function loadUser() {
  const raw = readJson(MATCH_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => buildMatch({ ...m, date: new Date(m.date) }));
}
function saveUser() {
  ensureDir();
  fs.writeFileSync(MATCH_FILE, JSON.stringify(userMatches.map(toStored), null, 2), 'utf8');
}

/* ── 대기 매치 (pending) ── */
function loadPending() {
  const raw = readJson(PENDING_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw;
}
function savePending() {
  ensureDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingMatches, null, 2), 'utf8');
}

/* ── 대시보드 설정 ── */
function loadDashConfig() {
  return readJson(DASH_CONFIG_FILE, dashConfig);
}
function saveDashConfig() {
  ensureDir();
  fs.writeFileSync(DASH_CONFIG_FILE, JSON.stringify(dashConfig, null, 2), 'utf8');
}

function invalidate() {
  cachedAll = null;
  cachedStats = null;
}

/* 부팅 */
async function init() {
  const saved = loadMembersFile();
  if (saved && Array.isArray(saved) && saved.length > 0) {
    // JSON 파일이 이미 있으면 그걸 사용
    loadMembers(saved);
    rosterInfo = { source: 'json', count: saved.length };
  } else {
    // 최초 실행: Google Sheets에서 가져와서 JSON으로 저장
    await importFromSheet();
  }
  userMatches = loadUser();
  pendingMatches = loadPending();
  dashConfig = loadDashConfig();
  invalidate();
  return rosterInfo;
}

/* ── 조회 ── */
function allMatches() {
  if (!cachedAll) cachedAll = [...userMatches].sort((a, b) => b.date - a.date);
  return cachedAll;
}
function stats() {
  if (!cachedStats) cachedStats = computeStats(allMatches());
  return cachedStats;
}
function findMatch(id) {
  return allMatches().find((m) => String(m.id) === String(id)) || null;
}

/* ── 매치 변경 ── */
function addUserMatch(match) {
  userMatches.unshift(match);
  saveUser();
  invalidate();
  return match;
}
function replaceUserMatch(id, match) {
  const idx = userMatches.findIndex((m) => String(m.id) === String(id));
  if (idx < 0) return false;
  userMatches[idx] = match;
  saveUser();
  invalidate();
  return true;
}
function deleteUserMatch(id) {
  const before = userMatches.length;
  userMatches = userMatches.filter((m) => String(m.id) !== String(id));
  if (userMatches.length === before) return false;
  saveUser();
  invalidate();
  return true;
}

/* ── 대기 매치 (pending) ── */
function addPending(p) {
  pendingMatches.unshift(p);
  savePending();
  return p;
}
function getPending() {
  return pendingMatches;
}
function findPending(id) {
  return pendingMatches.find((p) => String(p.id) === String(id)) || null;
}
function deletePending(id) {
  const before = pendingMatches.length;
  pendingMatches = pendingMatches.filter((p) => String(p.id) !== String(id));
  if (pendingMatches.length === before) return false;
  savePending();
  return true;
}

/* ── 대시보드 설정 ── */
function getDashConfig() {
  return { ...dashConfig };
}
function setDashConfig(cfg) {
  dashConfig = { ...dashConfig, ...cfg };
  saveDashConfig();
  return dashConfig;
}

/* ── 단원 관리 (JSON 직접 수정) ── */
function editMember(id, patch) {
  const m = memberById(Number(id));
  if (!m) return false;
  // 저장된 데이터에서 해당 단원 찾아서 패치 적용
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  Object.assign(members[idx], patch);
  // 리빌드: 저장 후 다시 로드
  const stored = members.map(toStoredMember);
  stored[idx] = { ...stored[idx], ...patch };
  loadMembers(stored);
  saveMembers();
  invalidate();
  return true;
}
function addMember(obj) {
  const id = nextId();
  const newMember = { id, ...obj, hidden: false };
  const stored = members.map(toStoredMember);
  stored.push(newMember);
  loadMembers(stored);
  saveMembers();
  invalidate();
  return id;
}
function removeMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx].hidden = true;
  loadMembers(stored);
  saveMembers();
  invalidate();
  return true;
}
function restoreMember(id) {
  const idx = members.findIndex(x => x.id === Number(id));
  if (idx < 0) return false;
  const stored = members.map(toStoredMember);
  stored[idx].hidden = false;
  loadMembers(stored);
  saveMembers();
  invalidate();
  return true;
}

function counts() {
  return { matches: allMatches().length, userMatches: userMatches.length, pending: pendingMatches.length };
}
function roster() {
  return rosterInfo;
}

module.exports = {
  init,
  importFromSheet,
  allMatches,
  stats,
  findMatch,
  addUserMatch,
  replaceUserMatch,
  deleteUserMatch,
  addPending,
  getPending,
  findPending,
  deletePending,
  getDashConfig,
  setDashConfig,
  editMember,
  addMember,
  removeMember,
  restoreMember,
  counts,
  roster,
};
