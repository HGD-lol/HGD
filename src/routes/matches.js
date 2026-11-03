'use strict';

const express = require('express');
const store = require('../store');
const { memberById, memberByPuuid, memberByNick, displayMember } = require('../lib/members');
const { buildMatch, serializeMatch } = require('../lib/match');
const { requireAdmin } = require('../lib/auth');
const riot = require('../lib/riot');
const { parseMatchForImport, POS_KO } = require('../lib/duo');

const router = express.Router();

/*
 * 한 팀 입력 검증 — id만 확인 (lane은 선택적), 용병은 id 체크 건너뜀.
 * allowIds: 수정 전 기록에 이미 들어있던 id — 그 사이 완전삭제된 단원이라도 그대로 둘 수 있게 허용한다.
 */
function validateSide(side, label, errors, allowIds) {
  if (!Array.isArray(side) || side.length !== 5) {
    errors.push(`${label} 팀은 정확히 5명이어야 합니다.`);
    return;
  }
  side.forEach((p, i) => {
    if (p == null || typeof p !== 'object') {
      errors.push(`${label} ${i + 1}번 선수 형식이 올바르지 않습니다.`);
      return;
    }
    if (p.mercenary) {
      if (!p.name || !String(p.name).trim()) errors.push(`${label} ${i + 1}번: 용병 이름을 입력하세요.`);
      return;
    }
    if (!memberById(Number(p.id)) && !allowIds.has(Number(p.id))) {
      errors.push(`${label} ${i + 1}번: 존재하지 않는 단원 id(${p.id}).`);
    }
  });
}

/* 공통: 요청 본문 → 검증된 매치 파라미터 */
function parseMatchBody(body, { allowIds = new Set() } = {}) {
  const { date, dur, winner, blue, red, mvpId, mode } = body || {};
  const errors = [];

  if (!date || Number.isNaN(new Date(date).getTime())) errors.push('경기 날짜가 올바르지 않습니다.');
  if (winner !== 'blue' && winner !== 'red') errors.push("승리 팀(winner)은 'blue' 또는 'red' 여야 합니다.");
  if (mode && mode !== '협곡' && mode !== '칼바람') errors.push("모드는 '협곡' 또는 '칼바람' 이어야 합니다.");
  validateSide(blue, '블루', errors, allowIds);
  validateSide(red, '레드', errors, allowIds);

  let ids = [];
  if (Array.isArray(blue) && Array.isArray(red)) {
    const regularPlayers = [...blue, ...red].filter(p => !p.mercenary);
    ids = regularPlayers.map((p) => Number(p && p.id));
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup != null && !Number.isNaN(dup)) {
      const m = displayMember(dup);
      errors.push(`${m ? m.name : dup} 단원이 양 팀에 중복 선택되었습니다.`);
    }
  }

  if (errors.length) return { errors };

  const normSide = (arr) => arr.map((p) => {
    if (p.mercenary) {
      return { id: -(Date.now() + Math.floor(Math.random() * 10000)), lane: p.lane || null, name: p.name, tier: p.tier || '언랭', mercenary: true };
    }
    return { id: Number(p.id), lane: p.lane || null };
  });
  return {
    errors: [],
    params: {
      date: new Date(date),
      dur: dur || null,
      blueWin: winner === 'blue',
      blue: normSide(blue),
      red: normSide(red),
      mvpId: mvpId != null ? Number(mvpId) : null,
      mode: mode || '협곡',
    },
  };
}

/* GET /api/matches — 전체 내전 기록 (최신순, limit 지원, 시즌 필터) */
router.get('/', (req, res) => {
  const limit = req.query.limit ? Math.max(0, parseInt(req.query.limit, 10)) : null;
  const seasonId = req.query.season || null;
  let list = store.allMatches(seasonId);
  const total = list.length;
  if (limit != null) list = list.slice(0, limit);
  res.json({ count: total, matches: list.map(serializeMatch) });
});

/* GET /api/matches/calendar — 최근 1년 동안 내전이 있었던 날 (깃허브 잔디용)
   시즌과 상관없이 전체 기록을 KST 날짜별로 센다. ?days= 로 기간 조절(기본 365, 최대 730). */
const KST_MS = 9 * 3600 * 1000;
const dayKST = (d) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
router.get('/calendar', (req, res) => {
  const daysReq = parseInt(req.query.days, 10);
  const span = Number.isFinite(daysReq) && daysReq > 0 ? Math.min(daysReq, 730) : 365;
  const today = dayKST(new Date());
  const from = dayKST(new Date(Date.now() - (span - 1) * 86400 * 1000));
  const days = {};
  for (const m of store.allMatches()) {
    const key = dayKST(m.date);
    if (key < from || key > today) continue;
    const cell = days[key] || (days[key] = { count: 0, rift: 0, aram: 0 });
    cell.count += 1;
    if (m.mode === '칼바람') cell.aram += 1; else cell.rift += 1;
  }
  const activeDays = Object.keys(days).length;
  const total = Object.values(days).reduce((a, c) => a + c.count, 0);
  res.json({ from, to: today, total, activeDays, days });
});

/*
 * POST /api/matches/import — 라이엇 match ID 로 내전 기록 가져오기.
 * Body: { matchId: "KR_...", seriesId?: string, gameNum?: number }
 *   seriesId / gameNum — 프론트가 여러 판을 묶어 보낼 때 세트 정보를 함께 전달한다.
 *
 * 1. Riot match-v5 API 에서 경기 데이터를 받아옴
 * 2. 참가자 10명을 단원 명단과 매칭 (PUUID → 닉네임#태그 순)
 * 3. 내전 기록(matches) 생성 + 상세 스탯(match_details/match_participants) 저장
 */
router.post('/import', async (req, res, next) => {
  try {
    const { matchId, seriesId, gameNum } = req.body || {};
    if (!matchId || typeof matchId !== 'string') {
      return res.status(400).json({ error: 'validation_failed', messages: ['matchId 를 입력하세요. (예: KR_1234567890)'] });
    }
    const riotMatchId = matchId.trim();

    // 중복 체크
    if (store.hasRiotMatchImported(riotMatchId)) {
      return res.status(409).json({ error: 'already_imported', messages: ['이미 가져온 경기입니다.'], riotMatchId });
    }

    // 관리자가 등록을 꺼둔 상태
    if (store.getDashConfig().matchRegistrationEnabled === false) {
      return res.status(403).json({ error: 'registration_disabled', messages: ['내전 등록이 비활성화되었습니다.'] });
    }

    if (!riot.HAS_KEY) {
      return res.status(400).json({ error: 'no_riot_key', messages: ['라이엇 API 키가 설정되지 않았습니다.'] });
    }

    // Riot API 에서 경기 데이터 가져오기
    const raw = await riot.fetchMatch(riotMatchId);
    if (!raw) {
      return res.status(404).json({ error: 'riot_match_not_found', messages: [`경기 '${riotMatchId}' 를 라이엇에서 찾지 못했습니다.`] });
    }

    // 파싱
    const parsed = parseMatchForImport(raw);
    if (!parsed) {
      return res.status(400).json({ error: 'parse_failed', messages: ['경기 데이터를 파싱할 수 없습니다.'] });
    }

    const { meta, participants } = parsed;

    // 5v5 검증
    const blue = participants.filter(p => p.teamId === 100);
    const red = participants.filter(p => p.teamId === 200);
    if (blue.length !== 5 || red.length !== 5) {
      return res.status(400).json({ error: 'not_5v5', messages: ['5v5 경기만 가져올 수 있습니다.'] });
    }

    // 참가자 → 단원 매칭 (PUUID → riotId 전체 → 게임네임만)
    const resolve = (p) => {
      let m = (p.puuid && memberByPuuid(p.puuid)) || (p.riotId && memberByNick(p.riotId)) || null;
      // 전체 riotId 로 못 찾으면 태그 빼고 게임네임만으로 재시도
      if (!m && p.riotId) {
        const h = p.riotId.lastIndexOf('#');
        if (h > 0) m = memberByNick(p.riotId.slice(0, h));
      }
      if (!m || m.hidden) return null;
      return m;
    };

    const blueWin = blue[0].win;

    // 내전 기록용 팀 배열 만들기
    const buildSide = (side) => side.map(p => {
      const m = resolve(p);
      if (m) {
        return { id: m.id, lane: p.position || null };
      }
      // 매칭 안 된 참가자 → 용병 처리
      return {
        id: -(Date.now() + Math.floor(Math.random() * 10000)),
        lane: p.position || null,
        name: p.riotId || p.champion,
        tier: '언랭',
        mercenary: true,
      };
    });

    // 내전 기록 생성
    const internalId = 'r' + Date.now();
    const matchDate = meta.gameAt ? new Date(meta.gameAt) : new Date();
    const match = buildMatch({
      id: internalId,
      date: matchDate,
      dur: meta.dur || null,
      blueWin,
      blue: buildSide(blue),
      red: buildSide(red),
      mvpId: null,
      mode: meta.gameMode === 'ARAM' ? '칼바람' : '협곡',
      seriesId: seriesId || null,
      gameNum: gameNum != null ? Number(gameNum) : null,
    });
    store.addUserMatch(match);
    store.clearPending();

    // 예비 단원 → 단원 자동 전환
    const allPlayerIds = [...match.blue, ...match.red].filter(p => !p.mercenary).map(p => p.id);
    allPlayerIds.forEach(id => {
      const m = memberById(id);
      if (m && m.role === '예비') store.editMember(id, { role: '단원' });
    });

    // 참가자에 memberId 매핑 추가
    const enriched = participants.map(p => {
      const m = resolve(p);
      return { ...p, memberId: m ? m.id : null };
    });

    // 상세 데이터 저장
    store.saveMatchDetails(internalId, meta, enriched);

    // 응답: 내전 기록 + 매칭 결과 요약
    const matched = enriched.filter(p => p.memberId != null).length;
    const unmatched = enriched.filter(p => p.memberId == null).map(p => p.riotId);

    res.status(201).json({
      match: serializeMatch(match),
      import: {
        riotMatchId,
        matched,
        unmatched,
        gameAt: meta.gameAt ? new Date(meta.gameAt).toISOString() : null,
        dur: meta.dur,
        endType: meta.endType,
        hasDetails: true,
      },
    });
  } catch (e) {
    if (e.code) return res.status(e.code === 'rate_limited' ? 429 : 400).json({ error: e.code, messages: [e.message] });
    next(e);
  }
});

/* GET /api/matches/series/:seriesId — 시리즈(세트) 전체 경기 + 각 경기 상세 */
router.get('/series/:seriesId', (req, res) => {
  const list = store.findSeries(req.params.seriesId);
  if (!list.length) return res.status(404).json({ error: 'series_not_found', seriesId: req.params.seriesId });
  let blueWins = 0, redWins = 0;
  const games = list.map(m => {
    if (m.blueWin) blueWins++; else redWins++;
    const details = store.getMatchDetails(m.id);
    const serialized = serializeMatch(m);
    if (details) {
      const enrich = (p) => {
        const member = p.memberId ? displayMember(p.memberId) : null;
        return { ...p, memberName: member ? member.name : null, memberTier: member ? member.tier : null };
      };
      serialized._details = {
        riotMatchId: details.riotMatchId,
        dur: details.dur,
        endType: details.endType,
        blue: details.participants.filter(p => p.teamId === 100).map(enrich),
        red: details.participants.filter(p => p.teamId === 200).map(enrich),
      };
    }
    return serialized;
  });
  res.json({
    seriesId: req.params.seriesId,
    total: games.length,
    blueWins,
    redWins,
    seriesWinner: blueWins > redWins ? 'blue' : (redWins > blueWins ? 'red' : 'tie'),
    games,
  });
});

/* GET /api/matches/:id/details — 내전 import 상세 데이터 (참가자별 스탯) */
router.get('/:id/details', (req, res) => {
  const m = store.findMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'match_not_found', id: req.params.id });
  const details = store.getMatchDetails(req.params.id);
  if (!details) return res.status(404).json({ error: 'no_details', message: '이 경기는 라이엇에서 가져온 기록이 아닙니다.' });

  // 참가자를 팀별로 나누고 단원 이름 붙이기
  const enrich = (p) => {
    const member = p.memberId ? displayMember(p.memberId) : null;
    return {
      ...p,
      memberName: member ? member.name : null,
      memberTier: member ? member.tier : null,
    };
  };
  const blueParticipants = details.participants.filter(p => p.teamId === 100).map(enrich);
  const redParticipants = details.participants.filter(p => p.teamId === 200).map(enrich);

  res.json({
    match: serializeMatch(m),
    riotMatchId: details.riotMatchId,
    gameAt: details.gameAt ? new Date(details.gameAt).toISOString() : null,
    dur: details.dur,
    queueId: details.queueId,
    gameMode: details.gameMode,
    endType: details.endType,
    blue: blueParticipants,
    red: redParticipants,
  });
});

/* GET /api/matches/:id — 단일 매치 */
router.get('/:id', (req, res) => {
  const m = store.findMatch(req.params.id);
  if (!m) return res.status(404).json({ error: 'match_not_found', id: req.params.id });
  res.json(serializeMatch(m));
});

/* POST /api/matches — 내전 등록 (누구나) */
router.post('/', (req, res) => {
  // 관리자가 등록을 꺼둔 상태 — 열려 있던 화면에서 들어온 요청도 안내 문구로 돌려보낸다
  if (store.getDashConfig().matchRegistrationEnabled === false) {
    return res.status(403).json({
      error: 'registration_disabled',
      messages: ['내전 등록이 비활성화되었습니다. 관리자에게 문의하세요.'],
    });
  }
  const { errors, params } = parseMatchBody(req.body);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const match = buildMatch({ id: 'u' + Date.now(), ...params });
  store.addUserMatch(match);

  // 기록으로 확정됐으니 선택 중이던 pending 행은 지운다
  store.clearPending();

  // 예비 단원이 내전에 참여하면 자동으로 '단원'으로 변경 (용병 제외)
  const allPlayerIds = [...params.blue, ...params.red].filter(p => !p.mercenary).map(p => p.id);
  allPlayerIds.forEach(id => {
    const m = memberById(id);
    if (m && m.role === '예비') {
      store.editMember(id, { role: '단원' });
    }
  });

  res.status(201).json(serializeMatch(match));
});

/* ── MVP 투표 ──
   메인 화면에서 자기 이름을 고른 단원이 경기별로 1표. 다시 누르면 덮어쓴다.
   투표자·대상 모두 단원이어야 하고, 대상은 그 경기에 뛴 단원(용병 제외)이며 자기 자신은 안 된다. */
const VOTE_WINDOW_DAYS = 14;   // 경기 후 이 기간이 지나면 투표 마감

function voteGuard(req, res) {
  const match = store.findMatch(req.params.id);
  if (!match) { res.status(404).json({ error: 'match_not_found', id: req.params.id }); return null; }
  const voterId = Number(req.body && req.body.voterId);
  const voter = Number.isInteger(voterId) ? memberById(voterId) : null;
  if (!voter) { res.status(403).json({ error: 'voter_invalid', message: '먼저 내 이름을 선택하세요.' }); return null; }
  const ageMs = Date.now() - match.date.getTime();
  if (ageMs > VOTE_WINDOW_DAYS * 86400 * 1000) {
    res.status(400).json({ error: 'vote_closed', message: `경기 후 ${VOTE_WINDOW_DAYS}일이 지나 투표가 마감되었습니다.` });
    return null;
  }
  return { match, voterId };
}

/* PUT /api/matches/:id/vote — { voterId, mvpId } */
router.put('/:id/vote', (req, res) => {
  const g = voteGuard(req, res);
  if (!g) return;
  const { match, voterId } = g;
  const mvpId = Number(req.body.mvpId);
  const players = [...match.blue, ...match.red].filter(p => !p.mercenary).map(p => Number(p.id));
  if (!Number.isInteger(mvpId) || !players.includes(mvpId)) {
    return res.status(400).json({ error: 'mvp_invalid', message: '이 경기에 참여한 단원만 MVP 로 뽑을 수 있습니다.' });
  }
  if (mvpId === voterId) {
    return res.status(400).json({ error: 'self_vote', message: '자기 자신에게는 투표할 수 없습니다.' });
  }
  store.setVote(match.id, voterId, mvpId);
  res.json(serializeMatch(store.findMatch(match.id)));
});

/* DELETE /api/matches/:id/vote — { voterId } 내 표 취소 */
router.delete('/:id/vote', (req, res) => {
  const g = voteGuard(req, res);
  if (!g) return;
  store.removeVote(g.match.id, g.voterId);
  res.json(serializeMatch(store.findMatch(g.match.id)));
});

/* PUT /api/matches/:id — 내전 기록 수정 (관리자) */
router.put('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const existing = store.findMatch(id);
  if (!existing) return res.status(404).json({ error: 'match_not_found', id });
  // 이미 기록에 있던 단원은 완전삭제됐더라도 유지할 수 있어야 한다 (새로 넣는 건 여전히 불가)
  const allowIds = new Set([...existing.blue, ...existing.red].filter(p => !p.mercenary).map(p => Number(p.id)));
  const { errors, params } = parseMatchBody(req.body, { allowIds });
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const match = buildMatch({ id, ...params });
  const ok = store.replaceUserMatch(id, match);
  if (!ok) return res.status(404).json({ error: 'match_not_found', id });
  res.json(serializeMatch(match));
});

/* DELETE /api/matches/:id — 매치 삭제 (관리자) */
router.delete('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const ok = store.deleteUserMatch(id);
  if (!ok) return res.status(404).json({ error: 'match_not_found', id });
  res.json({ deleted: true, id });
});

module.exports = router;
