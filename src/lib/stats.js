'use strict';

const { members } = require('./members');

/*
 * 전체 매치 목록으로부터 단원별 누적 전적을 집계한다.
 * matches 는 최신순(newest-first)으로 전달되므로, 각 단원이 처음 만나는 경기가
 * 가장 최근 경기다 → 앞쪽 연속 동일 결과가 "현재 연승/연패".
 * g:경기수 w:승 l:패 mvp:MVP횟수 wr:승률 streak:현재 연승(+)/연패(-)
 */
function computeStats(matches) {
  const stats = {};
  members.forEach((m) => {
    stats[m.id] = { id: m.id, g: 0, w: 0, l: 0, mvp: 0, wr: 0, streak: 0, _seq: [] };
  });

  matches.forEach((mt) => {
    const proc = (arr, won) =>
      arr.forEach((p) => {
        const s = stats[p.id];
        if (!s) return;
        s.g++;
        if (won) s.w++;
        if (p.mvp) s.mvp++;
        s._seq.push(won); // 최신순으로 누적
      });
    proc(mt.blue, mt.blueWin);
    proc(mt.red, !mt.blueWin);
  });

  Object.values(stats).forEach((s) => {
    s.l = s.g - s.w;
    s.wr = s.g ? s.w / s.g : 0;
    if (s._seq.length) {
      const first = s._seq[0];
      let n = 0;
      for (const r of s._seq) {
        if (r === first) n++;
        else break;
      }
      s.streak = first ? n : -n; // 연승 +, 연패 -
    }
    delete s._seq;
  });

  return stats;
}

module.exports = { computeStats };
