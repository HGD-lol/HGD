'use strict';

const { memberById } = require('../lib/members');
const store = require('../store');
const { TIER_RANK } = require('../lib/scales');

/*
 * 실시간 팀 경매 방(인메모리).
 * 진행: 로비(lobby) → 라이브(live: 매물 지명 → 입찰 → 낙찰 반복) → 종료(done).
 * 서버가 타이머를 소유하고, 상태 변경마다 방의 모든 소켓에 브로드캐스트한다.
 */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function memberScore(id) {
  const m = memberById(id);
  if (!m) return { id, name: `#${id}`, tier: '언랭', score: 0 };
  const s = store.stats()[id] || { score: 200 };
  return { id, name: m.name, tier: m.tier, tierRank: TIER_RANK[m.tier] || 0, score: s.score };
}

/*
 * config: { budget, minBid, bidIncrement, timerSec, resetSec, teamSize }
 * captains: [{ name }]  players: [memberId,...]
 */
function createRoom({ config = {}, captains = [], players = [] } = {}) {
  const playerList = [...new Set(players.map(Number))].filter((id) => memberById(id));
  const caps = captains
    .map((c, i) => ({ id: i + 1, name: String(c.name || `팀${i + 1}`).trim() || `팀${i + 1}`, points: 0, team: [] }))
    .slice(0, 8);
  if (caps.length < 2) throw new Error('캡틴은 최소 2명이어야 합니다.');
  if (playerList.length < 1) throw new Error('경매할 단원을 1명 이상 선택하세요.');

  const budget = clampInt(config.budget, 1000, 1, 1000000);
  const teamSize = clampInt(config.teamSize, Math.ceil(playerList.length / caps.length), 1, 20);
  caps.forEach((c) => (c.points = budget));

  const code = genCode();
  const room = {
    code,
    hostKey: genCode() + genCode(),
    status: 'lobby',
    config: {
      budget,
      minBid: clampInt(config.minBid, 10, 1, budget),
      bidIncrement: clampInt(config.bidIncrement, 10, 1, budget),
      timerSec: clampInt(config.timerSec, 30, 5, 300),
      resetSec: clampInt(config.resetSec, 10, 3, 120),
      teamSize,
    },
    captains: caps,
    players: playerList.map((id) => ({ ...memberScore(id), status: 'pool', soldTo: null, price: 0 })),
    order: shuffle(playerList),
    current: null, // { playerId, highBid, highCaptainId, endsAt }
    log: [],
    _timer: null,
    _sockets: new Set(),
    _seq: 0,
  };
  rooms.set(code, room);
  return room;
}

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}
function log(room, msg) {
  room.log.push({ t: Date.now(), msg });
  if (room.log.length > 40) room.log.shift();
}

/* 한 캡틴의 최대 입찰가 = 남은 슬롯 확보용 최소금액을 남긴 상태 */
function maxBidFor(room, cap) {
  const slotsLeft = room.config.teamSize - cap.team.length;
  if (slotsLeft <= 0) return 0;
  return cap.points - room.config.minBid * (slotsLeft - 1);
}

function currentPlayer(room) {
  return room.current ? room.players.find((p) => p.id === room.current.playerId) : null;
}

/* ── 진행 제어 ── */
function start(room) {
  if (room.status !== 'lobby') return;
  room.status = 'live';
  log(room, '경매를 시작합니다.');
  nominateNext(room);
}

function nominateNext(room) {
  clearTimer(room);
  room.current = null;
  const nextId = room.order.find((id) => {
    const p = room.players.find((x) => x.id === id);
    return p && p.status === 'pool';
  });
  if (nextId == null) {
    room.status = 'done';
    log(room, '모든 매물이 정리되었습니다. 경매 종료.');
    return;
  }
  const p = room.players.find((x) => x.id === nextId);
  p.status = 'onblock';
  room.current = { playerId: nextId, highBid: 0, highCaptainId: null, endsAt: Date.now() + room.config.timerSec * 1000 };
  log(room, `매물 등장: ${p.name} (${p.tier}) · 시작가 ${room.config.minBid}`);
  armTimer(room);
}

function placeBid(room, captainId, amount) {
  if (room.status !== 'live' || !room.current) return { error: '지금은 입찰할 수 없습니다.' };
  const cap = room.captains.find((c) => c.id === captainId);
  if (!cap) return { error: '캡틴이 아닙니다.' };
  if (cap.team.length >= room.config.teamSize) return { error: '이미 팀이 가득 찼습니다.' };

  const cur = room.current;
  const min = cur.highCaptainId == null ? room.config.minBid : cur.highBid + room.config.bidIncrement;
  let bid = amount == null ? min : parseInt(amount, 10);
  if (!Number.isFinite(bid)) return { error: '입찰가가 올바르지 않습니다.' };
  if (bid < min) bid = min;
  if (cur.highCaptainId === cap.id) return { error: '이미 최고 입찰자입니다.' };

  const cap_max = maxBidFor(room, cap);
  if (bid > cap_max) return { error: `포인트가 부족합니다. (최대 ${cap_max}P)` };

  cur.highBid = bid;
  cur.highCaptainId = cap.id;
  cur.endsAt = Date.now() + room.config.resetSec * 1000;
  const p = currentPlayer(room);
  log(room, `${cap.name} 입찰 ${bid}P → ${p.name}`);
  armTimer(room);
  return { ok: true };
}

function finalize(room) {
  clearTimer(room);
  const cur = room.current;
  if (!cur) return;
  const p = currentPlayer(room);
  if (cur.highCaptainId != null) {
    const cap = room.captains.find((c) => c.id === cur.highCaptainId);
    cap.points -= cur.highBid;
    cap.team.push(p.id);
    p.status = 'sold';
    p.soldTo = cap.id;
    p.price = cur.highBid;
    log(room, `낙찰! ${p.name} → ${cap.name} (${cur.highBid}P, 잔여 ${cap.points}P)`);
  } else {
    p.status = 'unsold';
    log(room, `유찰: ${p.name}`);
  }
  room.current = null;
  setTimeout(() => {
    if (rooms.get(room.code) === room && room.status === 'live') {
      nominateNext(room);
      broadcast(room);
    }
  }, 1500);
}

/* 유찰 매물 재경매 (호스트) */
function requeueUnsold(room) {
  const un = room.players.filter((p) => p.status === 'unsold');
  un.forEach((p) => {
    p.status = 'pool';
    if (!room.order.includes(p.id)) room.order.push(p.id);
  });
  if (room.status === 'done' && un.length) {
    room.status = 'live';
    log(room, `유찰 ${un.length}건 재경매.`);
    nominateNext(room);
  }
}

function armTimer(room) {
  clearTimer(room);
  const ms = Math.max(0, room.current.endsAt - Date.now());
  room._timer = setTimeout(() => {
    finalize(room);
    broadcast(room);
  }, ms);
}
function clearTimer(room) {
  if (room._timer) {
    clearTimeout(room._timer);
    room._timer = null;
  }
}

/* ── 브로드캐스트 ── */
function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    config: room.config,
    captains: room.captains.map((c) => ({
      id: c.id,
      name: c.name,
      points: c.points,
      team: c.team.map((id) => {
        const p = room.players.find((x) => x.id === id);
        return { id, name: p.name, tier: p.tier, price: p.price };
      }),
      slotsLeft: room.config.teamSize - c.team.length,
    })),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      score: p.score,
      status: p.status,
      soldTo: p.soldTo,
      price: p.price,
    })),
    current: room.current
      ? {
          playerId: room.current.playerId,
          player: (() => {
            const p = currentPlayer(room);
            return p ? { id: p.id, name: p.name, tier: p.tier, score: p.score } : null;
          })(),
          highBid: room.current.highBid,
          highCaptainId: room.current.highCaptainId,
          endsAt: room.current.endsAt,
          serverNow: Date.now(),
        }
      : null,
    remaining: room.players.filter((p) => p.status === 'pool').length,
    log: room.log.slice(-30),
    seq: ++room._seq,
  };
}

function broadcast(room) {
  const msg = JSON.stringify({ type: 'state', room: publicState(room) });
  for (const ws of room._sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

module.exports = {
  rooms,
  createRoom,
  getRoom,
  start,
  nominateNext,
  placeBid,
  finalize,
  requeueUnsold,
  broadcast,
  publicState,
  log,
  maxBidFor,
};
