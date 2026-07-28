'use strict';

const { parseCSV } = require('./csv');
const { RAW } = require('../data/roster');

/*
 * 협곡단 티어표 Google Sheets 를 CSV 로 내려받아 RAW 행 형식으로 변환한다.
 * 네트워크 실패/형식 오류 시 번들된 스냅샷(data/roster.js)으로 폴백한다.
 *
 * RAW 행 = [이름, 출생연도, 닉네임, 티어, 주라인, 부라인, 직책(축약)]
 */
const SHEET_ID = process.env.ROSTER_SHEET_ID || '1cFlRx2IZS0fPhyoQMbRNl2v2ZihrNBwpnt8U7EH1G8Q';
const GID = process.env.ROSTER_SHEET_GID || '0';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

/* 시트의 전체 직책 라벨 → 앱 내부 축약 직책 */
function mapRole(raw) {
  const r = (raw || '').trim();
  if (r.includes('예비')) return '예비';
  if (r.includes('부단장')) return '부단장';
  if (r.includes('단장')) return '단장';
  return '단원';
}

/* CSV 텍스트 → RAW 행 배열 (헤더 제거, 빈 행/유효 연도 없는 행 제외) */
function csvToRaw(text) {
  const table = parseCSV(text);
  if (!table.length) return [];
  const body = table.slice(1); // 헤더 제거
  return body
    .map((r) => {
      const name = (r[0] || '').trim();
      const birth = parseInt((r[1] || '').trim(), 10);
      return [
        name,
        birth,
        (r[2] || '').trim(),
        (r[3] || '').trim(),
        (r[4] || '').trim(),
        (r[5] || '').trim(),
        mapRole(r[6]),
      ];
    })
    .filter((row) => row[0] && Number.isFinite(row[1]));
}

async function loadRosterRows() {
  if (typeof fetch !== 'function') {
    return { rows: RAW, source: 'fallback', reason: 'global fetch 미지원 (Node 18+ 필요)', url: CSV_URL };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(CSV_URL, { redirect: 'follow', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const rows = csvToRaw(text);
    if (rows.length < 5) throw new Error(`파싱된 단원이 너무 적음 (${rows.length})`);
    return { rows, source: 'sheet', url: CSV_URL, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { rows: RAW, source: 'fallback', reason: e.message, url: CSV_URL };
  }
}

module.exports = { loadRosterRows, csvToRaw, mapRole, CSV_URL };
