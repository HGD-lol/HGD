'use strict';

const express = require('express');
const store = require('../store');
const { memberById, activeMembers } = require('../lib/members');

const router = express.Router();

/*
 * 기록 배지 — 시즌/모드 범위 안에서 각 항목 1위(동률이면 공동 수상)를 뽑는다.
 * 수상자가 없으면(기준 미달) 해당 배지는 응답에서 빠진다.
 */
const DEFS = [
  { key: 'score', icon: '👑', label: '최고 점수', desc: '내전 점수 1위', pick: (s) => s.score, min: 1, unit: '점', require: (s) => s.g > 0 },
  { key: 'wins', icon: '🏆', label: '최다 승리', desc: '가장 많이 이긴 단원', pick: (s) => s.w, min: 1, unit: '승' },
  { key: 'winrate', icon: '🎯', label: '최고 승률', desc: '5경기 이상 참여 기준', pick: (s) => s.wr, min: 0.0001, unit: '%', require: (s) => s.g >= 5, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'maxWin', icon: '🔥', label: '최장 연승', desc: '역대 최다 연속 승리', pick: (s) => s.maxWin, min: 2, unit: '연승' },
  { key: 'games', icon: '🎮', label: '최다 참여', desc: '가장 많이 나온 단원', pick: (s) => s.g, min: 1, unit: '경기' },
  { key: 'mvp', icon: '⭐', label: '최다 MVP', desc: 'MVP로 뽑힌 횟수', pick: (s) => s.mvp, min: 1, unit: '회' },
  { key: 'streak', icon: '⚡', label: '연승 진행 중', desc: '지금 연승을 달리는 단원', pick: (s) => s.streak, min: 2, unit: '연승' },
  { key: 'maxLose', icon: '🧊', label: '최장 연패', desc: '역대 최다 연속 패배', pick: (s) => s.maxLose, min: 2, unit: '연패' },
];

router.get('/', (req, res) => {
  const seasonId = req.query.season || null;
  const mode = req.query.mode && req.query.mode !== '전체' ? req.query.mode : null;
  const stats = store.stats(mode, seasonId);
  const activeIds = new Set(activeMembers().map((m) => m.id));
  const rows = Object.values(stats).filter((s) => activeIds.has(s.id));

  const badges = DEFS.map((d) => {
    const pool = rows.filter((s) => (d.require ? d.require(s) : true));
    if (!pool.length) return null;
    const best = pool.reduce((mx, s) => Math.max(mx, d.pick(s)), -Infinity);
    if (!Number.isFinite(best) || best < d.min) return null;
    const winners = pool
      .filter((s) => d.pick(s) === best)
      .map((s) => {
        const m = memberById(s.id);
        return { id: s.id, name: m ? m.name : `#${s.id}`, tier: m ? m.tier : '언랭', games: s.g };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return {
      key: d.key,
      icon: d.icon,
      label: d.label,
      desc: d.desc,
      value: Number(best.toFixed ? best.toFixed(4) : best),
      valueText: d.fmt ? d.fmt(best) : `${best}${d.unit}`,
      winners,
    };
  }).filter(Boolean);

  res.json({ mode: mode || '전체', count: badges.length, badges });
});

module.exports = router;
