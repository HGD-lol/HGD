'use strict';

const express = require('express');
const store = require('../store');
const { memberById, displayMember } = require('../lib/members');
const { buildMatch, serializeMatch } = require('../lib/match');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

/*
 * 한 팀 입력 검증 — id만 확인 (lane은 선택적), 용병은 id 체크 건너뜀.
 * allowIds: 수정 전 기록에 이미 들어있던 id — 그 사이 완전삭제된 단원이라도 그대로 둘 수 있게 허용한다.
 */
function validateSide(side, label, errors, allowIds) {
  if (!Array.isArray(side) || side.length !== 5) {
    errors.push(`${label} 팀은 정확히 5명이어야 합니다.`);
    return;
  }
  side.forEach((p, i) => {
    if (p == null || typeof p !== 'object') {
      errors.push(`${label} ${i + 1}번 선수 형식이 올바르지 않습니다.`);
      return;
    }
    if (p.mercenary) {
      if (!p.name || !String(p.name).trim()) errors.push(`${label} ${i + 1}번: 용병 이름을 입력하세요.`);
      return;
    }
    if (!memberById(Number(p.id)) && !allowIds.has(Number(p.id))) {
      errors.push(`${label} ${i + 1}번: 존재하지 않는 단원 id(${p.id}).`);
    }
  });
}

/* 공통: 요청 본문 → 검증된 매치 파라미터 */
function parseMatchBody(body, { allowIds = new Set() } = {}) {
  const { date, dur, winner, blue, red, mvpId, mode } = body || {};
  const errors = [];

  if (!date || Number.isNaN(new Date(date).getTime())) errors.push('경기 날짜가 올바르지 않습니다.');
  if (winner !== 'blue' && winner !== 'red') errors.push("승리 팀(winner)은 'blue' 또는 'red' 여야 합니다.");
  if (mode && mode !== '협곡' && mode !== '칼바람') errors.push("모드는 '협곡' 또는 '칼바람' 이어야 합니다.");
  validateSide(blue, '블루', errors, allowIds);
  validateSide(red, '레드', errors, allowIds);

  let ids = [];
  if (Array.isArray(blue) && Array.isArray(red)) {
    const regularPlayers = [...blue, ...red].filter(p => !p.mercenary);
    ids = regularPlayers.map((p) => Number(p && p.id));
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup != null && !Number.isNaN(dup)) {
      const m = displayMember(dup);
      errors.push(`${m ? m.name : dup} 단원이 양 팀에 중복 선택되었습니다.`);
    }
  }

  if (errors.length) return { errors };

  const normSide = (arr) => arr.map((p) => {
    if (p.mercenary) {
      return { id: -(Date.now() + Math.floor(Math.random() * 10000)), lane: p.lane || null, name: p.name, tier: p.tier || '언랭', mercenary: true };
    }
    return { id: Number(p.id), lane: p.lane || null };
  });
  return {
    errors: [],
    params: {
      date: new Date(date),
      dur: dur || null,
      blueWin: winner === 'blue',
      blue: normSide(blue),
      red: normSide(red),
      mvpId: mvpId != null ? Number(mvpId) : null,
      mode: mode || '협곡',
    },
  };
}

/* GET /api/matches — 전체 내전 기록 (최신순, limit 지원, 시즌 필터) */
router.get('/', (req, res) => {
  const limit = req.query.limit ? Math.max(0, parseInt(req.query.limit, 10)) : null;
  const seasonId = req.query.season || null;
  let list = store.allMatches(seasonId);
  const total = list.length;
  if (limit != null) list = list.slice(0, limit);
  res.json({ count: total, matches: list.map(serializeMatch) });
});

/* GET /api/matches/calendar — 최근 1년 동안 내전이 있었던 날 (깃허브 잔디용)
   시즌과 상관없이 전체 기록을 KST 날짜별로 센다. ?days= 로 기간 조절(기본 365, 최대 730). */
const KST_MS = 9 * 3600 * 1000;
const dayKST = (d) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
router.get('/calendar', (req, res) => {
  const daysReq = parseInt(req.query.days, 10);
  const span = Number.isFinite(daysReq) && daysReq > 0 ? Math.min(daysReq, 730) : 365;
  const today = dayKST(new Date());
  const from = dayKST(new Date(Date.now() - (span - 1) * 86400 * 1000));
  const days = {};
  for (const m of store.allMatches()) {
    const key = dayKST(m.date);
    if (key < from || key > today) continue;
    const cell = days[key] || (days[key] = { count: 0, rift: 0, aram: 0 });
    cell.count += 1;
    if (m.mode === '칼바람') cell.aram += 1; else cell.rift += 1;
  }
  const activeDays = Object.keys(days).length;
  const total = Object.values(days).reduce((a, c) => a + c.count, 0);
  res.json({ from, to: today, total, activeDays, days });
});

/* GET /api/matches/:id — 단일 매치 */
router.get('/:id', (req, res) => {
  const m = store.findMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'match_not_found', id: req.params.id });
  res.json(serializeMatch(m));
});

/* POST /api/matches — 내전 등록 (누구나) */
router.post('/', (req, res) => {
  // 관리자가 등록을 꺼둔 상태 — 열려 있던 화면에서 들어온 요청도 안내 문구로 돌려보낸다
  if (store.getDashConfig().matchRegistrationEnabled === false) {
    return res.status(403).json({
      error: 'registration_disabled',
      messages: ['내전 등록이 비활성화되었습니다. 관리자에게 문의하세요.'],
    });
  }
  const { errors, params } = parseMatchBody(req.body);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const match = buildMatch({ id: 'u' + Date.now(), ...params });
  store.addUserMatch(match);

  // 기록으로 확정됐으니 선택 중이던 pending 행은 지운다
  store.clearPending();

  // 예비 단원이 내전에 참여하면 자동으로 '단원'으로 변경 (용병 제외)
  const allPlayerIds = [...params.blue, ...params.red].filter(p => !p.mercenary).map(p => p.id);
  allPlayerIds.forEach(id => {
    const m = memberById(id);
    if (m && m.role === '예비') {
      store.editMember(id, { role: '단원' });
    }
  });

  res.status(201).json(serializeMatch(match));
});

/* ── MVP 투표 ──
   메인 화면에서 자기 이름을 고른 단원이 경기별로 1표. 다시 누르면 덮어쓴다.
   투표자·대상 모두 단원이어야 하고, 대상은 그 경기에 뛴 단원(용병 제외)이며 자기 자신은 안 된다. */
const VOTE_WINDOW_DAYS = 14;   // 경기 후 이 기간이 지나면 투표 마감

function voteGuard(req, res) {
  const match = store.findMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match_not_found', id: req.params.id }); return null; }
  const voterId = Number(req.body && req.body.voterId);
  const voter = Number.isInteger(voterId) ? memberById(voterId) : null;
  if (!voter) { res.status(403).json({ error: 'voter_invalid', message: '먼저 내 이름을 선택하세요.' }); return null; }
  const ageMs = Date.now() - match.date.getTime();
  if (ageMs > VOTE_WINDOW_DAYS * 86400 * 1000) {
    res.status(400).json({ error: 'vote_closed', message: `경기 후 ${VOTE_WINDOW_DAYS}일이 지나 투표가 마감되었습니다.` });
    return null;
  }
  return { match, voterId };
}

/* PUT /api/matches/:id/vote — { voterId, mvpId } */
router.put('/:id/vote', (req, res) => {
  const g = voteGuard(req, res);
  if (!g) return;
  const { match, voterId } = g;
  const mvpId = Number(req.body.mvpId);
  const players = [...match.blue, ...match.red].filter(p => !p.mercenary).map(p => Number(p.id));
  if (!Number.isInteger(mvpId) || !players.includes(mvpId)) {
    return res.status(400).json({ error: 'mvp_invalid', message: '이 경기에 참여한 단원만 MVP 로 뽑을 수 있습니다.' });
  }
  if (mvpId === voterId) {
    return res.status(400).json({ error: 'self_vote', message: '자기 자신에게는 투표할 수 없습니다.' });
  }
  store.setVote(match.id, voterId, mvpId);
  res.json(serializeMatch(store.findMatch(match.id)));
});

/* DELETE /api/matches/:id/vote — { voterId } 내 표 취소 */
router.delete('/:id/vote', (req, res) => {
  const g = voteGuard(req, res);
  if (!g) return;
  store.removeVote(g.match.id, g.voterId);
  res.json(serializeMatch(store.findMatch(g.match.id)));
});

/* PUT /api/matches/:id — 내전 기록 수정 (관리자) */
router.put('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const existing = store.findMatch(id);
  if (!existing) return res.status(404).json({ error: 'match_not_found', id });
  // 이미 기록에 있던 단원은 완전삭제됐더라도 유지할 수 있어야 한다 (새로 넣는 건 여전히 불가)
  const allowIds = new Set([...existing.blue, ...existing.red].filter(p => !p.mercenary).map(p => Number(p.id)));
  const { errors, params } = parseMatchBody(req.body, { allowIds });
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const match = buildMatch({ id, ...params });
  const ok = store.replaceUserMatch(id, match);
  if (!ok) return res.status(404).json({ error: 'match_not_found', id });
  res.json(serializeMatch(match));
});

/* DELETE /api/matches/:id — 매치 삭제 (관리자) */
router.delete('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const ok = store.deleteUserMatch(id);
  if (!ok) return res.status(404).json({ error: 'match_not_found', id });
  res.json({ deleted: true, id });
});

module.exports = router;
