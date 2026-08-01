'use strict';

const express = require('express');
const store = require('../store');
const { memberById } = require('../lib/members');
const { buildMatch, serializeMatch } = require('../lib/match');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

/* 한 팀 입력 검증 — id만 확인 (lane은 선택적) */
function validateSide(side, label, errors) {
  if (!Array.isArray(side) || side.length !== 5) {
    errors.push(`${label} 팀은 정확히 5명이어야 합니다.`);
    return;
  }
  side.forEach((p, i) => {
    if (p == null || typeof p !== 'object') {
      errors.push(`${label} ${i + 1}번 선수 형식이 올바르지 않습니다.`);
      return;
    }
    if (!memberById(Number(p.id))) errors.push(`${label} ${i + 1}번: 존재하지 않는 단원 id(${p.id}).`);
  });
}

/* 공통: 요청 본문 → 검증된 매치 파라미터 */
function parseMatchBody(body) {
  const { date, dur, winner, blue, red, mvpId, mode } = body || {};
  const errors = [];

  if (!date || Number.isNaN(new Date(date).getTime())) errors.push('경기 날짜가 올바르지 않습니다.');
  if (winner !== 'blue' && winner !== 'red') errors.push("승리 팀(winner)은 'blue' 또는 'red' 여야 합니다.");
  if (mode && mode !== '협곡' && mode !== '칼바람') errors.push("모드는 '협곡' 또는 '칼바람' 이어야 합니다.");
  validateSide(blue, '블루', errors);
  validateSide(red, '레드', errors);

  let ids = [];
  if (Array.isArray(blue) && Array.isArray(red)) {
    ids = [...blue, ...red].map((p) => Number(p && p.id));
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup != null && !Number.isNaN(dup)) {
      const m = memberById(dup);
      errors.push(`${m ? m.name : dup} 단원이 양 팀에 중복 선택되었습니다.`);
    }
  }

  if (errors.length) return { errors };

  const normSide = (arr) => arr.map((p) => ({ id: Number(p.id), lane: p.lane || null }));
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

/* GET /api/matches — 전체 내전 기록 (최신순, limit 지원) */
router.get('/', (req, res) => {
  const limit = req.query.limit ? Math.max(0, parseInt(req.query.limit, 10)) : null;
  let list = store.allMatches();
  if (limit != null) list = list.slice(0, limit);
  res.json({ count: store.allMatches().length, matches: list.map(serializeMatch) });
});

/* GET /api/matches/:id — 단일 매치 */
router.get('/:id', (req, res) => {
  const m = store.findMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'match_not_found', id: req.params.id });
  res.json(serializeMatch(m));
});

/* POST /api/matches — 내전 등록 (누구나) */
router.post('/', (req, res) => {
  const { errors, params } = parseMatchBody(req.body);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const match = buildMatch({ id: 'u' + Date.now(), ...params });
  store.addUserMatch(match);
  res.status(201).json(serializeMatch(match));
});

/* PUT /api/matches/:id — 내전 기록 수정 (관리자) */
router.put('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  if (!store.findMatch(id)) return res.status(404).json({ error: 'match_not_found', id });
  const { errors, params } = parseMatchBody(req.body);
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
