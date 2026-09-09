'use strict';

const express = require('express');
const store = require('../store');
const { memberById, activeMembers } = require('../lib/members');
const { computePairs, forMember } = require('../lib/synergy');

const router = express.Router();

function scopedMatches(req) {
  const seasonId = req.query.season || null;
  const mode = req.query.mode || null;
  let list = store.allMatches(seasonId);
  if (mode === '협곡') list = list.filter((m) => !m.mode || m.mode === '협곡');
  else if (mode === '칼바람') list = list.filter((m) => m.mode === '칼바람');
  return list;
}

const nameOf = (id) => {
  const m = memberById(id);
  return { id, name: m ? m.name : `#${id}`, tier: m ? m.tier : '언랭' };
};

/* GET /api/synergy — 전체 듀오/맞대결 순위 (?minGames=3&mode=&season=) */
router.get('/', (req, res) => {
  const minGames = req.query.minGames != null ? Math.max(1, parseInt(req.query.minGames, 10) || 1) : 3;
  const limit = req.query.limit != null ? Math.max(1, parseInt(req.query.limit, 10) || 5) : 5;
  const activeIds = new Set(activeMembers().map((m) => m.id));
  const { duo, rival } = computePairs(scopedMatches(req));

  const rows = [];
  duo.forEach((e) => {
    if (!activeIds.has(e.a) || !activeIds.has(e.b)) return;
    if (e.g < minGames) return;
    rows.push({
      a: nameOf(e.a),
      b: nameOf(e.b),
      games: e.g,
      wins: e.w,
      losses: e.g - e.w,
      winrate: Number((e.g ? e.w / e.g : 0).toFixed(4)),
    });
  });

  const byWr = [...rows].sort((x, y) => y.winrate - x.winrate || y.games - x.games);
  const byGames = [...rows].sort((x, y) => y.games - x.games || y.winrate - x.winrate);

  const rivalRows = [];
  rival.forEach((e) => {
    if (!activeIds.has(e.a) || !activeIds.has(e.b)) return;
    if (e.g < minGames) return;
    rivalRows.push({ a: nameOf(e.a), b: nameOf(e.b), games: e.g, aWins: e.w, bWins: e.g - e.w });
  });
  rivalRows.sort((x, y) => y.games - x.games);

  res.json({
    minGames,
    pairs: rows.length,
    bestDuos: byWr.slice(0, limit),
    worstDuos: [...byWr].reverse().slice(0, limit),
    mostPlayed: byGames.slice(0, limit),
    topRivalries: rivalRows.slice(0, limit),
  });
});

/* GET /api/synergy/:id — 단원 한 명의 궁합표 */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const me = memberById(id);
  if (!me) return res.status(404).json({ error: 'member_not_found', id: req.params.id });

  const minGames = req.query.minGames != null ? Math.max(1, parseInt(req.query.minGames, 10) || 1) : 1;
  const activeIds = new Set(activeMembers().map((m) => m.id));
  const { duo, rival } = computePairs(scopedMatches(req));

  const decorate = (list) =>
    list
      .filter((r) => activeIds.has(r.id) && r.games >= minGames)
      .map((r) => ({ ...r, ...nameOf(r.id), winrate: Number(r.winrate.toFixed(4)) }))
      .sort((a, b) => b.winrate - a.winrate || b.games - a.games);

  res.json({
    member: nameOf(id),
    minGames,
    duos: decorate(forMember(duo, id, 'duo')),
    rivals: decorate(forMember(rival, id, 'rival')),
  });
});

module.exports = router;
