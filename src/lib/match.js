'use strict';

const { displayMember } = require('./members');

function buildMatch({ id, date, dur, blueWin, blue, red, mvpId, mode, seasonId, seriesId, gameNum }) {
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
      const m = displayMember(p.id);   // 완전삭제된 단원(묘비)도 이름을 해석한다
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
    seriesId: seriesId || null,
    gameNum: gameNum != null ? Number(gameNum) : null,
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
    // manualMvpId = 관리자가 지정한 값, votes = 투표 집계(없으면 null). mvpId 는 둘을 합친 최종값.
    manualMvpId: m.manualMvpId === undefined ? m.mvpId : m.manualMvpId,
    votes: m.votes || null,
    blue: m.blue.map(serializePlayer),
    red: m.red.map(serializePlayer),
    seasonId: m.seasonId || null,
    seriesId: m.seriesId || null,
    gameNum: m.gameNum || null,
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
    seriesId: m.seriesId || null,
    gameNum: m.gameNum || null,
  };
}

module.exports = { buildMatch, serializeMatch, toStored };
