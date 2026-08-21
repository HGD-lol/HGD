'use strict';

const express = require('express');
const store = require('../store');
const { memberById, activeMembers, pool } = require('../lib/members');
const { serializeMatch } = require('../lib/match');
const { TIER_ORDER, TIER_RANK, TIER_COLOR } = require('../lib/scales');

const router = express.Router();

/* GET /api/dashboard — 대시보드 집계 */
router.get('/', (req, res) => {
  const currentSeason = store.getCurrentSeason();
  const seasonId = currentSeason ? currentSeason.id : null;
  const matches = store.allMatches(seasonId);
  const stats = store.stats(null, seasonId);
  const members = activeMembers();
  const config = store.getDashConfig();

  const avgAge = members.length ? Math.round(members.reduce((s, m) => s + m.age, 0) / members.length) : 0;
  const masters = members.filter((m) => m.tier === '마스터').length;
  const diaPlus = members.filter((m) => TIER_RANK[m.tier] >= 6).length;

  const tiles = [
    { key: '총 단원', value: members.length, sub: `활동 ${pool.length} · 예비 ${members.length - pool.length}` },
    { key: '내전 경기', value: matches.length, sub: `${config.season} 누적` },
    { key: '마스터 티어', value: masters, sub: `다이아+ ${diaPlus}명` },
    { key: '평균 연령', value: avgAge, sub: '단원 나이 기준' },
  ];

  const tierDist = TIER_ORDER.map((t) => ({
    tier: t,
    color: TIER_COLOR[t],
    count: members.filter((m) => m.tier === t).length,
  })).filter((d) => d.count > 0);

  const activeIds = new Set(members.map((m) => m.id));

  // 승률 TOP 5 (내전 3회 이상)
  const topPlayers = Object.values(stats)
    .filter((s) => s.g >= 3 && activeIds.has(s.id))
    .map((s) => {
      const m = memberById(s.id);
      return {
        id: s.id,
        name: m ? m.name : `#${s.id}`,
        tier: m ? m.tier : '언랭',
        games: s.g,
        wins: s.w,
        winrate: Number(s.wr.toFixed(4)),
        streak: s.streak,
      };
    })
    .sort((a, b) => b.winrate - a.winrate || b.games - a.games)
    .slice(0, 5);

  // 내전점수 TOP 5
  const topScores = Object.values(stats)
    .filter((s) => activeIds.has(s.id))
    .map((s) => {
      const m = memberById(s.id);
      return {
        id: s.id,
        name: m ? m.name : `#${s.id}`,
        tier: m ? m.tier : '언랭',
        games: s.g,
        score: s.score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const recentMatches = matches.slice(0, 5).map(serializeMatch);

  res.json({
    config,
    season: config.season,
    tiles,
    tierDistribution: tierDist,
    topPlayers,
    topScores,
    recentMatches,
    counts: store.counts(),
  });
});

module.exports = router;
