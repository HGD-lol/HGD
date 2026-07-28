'use strict';

const express = require('express');
const store = require('../store');
const { memberById } = require('../lib/members');
const { TIER_ORDER, LINE_ORDER } = require('../lib/scales');
const { COOKIE, TTL_MS, USING_DEFAULTS, makeToken, checkPassword, isAdmin, requireAdmin } = require('../lib/auth');

const router = express.Router();

const ROLES = ['단장', '부단장', '단원', '예비'];
const LINE_VALUES = new Set([...LINE_ORDER, '올라이너']);

/* ── 인증 ── */
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'bad_password', message: '비밀번호가 올바르지 않습니다.' });
  }
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ authed: isAdmin(req), usingDefaults: USING_DEFAULTS });
});

/* ── 단원 입력 검증 ── */
function validateMember(body, { partial } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => body && body[k] !== undefined;

  if (!partial || has('name')) {
    if (!body || !String(body.name || '').trim()) errors.push('이름을 입력하세요.');
    else out.name = String(body.name).trim();
  }
  if (has('birth')) {
    const b = Number(body.birth);
    if (!Number.isFinite(b) || b < 1900 || b > 2100) errors.push('출생연도가 올바르지 않습니다.');
    else out.birth = b;
  }
  if (has('nick')) out.nick = String(body.nick || '').trim();
  if (has('tier')) {
    if (!TIER_ORDER.includes(body.tier)) errors.push(`티어는 ${TIER_ORDER.join('/')} 중 하나여야 합니다.`);
    else out.tier = body.tier;
  }
  if (has('role')) {
    if (!ROLES.includes(body.role)) errors.push(`직책은 ${ROLES.join('/')} 중 하나여야 합니다.`);
    else out.role = body.role;
  }
  ['main', 'sub'].forEach((key) => {
    if (!has(key)) return;
    const arr = Array.isArray(body[key])
      ? body[key]
      : String(body[key] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = arr.filter((l) => !LINE_VALUES.has(l));
    if (bad.length) errors.push(`${key === 'main' ? '주라인' : '부라인'}에 알 수 없는 값: ${bad.join(', ')}`);
    else out[key] = arr;
  });

  return { errors, value: out };
}

/* ── 단원 관리 ── */
router.post('/members', requireAdmin, (req, res) => {
  const { errors, value } = validateMember(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  const id = store.addMember({
    name: value.name,
    birth: value.birth || new Date().getFullYear(),
    nick: value.nick || '',
    tier: value.tier || '언랭',
    main: value.main || [],
    sub: value.sub || [],
    role: value.role || '단원',
  });
  res.status(201).json(memberById(id));
});

router.patch('/members/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!memberById(id)) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  const { errors, value } = validateMember(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });
  store.editMember(id, value);
  res.json(memberById(id));
});

router.delete('/members/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!memberById(id)) return res.status(404).json({ error: 'member_not_found', id: req.params.id });
  store.removeMember(id);
  res.json({ removed: true, id });
});

router.post('/members/:id/restore', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  store.restoreMember(id);
  res.json({ restored: true, id });
});

module.exports = router;
