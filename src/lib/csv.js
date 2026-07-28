'use strict';

/*
 * 최소 CSV 파서 — 따옴표로 감싼 필드("미드, 서폿"), 이스케이프된 따옴표(""),
 * CRLF/LF 개행을 처리한다. 외부 의존성 없음.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

module.exports = { parseCSV };
