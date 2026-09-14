'use strict';

const express = require('express');
const store = require('../store');
const { members, memberById, activeMembers } = require('../lib/members');
const { ROLE_LABEL } = require('../lib/scales');
const { isAdmin } = require('../lib/auth');
const riot = require('../lib/riot');

const router = express.Router();

/* 단원별 티어 갱신은 누구나 할 수 있다 — 대신 방금 갱신된 단원은 다시 부르지 않는다.
   (전체 일괄 갱신은 관리자 전용으로 남겨둔다) */
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

function decorate(m) {
  const s = store.stats()[m.id] || { g: 0, w: 0, l: 0, wr: 0, mvp: 0, streak: 0, score: 200 };
  // PUUID 만 빼고 계정별 티어·조회 시각은 공개한다 (명단 카드에서 보여준다)
  const { accounts, ...pub } = m;
  return {
    ...pub,
    accounts: (accounts || []).map(({ puuid, ...a }) => a),
    roleLabel: ROLE_LABEL[m.role] || m.role,
    games: s.g,
    wins: s.w,
    losses: s.l,
    winrate: Number((s.wr || 0).toFixed(4)),
    streak: s.streak || 0,
    score: s.score,
  };
}

/* GET /api/members — 단원 명단 */
router.get('/', (req, res) => {
  const { line, tier, role, q, includeHidden } = req.query;
  let list = includeHidden === '1' ? members : activeMembers();

  if (line) list = list.filter((m) => m.lines.includes(line) || m.allLaner);
  if (tier) list = list.filter((m) => m.tier === tier);
  if (role) list = list.filter((m) => m.role === role);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((m) =>
      m.name.toLowerCase().includes(needle) || m.nicks.some((n) => n.toLowerCase().includes(needle)));
  }

  res.json({ count: list.length, members: list.map(decorate) });
});

/* GET /api/members/:id — 단원 상세 */
router.get('/:id', (req, res) => {
  const m = memberById(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  res.json(decorate(m));
});

/*
 * POST /api/members/:id/riot-refresh — 한 단원의 계정 솔로랭크를 라이엇에서 다시 받아온다.
 * 로그인 없이 쓸 수 있고, 5분 안에 이미 갱신된 단원은 호출 없이 그대로 돌려준다.
 * 관리자는 ?force=1 로 쿨다운을 무시할 수 있다.
 */
router.post('/:id/riot-refresh', async (req, res, next) => {
  try {
    const m = memberById(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
    if (!m.accounts.length) {
      return res.status(400).json({ error: 'no_accounts', messages: [`${m.name} 단원에게 등록된 계정이 없습니다.`] });
    }
    if (!riot.HAS_KEY) {
      return res.status(400).json({ error: 'no_riot_key', messages: ['라이엇 API 키가 설정되지 않았습니다.'] });
    }

    // 전부 최근에 갱신됐다면 굳이 다시 부르지 않는다 (관리자 force 제외)
    const force = req.query.force === '1' && isAdmin(req);
    const times = m.accounts.map((a) => (a.fetchedAt ? new Date(a.fetchedAt).getTime() : 0));
    const oldest = Math.min(...times);
    const waitMs = REFRESH_COOLDOWN_MS - (Date.now() - oldest);
    if (!force && waitMs > 0) {
      return res.json({
        member: decorate(m),
        errors: [],
        skipped: true,
        retryAfterSec: Math.ceil(waitMs / 1000),
      });
    }

    const { accounts, errors } = await riot.refreshAccounts(m.accounts);
    store.editMember(m.id, { accounts });
    res.json({ member: decorate(memberById(m.id)), errors, skipped: false });
  } catch (e) { next(e); }
});

module.exports = router;
