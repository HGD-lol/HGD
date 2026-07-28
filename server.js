'use strict';

const express = require('express');
const http = require('http');
const path = require('path');

const scales = require('./src/lib/scales');
const store = require('./src/store');
const { attachAuctionWs } = require('./src/auction/ws');

const membersRoute = require('./src/routes/members');
const matchesRoute = require('./src/routes/matches');
const statsRoute = require('./src/routes/stats');
const balanceRoute = require('./src/routes/balance');
const dashboardRoute = require('./src/routes/dashboard');
const scoresRoute = require('./src/routes/scores');
const adminRoute = require('./src/routes/admin');
const auctionRoute = require('./src/routes/auction');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 간단 요청 로그
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  next();
});

// 정적 파일 (public/ 이 있으면 프런트엔드도 서빙)
app.use(express.static(path.join(__dirname, 'public')));

/* 루트 → API 인덱스로 안내 (public/index.html 이 있으면 그쪽이 우선 서빙됨) */
app.get('/', (_req, res) => res.redirect('/api'));

/* ── API 인덱스 ── */
app.get('/api', (_req, res) => {
  res.json({
    name: '협곡단 · 내전 기록실 API',
    season: scales.SEASON_LABEL,
    endpoints: {
      'GET /api/dashboard': '대시보드 집계',
      'GET /api/members': '단원 명단 (?line=&tier=&role=&q=)',
      'GET /api/members/:id': '단원 상세',
      'GET /api/matches': '내전 기록 (?limit=)',
      'GET /api/matches/:id': '단일 매치',
      'POST /api/matches': '내전 등록',
      'DELETE /api/matches/:id': '사용자 매치 삭제',
      'GET /api/stats': '전적 순위 (?minGames=&sort=&order=)',
      'GET /api/stats/:id': '단원 개인 전적',
      'PUT /api/matches/:id': '내전 수정 (관리자)',
      'DELETE /api/matches/:id': '내전 삭제 (관리자)',
      'GET /api/stats': '전적 순위 (?minGames=&sort=&order=)',
      'GET /api/scores': '단원 자체 점수 순위',
      'POST /api/balance': '팀 밸런서 { ids:[10], reroll }',
      'GET /api/meta': '티어/라인/직책 스케일',
      'GET /api/roster/source': '로스터 데이터 출처(라이브 시트/폴백)',
      'POST /api/roster/refresh': '시트에서 로스터 다시 불러오기',
      'POST /api/admin/login': '관리자 로그인',
      'PATCH/POST/DELETE /api/admin/members': '단원 관리 (관리자)',
      'POST /api/auction/rooms': '경매방 생성 · WS /ws/auction',
    },
    roster: store.roster(),
    counts: store.counts(),
  });
});

/* ── 로스터 데이터 출처 ── */
app.get('/api/roster/source', (_req, res) => res.json(store.roster()));

/* ── 시트에서 로스터 재로딩 ── */
app.post('/api/roster/refresh', async (_req, res, next) => {
  try {
    const info = await store.init();
    res.json({ refreshed: true, roster: info, counts: store.counts() });
  } catch (e) {
    next(e);
  }
});

/* ── 스케일/메타 상수 ── */
app.get('/api/meta', (_req, res) => {
  res.json({
    season: { year: scales.SEASON_YEAR, label: scales.SEASON_LABEL },
    tierOrder: scales.TIER_ORDER,
    tierRank: scales.TIER_RANK,
    tierColor: scales.TIER_COLOR,
    lineOrder: scales.LINE_ORDER,
    lineColor: scales.LINE_COLOR,
    lineShort: scales.LINE_SHORT,
    roleLabel: scales.ROLE_LABEL,
  });
});

app.use('/api/members', membersRoute);
app.use('/api/matches', matchesRoute);
app.use('/api/stats', statsRoute);
app.use('/api/scores', scoresRoute);
app.use('/api/balance', balanceRoute);
app.use('/api/dashboard', dashboardRoute);
app.use('/api/admin', adminRoute);
app.use('/api/auction', auctionRoute);

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// 에러 핸들러 (잘못된 JSON 본문 등)
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: '요청 본문 JSON 형식이 올바르지 않습니다.' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

async function bootstrap() {
  const info = await store.init(); // 로스터(라이브 시트/폴백) 로드 후 매치 구성
  return info;
}

const server = http.createServer(app);
attachAuctionWs(server); // /ws/auction WebSocket

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
        console.log(`   단원 ${require('./src/lib/members').members.length}명 · 내전 ${c.matches}경기 (샘플 ${c.sampleMatches} + 사용자 ${c.userMatches})`);
        if (USING_DEFAULTS) {
          console.log('   ⚠ ADMIN_PASSWORD/SESSION_SECRET 미설정 — 개발용 기본값 사용 중 (기본 비번: hyeopgok)');
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
