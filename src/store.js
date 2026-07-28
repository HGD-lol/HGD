'use strict';

const fs = require('fs');
const path = require('path');

const { buildMatch, toStored } = require('./lib/match');
const { computeStats } = require('./lib/stats');
const { genMatches } = require('./lib/sample');
const { setRoster, setOverlay, ADDED_BASE } = require('./lib/members');
const { loadRosterRows } = require('./lib/roster-source');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MATCH_FILE = path.join(DATA_DIR, 'matches.json');
const OVERLAY_FILE = path.join(DATA_DIR, 'members-override.json');

/*
 * 저장소.
 * init(): 시트 로스터 로드 → 관리자 오버레이 적용 → 샘플 전적 생성 → 사용자 전적 로드.
 * 로스터 오버레이(단원 편집/추가/삭제)와 사용자 매치는 data/*.json 에 영속.
 */
const BOOT_MS = Date.now();
let sampleMatches = [];
let userMatches = [];
let overlay = { edits: {}, added: [], removed: [] };
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

/* ── 관리자 오버레이 ── */
function loadOverlay() {
  const o = readJson(OVERLAY_FILE, {});
  return { edits: o.edits || {}, added: o.added || [], removed: o.removed || [] };
}
function saveOverlay() {
  ensureDir();
  fs.writeFileSync(OVERLAY_FILE, JSON.stringify(overlay, null, 2), 'utf8');
}
function applyOverlay() {
  setOverlay(overlay);
  saveOverlay();
  invalidate();
}

function invalidate() {
  cachedAll = null;
  cachedStats = null;
}

/* 부팅/새로고침 */
async function init() {
  const r = await loadRosterRows();
  setRoster(r.rows);
  overlay = loadOverlay();
  setOverlay(overlay);
  rosterInfo = { source: r.source, count: r.rows.length, url: r.url, reason: r.reason, fetchedAt: r.fetchedAt };
  sampleMatches = genMatches(26, BOOT_MS);
  userMatches = loadUser();
  invalidate();
  return rosterInfo;
}

/* ── 조회 ── */
function allMatches() {
  if (!cachedAll) cachedAll = [...userMatches, ...sampleMatches].sort((a, b) => b.date - a.date);
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

/* ── 단원 관리 (오버레이) ── */
function editMember(id, patch) {
  const num = Number(id);
  if (num >= ADDED_BASE) {
    const idx = num - ADDED_BASE;
    if (!overlay.added[idx]) return false;
    overlay.added[idx] = { ...overlay.added[idx], ...patch };
  } else {
    overlay.edits[num] = { ...(overlay.edits[num] || {}), ...patch };
  }
  applyOverlay();
  return true;
}
function addMember(obj) {
  overlay.added.push(obj);
  const id = ADDED_BASE + overlay.added.length - 1;
  applyOverlay();
  return id;
}
function removeMember(id) {
  const num = Number(id);
  if (!overlay.removed.map(Number).includes(num)) overlay.removed.push(num);
  applyOverlay();
  return true;
}
function restoreMember(id) {
  overlay.removed = overlay.removed.filter((x) => Number(x) !== Number(id));
  applyOverlay();
  return true;
}

function counts() {
  return { matches: allMatches().length, userMatches: userMatches.length, sampleMatches: sampleMatches.length };
}
function roster() {
  return rosterInfo;
}

module.exports = {
  init,
  allMatches,
  stats,
  findMatch,
  addUserMatch,
  replaceUserMatch,
  deleteUserMatch,
  editMember,
  addMember,
  removeMember,
  restoreMember,
  counts,
  roster,
};
