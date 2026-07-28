'use strict';

const express = require('express');
const R = require('../auction/rooms');

const router = express.Router();

/* POST /api/auction/rooms — 경매방 생성. body: { config, captains:[{name}], players:[id] } */
router.post('/rooms', (req, res) => {
  try {
    const room = R.createRoom(req.body || {});
    res.status(201).json({
      code: room.code,
      hostKey: room.hostKey, // 생성자(호스트)만 알고 있어야 하는 키
      state: R.publicState(room),
    });
  } catch (e) {
    res.status(400).json({ error: 'create_failed', message: e.message });
  }
});

/* GET /api/auction/rooms/:code — 방 상태(관전용) */
router.get('/rooms/:code', (req, res) => {
  const room = R.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'room_not_found', code: req.params.code });
  res.json(R.publicState(room));
});

module.exports = router;
