'use strict';

/*
 * 단원 간 조합 통계.
 *  - duo   : 같은 팀으로 함께 뛴 기록 (두 사람의 승패가 항상 같다)
 *  - rival : 서로 반대 팀으로 만난 기록 (a 기준 승수를 저장)
 * 용병은 id 가 매 등록마다 새로 생성되는 임시값이라 제외한다.
 */

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const memberIds = (side) => side.filter((p) => !p.mercenary && Number(p.id) >= 0).map((p) => Number(p.id));

function computePairs(matches) {
  const duo = new Map();
  const rival = new Map();

  const touch = (map, x, y) => {
    const k = pairKey(x, y);
    let e = map.get(k);
    if (!e) {
      e = { a: Math.min(x, y), b: Math.max(x, y), g: 0, w: 0 };
      map.set(k, e);
    }
    return e;
  };

  matches.forEach((mt) => {
    const B = memberIds(mt.blue);
    const R = memberIds(mt.red);

    // 같은 팀 조합
    [[B, mt.blueWin], [R, !mt.blueWin]].forEach(([ids, won]) => {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const e = touch(duo, ids[i], ids[j]);
          e.g++;
          if (won) e.w++;
        }
      }
    });

    // 맞대결 조합 — w 는 e.a(작은 id) 기준 승수
    B.forEach((x) => {
      R.forEach((y) => {
        const e = touch(rival, x, y);
        e.g++;
        const aIsBlue = e.a === x;
        if (aIsBlue ? mt.blueWin : !mt.blueWin) e.w++;
      });
    });
  });

  return { duo, rival };
}

/* 한 단원 기준으로 상대편 id 와 그 단원의 승/패로 풀어낸다 */
function forMember(map, id, kind) {
  const out = [];
  map.forEach((e) => {
    if (e.a !== id && e.b !== id) return;
    const other = e.a === id ? e.b : e.a;
    // duo 는 승패 공유, rival 은 e.a 기준이므로 b 쪽이면 뒤집는다
    const wins = kind === 'duo' ? e.w : (e.a === id ? e.w : e.g - e.w);
    out.push({ id: other, games: e.g, wins, losses: e.g - wins, winrate: e.g ? wins / e.g : 0 });
  });
  return out;
}

module.exports = { computePairs, forMember, pairKey };
