'use strict';

const express = require('express');
const store = require('../store');
const { activeMembers, memberById } = require('../lib/members');

const router = express.Router();

/* GET /api/scores — 내전 점수 순위 */
router.get('/', (_req, res) => {
  const stats = store.stats();
  const rows = activeMembers()
    .map((m) => {
      const s = stats[m.id] || { g: 0, w: 0, l: 0, wr: 0, mvp: 0, streak: 0, score: 200 };
      return {
        id: m.id,
        name: m.name,
        tier: m.tier,
        role: m.role,
        games: s.g,
        wins: s.w,
        losses: s.l,
        winrate: Number(s.wr.toFixed(4)),
        streak: s.streak,
        score: s.score,
      };
    })
    .sort((a, b) => b.score - a.score || b.winrate - a.winrate || a.name.localeCompare(b.name, 'ko'));

  res.json({ count: rows.length, scores: rows });
});

module.exports = router;
