'use strict';

const { memberById } = require('./members');

function buildMatch({ id, date, dur, blueWin, blue, red, mvpId, mode }) {
  const mvpNum = mvpId == null ? null : Number(mvpId);
  const norm = (arr) =>
    arr.map((p) => {
      const m = memberById(p.id);
      return {
        id: Number(p.id),
        name: m ? m.name : `#${p.id}`,
        tier: m ? m.tier : '언랭',
        lane: p.lane || null,
        mvp: mvpNum != null && Number(p.id) === mvpNum,
      };
    });

  const B = norm(blue);
  const R = norm(red);
  const hasMvp = [...B, ...R].some((p) => p.mvp);

  return {
    id,
    date: date instanceof Date ? date : new Date(date),
    dur: dur ? +dur : null,
    mode: mode || '협곡',
    blueWin: !!blueWin,
    blue: B,
    red: R,
    mvpId: hasMvp ? mvpNum : null,
  };
}

function serializeMatch(m) {
  return {
    id: m.id,
    date: m.date.toISOString(),
    dur: m.dur,
    mode: m.mode || '협곡',
    blueWin: m.blueWin,
    mvpId: m.mvpId,
    blue: m.blue.map(serializePlayer),
    red: m.red.map(serializePlayer),
  };
}

function serializePlayer(p) {
  return { id: p.id, name: p.name, tier: p.tier, lane: p.lane, mvp: p.mvp };
}

function toStored(m) {
  return {
    id: m.id,
    date: m.date.toISOString(),
    dur: m.dur,
    mode: m.mode || '협곡',
    blueWin: m.blueWin,
    mvpId: m.mvpId,
    blue: m.blue.map((p) => ({ id: p.id, lane: p.lane })),
    red: m.red.map((p) => ({ id: p.id, lane: p.lane })),
  };
}

module.exports = { buildMatch, serializeMatch, toStored };
