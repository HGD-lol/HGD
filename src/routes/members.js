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

/*
 * POST /api/members/riot-refresh-all — 대시보드 '솔랭 점수 TOP 5' 새로고침.
 * 활동 단원 전원의 솔로랭크를 다시 받되, 5분 안에 갱신된 단원은 건너뛴다(단원별 갱신과 같은 쿨다운).
 * 여러 사람이 동시에 눌러도 라이엇 호출은 한 번만 돌도록 진행 중인 작업을 같이 기다린다.
 * 호출 한도에 걸리면 거기서 멈추고, 그때까지 받은 값은 이미 저장돼 있다.
 */
let refreshAllRun = null;
async function refreshAllMembers() {
  const now = Date.now();
  const targets = activeMembers().filter((m) => m.accounts.length && m.accounts.some((a) =>
    !a.fetchedAt || now - new Date(a.fetchedAt).getTime() >= REFRESH_COOLDOWN_MS));
  const errors = [];
  let refreshed = 0;
  let stopped = null;
  for (const t of targets) {
    const { accounts, errors: errs } = await riot.refreshAccounts(t.accounts);
    store.editMember(t.id, { accounts });
    refreshed++;
    errs.forEach((e) => errors.push(`${t.name} — ${e}`));
    stopped = errs.find((e) => /한도|키가 만료|API_KEY/.test(e)) || null;
    if (stopped) break;   // 키 문제·한도 초과면 나머지를 두드려도 소용없다
  }
  return { targets: targets.length, refreshed, errors, stopped };
}
router.post('/riot-refresh-all', async (req, res, next) => {
  try {
    if (!riot.HAS_KEY) {
      return res.status(400).json({ error: 'no_riot_key', messages: ['라이엇 API 키가 설정되지 않았습니다.'] });
    }
    if (!refreshAllRun) refreshAllRun = refreshAllMembers().finally(() => { refreshAllRun = null; });
    const result = await refreshAllRun;
    res.json({ ...result, members: activeMembers().map(decorate) });
  } catch (e) { next(e); }
});

/* GET /api/members/:id — 단원 상세 */
router.get('/:id', (req, res) => {
  const m = memberById(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  res.json(decorate(m));
});

/* GET /api/members/:id/profile — 단원 상세 프로필 (5각형 지표 + 순위) */
router.get('/:id/profile', (req, res) => {
  const id = Number(req.params.id);
  const m = memberById(id);
  if (!m) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  const seasonId = req.query.seasonId || undefined;

  const rows = store.memberProfile(id, seasonId);
  if (!rows.length) return res.json({ member: decorate(m), games: 0, stats: null, radar: null, ranks: null });

  // 개인 집계
  const agg = aggregate(rows);

  // 전원 집계 → 순위
  const all = store.allMemberProfiles(seasonId);
  const MIN_GAMES = 3;
  const allAggs = {};
  for (const [mid, prows] of Object.entries(all)) {
    if (prows.length >= MIN_GAMES) allAggs[mid] = aggregate(prows);
  }
  const totalMembers = Object.keys(allAggs).length;

  // 5축 레이더 점수 (0~100 백분위)
  const axes = [
    { key: 'combat', label: '전투', metric: a => a.kda * 0.4 + a.killParticipation * 0.4 + a.damagePerMin * 0.002 },
    { key: 'survival', label: '생존', metric: a => 1 / (1 + a.deathsPerMin) },
    { key: 'vision', label: '시야', metric: a => a.visionPerMin },
    { key: 'growth', label: '성장', metric: a => a.csPerMin * 0.5 + a.goldPerMin * 0.001 },
    { key: 'damage', label: '딜량', metric: a => a.damagePerMin },
  ];

  const radar = {};
  const ranks = {};
  for (const ax of axes) {
    const myVal = ax.metric(agg);
    const vals = Object.entries(allAggs).map(([mid, a]) => ({ mid: +mid, v: ax.metric(a) }));
    vals.sort((a, b) => b.v - a.v);
    const rank = vals.findIndex(v => v.mid === id) + 1;
    const pct = totalMembers > 1 ? Math.round(((totalMembers - rank) / (totalMembers - 1)) * 100) : 50;
    radar[ax.key] = pct;
    ranks[ax.key] = { rank, total: totalMembers, value: +myVal.toFixed(2) };
  }

  // 시리즈 승패 vs 매치 승패 구분
  const record = computeRecord(id, seasonId, store);

  // 최근 10경기
  const recentMatches = rows.slice(0, 10).map(r => ({
    matchId: r.matchId, champion: r.champion, position: r.position,
    win: r.win, kills: r.kills, deaths: r.deaths, assists: r.assists,
    kda: r.deaths > 0 ? +((r.kills + r.assists) / r.deaths).toFixed(2) : r.kills + r.assists,
    damage: r.damage, gold: r.gold, cs: r.cs, items: r.items || [],
    dur: r.dur, date: r.gameAt || (r.matchDate ? new Date(r.matchDate).toISOString() : null),
    seriesId: r.seriesId,
  }));

  // 하이라이트 (개인 최고 기록)
  const highlights = computeHighlights(rows);

  // 블루/레드 사이드 전적
  const blueSide = rows.filter(r => r.teamId === 100);
  const redSide = rows.filter(r => r.teamId === 200);
  const sideRecord = {
    blue: { games: blueSide.length, wins: blueSide.filter(r => r.win).length },
    red: { games: redSide.length, wins: redSide.filter(r => r.win).length },
  };
  sideRecord.blue.winrate = sideRecord.blue.games ? +(sideRecord.blue.wins / sideRecord.blue.games).toFixed(4) : 0;
  sideRecord.red.winrate = sideRecord.red.games ? +(sideRecord.red.wins / sideRecord.red.games).toFixed(4) : 0;

  // 모드별 전적 (협곡 vs 칼바람)
  const modeBreakdown = {};
  rows.forEach(r => {
    const mode = r.mode || '협곡';
    if (!modeBreakdown[mode]) modeBreakdown[mode] = { games: 0, wins: 0 };
    modeBreakdown[mode].games++; if (r.win) modeBreakdown[mode].wins++;
  });

  // 최근 폼 (last 5, last 10, last 20)
  const recentForm = {};
  [5, 10, 20].forEach(n => {
    const slice = rows.slice(0, Math.min(n, rows.length));
    const w = slice.filter(r => r.win).length;
    recentForm['last' + n] = { games: slice.length, wins: w, winrate: slice.length ? +(w / slice.length).toFixed(4) : 0 };
  });

  // 승리/패배 평균 시간
  const winRows = rows.filter(r => r.win), loseRows = rows.filter(r => !r.win);
  const avgDur = arr => arr.length ? +(arr.reduce((s, r) => s + (r.dur || 0), 0) / arr.length / 60).toFixed(1) : 0;
  const durationStats = { avgWinMin: avgDur(winRows), avgLossMin: avgDur(loseRows), avgAllMin: avgDur(rows) };

  // 함께한 단원 (같은 팀) TOP 5
  const teammates = computeTeammates(id, seasonId, store);

  // 상대한 단원 (적 팀) TOP 5
  const rivals = computeRivals(id, seasonId, store);

  // 승리 시 vs 패배 시 평균 스탯 비교
  const winAgg = winRows.length >= 2 ? aggregate(winRows) : null;
  const loseAgg = loseRows.length >= 2 ? aggregate(loseRows) : null;
  const winLoseCompare = winAgg && loseAgg ? {
    win: { kda: winAgg.kda, damagePerMin: winAgg.damagePerMin, goldPerMin: winAgg.goldPerMin, csPerMin: winAgg.csPerMin, visionPerMin: winAgg.visionPerMin, killParticipation: winAgg.killParticipation },
    lose: { kda: loseAgg.kda, damagePerMin: loseAgg.damagePerMin, goldPerMin: loseAgg.goldPerMin, csPerMin: loseAgg.csPerMin, visionPerMin: loseAgg.visionPerMin, killParticipation: loseAgg.killParticipation },
  } : null;

  // 상세 스탯 백분위 순위 (your.gg 스타일)
  const statRanks = computeStatRanks(id, agg, allAggs, totalMembers);

  // 포지션별 KDA
  const posKda = {};
  rows.forEach(r => {
    const p = r.position || '없음';
    if (!posKda[p]) posKda[p] = { kills: 0, deaths: 0, assists: 0, games: 0 };
    posKda[p].kills += r.kills; posKda[p].deaths += r.deaths; posKda[p].assists += r.assists; posKda[p].games++;
  });
  const positionKda = Object.entries(posKda).map(([pos, v]) => ({
    position: pos, games: v.games,
    kda: v.deaths > 0 ? +((v.kills + v.assists) / v.deaths).toFixed(2) : v.kills + v.assists,
  })).sort((a, b) => b.games - a.games);

  res.json({
    member: decorate(m),
    games: rows.length,
    stats: agg,
    radar,
    ranks,
    record,
    recentChampions: topChampions(rows, 5),
    allChampions: topChampions(rows, 999),
    positionStats: positionBreakdown(rows),
    recentMatches,
    highlights,
    sideRecord,
    modeBreakdown,
    recentForm,
    durationStats,
    teammates,
    rivals,
    winLoseCompare,
    positionKda,
    statRanks,
  });
});

/* 시리즈 승패 vs 매치(단판) 승패 구분 집계 */
function computeRecord(memberId, seasonId, store) {
  const matches = store.allMatches(seasonId || undefined);
  // 이 단원이 참여한 매치만
  const mine = matches.filter(m => [...m.blue, ...m.red].some(p => !p.mercenary && p.id === memberId));

  let matchWins = 0, matchLosses = 0, seriesWins = 0, seriesLosses = 0;
  const seriesSeen = new Set();

  mine.forEach(m => {
    const onBlue = m.blue.some(p => !p.mercenary && p.id === memberId);
    const won = onBlue === m.blueWin;

    if (m.seriesId) {
      if (!seriesSeen.has(m.seriesId)) {
        seriesSeen.add(m.seriesId);
        // 시리즈 전체 결과 판정 — 1경기 블루팀=A팀, 선수 매칭
        const seriesGames = matches.filter(g => g.seriesId === m.seriesId);
        const endTime = g => g.date.getTime() + (g.dur || 0) * 1000;
        seriesGames.sort((a, b) => endTime(a) - endTime(b));
        const first = seriesGames[0];
        const teamAIds = new Set(first.blue.filter(p => !p.mercenary).map(p => p.id));
        let aW = 0, bW = 0;
        seriesGames.forEach(g => {
          const aOnBlue = g.blue.filter(p => !p.mercenary && teamAIds.has(p.id)).length;
          const aOnRed = g.red.filter(p => !p.mercenary && teamAIds.has(p.id)).length;
          const teamAIsBlue = aOnBlue >= aOnRed;
          if (teamAIsBlue === g.blueWin) aW++; else bW++;
        });
        // 이 단원이 A팀인지 B팀인지
        const memberIsTeamA = teamAIds.has(memberId);
        const memberTeamWon = memberIsTeamA ? (aW > bW) : (bW > aW);
        if (memberTeamWon) seriesWins++; else seriesLosses++;
      }
    } else {
      // 단판
      if (won) matchWins++; else matchLosses++;
    }
  });

  const totalW = matchWins + seriesWins, totalL = matchLosses + seriesLosses;
  return {
    total: { wins: totalW, losses: totalL, games: totalW + totalL, winrate: (totalW + totalL) > 0 ? +((totalW / (totalW + totalL))).toFixed(4) : 0 },
    match: { wins: matchWins, losses: matchLosses, games: matchWins + matchLosses },
    series: { wins: seriesWins, losses: seriesLosses, games: seriesWins + seriesLosses },
  };
}

function computeHighlights(rows) {
  let bestKda = null, highestDamage = null, maxKills = null;
  let maxWin = 0, maxLose = 0, curW = 0, curL = 0;

  // 오래된 순으로 연승/연패 계산
  const chrono = [...rows].reverse();
  chrono.forEach(r => {
    if (r.win) { curW++; curL = 0; } else { curL++; curW = 0; }
    if (curW > maxWin) maxWin = curW;
    if (curL > maxLose) maxLose = curL;
  });

  rows.forEach(r => {
    const kda = r.deaths > 0 ? (r.kills + r.assists) / r.deaths : r.kills + r.assists;
    if (!bestKda || kda > bestKda.kda) bestKda = { kda: +kda.toFixed(2), champion: r.champion, kills: r.kills, deaths: r.deaths, assists: r.assists };
    if (!highestDamage || r.damage > highestDamage.damage) highestDamage = { damage: r.damage, champion: r.champion };
    if (!maxKills || r.kills > maxKills.kills) maxKills = { kills: r.kills, champion: r.champion, deaths: r.deaths, assists: r.assists };
  });

  return { bestKda, highestDamage, maxKills, maxWinStreak: maxWin, maxLoseStreak: maxLose };
}

/* 상세 스탯 백분위 순위 — your.gg 스타일 등급 */
function computeStatRanks(memberId, myAgg, allAggs, totalMembers) {
  // 높을수록 좋은 지표 vs 낮을수록 좋은 지표
  const metrics = [
    // 전투
    { key: 'kda', label: 'KDA', cat: '전투', get: a => a.kda, fmt: v => v.toFixed(2) },
    { key: 'kills', label: '킬', cat: '전투', get: a => a.kills, fmt: v => v.toFixed(1) },
    { key: 'assists', label: '어시스트', cat: '전투', get: a => a.assists, fmt: v => v.toFixed(1) },
    { key: 'deaths', label: '데스', cat: '전투', get: a => a.deaths, fmt: v => v.toFixed(1), asc: true },
    { key: 'killParticipation', label: '킬 관여율', cat: '전투', get: a => a.killParticipation, fmt: v => v.toFixed(0) + '%' },
    { key: 'firstBloods', label: '퍼스트블러드', cat: '전투', get: a => a.firstBloods / a.games, fmt: v => v.toFixed(2) },
    // 성장
    { key: 'csPerMin', label: '분당 CS', cat: '성장', get: a => a.csPerMin, fmt: v => v.toFixed(1) },
    { key: 'goldPerMin', label: '분당 골드', cat: '성장', get: a => a.goldPerMin, fmt: v => String(v) },
    // 딜량
    { key: 'damagePerMin', label: '분당 딜량', cat: '딜량', get: a => a.damagePerMin, fmt: v => String(v) },
    { key: 'damageTakenPerMin', label: '분당 받은 딜량', cat: '딜량', get: a => a.damageTakenPerMin, fmt: v => String(v) },
    { key: 'damagePerGold', label: '골드당 딜량', cat: '딜량', get: a => a.avgDamage / Math.max(a.avgGold, 1), fmt: v => v.toFixed(2) },
    { key: 'damagePerDeath', label: '데스당 딜량', cat: '딜량', get: a => a.avgDamage / Math.max(a.deaths, 0.5), fmt: v => Math.round(v).toLocaleString() },
    { key: 'takenPerDeath', label: '데스당 받은 딜량', cat: '딜량', get: a => (a.damageTakenPerMin * 60) / Math.max(a.deaths, 0.5), fmt: v => Math.round(v).toLocaleString() },
    // 시야
    { key: 'visionPerMin', label: '분당 시야 점수', cat: '시야', get: a => a.visionPerMin, fmt: v => v.toFixed(2) },
    { key: 'controlWardsPerGame', label: '제어 와드', cat: '시야', get: a => a.controlWardsPerGame, fmt: v => v.toFixed(1) },
    { key: 'wardsPlacedPerGame', label: '와드 설치', cat: '시야', get: a => a.wardsPlacedPerGame, fmt: v => v.toFixed(1) },
    { key: 'wardsKilledPerGame', label: '와드 제거', cat: '시야', get: a => a.wardsKilledPerGame, fmt: v => v.toFixed(1) },
    // 유틸
    { key: 'ccTimePerGame', label: 'CC 시간', cat: '유틸', get: a => a.ccTimePerGame, fmt: v => v.toFixed(1) + '초' },
    { key: 'healPerGame', label: '힐량', cat: '유틸', get: a => a.healPerGame, fmt: v => Number(v).toLocaleString() },
    { key: 'shieldPerGame', label: '보호막', cat: '유틸', get: a => a.shieldPerGame, fmt: v => Number(v).toLocaleString() },
  ];

  const results = [];
  for (const m of metrics) {
    const myVal = m.get(myAgg);
    const vals = Object.entries(allAggs).map(([mid, a]) => ({ mid: +mid, v: m.get(a) }));
    // asc = 낮을수록 좋음 (데스 등)
    if (m.asc) vals.sort((a, b) => a.v - b.v);
    else vals.sort((a, b) => b.v - a.v);
    const rank = vals.findIndex(v => v.mid === memberId) + 1;
    const pct = totalMembers > 1 ? +((rank / totalMembers) * 100).toFixed(1) : 50;
    const grade = pctToGrade(pct);
    results.push({
      key: m.key, label: m.label, cat: m.cat,
      value: m.fmt(myVal), rank, total: totalMembers,
      percentile: pct, grade,
    });
  }
  return results;
}

function pctToGrade(pct) {
  if (pct <= 0.5) return 'SSS';
  if (pct <= 1) return 'SS';
  if (pct <= 3) return 'S+';
  if (pct <= 5) return 'S';
  if (pct <= 10) return 'A+';
  if (pct <= 15) return 'A';
  if (pct <= 25) return 'A-';
  if (pct <= 35) return 'B+';
  if (pct <= 50) return 'B';
  if (pct <= 65) return 'B-';
  if (pct <= 75) return 'C+';
  if (pct <= 85) return 'C';
  if (pct <= 95) return 'C-';
  return 'D';
}

/* 함께한 단원 (같은 팀) TOP 5 */
function computeTeammates(memberId, seasonId, store) {
  const matches = store.allMatches(seasonId || undefined);
  const mates = {};
  matches.forEach(m => {
    const inBlue = m.blue.some(p => !p.mercenary && p.id === memberId);
    const inRed = m.red.some(p => !p.mercenary && p.id === memberId);
    if (!inBlue && !inRed) return;
    const team = inBlue ? m.blue : m.red;
    const won = inBlue === m.blueWin;
    team.forEach(p => {
      if (p.mercenary || p.id === memberId) return;
      if (!mates[p.id]) mates[p.id] = { id: p.id, name: p.name, games: 0, wins: 0 };
      mates[p.id].games++; if (won) mates[p.id].wins++;
    });
  });
  return Object.values(mates).sort((a, b) => b.games - a.games).slice(0, 5)
    .map(t => ({ ...t, winrate: +(t.wins / t.games).toFixed(4) }));
}

/* 상대한 단원 (적 팀) TOP 5 */
function computeRivals(memberId, seasonId, store) {
  const matches = store.allMatches(seasonId || undefined);
  const enemies = {};
  matches.forEach(m => {
    const inBlue = m.blue.some(p => !p.mercenary && p.id === memberId);
    const inRed = m.red.some(p => !p.mercenary && p.id === memberId);
    if (!inBlue && !inRed) return;
    const enemy = inBlue ? m.red : m.blue;
    const won = inBlue === m.blueWin;
    enemy.forEach(p => {
      if (p.mercenary) return;
      if (!enemies[p.id]) enemies[p.id] = { id: p.id, name: p.name, games: 0, wins: 0 };
      enemies[p.id].games++; if (won) enemies[p.id].wins++;
    });
  });
  return Object.values(enemies).sort((a, b) => b.games - a.games).slice(0, 5)
    .map(t => ({ ...t, winrate: +(t.wins / t.games).toFixed(4) }));
}

function aggregate(rows) {
  let kills = 0, deaths = 0, assists = 0, gold = 0, cs = 0, damage = 0, damageTaken = 0,
      damageMitigated = 0, vision = 0, wardsPlaced = 0, wardsKilled = 0, controlWards = 0,
      kp = 0, wins = 0, totalDur = 0, heal = 0, shield = 0, ccTime = 0,
      doubles = 0, triples = 0, quadras = 0, pentas = 0, firstBloods = 0,
      turrets = 0, inhibitors = 0;
  rows.forEach(r => {
    kills += r.kills; deaths += r.deaths; assists += r.assists;
    gold += r.gold; cs += r.cs; damage += r.damage;
    damageTaken += r.damageTaken || 0; damageMitigated += r.damageMitigated || 0;
    vision += r.vision; wardsPlaced += r.wardsPlaced || 0;
    wardsKilled += r.wardsKilled || 0; controlWards += r.controlWards || 0;
    kp += r.killParticipation || 0;
    if (r.win) wins++;
    totalDur += r.dur || 0;
    heal += r.heal || 0; shield += r.shield || 0; ccTime += r.ccTime || 0;
    doubles += r.doubleKills || 0; triples += r.tripleKills || 0;
    quadras += r.quadraKills || 0; pentas += r.pentaKills || 0;
    if (r.firstBlood) firstBloods++;
    turrets += r.turretKills || 0; inhibitors += r.inhibitorKills || 0;
  });
  const g = rows.length;
  const mins = totalDur / 60;
  return {
    games: g, wins, losses: g - wins, winrate: +(wins / g).toFixed(4),
    kills: +(kills / g).toFixed(1), deaths: +(deaths / g).toFixed(1), assists: +(assists / g).toFixed(1),
    kda: deaths > 0 ? +((kills + assists) / deaths).toFixed(2) : kills + assists,
    killParticipation: +(kp / g).toFixed(1),
    goldPerMin: mins > 0 ? +(gold / mins).toFixed(0) : 0,
    csPerMin: mins > 0 ? +(cs / mins).toFixed(1) : 0,
    damagePerMin: mins > 0 ? +(damage / mins).toFixed(0) : 0,
    damageTakenPerMin: mins > 0 ? +(damageTaken / mins).toFixed(0) : 0,
    damageMitigatedPerMin: mins > 0 ? +(damageMitigated / mins).toFixed(0) : 0,
    visionPerMin: mins > 0 ? +(vision / mins).toFixed(2) : 0,
    wardsPlacedPerGame: +(wardsPlaced / g).toFixed(1),
    wardsKilledPerGame: +(wardsKilled / g).toFixed(1),
    controlWardsPerGame: +(controlWards / g).toFixed(1),
    deathsPerMin: mins > 0 ? +(deaths / mins).toFixed(3) : 0,
    healPerGame: +(heal / g).toFixed(0), shieldPerGame: +(shield / g).toFixed(0),
    ccTimePerGame: +(ccTime / g).toFixed(1),
    doubleKills: doubles, tripleKills: triples, quadraKills: quadras, pentaKills: pentas,
    firstBloods, turretKills: turrets, inhibitorKills: inhibitors,
    avgGold: +(gold / g).toFixed(0), avgDamage: +(damage / g).toFixed(0),
    avgCS: +(cs / g).toFixed(0), avgVision: +(vision / g).toFixed(1),
  };
}

function topChampions(rows, limit) {
  const champs = {};
  rows.forEach(r => {
    if (!r.champion) return;
    if (!champs[r.champion]) champs[r.champion] = { champion: r.champion, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 };
    const c = champs[r.champion];
    c.games++; if (r.win) c.wins++;
    c.kills += r.kills; c.deaths += r.deaths; c.assists += r.assists;
  });
  return Object.values(champs)
    .sort((a, b) => b.games - a.games)
    .slice(0, limit)
    .map(c => ({
      ...c,
      winrate: +(c.wins / c.games).toFixed(4),
      kda: c.deaths > 0 ? +((c.kills + c.assists) / c.deaths).toFixed(2) : c.kills + c.assists,
    }));
}

function positionBreakdown(rows) {
  const pos = {};
  rows.forEach(r => {
    const p = r.position || '없음';
    if (!pos[p]) pos[p] = { position: p, games: 0, wins: 0 };
    pos[p].games++; if (r.win) pos[p].wins++;
  });
  return Object.values(pos).sort((a, b) => b.games - a.games)
    .map(p => ({ ...p, winrate: +(p.wins / p.games).toFixed(4) }));
}

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
