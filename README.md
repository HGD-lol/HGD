# 협곡단 · 내전 기록실 API

롤 내전 기록 앱(아티팩트)을 **Node.js + Express** REST API 백엔드로 재구성한 프로젝트입니다.
단원 명단·내전 전적·전적 순위·팀 밸런서 기능을 JSON API로 제공하며, 사용자가 등록한 내전은
`data/matches.json` 파일에 영속됩니다. (샘플 전적 26경기는 로스터 기반으로 부팅 시 결정론적으로 생성)

원본 아티팩트 UI를 그대로 이식한 **웹 프런트엔드**가 포함되어 있어 서버 실행 후 바로 사용할 수 있습니다.
프런트엔드의 모든 데이터는 이 API를 `fetch`/WebSocket 으로 호출합니다.

| 페이지 | 경로 | 내용 |
|---|---|---|
| 메인 | `/` | 대시보드·명단·기록·순위(점수)·밸런서·내전 등록 |
| 관리자 | `/admin.html` | 로그인 후 단원 관리 + 내전 기록 수정/삭제/추가 |
| 팀 경매 | `/auction.html` | 실시간 다기기 경매(방 생성/참여, 입찰) |

## 실행

```bash
npm install
npm start        # 웹 UI: http://localhost:3000/  ·  API: http://localhost:3000/api
npm run dev      # 파일 변경 감지 (node --watch)
```

환경변수:
- `PORT` — 포트 (기본 3000)
- `ADMIN_PASSWORD` — 관리자 비밀번호 (미설정 시 개발용 기본값 `hyeopgok`)
- `SESSION_SECRET` — 세션 토큰 서명 키 (운영 시 반드시 설정)
- `ROSTER_SHEET_ID` / `ROSTER_SHEET_GID` — 로스터 시트 지정

```bash
# 예 (Windows PowerShell)
$env:ADMIN_PASSWORD="비밀번호"; $env:SESSION_SECRET="랜덤문자열"; npm start
```

## 주요 기능

- **내전 등록**: KDA 입력 없이 라인별 5:5 선택 + 승리팀 + **MVP 직접 지정**.
- **단원 점수**: `티어점수(등급×10) + 승률보정((승률−0.5)×40) + 연승연패(현재 연속 결과)`.
  연승 n → +n, 연패 n → −n (승리 시 연패 보너스 초기화, 패배 시 연승 보너스 초기화). `src/lib/scoring.js`.
- **관리자**: 공용 비밀번호 로그인(쿠키 세션). 단원 편집/추가/삭제(소프트, 과거 기록 보존)는
  `data/members-override.json` 오버레이로 저장되어 시트 위에 덧입혀짐. 내전 수정/삭제도 관리자 전용.
- **실시간 팀 경매**: 방 생성 → 코드 공유 → 캡틴들이 각 기기에서 접속해 동시 입찰.
  서버가 타이머·낙찰을 소유(`src/auction/`), WebSocket `/ws/auction` 으로 상태 브로드캐스트.

## 데이터 출처 (라이브)

단원 명단은 서버 부팅 시 **협곡단 티어표 Google Sheets** 에서 CSV 로 직접 가져옵니다.

- 시트: `https://docs.google.com/spreadsheets/d/1cFlRx2IZS0fPhyoQMbRNl2v2ZihrNBwpnt8U7EH1G8Q` (gid=0)
- 파싱: `src/lib/roster-source.js` (CSV → 단원 행), `src/lib/csv.js` (따옴표·다중 라인 처리)
- 폴백: 네트워크 실패 시 번들 스냅샷 `src/data/roster.js` 사용 (`/api/roster/source` 로 출처 확인)
- 직책 라벨(`협곡 단장`/`협곡 부단장`/`협곡단원`/`예비 단원`)은 내부 축약형(`단장`/`부단장`/`단원`/`예비`)으로 매핑
- 시트를 수정한 뒤 재시작 없이 반영하려면 `POST /api/roster/refresh`
- 다른 시트를 쓰려면 환경변수 `ROSTER_SHEET_ID`, `ROSTER_SHEET_GID` 설정

## 라이엇 API 연동

`src/lib/riot.js` — 관리자 화면의 `⟳ 티어` 버튼(`POST /api/admin/members/:id/riot-refresh`)이 단원 한 명의 계정을 갱신한다.

- PUUID 가 없는 계정: `GET {region}/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}` 로 받아서 저장
- 티어: `GET {platform}/lol/league/v4/entries/by-puuid/{puuid}` → `RANKED_SOLO_5x5` 만 사용(자유랭크는 버린다). 언랭이면 `tier: '언랭'`
- 라이엇 티어(`DIAMOND`)는 앱 표기(`다이아`)로 변환해서 저장하고, 마스터 이상은 세부 등급을 버린다
- 레이트 리밋 — 응답 헤더로 확인한 실제 값
  - `x-method-rate-limit`: account-v1 `1000:60`, league-v4 `20000:10,1200000:600` (넉넉함)
  - `x-app-rate-limit`: `100:120,20:1` — **모든 호출에 함께 걸리는 앱 한도라 이쪽이 실질 상한**
  - `riot.js` 의 limiter 가 호출 전에 버킷(1초/2분)을 확인해 필요한 만큼 기다린다. 한도 스펙은 응답 헤더에서 읽어 자동으로 맞추므로 키가 바뀌면 따라간다
  - 20초 넘게 기다려야 하면 매달리지 않고 `…초 뒤에 다시 시도해 주세요` 로 실패시킨다
  - **단원별 갱신은 공개**: `POST /api/members/:id/riot-refresh` — 로그인 없이 명단 카드의 `⟳` 로 누구나 누를 수 있다. 대신 **5분 쿨다운**이 있어 최근 갱신된 단원은 라이엇을 부르지 않고 `skipped:true` 와 `retryAfterSec` 만 돌려준다(관리자는 `?force=1` 로 무시)
  - **전체 일괄 갱신은 관리자 전용**: 관리자 페이지 툴바와 메인 명단의 `⟳ 전체 티어 갱신`(관리자로 로그인했을 때만 보임). 단원별 관리자 엔드포인트 `POST /api/admin/members/:id/riot-refresh` 를 한 명씩 호출하며 진행률을 표시하고, 한도에 걸리면 그 지점에서 멈춘다(그때까지는 저장됨)
  - 실패한 계정은 화면에 목록으로 뜬다 — `단원명 — '닉네임#태그' 사유`

**티어** — `tier` 는 파생값이다
- `tier` = 계정 중 가장 높은 솔로랭크(`soloTier`)가 있으면 그 값, 없으면 `baseTier`
- `baseTier` = 시트/관리자가 직접 넣은 티어. DB `members.tier` 에 저장되는 것은 항상 이쪽이라 조회 결과가 수동 값을 덮어쓰지 않는다
- 명단·상세카드·경매·밸런서·대시보드 티어 분포가 모두 `m.tier` 를 보므로 전 화면이 같은 값을 쓴다
- 관리자 편집 패널의 `티어(수동)` 가 `baseTier` 다

**표기 티어 상세** — `soloTier`/`soloRank`/`soloLp`/`soloNick` (파생값, 저장하지 않음)
- 대표 계정은 `accounts[0]` 그대로 두고, **표시용 티어는 계정 중 가장 높은 솔로랭크**를 쓴다 (티어 → 세부 등급 → LP 순 비교)
- 부계정이 더 높으면 관리자 표의 티어 배지와 명단 카드의 `↑ 부계정` 표시가 초록색으로 바뀌고 어느 계정인지 툴팁에 나온다
- 메인 명단 카드는 닉네임 아래에 이 티어를 적고, 카드에 마우스를 올리면 계정별 티어와 마지막 조회 시각이 상세 카드에 나온다
- 조회했는데 전 계정이 언랭이면 `언랭`, 아직 조회 전이면 `null`
- 계정 하나가 실패해도 나머지는 계속 갱신하고 실패 사유만 모아서 돌려준다
- 환경변수: `RIOT_API_KEY`(개발용 키는 24시간마다 만료 — 403 이면 키부터 새로 발급), `RIOT_PLATFORM`(기본 `kr`), `RIOT_REGION`(기본 `asia`)

## 데이터 모델

**단원(member)** — Supabase `members`(최초 1회는 라이브 시트)에서 로드
```
{ id, name, birth, age, nick, nicks[], accounts[], tier, baseTier, solo*, main[], sub[], role, lines[], allLaner }
```
- 한 단원이 부계정을 여러 개 가질 수 있다. 원본은 `accounts`:
  ```
  accounts: [{ nick: "닉네임#KR1", puuid: "…" | null,
               tier: "다이아" | null, rank: "IV" | null, lp: 1 | null,
               fetchedAt: ISO문자열 | null }]
  ```
  - `accounts[0]` = 대표 계정, `nick` = 대표 닉네임, `nicks` = 닉네임 문자열 목록(검색·표시용 파생값)
  - `puuid` = 라이엇 계정 식별자, `tier`/`rank`/`lp` = **솔로랭크** 티어·세부등급·LP, `fetchedAt` = 마지막 조회 시각
  - DB 에는 `members.nicks`(jsonb) 한 칸에 `accounts` 배열을 통째로 저장한다. 예전 형식(문자열 배열/단일 문자열)은 읽을 때 자동으로 계정 객체로 올라간다.
  - 관리자 화면의 단원 목록 → `+ 계정` 버튼에서 추가·삭제·대표 지정, `⟳ 티어` 버튼에서 라이엇 조회
  - **PUUID 만 공개 API 에서 뺀다** — `GET /api/members` 는 계정별 `nick`/`tier`/`rank`/`lp`/`fetchedAt` 까지 주고(명단 카드 hover 에서 쓴다), `puuid` 가 붙은 원본은 관리자 전용 `GET /api/admin/members` 에서만 준다

**매치(match)**
```
{ id, date, dur, blueWin, mvpId,
  blue:[{ id, name, tier, lane, k, d, a, score, mvp }], red:[...] }
```
- MVP = 승리 팀 내 최고 스코어 `(k+a)/max(1,d)` 로 자동 계산
- id 접두사: `s`=샘플(삭제 불가), `u`=사용자 등록

**대기 내전(pending)** — 내전 등록 화면에서 선택 중인 상태. 테이블에 **항상 1행만** 유지된다
```
{ id:'draft', date, mode, player_ids, mercenaries:[{name, tier, lane}] }
```
- 선수를 고를 때마다 이 행을 덮어쓰므로 **페이지를 새로고침해도 선택이 그대로 복원**된다
- 용병은 `player_ids` 에 들어가지 않고 `mercenaries` 에 이름을 직접 적는다.
  전원 용병이면 `player_ids` 는 `NULL`
- 내전 기록을 저장하면(`POST /api/matches`) 이 행은 삭제된다
- 컬럼 변경 쿼리: [`sql/pending.sql`](sql/pending.sql) — Supabase SQL Editor 에서 실행

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api` | 엔드포인트 목록 |
| GET | `/api/meta` | 티어/라인/직책 스케일 상수 |
| GET | `/api/dashboard` | 타일·티어분포·상위딜러·최근내전 집계 |
| GET | `/api/members` | 단원 명단 (`?line=&tier=&role=&q=`) |
| GET | `/api/members/:id` | 단원 상세 |
| GET | `/api/matches` | 내전 기록 최신순 (`?limit=`) |
| GET | `/api/matches/:id` | 단일 매치 |
| POST | `/api/matches` | 내전 등록 (저장 시 `pending` 행 삭제) |
| DELETE | `/api/matches/:id` | 사용자 매치 삭제 |
| GET | `/api/pending` | 선택 중인 선수 (새로고침 복원) |
| PUT | `/api/pending` | 선택 상태 저장 — `{mode, playerIds, mercenaries}` |
| DELETE | `/api/pending` | 선택 초기화 |
| PUT | `/api/matches/:id` | 내전 수정 (관리자) |
| DELETE | `/api/matches/:id` | 내전 삭제 (관리자) |
| GET | `/api/stats` | 전적 순위 (`?minGames=3&sort=wr|score|streak&order=`) |
| GET | `/api/scores` | 단원 자체 점수 순위 |
| POST | `/api/balance` | 팀 밸런서 |
| POST | `/api/admin/login` · `logout` · `GET me` | 관리자 인증 |
| POST/PATCH/DELETE | `/api/admin/members[/:id]` | 단원 추가/편집/삭제 (관리자) |
| POST | `/api/auction/rooms` | 경매방 생성 (WS `/ws/auction`) |
| GET | `/api/roster/source` | 로스터 데이터 출처(라이브 시트/폴백) |
| POST | `/api/roster/refresh` | 시트에서 로스터 다시 불러오기 |

### 내전 등록 예시

```bash
curl -X POST http://localhost:3000/api/matches -H "Content-Type: application/json" -d '{
  "date": "2026-07-27",
  "dur": 32,
  "winner": "blue",
  "blue": [
    {"id":0,"lane":"원딜","k":8,"d":3,"a":6},
    {"id":2,"lane":"정글","k":5,"d":4,"a":9},
    {"id":4,"lane":"미드","k":7,"d":5,"a":4},
    {"id":14,"lane":"탑","k":3,"d":6,"a":3},
    {"id":15,"lane":"서폿","k":1,"d":4,"a":14}
  ],
  "red": [
    {"id":8,"lane":"정글","k":6,"d":7,"a":5},
    {"id":9,"lane":"미드","k":4,"d":8,"a":6},
    {"id":19,"lane":"원딜","k":5,"d":6,"a":4},
    {"id":29,"lane":"탑","k":2,"d":7,"a":3},
    {"id":18,"lane":"서폿","k":0,"d":6,"a":9}
  ]
}'
```

### 팀 밸런서 예시

```bash
curl -X POST http://localhost:3000/api/balance -H "Content-Type: application/json" \
  -d '{"ids":[0,2,4,8,9,14,15,18,19,29],"reroll":0}'
```
티어 합 차이를 최소화하는 5:5 편성을 반환하며, `reroll` 을 증가시키면 동점 후보들 사이에서 다시 섞습니다.

## 구조

```
server.js                 Express + http 서버 · 라우팅 · WebSocket 부착 · public/ 서빙
public/
  index.html              메인 UI (대시보드·명단·기록·순위·밸런서·등록)
  admin.html              관리자 UI (로그인 + 단원/내전 관리)
  auction.html            실시간 팀 경매 UI (WebSocket)
src/
  data/roster.js          티어표 폴백 스냅샷(RAW)
  lib/
    scales.js             티어/라인/직책 상수
    csv.js                CSV 파서(따옴표·다중 라인)
    roster-source.js      Google Sheets 라이브 로더(+폴백)
    members.js            로스터 + 관리자 오버레이 (setRoster/setOverlay)
    match.js              매치 빌드 · MVP · 직렬화 (KDA 없음)
    stats.js              전적 집계 + 연승/연패 스트릭
    scoring.js            단원 자체 점수 계산
    balancer.js           팀 밸런싱 알고리즘
    sample.js             결정론적 샘플 전적 생성
    auth.js               관리자 비밀번호 + HMAC 쿠키 세션
  auction/
    rooms.js              경매방 인메모리 상태·타이머·낙찰 로직
    ws.js                 /ws/auction WebSocket 핸들러
  store.js                매치·오버레이 저장소 (JSON 영속 + 통계 캐시)
  routes/                 members · matches · stats · scores · balance · dashboard · admin · auction
data/matches.json         사용자 등록 내전 (런타임 생성)
data/members-override.json 관리자 단원 편집/추가/삭제 (런타임 생성)
```
