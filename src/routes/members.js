'use strict';

const express = require('express');
const store = require('../store');
const { members, memberById, activeMembers } = require('../lib/members');
const { ROLE_LABEL } = require('../lib/scales');
const { scoreOf } = require('../lib/scoring');

const router = express.Router();

function decorate(m) {
  const s = store.stats()[m.id] || { g: 0, w: 0, l: 0, wr: 0, mvp: 0, streak: 0 };
  const sc = scoreOf(m, s);
  return {
    ...m,
    roleLabel: ROLE_LABEL[m.role] || m.role,
    games: s.g,
    wins: s.w,
    losses: s.l,
    winrate: Number((s.wr || 0).toFixed(4)),
    streak: s.streak || 0,
    score: sc.total,
    scoreParts: sc,
  };
}

/* GET /api/members  — 단원 명단 (필터: line, tier, role, q, includeHidden) */
router.get('/', (req, res) => {
  const { line, tier, role, q, includeHidden } = req.query;
  let list = includeHidden === '1' ? members : activeMembers();

  if (line) list = list.filter((m) => m.lines.includes(line) || m.allLaner);
  if (tier) list = list.filter((m) => m.tier === tier);
  if (role) list = list.filter((m) => m.role === role);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((m) => m.name.toLowerCase().includes(needle) || m.nick.toLowerCase().includes(needle));
  }

  res.json({ count: list.length, members: list.map(decorate) });
});

/* GET /api/members/:id — 단원 상세 */
router.get('/:id', (req, res) => {
  const m = memberById(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  res.json(decorate(m));
});

module.exports = router;
