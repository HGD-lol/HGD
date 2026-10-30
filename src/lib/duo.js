'use strict';

/*
 * 라이엇 실제 경기(match-v5) 기반 듀오 통계.
 *
 *  - compactMatch : match-v5 원본(≈80KB) 에서 화면·집계에 쓰는 것만 뽑아 압축 레코드로 만든다(≈3KB).
 *                   압축 레코드가 DB(riot_matches.data) 에 저장되는 형태다.
 *  - computeDuo   : 압축 레코드 목록에서 기준 선수(anchor PUUID)와 같은 팀에 있었던 단원을 찾아
 *                   단원별 경기수·승률·KDA 와 경기 목록을 만든다.
 *
 * 참가자를 단원으로 이어 주는 방법(resolve): PUUID 가 등록된 계정이면 PUUID 로, 아니면
 * 'riotIdGameName#riotIdTagline' 을 단원 닉네임(부계정 포함)과 맞춰 본다. 둘 다 아니면 외부인.
 */

/* 큐 id → 표시 이름. 모르는 큐는 gameMode 로 대신한다 */
const QUEUE_LABEL = {
  0: '사용자 설정', 400: '일반(드래프트)', 430: '일반(블라인드)', 490: '일반(빠른 대전)',
  420: '솔로랭크', 440: '자유랭크', 450: '칼바람', 700: '격전', 720: '칼바람 격전',
  900: 'URF', 1020: '단일 챔피언', 1300: '돌격 넥서스', 1400: '궁극기 주문서',
  1700: '아레나', 1710: '아레나', 1900: 'URF', 2000: '튜토리얼', 2010: '튜토리얼', 2020: '튜토리얼',
};
const MODE_LABEL = { CLASSIC: '소환사의 협곡', ARAM: '칼바람', URF: 'URF', CHERRY: '아레나', NEXUSBLITZ: '돌격 넥서스', ONEFORALL: '단일 챔피언', TUTORIAL: '튜토리얼', PRACTICETOOL: '연습' };

/* 화면 필터용 큐 묶음 */
const QUEUE_GROUP = {
  ranked: [420, 440],
  normal: [400, 430, 490],
  aram: [450, 720],
  custom: [0],
};
function queueGroup(queueId) {
  for (const [g, ids] of Object.entries(QUEUE_GROUP)) if (ids.includes(Number(queueId))) return g;
  return 'other';
}
function queueLabel(queueId, gameMode) {
  return QUEUE_LABEL[Number(queueId)] || MODE_LABEL[gameMode] || (gameMode ? String(gameMode) : '기타');
}

/* 라이엇 포지션 → 앱 라인 표기 */
const POS_KO = { TOP: '탑', JUNGLE: '정글', MIDDLE: '미드', BOTTOM: '원딜', UTILITY: '서폿' };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/*
 * 무효 경기(다시하기) 판정.
 *   - 라이엇이 다시하기로 표시한 경기(gameEndedInEarlySurrender) 는 무조건 무효.
 *   - 그 밖에 VOID_SEC(6분) 안에 끝난 경기도 무효. 정상 항복은 이보다 이른 시간에 불가능하므로
 *     이 안에 끝났다면 탈주자 때문에 조기 항복한 경기(라이엇은 '항복'으로만 표시하고 패배로 센다)거나
 *     서버 문제로 끊긴 경기다. 예: 3분 20초에 팀원이 1레벨인 채 항복 → 라이엇은 패배, 여기서는 무효.
 *   옛 레코드에는 end 가 없으므로 dur 만으로도 판정되게 둔다.
 */
const VOID_SEC = 360;
function isVoidGame(r) {
  if (!r) return false;
  if (r.end === 'remake') return true;
  return r.dur > 0 && r.dur < VOID_SEC;
}

/* match-v5 원본 → 압축 레코드 */
function compactMatch(raw) {
  if (!raw || !raw.metadata || !raw.info) return null;
  const info = raw.info;
  const participants = (info.participants || []).map((p) => ({
    puuid: p.puuid || null,
    riotId: p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline || ''}` : (p.summonerName || ''),
    champ: p.championName || '',
    teamId: num(p.teamId),
    win: !!p.win,
    k: num(p.kills), d: num(p.deaths), a: num(p.assists),
    pos: POS_KO[p.teamPosition] || POS_KO[p.individualPosition] || null,
    lvl: num(p.champLevel),
    cs: num(p.totalMinionsKilled) + num(p.neutralMinionsKilled),
    gold: num(p.goldEarned),
    dmg: num(p.totalDamageDealtToChampions),
    vision: num(p.visionScore),
    multi: num(p.pentaKills) ? 'penta' : (num(p.quadraKills) ? 'quadra' : (num(p.tripleKills) ? 'triple' : null)),
  }));
  const ps = info.participants || [];
  // 종료 사유 — remake(다시하기) · surrender(항복) · complete(넥서스 파괴)
  const end = ps.some((p) => p.gameEndedInEarlySurrender) ? 'remake' : (ps.some((p) => p.gameEndedInSurrender) ? 'surrender' : 'complete');
  return {
    id: raw.metadata.matchId,
    gameAt: num(info.gameCreation) || null,                  // ms
    endAt: num(info.gameEndTimestamp) || null,              // ms
    dur: num(info.gameDuration),                             // 초 (최신 패치 기준)
    queueId: num(info.queueId),
    gameMode: info.gameMode || null,
    result: info.endOfGameResult || null,
    end,
    participants,
  };
}

const kdaRatio = (k, d, a) => (d > 0 ? (k + a) / d : (k + a));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/* 누적 k/d/a/cs → 평균. durSec 은 그 경기들의 총 길이(초) — 분당 CS 용 */
function kdaBlock(k, d, a, games, cs = 0, durSec = 0) {
  const g = Math.max(1, games);
  return {
    k, d, a,
    avgK: round1(k / g), avgD: round1(d / g), avgA: round1(a / g),
    ratio: round2(kdaRatio(k, d, a)),
    perfect: d === 0 && (k + a) > 0,
    cs,
    avgCs: Math.round(cs / g),
    csPerMin: durSec > 0 ? round1(cs / (durSec / 60)) : 0,
  };
}

/* 참가자 한 명 → 경기 카드에 보여줄 한 줄 */
function playerLine(p) {
  return {
    champ: p.champ, k: p.k, d: p.d, a: p.a, pos: p.pos, lvl: p.lvl, cs: p.cs, gold: p.gold, dmg: p.dmg, vision: p.vision,
    kda: round2(kdaRatio(p.k, p.d, p.a)), multi: p.multi || null, riotId: p.riotId,
  };
}

/*
 * 듀오 집계.
 *   records       압축 레코드 배열(순서 무관)
 *   anchorPuuid   기준 선수 PUUID
 *   resolve(p)    참가자 → 단원 {id, name, tier} | null
 *   anchorId      기준 선수의 단원 id (부계정이 같은 경기에 있을 리는 없지만 안전하게 뺀다)
 *   opts.group    큐 묶음 필터('ranked'|'normal'|'aram'|'custom'|'other'|null)
 */
function computeDuo(records, anchorPuuid, resolve, anchorId, opts = {}) {
  const group = opts.group || null;
  const partners = new Map();   // memberId → 집계
  const games = [];
  let anchorAll = { games: 0, wins: 0 };   // 기준 선수 전체(저장된 경기) 승패 — 듀오 때와 비교용
  let soloGames = 0, soloWins = 0;         // 단원 없이 뛴 경기
  const queueCounts = {};
  const outsiders = new Map();             // riotId → 같은 팀이었지만 단원으로 못 이은 계정 (부계정 등록 힌트)

  const sorted = [...records].sort((x, y) => (y.gameAt || 0) - (x.gameAt || 0));
  sorted.forEach((r) => {
    const me = (r.participants || []).find((p) => p.puuid === anchorPuuid);
    if (!me) return;
    if (group && queueGroup(r.queueId) !== group) return;
    // 다시하기·탈주자 조기 항복 등 무효 경기는 승패로 세지 않는다 (isVoidGame)
    if (isVoidGame(r)) return;
    anchorAll.games++; if (me.win) anchorAll.wins++;
    queueCounts[r.queueId] = (queueCounts[r.queueId] || 0) + 1;

    const allies = [];
    const enemies = [];
    (r.participants || []).forEach((p) => {
      if (p === me) return;
      const m = resolve(p);
      if (!m) {
        if (p.teamId === me.teamId && p.riotId) {
          const o = outsiders.get(p.riotId) || { riotId: p.riotId, games: 0, wins: 0, lastAt: 0 };
          o.games++; if (me.win) o.wins++; o.lastAt = Math.max(o.lastAt, r.gameAt || 0);
          outsiders.set(p.riotId, o);
        }
        return;
      }
      if (m.id === anchorId) return;
      const line = { id: m.id, name: m.name, tier: m.tier, ...playerLine(p) };
      const side = p.teamId === me.teamId ? allies : enemies;
      if (!side.some((x) => x.id === m.id)) side.push(line);   // 한 단원은 한 경기에 한 번만
    });

    if (!allies.length) { soloGames++; if (me.win) soloWins++; }
    if (!allies.length && !enemies.length) return;

    const game = {
      id: r.id,
      gameAt: r.gameAt ? new Date(r.gameAt).toISOString() : null,
      dur: r.dur,
      queueId: r.queueId,
      queue: queueLabel(r.queueId, r.gameMode),
      group: queueGroup(r.queueId),
      win: me.win,
      me: playerLine(me),
      allies,
      enemies,
    };
    if (allies.length) games.push(game);

    allies.forEach((al) => {
      let e = partners.get(al.id);
      if (!e) {
        e = { id: al.id, name: al.name, tier: al.tier, games: 0, wins: 0, dur: 0, me: { k: 0, d: 0, a: 0, cs: 0 }, partner: { k: 0, d: 0, a: 0, cs: 0 },
          lastAt: null, firstAt: null, recent: [], champs: new Map(), myChamps: new Map(), queues: {}, pos: new Map() };
        partners.set(al.id, e);
      }
      e.games++;
      if (me.win) e.wins++;
      e.dur += r.dur || 0;
      e.me.k += me.k; e.me.d += me.d; e.me.a += me.a; e.me.cs += me.cs || 0;
      e.partner.k += al.k; e.partner.d += al.d; e.partner.a += al.a; e.partner.cs += al.cs || 0;
      if (!e.lastAt || (r.gameAt || 0) > e.lastAt) e.lastAt = r.gameAt || 0;
      if (!e.firstAt || (r.gameAt || 0) < e.firstAt) e.firstAt = r.gameAt || 0;
      if (e.recent.length < 10) e.recent.push(me.win ? 'W' : 'L');   // sorted 가 최신순이라 앞이 최근
      e.champs.set(al.champ, (e.champs.get(al.champ) || 0) + 1);
      e.myChamps.set(me.champ, (e.myChamps.get(me.champ) || 0) + 1);
      e.queues[game.queue] = (e.queues[game.queue] || 0) + 1;
      if (al.pos) e.pos.set(al.pos, (e.pos.get(al.pos) || 0) + 1);
    });
  });

  const topN = (map, n) => [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  const rows = [...partners.values()].map((e) => {
    // 현재 연속 — 최근 경기부터 같은 결과가 이어지는 길이 (+연승 / −연패)
    let streak = 0;
    if (e.recent.length) {
      const first = e.recent[0];
      for (const x of e.recent) { if (x === first) streak++; else break; }
      if (first === 'L') streak = -streak;
    }
    return {
      id: e.id, name: e.name, tier: e.tier,
      games: e.games, wins: e.wins, losses: e.games - e.wins,
      winrate: Number((e.games ? e.wins / e.games : 0).toFixed(4)),
      me: kdaBlock(e.me.k, e.me.d, e.me.a, e.games, e.me.cs, e.dur),
      partner: kdaBlock(e.partner.k, e.partner.d, e.partner.a, e.games, e.partner.cs, e.dur),
      lastAt: e.lastAt ? new Date(e.lastAt).toISOString() : null,
      firstAt: e.firstAt ? new Date(e.firstAt).toISOString() : null,
      recent: e.recent,
      streak,
      champs: topN(e.champs, 3),
      myChamps: topN(e.myChamps, 3),
      pos: topN(e.pos, 2),
      queues: e.queues,
    };
  }).sort((x, y) => y.games - x.games || y.winrate - x.winrate || x.name.localeCompare(y.name, 'ko'));

  const duoGames = games.length;
  const duoWins = games.filter((g) => g.win).length;
  // 2경기 이상 같은 팀이었던 미등록 계정 — 솔랭·자랭에서 우연히 만난 사람은 보통 1경기라 걸러진다
  const frequentOutsiders = [...outsiders.values()].filter((o) => o.games >= 2)
    .sort((x, y) => y.games - x.games || y.lastAt - x.lastAt).slice(0, 12)
    .map((o) => ({ riotId: o.riotId, games: o.games, wins: o.wins, lastAt: o.lastAt ? new Date(o.lastAt).toISOString() : null }));
  return {
    partners: rows,
    games,
    frequentOutsiders,
    summary: {
      total: anchorAll.games, totalWins: anchorAll.wins,
      duoGames, duoWins, duoWinrate: Number((duoGames ? duoWins / duoGames : 0).toFixed(4)),
      soloGames, soloWins, soloWinrate: Number((soloGames ? soloWins / soloGames : 0).toFixed(4)),
      partnersCount: rows.length,
      queueCounts,
    },
  };
}

module.exports = { compactMatch, computeDuo, isVoidGame, VOID_SEC, queueLabel, queueGroup, QUEUE_LABEL, QUEUE_GROUP, POS_KO };
