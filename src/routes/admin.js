'use strict';

const express = require('express');
const store = require('../store');
const { members, memberById, memberByNick, memberByPuuid, parseAccounts } = require('../lib/members');
const { TIER_ORDER, LINE_ORDER } = require('../lib/scales');
const { COOKIE, TTL_MS, USING_DEFAULTS, makeToken, checkPassword, isAdmin, requireAdmin } = require('../lib/auth');
const riot = require('../lib/riot');

const router = express.Router();

const ROLES = ['단장', '부단장', '단원', '예비'];
const MAX_NICKS = 8;        // 부계정까지 쳐도 이 이상은 오타·복붙 사고로 본다
const MAX_NICK_LEN = 40;
const PUUID_RE = /^[A-Za-z0-9_-]{20,128}$/;   // 라이엇 PUUID (보통 78자 base64url)
const RANKS = ['I', 'II', 'III', 'IV'];
const LINE_VALUES = new Set([...LINE_ORDER, '올라이너']);

/* ── 인증 ── */
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'bad_password', message: '비밀번호가 올바르지 않습니다.' });
  }
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const authed = isAdmin(req);
  // nicksColumn=false 면 계정(닉네임) 변경이 DB 에 저장되지 않는다 — 관리자 화면에서 경고를 띄운다
  res.json({ authed, usingDefaults: USING_DEFAULTS, ...(authed ? { nicksColumn: store.nicksPersisted() } : {}) });
});

/* ── 대시보드 설정 ── */
router.get('/dashboard-config', requireAdmin, (req, res) => {
  res.json(store.getDashConfig());
});

router.patch('/dashboard-config', requireAdmin, (req, res) => {
  const { title, description, season, matchRegistrationEnabled } = req.body || {};
  const patch = {};
  if (title !== undefined) patch.title = String(title).trim();
  if (description !== undefined) patch.description = String(description).trim();
  if (season !== undefined) patch.season = String(season).trim();
  if (matchRegistrationEnabled !== undefined) patch.matchRegistrationEnabled = !!matchRegistrationEnabled;
  const cfg = store.setDashConfig(patch);
  res.json(cfg);
});

/* ── 시즌 관리 ── */
router.get('/seasons', requireAdmin, (req, res) => {
  res.json({ seasons: store.getSeasons(), current: store.getCurrentSeason() });
});

router.post('/seasons', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'validation_failed', messages: ['시즌 이름을 입력하세요.'] });
  }
  const season = store.createSeason(String(name).trim());
  res.status(201).json(season);
});

/* ── 데이터 백업 ── */
/* 백업 대상 — Supabase 의 모든 테이블. orderBy 는 페이지네이션이 어긋나지 않도록 PK 기준.
   테이블을 새로 추가하면 여기에도 넣어야 백업에 포함된다. */
const BACKUP_TABLES = [
  { key: 'members',            table: 'members',            orderBy: 'id.asc' },
  { key: 'matches',            table: 'matches',            orderBy: 'id.asc' },
  { key: 'pending',            table: 'pending',            orderBy: 'id.asc' },
  { key: 'seasons',            table: 'seasons',            orderBy: 'id.asc' },
  { key: 'dashboard_config',   table: 'dashboard_config',   orderBy: 'id.asc' },
  { key: 'match_details',      table: 'match_details',      orderBy: 'match_id.asc' },
  { key: 'match_participants', table: 'match_participants', orderBy: 'id.asc' },
  { key: 'mvp_votes',          table: 'mvp_votes',          orderBy: 'match_id.asc,voter_id.asc' },
  { key: 'riot_matches',       table: 'riot_matches',       orderBy: 'match_id.asc' },
  { key: 'updates',            table: 'updates',            orderBy: 'id.asc' },
  { key: 'suggestions',        table: 'suggestions',        orderBy: 'id.asc' },
];

router.get('/backup', requireAdmin, async (req, res) => {
  try {
    const sb = require('../lib/supabase');
    const backup = { exportedAt: new Date().toISOString(), counts: {}, errors: {} };
    // 테이블 하나가 없거나 실패해도 나머지는 받아지도록 개별로 감싼다
    await Promise.all(BACKUP_TABLES.map(async ({ key, table, orderBy }) => {
      try {
        const rows = await sb.selectAll(table, orderBy);
        backup[key] = rows;
        backup.counts[key] = rows.length;
      } catch (e) {
        backup[key] = [];
        backup.counts[key] = 0;
        backup.errors[key] = e.message;
      }
    }));
    // 예전 백업 파일과 같은 키도 유지한다
    backup.dashboardConfig = backup.dashboard_config[0] || {};
    if (!Object.keys(backup.errors).length) delete backup.errors;
    const filename = `hgd-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) {
    res.status(500).json({ error: 'backup_failed', message: e.message });
  }
});

/* 오늘(KST) — 'YYYY-MM-DD'. UTC 로 자르면 한국 밤 시간에 하루 밀린다 */
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/* ── 단원 입력 검증 ── */
function validateMember(body, { partial, id } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => body && body[k] !== undefined;

  if (!partial || has('name')) {
    if (!body || !String(body.name || '').trim()) errors.push('이름을 입력하세요.');
    else out.name = String(body.name).trim();
  }
  if (has('birth')) {
    const b = Number(body.birth);
    if (!Number.isFinite(b) || b < 1900 || b > 2100) errors.push('출생연도가 올바르지 않습니다.');
    else out.birth = b;
  }
  /* 계정 — 닉네임 + PUUID + 마지막 조회 시각. 배열/쉼표 문자열 모두 받고 첫 번째가 대표 계정이 된다 */
  if (has('accounts') || has('nicks') || has('nick')) {
    const list = parseAccounts(has('accounts') ? body.accounts : (has('nicks') ? body.nicks : body.nick));
    if (list.length > MAX_NICKS) errors.push(`계정은 최대 ${MAX_NICKS}개까지 등록할 수 있습니다.`);
    list.forEach((a) => {
      if (a.nick.length > MAX_NICK_LEN) errors.push(`닉네임이 너무 깁니다(최대 ${MAX_NICK_LEN}자): ${a.nick.slice(0, 20)}…`);
      // 다른 단원이 이미 쓰는 닉/PUUID 면 막는다 — 부계정을 엉뚱한 사람에게 붙이는 사고를 예방
      const owner = memberByNick(a.nick);
      if (owner && owner.id !== id) errors.push(`'${a.nick}' 는 이미 ${owner.name} 단원의 계정입니다.`);
      if (a.puuid) {
        if (!PUUID_RE.test(a.puuid)) errors.push(`'${a.nick}' 의 PUUID 형식이 올바르지 않습니다.`);
        const puuidOwner = memberByPuuid(a.puuid);
        if (puuidOwner && puuidOwner.id !== id) errors.push(`'${a.nick}' 의 PUUID 는 이미 ${puuidOwner.name} 단원의 계정입니다.`);
      }
      if (a.tier && !TIER_ORDER.includes(a.tier)) errors.push(`'${a.nick}' 의 티어 값이 올바르지 않습니다.`);
      if (a.rank && !RANKS.includes(a.rank)) errors.push(`'${a.nick}' 의 세부 등급은 ${RANKS.join('/')} 중 하나여야 합니다.`);
      if (a.lp !== null && (a.lp < 0 || a.lp > 10000)) errors.push(`'${a.nick}' 의 LP 가 올바르지 않습니다.`);
      if (a.fetchedAt && Number.isNaN(new Date(a.fetchedAt).getTime())) {
        errors.push(`'${a.nick}' 의 조회 시각 형식이 올바르지 않습니다.`);
      }
    });
    out.accounts = list;
    out.nick = list.length ? list[0].nick : '';
  }
  if (has('joined')) {
    const v = String(body.joined || '').trim();
    if (!v) out.joined = null;                                   // 비우면 '모름'
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) {
      errors.push('가입날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
    } else out.joined = v;
  }
  if (has('tier')) {
    if (!TIER_ORDER.includes(body.tier)) errors.push(`티어는 ${TIER_ORDER.join('/')} 중 하나여야 합니다.`);
    else out.tier = body.tier;
  }
  if (has('role')) {
    if (!ROLES.includes(body.role)) errors.push(`직책은 ${ROLES.join('/')} 중 하나여야 합니다.`);
    else out.role = body.role;
  }
  ['main', 'sub'].forEach((key) => {
    if (!has(key)) return;
    const arr = Array.isArray(body[key])
      ? body[key]
      : String(body[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = arr.filter((l) => !LINE_VALUES.has(l));
    if (bad.length) errors.push(`${key === 'main' ? '주라인' : '부라인'}에 알 수 없는 값: ${bad.join(', ')}`);
    else out[key] = arr;
  });

  return { errors, value: out };
}

/* ── 라이엇 조회 ──
   계정에 PUUID 가 없으면 account-v1 로 먼저 받아 채우고, league-v4 로 솔로랭크 티어/LP 를 갱신한다.
   한 계정이 실패해도 나머지는 계속 돌리고, 실패 사유만 모아서 돌려준다. */
function riotKeyGuard(res) {
  if (riot.HAS_KEY) return false;
  res.status(400).json({ error: 'no_riot_key', messages: ['RIOT_API_KEY 환경변수가 설정되지 않았습니다.'] });
  return true;
}

router.post('/members/:id/riot-refresh', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const m = memberById(id);
    if (!m) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
    if (riotKeyGuard(res)) return;
    if (!m.accounts.length) {
      return res.status(400).json({ error: 'no_accounts', messages: [`${m.name} 단원에게 등록된 계정이 없습니다.`] });
    }
    const { accounts, errors } = await riot.refreshAccounts(m.accounts);
    store.editMember(id, { accounts });
    res.json({ member: memberById(id), errors });
  } catch (e) { next(e); }
});

/* ── 단원 관리 ── */
/* 관리자 화면용 단원 목록 — 계정의 PUUID·조회 시각까지 준다(공개 API 는 닉네임만 내보낸다) */
router.get('/members', requireAdmin, (req, res) => {
  const stats = store.stats();
  res.json({
    count: members.length,
    members: members.map((m) => ({ ...m, score: (stats[m.id] || {}).score || 200 })),
  });
});

router.post('/members', requireAdmin, (req, res) => {
  const { errors, value } = validateMember(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const id = store.addMember({
    name: value.name,
    birth: value.birth || new Date().getFullYear(),
    accounts: value.accounts || [],
    tier: value.tier || '언랭',
    main: value.main || [],
    sub: value.sub || [],
    role: value.role || '예비',
    joined: value.joined || todayKST(),   // 신규 단원은 오늘 가입으로 본다
  });
  res.status(201).json(memberById(id));
});

router.patch('/members/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!memberById(id)) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  const { errors, value } = validateMember(req.body, { partial: true, id });
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  store.editMember(id, value);
  res.json(memberById(id));
});

router.delete('/members/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!memberById(id)) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  store.removeMember(id);
  res.json({ removed: true, id });
});

router.post('/members/:id/restore', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  store.restoreMember(id);
  res.json({ restored: true, id });
});

router.delete('/members/:id/permanent', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!memberById(id)) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  store.permanentDeleteMember(id);
  res.json({ permanentlyDeleted: true, id });
});

module.exports = router;
