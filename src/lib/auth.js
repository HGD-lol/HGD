'use strict';

const crypto = require('crypto');

/*
 * 공용 관리자 비밀번호 + HMAC 서명 쿠키 세션.
 *  - ADMIN_PASSWORD : 관리자 비밀번호 (미설정 시 개발용 기본값)
 *  - SESSION_SECRET : 토큰 서명 키 (미설정 시 개발용 기본값)
 * 외부 의존성 없이 crypto 만 사용한다.
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hyeopgok';
const SECRET = process.env.SESSION_SECRET || 'hgd-dev-secret-change-me';
const COOKIE = 'hgd_admin';
const TTL_MS = 12 * 60 * 60 * 1000; // 12시간

const USING_DEFAULTS = !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET;

function hashHex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}
function makeToken() {
  const body = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + TTL_MS })).toString('base64url');
  return body + '.' + sign(body);
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  const h = req.headers && req.headers.cookie;
  if (h) {
    h.split(';').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > -1) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
    });
  }
  return out;
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return false;
  const a = Buffer.from(hashHex(pw));
  const b = Buffer.from(hashHex(ADMIN_PASSWORD));
  return crypto.timingSafeEqual(a, b);
}
function isAdmin(req) {
  return !!verifyToken(parseCookies(req)[COOKIE]);
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'unauthorized', message: '관리자 로그인이 필요합니다.' });
}

module.exports = { COOKIE, TTL_MS, USING_DEFAULTS, makeToken, verifyToken, checkPassword, isAdmin, requireAdmin };
