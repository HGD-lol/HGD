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
      'GET /api/pending': '대기 내전 목록',
      'POST /api/pending': '내전 선수 등록',
      'POST /api/pending/:id/complete': '대기 내전 → 기록 저장',
      'GET /api/stats': '전적 순위',
      'GET /api/scores': '내전 점수 순위',
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

/* ── Pending (대기 내전) ── */
app.get('/api/pending', (_req, res) => {
  const list = store.getPending().map((p) => ({
    ...p,
    players: p.playerIds.map((id) => {
      const m = memberById(id);
      const s = store.stats()[id] || { score: 200 };
      return { id, name: m ? m.name : `#${id}`, tier: m ? m.tier : '언랭', score: s.score };
    }),
  }));
  res.json({ count: list.length, pending: list });
});

app.post('/api/pending', (req, res) => {
  const { playerIds, mode } = req.body || {};
  if (!Array.isArray(playerIds) || playerIds.length !== 10) {
    return res.status(400).json({ error: 'validation_failed', messages: ['정확히 10명을 선택하세요.'] });
  }
  if (mode && mode !== '협곡' && mode !== '칼바람') {
    return res.status(400).json({ error: 'validation_failed', messages: ["모드는 '협곡' 또는 '칼바람' 이어야 합니다."] });
  }
  const ids = playerIds.map(Number);
  const bad = ids.filter((id) => !memberById(id));
  if (bad.length) {
    return res.status(400).json({ error: 'validation_failed', messages: [`존재하지 않는 단원 id: ${bad.join(', ')}`] });
  }
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup != null) {
    return res.status(400).json({ error: 'validation_failed', messages: ['중복된 단원이 있습니다.'] });
  }
  const pending = {
    id: 'p' + Date.now(),
    date: new Date().toISOString(),
    mode: mode || '협곡',
    playerIds: ids,
  };
  store.addPending(pending);
  res.status(201).json(pending);
});

app.delete('/api/pending/:id', (req, res) => {
  const ok = store.deletePending(req.params.id);
  if (!ok) return res.status(404).json({ error: 'pending_not_found' });
  res.json({ deleted: true });
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
