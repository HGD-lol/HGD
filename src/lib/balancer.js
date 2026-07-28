'use strict';

const { memberById } = require('./members');
const { LINE_ORDER, TIER_RANK } = require('./scales');

/* 단원의 특정 라인 적합도: 3=주라인 2=올라운더 1=부라인 0=대체 */
function laneFit(m, lane) {
  const main = m.main.filter((x) => x !== '올라이너');
  const sub = m.sub.filter((x) => x !== '올라이너');
  if (main.includes(lane)) return 3;
  if (m.allLaner) return 2;
  if (sub.includes(lane)) return 1;
  return 0;
}

const fitLabel = (fit) => (fit >= 3 ? '주라인' : fit === 2 ? '올라운더' : fit === 1 ? '부라인' : '대체');

/* 5인 팀에 대해 라인 적합도 합이 최대가 되는 배치를 완전탐색으로 찾는다 */
function bestLanes(team) {
  let best = null;
  let bs = -1;
  const rec = (cur) => {
    if (cur.length === 5) {
      let s = 0;
      for (let i = 0; i < 5; i++) s += laneFit(team[i], cur[i]);
      if (s > bs) {
        bs = s;
        best = cur.slice();
      }
      return;
    }
    for (const l of LINE_ORDER) {
      if (!cur.includes(l)) {
        cur.push(l);
        rec(cur);
        cur.pop();
      }
    }
  };
  rec([]);

  const assign = team
    .map((m, i) => ({ m, lane: best[i], fit: laneFit(m, best[i]) }))
    .sort((a, b) => LINE_ORDER.indexOf(a.lane) - LINE_ORDER.indexOf(b.lane));
  return { assign, fit: bs };
}

const tierScore = (m) => TIER_RANK[m.tier];

/*
 * 10명(id 배열)을 티어 합 차이가 최소가 되도록 5:5 로 나눈다.
 * 동점(티어 차 +1 이내) 후보들 중 reroll 인덱스로 순환 선택 → "다시 섞기".
 */
function doBalance(ids, reroll = 0) {
  const combos = [];
  const rec = (start, cur) => {
    if (cur.length === 5) {
      if (cur.includes(ids[0])) combos.push(cur.slice()); // ids[0] 고정 → 좌우 대칭 중복 제거
      return;
    }
    for (let i = start; i < ids.length; i++) {
      cur.push(ids[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);

  const cands = combos.map((blueIds) => {
    const redIds = ids.filter((id) => !blueIds.includes(id));
    const blueM = blueIds.map(memberById);
    const redM = redIds.map(memberById);
    const bsum = blueM.reduce((s, m) => s + tierScore(m), 0);
    const rsum = redM.reduce((s, m) => s + tierScore(m), 0);
    const bl = bestLanes(blueM);
    const rl = bestLanes(redM);
    return { blueM, redM, bsum, rsum, tierDiff: Math.abs(bsum - rsum), fit: bl.fit + rl.fit, bl, rl };
  });

  cands.sort((a, b) => a.tierDiff - b.tierDiff || b.fit - a.fit);
  const near = cands.filter((c) => c.tierDiff <= cands[0].tierDiff + 1);
  return near[reroll % near.length];
}

function verdict(diff) {
  if (diff === 0) return { t: '완벽한 균형', level: 'perfect' };
  if (diff <= 1) return { t: '매우 균형적', level: 'great' };
  if (diff <= 3) return { t: '균형적', level: 'good' };
  if (diff <= 5) return { t: '약간 기움', level: 'warn' };
  return { t: '불균형', level: 'bad' };
}

/* API 응답용으로 밸런스 결과를 직렬화 */
function balanceResult(ids, reroll = 0) {
  const d = doBalance(ids, reroll);
  const toSide = (side) =>
    side.assign.map((x) => ({
      id: x.m.id,
      name: x.m.name,
      tier: x.m.tier,
      lane: x.lane,
      fit: x.fit,
      fitLabel: fitLabel(x.fit),
    }));
  return {
    reroll,
    tierDiff: d.tierDiff,
    blue: { tierSum: d.bsum, players: toSide(d.bl) },
    red: { tierSum: d.rsum, players: toSide(d.rl) },
    fitTotal: d.fit,
    verdict: verdict(d.tierDiff),
  };
}

module.exports = { laneFit, fitLabel, bestLanes, doBalance, verdict, balanceResult };
