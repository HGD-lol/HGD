'use strict';

const express = require('express');
const store = require('../store');
const { memberById, activeMembers } = require('../lib/members');
const { scoreOf } = require('../lib/scoring');

const router = express.Router();

const SORT_KEYS = { wr: 'winrate', winrate: 'winrate', games: 'games', wins: 'wins', mvp: 'mvp', score: 'score' };

function row(s) {
  const m = memberById(s.id);
  const sc = scoreOf(m || {}, s);
  return {
    id: s.id,
    name: m ? m.name : `#${s.id}`,
    tier: m ? m.tier : '언랭',
    role: m ? m.role : null,
    games: s.g,
    wins: s.w,
    losses: s.l,
    winrate: Number(s.wr.toFixed(4)),
    mvp: s.mvp,
    streak: s.streak,
    score: sc.total,
    scoreParts: sc,
  };
}

/*
 * GET /api/stats — 전적 순위표.
 * 쿼리: minGames(기본 3), sort(wr|games|wins|mvp|score, 기본 wr), order(desc|asc)
 */
router.get('/', (req, res) => {
  const stats = store.stats();
  const minGames = req.query.minGames != null ? parseInt(req.query.minGames, 10) : 3;
  const sortKey = SORT_KEYS[req.query.sort] || 'winrate';
  const asc = req.query.order === 'asc';
  const activeIds = new Set(activeMembers().map((m) => m.id)); // 숨김 단원 제외

  let rows = Object.values(stats)
    .filter((s) => s.g >= minGames && activeIds.has(s.id))
    .map(row);

  rows.sort((a, b) => {
    const diff = b[sortKey] - a[sortKey] || b.games - a.games || a.name.localeCompare(b.name, 'ko');
    return asc ? -diff : diff;
  });

  res.json({ minGames, sort: sortKey, order: asc ? 'asc' : 'desc', count: rows.length, standings: rows });
});

/* GET /api/stats/:id — 단원 개인 전적 */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!memberById(id)) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  res.json(row(store.stats()[id]));
});

module.exports = router;
