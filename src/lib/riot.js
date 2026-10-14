'use strict';

/*
 * 라이엇 API — 계정(PUUID) 조회, 솔로랭크 티어 조회, 경기 기록(match-v5) 조회를 쓴다.
 *   PUUID 없음  → GET {region}/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}
 *   티어 조회   → GET {platform}/lol/league/v4/entries/by-puuid/{puuid}  (RANKED_SOLO_5x5 만 사용)
 *   경기 목록   → GET {region}/lol/match/v5/matches/by-puuid/{puuid}/ids  (최신순, 한 번에 최대 100개)
 *   경기 상세   → GET {region}/lol/match/v5/matches/{matchId}           (참가자 10명의 KDA·챔피언·팀)
 *
 * 레이트 리밋 — 응답 헤더로 확인한 값:
 *   x-method-rate-limit  account-v1 1000:60 / league-v4 20000:10,1200000:600 / match-v5 2000:10  (넉넉하다)
 *   x-app-rate-limit     100:120,20:1                                          (이게 실질 상한)
 * 메서드 한도는 크지만 앱 한도(1초 20회 · 2분 100회)가 모든 호출에 함께 걸린다.
 * 그래서 호출 전에 아래 limiter 가 버킷을 보고 기다린다 — 한도 스펙은 헤더에서 읽어 스스로 맞춘다.
 *
 * 환경변수
 *   RIOT_API_KEY   개발용 키는 24시간마다 만료된다(403 이면 키부터 새로 발급)
 *   RIOT_PLATFORM  league-v4 호스트 (기본 kr)
 *   RIOT_REGION    account-v1 호스트 (기본 asia)
 */
const KEY = process.env.RIOT_API_KEY || 'RGAPI-9a8a529c-6e31-4a95-b7fb-ef298efa117f';
const PLATFORM = process.env.RIOT_PLATFORM || 'kr';
const REGION = process.env.RIOT_REGION || 'asia';

const HAS_KEY = !!KEY;
const MAX_RETRY_WAIT_MS = 10000; // 429 를 만났을 때 기다려 줄 최대 시간
const MAX_WAIT_MS = 20000;       // 버킷이 차서 이보다 오래 기다려야 하면 실패로 돌린다(요청이 매달리지 않게)
const SAFETY = 1;                // 버킷마다 한 칸 남겨둔다

/* 라이엇 티어 → 앱에서 쓰는 한글 티어 (scales.TIER_ORDER 와 같은 표기) */
const TIER_KO = {
  IRON: '아이언', BRONZE: '브론즈', SILVER: '실버', GOLD: '골드', PLATINUM: '플레티넘',
  EMERALD: '에메랄드', DIAMOND: '다이아', MASTER: '마스터', GRANDMASTER: '그랜드마스터', CHALLENGER: '챌린저',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 앱 레이트 리밋 추적 ──
   [{limit, window(초), hits[]}] — 헤더(x-app-rate-limit)를 받으면 스펙을 그대로 따라간다.
   키를 바꾸거나 프로덕션 키로 올라가면 자동으로 넓어진다. */
let buckets = [{ limit: 20, window: 1, hits: [] }, { limit: 100, window: 120, hits: [] }];

function syncBuckets(res) {
  const spec = res.headers.get('x-app-rate-limit');
  if (!spec) return;
  const parsed = spec.split(',').map((p) => {
    const [limit, window] = p.split(':').map(Number);
    return { limit, window };
  }).filter((b) => Number.isFinite(b.limit) && Number.isFinite(b.window));
  if (!parsed.length) return;
  buckets = parsed.map((b) => {
    const prev = buckets.find((x) => x.window === b.window);
    return { limit: b.limit, window: b.window, hits: prev ? prev.hits : [] };
  });
}

/* 가장 빡빡한 버킷이 풀릴 때까지 기다렸다가 호출 한 건을 기록한다 */
async function takeSlot() {
  for (;;) {
    const now = Date.now();
    let wait = 0;
    for (const b of buckets) {
      b.hits = b.hits.filter((t) => now - t < b.window * 1000);
      if (b.hits.length >= Math.max(1, b.limit - SAFETY)) {
        wait = Math.max(wait, b.window * 1000 - (now - b.hits[0]) + 50);
      }
    }
    if (!wait) break;
    if (wait > MAX_WAIT_MS) {
      throw riotError(`라이엇 호출 한도에 도달했습니다. ${Math.ceil(wait / 1000)}초 뒤에 다시 시도해 주세요.`, 'rate_limited');
    }
    await sleep(wait);
  }
  buckets.forEach((b) => b.hits.push(Date.now()));
}

function riotError(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

async function riotGet(host, path, { retried = false } = {}) {
  if (!HAS_KEY) throw riotError('RIOT_API_KEY 가 설정되지 않았습니다.', 'no_key');
  await takeSlot();
  const res = await fetch(`https://${host}.api.riotgames.com${path}`, { headers: { 'X-Riot-Token': KEY } });
  syncBuckets(res);

  if (res.status === 404) return null;                       // 없는 계정/언랭은 오류가 아니다
  if (res.status === 429 && !retried) {
    const wait = Math.min((Number(res.headers.get('retry-after')) || 2) * 1000, MAX_RETRY_WAIT_MS);
    await sleep(wait);
    return riotGet(host, path, { retried: true });
  }
  if (res.status === 401 || res.status === 403) {
    throw riotError('라이엇 API 키가 만료되었거나 권한이 없습니다. (403)', 'bad_key', res.status);
  }
  if (!res.ok) {
    throw riotError(`라이엇 API 오류 (${res.status})`, 'http_error', res.status);
  }
  return res.json();
}

/* '닉네임#KR1' → { gameName, tagLine } (태그가 없으면 null — 계정 조회 불가) */
function parseRiotId(nick) {
  const s = String(nick == null ? '' : nick).trim();
  const i = s.lastIndexOf('#');
  if (i <= 0 || i === s.length - 1) return null;
  return { gameName: s.slice(0, i).trim(), tagLine: s.slice(i + 1).trim() };
}

/* 라이엇 ID → PUUID (없는 계정이면 null) */
async function fetchPuuid(nick) {
  const id = parseRiotId(nick);
  if (!id) throw riotError(`'${nick}' 는 태그(#KR1)가 없어 조회할 수 없습니다.`, 'bad_riot_id');
  const path = `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(id.gameName)}/${encodeURIComponent(id.tagLine)}`;
  const data = await riotGet(REGION, path);
  return data && data.puuid ? data.puuid : null;
}

/* PUUID → 솔로랭크 { tier, rank, lp }. 언랭이면 tier '언랭' */
async function fetchSoloRank(puuid) {
  const list = await riotGet(PLATFORM, `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`);
  const solo = Array.isArray(list) ? list.find((e) => e.queueType === 'RANKED_SOLO_5x5') : null;
  if (!solo) return { tier: '언랭', rank: null, lp: null };
  return {
    tier: TIER_KO[solo.tier] || '언랭',
    // 마스터 이상은 세부 등급(I)이 의미 없어 버린다
    rank: TIER_KO[solo.tier] && ['마스터', '그랜드마스터', '챌린저'].includes(TIER_KO[solo.tier]) ? null : (solo.rank || null),
    lp: Number.isFinite(Number(solo.leaguePoints)) ? Number(solo.leaguePoints) : null,
  };
}

/*
 * 계정 한 건 갱신 — PUUID 가 없으면 먼저 받아서 채우고, 솔로랭크 티어/LP/조회시각을 넣는다.
 * 실패해도 던지지 않고 { account, error } 로 돌려준다(한 명 실패가 전체를 막지 않게).
 */
async function refreshAccount(acc) {
  const out = { ...acc };
  try {
    if (!out.puuid) {
      const puuid = await fetchPuuid(out.nick);
      if (!puuid) return { account: out, error: `'${out.nick}' 계정을 라이엇에서 찾지 못했습니다.` };
      out.puuid = puuid;
    }
    const solo = await fetchSoloRank(out.puuid);
    out.tier = solo.tier;
    out.rank = solo.rank;
    out.lp = solo.lp;
    out.fetchedAt = new Date().toISOString();
    return { account: out, error: null };
  } catch (e) {
    // 어느 계정에서 난 실패인지 항상 보이게 닉네임을 붙인다
    const msg = e.message.includes(out.nick) ? e.message : `'${out.nick}' ${e.message}`;
    return { account: out, error: msg, code: e.code };
  }
}

/* 계정 여러 건 — 순차 처리(레이트 리밋). PUUID 를 새로 받은 계정도 그대로 반영된다 */
async function refreshAccounts(accounts) {
  const list = [];
  const errors = [];
  for (const acc of accounts) {
    const r = await refreshAccount(acc);
    list.push(r.account);
    if (r.error) errors.push(r.error);
    // 키 문제나 한도 초과면 더 두드려도 소용없다
    if (r.code === 'no_key' || r.code === 'bad_key' || r.code === 'rate_limited') break;
  }
  return { accounts: list, errors };
}

/*
 * PUUID → 경기 id 목록(최신순). start/count 로 페이지를 넘긴다(count 최대 100).
 * startTime(초) 을 주면 그 이후 경기만, queue 를 주면 그 큐만 받는다.
 */
async function fetchMatchIds(puuid, { start = 0, count = 100, startTime = null, queue = null } = {}) {
  const q = new URLSearchParams({ start: String(Math.max(0, start)), count: String(Math.min(100, Math.max(1, count))) });
  if (startTime) q.set('startTime', String(Math.floor(startTime)));
  if (queue != null) q.set('queue', String(queue));
  const list = await riotGet(REGION, `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${q}`);
  return Array.isArray(list) ? list : [];
}

/* 경기 id → match-v5 원본 (없는 경기면 null) */
async function fetchMatch(matchId) {
  return riotGet(REGION, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
}

/* 지금 남은 호출 여유 — 화면에 굳이 쓰진 않지만 진단할 때 본다 */
function rateStatus() {
  const now = Date.now();
  return buckets.map((b) => ({ limit: b.limit, window: b.window, used: b.hits.filter((t) => now - t < b.window * 1000).length }));
}

module.exports = { HAS_KEY, PLATFORM, REGION, TIER_KO, parseRiotId, fetchPuuid, fetchSoloRank, refreshAccount, refreshAccounts, fetchMatchIds, fetchMatch, rateStatus, riotError };
