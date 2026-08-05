'use strict';

/*
 * Supabase PostgREST API 헬퍼.
 * 별도 라이브러리 없이 fetch 만 사용한다.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qrdbhhaoywtaxnhumktw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Fl3HCE4lKfZkeGtU9arOKg_g1QfJTDf';

const BASE = `${SUPABASE_URL}/rest/v1`;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...extra,
  };
}

async function query(table, { filter = '', method = 'GET', body, select: sel = '*', extraHeaders = {} } = {}) {
  const qs = filter ? `?${filter}&select=${sel}` : `?select=${sel}`;
  const url = `${BASE}/${table}${qs}`;
  const opts = { method, headers: headers(extraHeaders) };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${table}: ${res.status} ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return res.json();
  return null;
}

async function insert(table, data) {
  return query(table, { method: 'POST', body: data });
}

/* UPSERT — INSERT ON CONFLICT DO UPDATE (primary key 기준) */
async function upsert(table, data) {
  return query(table, {
    method: 'POST',
    body: data,
    extraHeaders: { Prefer: 'return=representation,resolution=merge-duplicates' },
  });
}

async function select(table, filter = '', sel = '*', orderBy = '') {
  let f = filter;
  if (orderBy) f += (f ? '&' : '') + `order=${orderBy}`;
  return query(table, { filter: f, select: sel });
}

async function update(table, filter, data) {
  return query(table, { method: 'PATCH', filter, body: data });
}

async function del(table, filter) {
  return query(table, { method: 'DELETE', filter });
}

module.exports = { insert, upsert, select, update, del, SUPABASE_URL };
