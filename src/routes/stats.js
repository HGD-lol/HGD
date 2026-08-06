'use strict';

const express = require('express');
const store = require('../store');
const { memberById, activeMembers } = require('../lib/members');

const router = express.Router();

const SORT_KEYS = { wr: 'winrate', winrate: 'winrate', games: 'games', wins: 'wins', mvp: 'mvp', score: 'score' };

function row(s) {
  const m = memberById(s.id);
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
    score: s.score,
    lastMatch: s.lastMatch ? (s.lastMatch instanceof Date ? s.lastMatch.toISOString() : s.lastMatch) : null,
  };
}

/* GET /api/stats — 전적 순위표 */
router.get('/', (req, res) => {
  const mode = req.query.mode || null; // '협곡' | '칼바람' | null(전체)
  const stats = store.stats(mode);
  const minGames = req.query.minGames != null ? parseInt(req.query.minGames, 10) : 1;
  const sortKey = SORT_KEYS[req.query.sort] || 'winrate';
  const asc = req.query.order === 'asc';
  const activeIds = new Set(activeMembers().map((m) => m.id));

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
