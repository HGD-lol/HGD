'use strict';

const crypto = require('crypto');
const express = require('express');
const sb = require('../lib/supabase');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

function hashIp(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/* POST /api/suggestions — 건의 작성 (누구나, 1시간당 1개) */
router.post('/', async (req, res) => {
  const { author_name, content } = req.body || {};
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: 'validation_failed', message: '내용을 입력하세요.' });
  }
  const name = String(author_name || '익명').trim().slice(0, 30) || '익명';
  const text = String(content).trim().slice(0, 2000);
  const ipHash = hashIp(req);

  try {
    // 도배 방지: 같은 IP에서 1시간 내 작성 여부 확인
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await sb.select('suggestions', `ip_hash=eq.${ipHash}&created_at=gte.${oneHourAgo}`);
    if (recent && recent.length > 0) {
      return res.status(429).json({ error: 'rate_limited', message: '1시간에 1개의 건의만 작성할 수 있습니다.' });
    }

    const editToken = crypto.randomBytes(16).toString('hex');
    const rows = await sb.insert('suggestions', {
      author_name: name,
      content: text,
      edit_token: editToken,
      ip_hash: ipHash,
    });
    const created = rows && rows[0];
    res.status(201).json({ id: created.id, edit_token: editToken });
  } catch (e) {
    console.error('건의 작성 실패:', e.message);
    res.status(500).json({ error: 'internal_error', message: '저장에 실패했습니다.' });
  }
});

/* PATCH /api/suggestions/:id — 건의 수정 (작성자 본인, edit_token 필요) */
router.patch('/:id', async (req, res) => {
  const { edit_token, content } = req.body || {};
  if (!edit_token) return res.status(401).json({ error: 'unauthorized', message: '수정 권한이 없습니다.' });
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: 'validation_failed', message: '내용을 입력하세요.' });
  }
  try {
    const rows = await sb.update(
      'suggestions',
      `id=eq.${req.params.id}&edit_token=eq.${edit_token}`,
      { content: String(content).trim().slice(0, 2000) }
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: '건의를 찾을 수 없거나 수정 권한이 없습니다.' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('건의 수정 실패:', e.message);
    res.status(500).json({ error: 'internal_error', message: '수정에 실패했습니다.' });
  }
});

/* GET /api/suggestions — 건의 목록 (관리자 전용) */
router.get('/', requireAdmin, async (_req, res) => {
  try {
    const rows = await sb.select('suggestions', '', '*', 'created_at.desc');
    res.json({ count: (rows || []).length, suggestions: rows || [] });
  } catch (e) {
    console.error('건의 조회 실패:', e.message);
    res.status(500).json({ error: 'internal_error', message: '조회에 실패했습니다.' });
  }
});

/* DELETE /api/suggestions/:id — 건의 삭제 (관리자 전용) */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await sb.del('suggestions', `id=eq.${req.params.id}`);
    res.json({ deleted: true });
  } catch (e) {
    console.error('건의 삭제 실패:', e.message);
    res.status(500).json({ error: 'internal_error', message: '삭제에 실패했습니다.' });
  }
});

module.exports = router;
