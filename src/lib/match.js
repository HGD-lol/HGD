'use strict';

const { memberById } = require('./members');

function buildMatch({ id, date, dur, blueWin, blue, red, mvpId, mode, seasonId }) {
  const mvpNum = mvpId == null ? null : Number(mvpId);
  const norm = (arr) =>
    arr.map((p) => {
      if (p.mercenary) {
        return {
          id: p.id || -(Date.now() + Math.floor(Math.random() * 10000)),
          name: p.name || '용병',
          tier: p.tier || '언랭',
          lane: p.lane || null,
          mvp: false,
          mercenary: true,
        };
      }
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
    seasonId: seasonId || null,
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
    seasonId: m.seasonId || null,
  };
}

function serializePlayer(p) {
  const out = { id: p.id, name: p.name, tier: p.tier, lane: p.lane, mvp: p.mvp };
  if (p.mercenary) out.mercenary = true;
  return out;
}

function toStored(m) {
  const storePlayer = (p) => {
    const out = { id: p.id, lane: p.lane };
    if (p.mercenary) { out.mercenary = true; out.name = p.name; out.tier = p.tier; }
    return out;
  };
  return {
    id: m.id,
    date: m.date.toISOString(),
    dur: m.dur,
    mode: m.mode || '협곡',
    blueWin: m.blueWin,
    mvpId: m.mvpId,
    blue: m.blue.map(storePlayer),
    red: m.red.map(storePlayer),
    seasonId: m.seasonId || null,
  };
}

module.exports = { buildMatch, serializeMatch, toStored };
