'use strict';

const { memberById } = require('./members');

/*
 * 저장 형태의 원시 매치({ id, date, dur, blueWin, mvpId, blue:[{id,lane}], red:[...] })를
 * 이름·티어·MVP 가 채워진 완성 매치 객체로 빌드한다.
 * MVP 는 등록 시 직접 지정한다(mvpId). KDA 는 더 이상 다루지 않는다.
 */
function buildMatch({ id, date, dur, blueWin, blue, red, mvpId }) {
  const mvpNum = mvpId == null ? null : Number(mvpId);
  const norm = (arr) =>
    arr.map((p) => {
      const m = memberById(p.id);
      return {
        id: Number(p.id),
        name: m ? m.name : `#${p.id}`,
        tier: m ? m.tier : '언랭',
        lane: p.lane,
        mvp: mvpNum != null && Number(p.id) === mvpNum,
      };
    });

  const B = norm(blue);
  const R = norm(red);
  const hasMvp = [...B, ...R].some((p) => p.mvp);

  return {
    id,
    date: date instanceof Date ? date : new Date(date),
    dur: +dur || 30,
    blueWin: !!blueWin,
    blue: B,
    red: R,
    mvpId: hasMvp ? mvpNum : null,
  };
}

/* 저장/전송용 직렬화 (date -> ISO 문자열) */
function serializeMatch(m) {
  return {
    id: m.id,
    date: m.date.toISOString(),
    dur: m.dur,
    blueWin: m.blueWin,
    mvpId: m.mvpId,
    blue: m.blue.map(serializePlayer),
    red: m.red.map(serializePlayer),
  };
}

function serializePlayer(p) {
  return { id: p.id, name: p.name, tier: p.tier, lane: p.lane, mvp: p.mvp };
}

/* 파일 저장용 최소 형태 */
function toStored(m) {
  return {
    id: m.id,
    date: m.date.toISOString(),
    dur: m.dur,
    blueWin: m.blueWin,
    mvpId: m.mvpId,
    blue: m.blue.map((p) => ({ id: p.id, lane: p.lane })),
    red: m.red.map((p) => ({ id: p.id, lane: p.lane })),
  };
}

module.exports = { buildMatch, serializeMatch, toStored };
