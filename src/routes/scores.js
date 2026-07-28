'use strict';

const express = require('express');
const store = require('../store');
const { activeMembers } = require('../lib/members');
const { scoreOf } = require('../lib/scoring');

const router = express.Router();

/*
 * GET /api/scores — 전 활동 단원 자체 점수 순위.
 * 점수 = 티어점수 + 승률보정 + 연승연패. (경기 없는 단원도 티어점수로 포함)
 */
router.get('/', (_req, res) => {
  const stats = store.stats();
  const rows = activeMembers()
    .map((m) => {
      const s = stats[m.id] || { g: 0, w: 0, l: 0, wr: 0, mvp: 0, streak: 0 };
      const sc = scoreOf(m, s);
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
        tierScore: sc.tierScore,
        winrateScore: sc.winrateScore,
        streakScore: sc.streakScore,
        base: sc.base,
        score: sc.total,
      };
    })
    .sort((a, b) => b.score - a.score || b.winrate - a.winrate || a.name.localeCompare(b.name, 'ko'));

  res.json({ count: rows.length, scores: rows });
});

module.exports = router;
