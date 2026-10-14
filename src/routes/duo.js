'use strict';

/*
 * 라이엇 실제 경기 기반 듀오 통계 — "이윤성과의 듀오".
 *
 * 기준 선수(anchor)의 match-v5 전적을 받아 riot_matches 에 캐시하고, 그 경기들에서
 * 같은 팀에 있었던 단원(PUUID 또는 닉네임#태그로 매칭)별 경기수·승률·KDA 를 낸다.
 *
 *   GET  /api/duo            ?group=ranked|normal|aram|custom|other  → 집계 + 경기 목록
 *   POST /api/duo/sync       라이엇에서 최근 경기 받아오기(공개, 쿨다운·동시실행 1개·호출 예산)
 *
 * 기준 선수는 환경변수 DUO_ANCHOR(기본 '어나니머스#kali') 닉네임을 단원 명단에서 찾는다.
 *
 * 호출 예산 — 앱 한도가 2분에 100회라 한 번의 동기화는
 *   경기 id 목록  최대 ID_PAGES 회(100개씩)  +  경기 상세  최대 DETAIL_BUDGET 회
 * 로 묶고, 아직 못 받은 경기가 남으면 remaining 으로 알려서 화면이 이어서 누르게 한다.
 */
const express = require('express');
const store = require('../store');
const riot = require('../lib/riot');
const { memberByNick, memberByPuuid, memberById } = require('../lib/members');
const { isAdmin } = require('../lib/auth');
const { compactMatch, computeDuo, QUEUE_GROUP } = require('../lib/duo');

const router = express.Router();

const ANCHOR_NICK = process.env.DUO_ANCHOR || '어나니머스#kali';
const ID_PAGES = Math.max(1, Number(process.env.DUO_ID_PAGES) || 5);          // 최근 500경기까지 본다 (페이지당 호출 1회)
const DETAIL_BUDGET = Math.max(1, Number(process.env.DUO_DETAIL_BUDGET) || 40); // 한 번에 받는 경기 상세 수
const ID_CACHE_MS = 10 * 60 * 1000;         // id 목록은 이 시간 동안 재사용하고 첫 페이지만 새로 본다(이어받기 때 호출 절약)
const COOLDOWN_MS = 2 * 60 * 1000;          // 새 경기가 없었던 동기화 뒤 이 시간 동안은 라이엇을 다시 부르지 않는다
const STALE_MS = 30 * 60 * 1000;            // 마지막 동기화가 이보다 오래됐으면 화면이 자동으로 sync 를 누른다

/* 기준 단원 + 그 계정 (닉네임이 명단에 없으면 null) */
function anchorMember() {
  const m = memberByNick(ANCHOR_NICK);
  if (!m) return null;
  const nick = String(ANCHOR_NICK).trim().toLowerCase().replace(/\s+/g, '');
  const acc = m.accounts.find((a) => a.nick.trim().toLowerCase().replace(/\s+/g, '') === nick) || m.accounts[0];
  return { member: m, account: acc || null };
}

/* PUUID 가 비어 있으면 라이엇에서 받아 단원에 저장한다 */
async function ensurePuuid(anchor) {
  if (anchor.account && anchor.account.puuid) return anchor.account.puuid;
  if (!riot.HAS_KEY) throw riot.riotError('RIOT_API_KEY 가 설정되지 않았습니다.', 'no_key');
  const puuid = await riot.fetchPuuid(anchor.account ? anchor.account.nick : ANCHOR_NICK);
  if (!puuid) throw riot.riotError(`'${ANCHOR_NICK}' 계정을 라이엇에서 찾지 못했습니다.`, 'not_found');
  const accounts = anchor.member.accounts.map((a) => (a === anchor.account ? { ...a, puuid } : a));
  store.editMember(anchor.member.id, { accounts });
  return puuid;
}

/* 참가자 → 단원. PUUID 우선, 없으면 닉네임#태그(부계정 포함) */
function resolveParticipant(p) {
  const m = (p.puuid && memberByPuuid(p.puuid)) || (p.riotId && memberByNick(p.riotId)) || null;
  if (!m || m.hidden) return null;
  return { id: m.id, name: m.name, tier: m.tier };
}

function syncInfo(puuid) {
  const s = store.getRiotSync(puuid) || {};
  const lastAt = s.lastAt || null;
  return {
    lastAt,
    inProgress: !!syncRun,
    stale: !lastAt || Date.now() - new Date(lastAt).getTime() > STALE_MS,
    remaining: s.remaining || 0,
    error: s.error || null,
  };
}

function buildResponse(anchor, puuid, group) {
  const records = store.riotMatchesWith(puuid);
  const data = computeDuo(records, puuid, resolveParticipant, anchor.member.id, { group });
  return {
    anchor: { id: anchor.member.id, name: anchor.member.name, nick: anchor.account ? anchor.account.nick : ANCHOR_NICK, tier: anchor.member.tier },
    group: group || null,
    groups: Object.keys(QUEUE_GROUP).concat('other'),
    cached: records.length,
    persisted: store.riotPersisted(),
    sync: syncInfo(puuid),
    ...data,
  };
}

/* 한 번의 동기화 — 최근 경기 id 를 훑어 아직 없는 경기 상세를 예산만큼 받는다 */
let syncRun = null;
const idCache = new Map();   // puuid → { at, ids } — 이어받기 라운드에서 전 페이지를 다시 받지 않게
async function listRecentIds(puuid) {
  const cached = idCache.get(puuid);
  let pagesHit = 0;
  let ids;
  if (cached && Date.now() - cached.at < ID_CACHE_MS) {
    // 새로 끝난 경기만 첫 페이지에서 보충한다
    const first = await riot.fetchMatchIds(puuid, { start: 0, count: 100 });
    pagesHit = 1;
    ids = [...new Set([...first, ...cached.ids])];
  } else {
    ids = [];
    for (let page = 0; page < ID_PAGES; page++) {
      const list = await riot.fetchMatchIds(puuid, { start: page * 100, count: 100 });
      pagesHit++;
      ids.push(...list);
      if (list.length < 100) break;
    }
    idCache.set(puuid, { at: Date.now(), ids });
  }
  return { ids, pagesHit };
}
async function syncOnce(anchor, puuid) {
  const known = store.riotMatchIds();
  const { ids, pagesHit } = await listRecentIds(puuid);
  const unknown = ids.filter((id) => !known.has(String(id)));   // 최신순 그대로
  const got = [];
  const errors = [];
  let stopped = null;
  for (const id of unknown.slice(0, DETAIL_BUDGET)) {
    try {
      const raw = await riot.fetchMatch(id);
      const rec = compactMatch(raw);
      if (rec) got.push(rec);
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
      if (e.code === 'no_key' || e.code === 'bad_key' || e.code === 'rate_limited') { stopped = e.message; break; }
      // 재시도까지 429 면 한도에 걸린 것 — 남은 예산을 더 두드리지 않고 다음 동기화에 맡긴다
      if (e.status === 429) { stopped = '라이엇 호출 한도에 걸렸습니다. 1~2분 뒤에 ⟳ 를 다시 눌러 주세요.'; break; }
    }
  }
  const added = store.addRiotMatches(got, puuid);
  const remaining = Math.max(0, unknown.length - got.length);
  store.setRiotSync(puuid, { lastAt: new Date().toISOString(), lastNew: added, remaining, error: stopped || null });
  return { pages: pagesHit, scanned: ids.length, added, remaining, errors, stopped };
}

/* GET /api/duo — 현재 캐시로 집계 (라이엇을 부르지 않는다) */
router.get('/', (req, res) => {
  const anchor = anchorMember();
  if (!anchor) return res.status(404).json({ error: 'anchor_not_found', messages: [`'${ANCHOR_NICK}' 닉네임을 가진 단원이 명단에 없습니다.`] });
  const group = req.query.group && req.query.group !== 'all' ? String(req.query.group) : null;
  const puuid = anchor.account && anchor.account.puuid;
  if (!puuid) {
    // 아직 PUUID 를 못 받은 상태 — 빈 집계와 함께 sync 가 필요하다고 알린다
    return res.json({
      anchor: { id: anchor.member.id, name: anchor.member.name, nick: anchor.account ? anchor.account.nick : ANCHOR_NICK, tier: anchor.member.tier },
      group, groups: Object.keys(QUEUE_GROUP).concat('other'), cached: 0, persisted: store.riotPersisted(),
      sync: { lastAt: null, inProgress: !!syncRun, stale: true, remaining: 0, error: null },
      partners: [], games: [], summary: { total: 0, totalWins: 0, duoGames: 0, duoWins: 0, duoWinrate: 0, soloGames: 0, soloWins: 0, soloWinrate: 0, partnersCount: 0, queueCounts: {} },
    });
  }
  res.json(buildResponse(anchor, puuid, group));
});

/* POST /api/duo/sync — 라이엇에서 최근 경기 받아오기 (공개). 관리자는 ?force=1 로 쿨다운 무시 */
router.post('/sync', async (req, res, next) => {
  try {
    const anchor = anchorMember();
    if (!anchor) return res.status(404).json({ error: 'anchor_not_found', messages: [`'${ANCHOR_NICK}' 닉네임을 가진 단원이 명단에 없습니다.`] });
    if (!riot.HAS_KEY) return res.status(400).json({ error: 'no_riot_key', messages: ['라이엇 API 키가 설정되지 않았습니다.'] });
    const group = req.query.group && req.query.group !== 'all' ? String(req.query.group) : null;

    const puuid = await ensurePuuid(anchor);
    const prev = store.getRiotSync(puuid);
    const force = req.query.force === '1' && isAdmin(req);
    // 직전 동기화에서 새 경기가 없었고 아직 쿨다운 안이면 라이엇을 부르지 않는다 (남은 게 있으면 바로 이어서 받는다)
    if (!force && !syncRun && prev && prev.lastAt && !prev.remaining && prev.lastNew === 0) {
      const waitMs = COOLDOWN_MS - (Date.now() - new Date(prev.lastAt).getTime());
      if (waitMs > 0) {
        return res.json({ ...buildResponse(anchor, puuid, group), result: { skipped: true, retryAfterSec: Math.ceil(waitMs / 1000), added: 0, remaining: 0, errors: [] } });
      }
    }
    if (!syncRun) syncRun = syncOnce(anchor, puuid).finally(() => { syncRun = null; });
    const result = await syncRun;
    res.json({ ...buildResponse(anchor, puuid, group), result: { skipped: false, ...result } });
  } catch (e) {
    if (e.code) return res.status(e.code === 'rate_limited' ? 429 : 400).json({ error: e.code, messages: [e.message] });
    next(e);
  }
});

module.exports = router;
