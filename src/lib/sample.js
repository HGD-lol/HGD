'use strict';

const { pool } = require('./members');
const { buildMatch } = require('./match');
const { LINE_ORDER, TIER_RANK } = require('./scales');

/* 결정론적 시드 RNG (원본 앱과 동일 시드) → 서버 재시작 시 동일한 샘플 전적 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
 * 로스터 기반 샘플 내전 전적을 생성한다.
 * baseMs 를 인자로 받아 결정론을 유지한다(서버 부팅 시각 1회 고정).
 */
function genMatches(count = 26, baseMs = 0) {
  const rnd = mulberry32(20260727);
  const ri = (n) => Math.floor(rnd() * n);
  const dayMs = 86400000;
  const base = baseMs - dayMs * 2; // 최신 샘플이 ~2일 전 → 새 기록이 위로 쌓임
  const out = [];

  for (let g = 0; g < count; g++) {
    const shuffled = [...pool].sort(() => rnd() - 0.5).slice(0, 10);
    const blue = shuffled.slice(0, 5);
    const red = shuffled.slice(5, 10);

    const assign = (team) => {
      const laneLeft = [...LINE_ORDER];
      const res = [];
      const remaining = [...team];
      for (const p of [...team]) {
        const want = p.main.find((l) => laneLeft.includes(l));
        if (want) {
          res.push({ p, lane: want });
          laneLeft.splice(laneLeft.indexOf(want), 1);
          remaining.splice(remaining.indexOf(p), 1);
        }
      }
      for (const p of remaining) {
        const lane = laneLeft.shift();
        res.push({ p, lane });
      }
      return res.sort((a, b) => LINE_ORDER.indexOf(a.lane) - LINE_ORDER.indexOf(b.lane));
    };

    const bl = assign(blue);
    const rd = assign(red);
    const avg = (t) => t.reduce((s, x) => s + TIER_RANK[x.p.tier], 0) / 5;
    const bAdv = avg(bl) - avg(rd);
    const blueWin = rnd() < 0.5 + bAdv * 0.03;
    const dur = 22 + ri(20);

    const rawB = bl.map((e) => ({ id: e.p.id, lane: e.lane }));
    const rawR = rd.map((e) => ({ id: e.p.id, lane: e.lane }));
    const winners = blueWin ? rawB : rawR;
    const mvpId = winners[ri(winners.length)].id; // 승리 팀에서 무작위 MVP
    const date = new Date(base - (count - 1 - g) * (dayMs * (2 + ri(3))));
    out.push(buildMatch({ id: 's' + g, date, dur, blueWin, blue: rawB, red: rawR, mvpId }));
  }
  return out.reverse(); // 최신순
}

module.exports = { genMatches };
