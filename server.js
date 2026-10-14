'use strict';

const express = require('express');
const http = require('http');
const path = require('path');

const scales = require('./src/lib/scales');
const store = require('./src/store');
const { attachAuctionWs } = require('./src/auction/ws');
const { memberById, members: memberList } = require('./src/lib/members');

const membersRoute = require('./src/routes/members');
const matchesRoute = require('./src/routes/matches');
const statsRoute = require('./src/routes/stats');
const balanceRoute = require('./src/routes/balance');
const dashboardRoute = require('./src/routes/dashboard');
const scoresRoute = require('./src/routes/scores');
const adminRoute = require('./src/routes/admin');
const auctionRoute = require('./src/routes/auction');
const synergyRoute = require('./src/routes/synergy');
const badgesRoute = require('./src/routes/badges');
const updatesRoute = require('./src/routes/updates');
const duoRoute = require('./src/routes/duo');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => res.redirect('/api'));

/* ── API 인덱스 ── */
app.get('/api', (_req, res) => {
  res.json({
    name: '협곡단 · 내전 기록실 API',
    season: store.getDashConfig().season,
    endpoints: {
      'GET /api/dashboard': '대시보드 집계',
      'GET /api/members': '단원 명단',
      'GET /api/matches': '내전 기록',
      'POST /api/matches': '내전 등록',
      'GET /api/pending': '선택 중인 선수 (새로고침 복원)',
      'PUT /api/pending': '선택 상태 저장 (선택할 때마다)',
      'DELETE /api/pending': '선택 초기화',
      'GET /api/stats': '전적 순위',
      'GET /api/scores': '내전 점수 순위',
      'GET /api/synergy': '듀오/맞대결 조합 통계',
      'GET /api/synergy/:id': '단원별 궁합표',
      'GET /api/duo': '라이엇 실제 경기 기반 듀오 통계 (기준 단원과 같은 팀이었던 단원별 승률·KDA)',
      'POST /api/duo/sync': '라이엇에서 기준 단원의 최근 경기 받아오기',
      'GET /api/badges': '기록 배지',
      'GET /api/updates': '업데이트 게시판',
      'POST /api/balance': '팀 밸런서',
      'GET /api/meta': '스케일 상수',
    },
    roster: store.roster(),
    counts: store.counts(),
  });
});

/* ── 로스터 데이터 출처 ── */
app.get('/api/roster/source', (_req, res) => res.json(store.roster()));

/* ── 시트에서 로스터 재로딩 (명시적 요청 시에만) ── */
app.post('/api/roster/refresh', async (_req, res, next) => {
  try {
    const info = await store.importFromSheet();
    res.json({ refreshed: true, roster: info, counts: store.counts() });
  } catch (e) {
    next(e);
  }
});

/* ── 시즌 ── */
app.get('/api/seasons', (_req, res) => {
  res.json({ seasons: store.getSeasons(), current: store.getCurrentSeason() });
});

/* ── 스케일/메타 상수 ── */
app.get('/api/meta', (_req, res) => {
  res.json({
    season: { year: scales.SEASON_YEAR, label: store.getDashConfig().season },
    tierOrder: scales.TIER_ORDER,
    tierRank: scales.TIER_RANK,
    tierColor: scales.TIER_COLOR,
    lineOrder: scales.LINE_ORDER,
    lineColor: scales.LINE_COLOR,
    lineShort: scales.LINE_SHORT,
    roleLabel: scales.ROLE_LABEL,
  });
});

/* ── Pending (내전 등록 중인 선택 상태) ──
   pending 테이블 1행에 선택 전체를 담는다.
     player_ids  선택된 단원 id 배열 (전원 용병이면 NULL)
     mercenaries 용병 [{name, tier, lane}] — 단원이 아니라 이름을 직접 적는 자리
   선수를 고를 때마다 이 행을 덮어쓰므로 새로고침해도 선택이 남아 있고,
   내전 기록이 저장되면(POST /api/matches) 행이 삭제된다. */
const MODES = ['협곡', '칼바람'];
const EMPTY_PENDING = { mode: '협곡', playerIds: [], mercenaries: [] };

/* 초안 → 화면이 바로 쓸 수 있는 형태 (이름·티어·점수 채워서) */
function serializePending(d) {
  const draft = d || EMPTY_PENDING;
  const stats = store.stats();
  const players = draft.playerIds.map((id) => {
    const m = memberById(id);
    const st = stats[id] || { score: 200 };
    return { id, name: m ? m.name : `#${id}`, tier: m ? m.tier : '언랭', score: st.score, mercenary: false };
  });
  const mercs = draft.mercenaries.map((merc, i) => ({
    id: `merc_${i}`,
    name: merc.name || '',
    tier: merc.tier || '언랭',
    lane: merc.lane || null,
    score: null,
    mercenary: true,
  }));
  return {
    mode: draft.mode || '협곡',
    count: players.length + mercs.length,
    playerIds: draft.playerIds,
    mercenaries: draft.mercenaries,
    players: [...players, ...mercs],
  };
}

/* 선택 상태 검증 — 10명은 '저장 시점'에만 요구하고, 여기서는 고르는 중이라 10명 이하만 본다 */
function parsePendingBody(body) {
  const { mode, playerIds, mercenaries } = body || {};
  const errors = [];

  if (mode && !MODES.includes(mode)) errors.push("모드는 '협곡' 또는 '칼바람' 이어야 합니다.");

  const ids = Array.isArray(playerIds) ? playerIds.map(Number) : [];
  if (ids.some((id) => !Number.isFinite(id))) errors.push('단원 id 형식이 올바르지 않습니다.');
  const bad = ids.filter((id) => Number.isFinite(id) && !memberById(id));
  if (bad.length) errors.push(`존재하지 않는 단원 id: ${bad.join(', ')}`);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup != null) {
    const m = memberById(dup);
    errors.push(`${m ? m.name : dup} 단원이 중복 선택되었습니다.`);
  }

  const rawMercs = Array.isArray(mercenaries) ? mercenaries : [];
  // 이름은 아직 타이핑 중일 수 있으므로 비어 있어도 저장한다 (기록 저장 때 검증됨)
  const mercs = rawMercs.map((m) => ({
    name: m && m.name != null ? String(m.name).trim() : '',
    tier: (m && m.tier) || '언랭',
    lane: (m && m.lane && m.lane !== '없음') ? m.lane : null,
  }));

  if (ids.length + mercs.length > 10) errors.push('최대 10명까지 선택할 수 있습니다.');

  if (errors.length) return { errors };
  return { errors: [], value: { mode: mode || '협곡', playerIds: ids, mercenaries: mercs } };
}

/* GET /api/pending — 선택 상태 (새로고침 복원용) */
app.get('/api/pending', (_req, res) => {
  res.json(serializePending(store.getPending()));
});

/* PUT /api/pending — 선택이 바뀔 때마다 전체 저장 */
app.put('/api/pending', (req, res) => {
  const { errors, value } = parsePendingBody(req.body);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', messages: errors });

  // 아무도 안 남았으면 행을 남겨둘 이유가 없다
  if (value.playerIds.length === 0 && value.mercenaries.length === 0) {
    store.clearPending();
    return res.json(serializePending(null));
  }
  res.json(serializePending(store.savePending(value)));
});

/* DELETE /api/pending — 선택 초기화 */
app.delete('/api/pending', (_req, res) => {
  const cleared = store.clearPending();
  res.json({ deleted: true, cleared });
});

app.use('/api/members', membersRoute);
app.use('/api/matches', matchesRoute);
app.use('/api/stats', statsRoute);
app.use('/api/scores', scoresRoute);
app.use('/api/balance', balanceRoute);
app.use('/api/dashboard', dashboardRoute);
app.use('/api/admin', adminRoute);
app.use('/api/auction', auctionRoute);
app.use('/api/synergy', synergyRoute);
app.use('/api/badges', badgesRoute);
app.use('/api/updates', updatesRoute);
app.use('/api/duo', duoRoute);

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: '요청 본문 JSON 형식이 올바르지 않습니다.' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

async function bootstrap() {
  const info = await store.init();
  return info;
}

const server = http.createServer(app);
attachAuctionWs(server);

if (require.main === module) {
  bootstrap()
    .then((info) => {
      server.listen(PORT, () => {
        const c = store.counts();
        const { USING_DEFAULTS } = require('./src/lib/auth');
        const src = info.source === 'sheet' ? `라이브 시트 (${info.count}명)` : `폴백 스냅샷 (${info.reason || 'offline'})`;
        console.log(`\n⚔️  협곡단 내전 기록실`);
        console.log(`   웹 UI  http://localhost:${PORT}/`);
        console.log(`   API    http://localhost:${PORT}/api`);
        console.log(`   관리자 http://localhost:${PORT}/admin.html   경매 http://localhost:${PORT}/auction.html`);
        console.log(`   로스터 ${src}`);
        console.log(`   단원 ${memberList.length}명 · 내전 ${c.matches}경기`);
        if (USING_DEFAULTS) {
          console.log('   ⚠ ADMIN_PASSWORD/SESSION_SECRET 미설정 — 개발용 기본값 사용 중');
        }
        console.log('');
      });
    })
    .catch((e) => {
      console.error('부팅 실패:', e);
      process.exit(1);
    });
}

module.exports = app;
module.exports.bootstrap = bootstrap;
module.exports.server = server;
