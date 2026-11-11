'use strict';

/*
 * 대회(CK) API.
 *  - GET  /api/tournament            메인 화면용 — '메인 노출' 대회 1건 (팀·대진·결과 계산 포함)
 *  - GET  /api/tournament/admin/all  관리자 — 전체 대회 원본(doc) + 계산 결과(view)
 *  - POST /api/tournament            새 대회 (관리자)
 *  - PUT  /api/tournament/:id        대회 통째로 저장 (관리자) — 팀·선수·대진·연결된 내전 기록
 *  - DELETE /api/tournament/:id      대회 삭제 (관리자)
 */
const express = require('express');
const t = require('../lib/tournament');
const { requireAdmin } = require('../lib/auth');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const invalid = (res, errors) => res.status(400).json({ error: 'validation_failed', messages: errors, message: errors[0] });
const pack = (doc) => ({ doc, view: t.view(doc) });

router.get('/', wrap(async (_req, res) => {
  const doc = await t.featured();
  res.json({ tournament: doc ? t.view(doc) : null });
}));

router.get('/admin/all', requireAdmin, wrap(async (_req, res) => {
  const docs = await t.all();
  res.json({
    tournaments: docs.map(pack),
    persisted: t.isPersisted(),
    stages: t.STAGES, statuses: t.STATUSES, bestOf: t.BEST_OF,
  });
}));

router.post('/', requireAdmin, wrap(async (req, res) => {
  const r = await t.create(req.body);
  if (r.errors.length) return invalid(res, r.errors);
  res.status(201).json({ ...pack(r.doc), warning: r.warning || null });
}));

router.put('/:id', requireAdmin, wrap(async (req, res) => {
  const r = await t.save(req.params.id, req.body);
  if (r.notFound) return res.status(404).json({ error: 'not_found', message: '대회를 찾을 수 없습니다.' });
  if (r.errors.length) return invalid(res, r.errors);
  res.json({ ...pack(r.doc), warning: r.warning || null });
}));

router.delete('/:id', requireAdmin, wrap(async (req, res) => {
  const r = await t.remove(req.params.id);
  if (r.notFound) return res.status(404).json({ error: 'not_found', message: '대회를 찾을 수 없습니다.' });
  if (r.errors.length) return invalid(res, r.errors);
  res.json({ deleted: true, id: req.params.id });
}));

module.exports = router;
