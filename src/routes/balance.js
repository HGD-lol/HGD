'use strict';

const express = require('express');
const { memberById } = require('../lib/members');
const { balanceResult } = require('../lib/balancer');

const router = express.Router();

/*
 * POST /api/balance — 팀 밸런서.
 * body: { ids: [10개 단원 id], reroll?: number }
 * 티어 합이 최대한 균형 잡히도록 블루/레드 5:5 편성 후 라인까지 배치한다.
 */
router.post('/', (req, res) => {
  const { ids, reroll } = req.body || {};

  if (!Array.isArray(ids) || ids.length !== 10) {
    return res.status(400).json({ error: 'need_ten', message: '정확히 10명의 단원 id 를 보내주세요.' });
  }

  const nums = ids.map(Number);
  const unknown = nums.filter((id) => !memberById(id));
  if (unknown.length) {
    return res.status(400).json({ error: 'unknown_members', ids: unknown });
  }

  const uniq = new Set(nums);
  if (uniq.size !== 10) {
    return res.status(400).json({ error: 'duplicate_members', message: '중복된 단원이 있습니다.' });
  }

  const rerollN = Number.isFinite(Number(reroll)) ? Math.max(0, Math.floor(Number(reroll))) : 0;
  res.json(balanceResult(nums, rerollN));
});

module.exports = router;
