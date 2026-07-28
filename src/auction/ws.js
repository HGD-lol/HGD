'use strict';

const { WebSocketServer } = require('ws');
const url = require('url');
const R = require('./rooms');

/*
 * 경매 WebSocket. 클라이언트는 /ws/auction?code=ABCD&name=...&host=KEY 로 접속.
 * 서버가 타이머·낙찰을 소유하고 상태를 브로드캐스트한다.
 */
function attachAuctionWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== '/ws/auction') return; // 다른 업그레이드는 무시
    const room = R.getRoom(query.code);
    if (!room) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.roomCode = room.code;
      ws.name = String(query.name || '관전자').slice(0, 20);
      ws.isHost = query.host && query.host === room.hostKey;
      ws.captainId = null;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const room = R.getRoom(ws.roomCode);
    if (!room) return ws.close();
    room._sockets.add(ws);
    send(ws, { type: 'hello', you: { name: ws.name, isHost: !!ws.isHost }, room: R.publicState(room) });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      handle(ws, room, msg);
    });
    ws.on('close', () => room._sockets.delete(ws));
    ws.on('error', () => room._sockets.delete(ws));
  });

  return wss;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function err(ws, message) {
  send(ws, { type: 'error', message });
}

function handle(ws, room, msg) {
  switch (msg.type) {
    case 'claim': {
      const cid = Number(msg.captainId);
      if (!room.captains.find((c) => c.id === cid)) return err(ws, '없는 캡틴 슬롯입니다.');
      ws.captainId = cid;
      send(ws, { type: 'claimed', captainId: cid });
      R.broadcast(room);
      break;
    }
    case 'release':
      ws.captainId = null;
      R.broadcast(room);
      break;

    case 'bid': {
      if (ws.captainId == null) return err(ws, '먼저 캡틴을 선택하세요.');
      const res = R.placeBid(room, ws.captainId, msg.amount);
      if (res.error) return err(ws, res.error);
      R.broadcast(room);
      break;
    }

    /* ── 호스트 전용 ── */
    case 'start':
      if (!ws.isHost) return err(ws, '호스트만 시작할 수 있습니다.');
      R.start(room);
      R.broadcast(room);
      break;
    case 'skip': // 현재 매물 즉시 마감
      if (!ws.isHost) return err(ws, '호스트만 가능합니다.');
      if (room.current) { R.finalize(room); R.broadcast(room); }
      break;
    case 'next': // 매물 없을 때 다음 지명
      if (!ws.isHost) return err(ws, '호스트만 가능합니다.');
      if (room.status === 'live' && !room.current) { R.nominateNext(room); R.broadcast(room); }
      break;
    case 'requeue': // 유찰 재경매
      if (!ws.isHost) return err(ws, '호스트만 가능합니다.');
      R.requeueUnsold(room);
      R.broadcast(room);
      break;

    default:
      err(ws, '알 수 없는 요청입니다.');
  }
}

module.exports = { attachAuctionWs };
