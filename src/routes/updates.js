'use strict';

/*
 * 업데이트 게시판.
 *  - 관리자가 관리자 페이지 '업데이트 게시판' 탭에서 작성/수정/삭제
 *  - 메인 화면 '업데이트' 탭에서 누구나 열람
 * 저장소는 Supabase `updates` 테이블 (sql/updates.sql).
 */
const express = require('express');
const sb = require('../lib/supabase');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();

const MAX_TITLE = 120;
const MAX_CONTENT = 10000;
const TABLE = 'updates';

function idFilter(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return `id=eq.${id}`;
}

function serialize(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content || '',
    pinned: row.pinned === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

/* 본문 검증 — partial=true 면 PATCH 라서 넘어온 필드만 본다 */
function parseBody(body, partial) {
  const { title, content, pinned } = body || {};
  const errors = [];
  const out = {};

  if (title !== undefined || !partial) {
    const t = title == null ? '' : String(title).trim();
    if (!t) errors.push('제목을 입력하세요.');
    else if (t.length > MAX_TITLE) errors.push(`제목은 ${MAX_TITLE}자 이하여야 합니다.`);
    else out.title = t;
  }
  if (content !== undefined || !partial) {
    const c = content == null ? '' : String(content).replace(/\r\n/g, '\n').trim();
    if (c.length > MAX_CONTENT) errors.push(`내용은 ${MAX_CONTENT}자 이하여야 합니다.`);
    else out.content = c;
  }
  if (pinned !== undefined) out.pinned = !!pinned;

  return { errors, value: out };
}

function dbError(res, what, e) {
  console.error(`업데이트 ${what} 실패:`, e.message);
  const missing = /relation .*updates.* does not exist|PGRST205|Could not find the table/i.test(e.message);
  const rls = /42501|row-level security/i.test(e.message);
  let message = `${what}에 실패했습니다.`;
  if (missing) message = 'updates 테이블이 없습니다. sql/updates.sql 을 Supabase 에서 실행하세요.';
  else if (rls) message = 'updates 테이블의 RLS(행 수준 보안)에 막혔습니다. Supabase SQL Editor 에서 실행하세요: alter table public.updates disable row level security;';
  res.status(500).json({ error: 'internal_error', message });
}

/* GET /api/updates — 목록 (고정글 먼저, 그 다음 최신순) */
router.get('/', async (req, res) => {
  try {
    const rows = await sb.select(TABLE, '', '*', 'pinned.desc,created_at.desc');
    let list = (rows || []).map(serialize);
    const limit = Number(req.query.limit);
    if (Number.isInteger(limit) && limit > 0) list = list.slice(0, limit);
    res.json({ count: list.length, updates: list });
  } catch (e) {
    dbError(res, '조회', e);
  }
});

/* GET /api/updates/:id */
router.get('/:id', async (req, res) => {
  const f = idFilter(req.params.id);
  if (!f) return res.status(404).json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' });
  try {
    const rows = await sb.select(TABLE, f);
    if (!rows || !rows.length) return res.status(404).json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' });
    res.json(serialize(rows[0]));
  } catch (e) {
    dbError(res, '조회', e);
  }
});

/* POST /api/updates — 작성 (관리자) */
router.post('/', requireAdmin, async (req, res) => {
  const { errors, value } = parseBody(req.body, false);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors, message: errors[0] });
  try {
    const rows = await sb.insert(TABLE, { title: value.title, content: value.content, pinned: value.pinned === true });
    res.status(201).json(serialize(rows[0]));
  } catch (e) {
    dbError(res, '저장', e);
  }
});

/* PATCH /api/updates/:id — 수정 (관리자) */
router.patch('/:id', requireAdmin, async (req, res) => {
  const f = idFilter(req.params.id);
  if (!f) return res.status(404).json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' });
  const { errors, value } = parseBody(req.body, true);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors, message: errors[0] });
  if (!Object.keys(value).length) return res.status(400).json({ error: 'validation_failed', message: '수정할 내용이 없습니다.' });
  try {
    const rows = await sb.update(TABLE, f, { ...value, updated_at: new Date().toISOString() });
    if (!rows || !rows.length) return res.status(404).json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' });
    res.json(serialize(rows[0]));
  } catch (e) {
    dbError(res, '수정', e);
  }
});

/* DELETE /api/updates/:id — 삭제 (관리자) */
router.delete('/:id', requireAdmin, async (req, res) => {
  const f = idFilter(req.params.id);
  if (!f) return res.status(404).json({ error: 'not_found', message: '게시글을 찾을 수 없습니다.' });
  try {
    await sb.del(TABLE, f);
    res.json({ deleted: true, id: Number(req.params.id) });
  } catch (e) {
    dbError(res, '삭제', e);
  }
});

module.exports = router;
