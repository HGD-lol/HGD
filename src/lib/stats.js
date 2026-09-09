'use strict';

const { members } = require('./members');
const { BASE_SCORE, WIN_POINTS, LOSS_POINTS } = require('./scoring');

/*
 * 전체 매치 목록으로부터 단원별 누적 전적 + 내전 점수를 집계한다.
 * matches 는 최신순(newest-first)으로 전달된다.
 */
function computeStats(matches, modeFilter) {
  if (modeFilter) {
    matches = matches.filter((m) => (m.mode || '협곡') === modeFilter);
  }
  const stats = {};
  members.forEach((m) => {
    stats[m.id] = { id: m.id, g: 0, w: 0, l: 0, mvp: 0, wr: 0, streak: 0, maxWin: 0, maxLose: 0, score: BASE_SCORE, lastMatch: null, _seq: [] };
  });

  // 전적 집계 (최신순)
  matches.forEach((mt) => {
    const proc = (arr, won) =>
      arr.forEach((p) => {
        const s = stats[p.id];
        if (!s) return;
        s.g++;
        if (won) s.w++;
        if (p.mvp) s.mvp++;
        s._seq.push(won);
        // 최신순이므로 첫 만남이 마지막 참여 날짜
        if (!s.lastMatch) s.lastMatch = mt.date;
      });
    proc(mt.blue, mt.blueWin);
    proc(mt.red, !mt.blueWin);
  });

  // 연승/연패 계산
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
      s.streak = first ? n : -n;
      // 역대 최장 연승/연패 (배지용)
      let cw = 0, cl = 0;
      for (const r of s._seq) {
        if (r) { cw++; cl = 0; } else { cl++; cw = 0; }
        if (cw > s.maxWin) s.maxWin = cw;
        if (cl > s.maxLose) s.maxLose = cl;
      }
    }
    delete s._seq;
  });

  // 내전 점수 계산 (기본은 협곡만 · 모드 필터가 지정되면 해당 모드 기준, 시간순으로 처리)
  const scoreMatches = modeFilter ? matches : matches.filter((m) => !m.mode || m.mode === '협곡');
  const chronological = [...scoreMatches].reverse(); // oldest first
  const scoreStreaks = {};

  chronological.forEach((mt) => {
    const proc = (arr, won) => {
      arr.forEach((p) => {
        if (!stats[p.id]) return;
        if (scoreStreaks[p.id] == null) scoreStreaks[p.id] = 0;

        if (won) {
          if (scoreStreaks[p.id] > 0) scoreStreaks[p.id]++;
          else scoreStreaks[p.id] = 1;
          // 1승 +16, 2연승 +17, 3연승 +18 ...
          stats[p.id].score += WIN_POINTS + (scoreStreaks[p.id] - 1);
        } else {
          if (scoreStreaks[p.id] < 0) scoreStreaks[p.id]--;
          else scoreStreaks[p.id] = -1;
          // 1패 -14, 2연패 -15, 3연패 -16 ...
          stats[p.id].score += -(LOSS_POINTS + (-scoreStreaks[p.id] - 1));
        }
      });
    };
    proc(mt.blue, mt.blueWin);
    proc(mt.red, !mt.blueWin);
  });

  return stats;
}

module.exports = { computeStats };
