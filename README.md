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

## 데이터 모델

**단원(member)** — 라이브 시트(또는 폴백 스냅샷)에서 로드
```
{ id, name, birth, age, nick, tier, main[], sub[], role, lines[], allLaner }
```

**매치(match)**
```
{ id, date, dur, blueWin, mvpId,
  blue:[{ id, name, tier, lane, k, d, a, score, mvp }], red:[...] }
```
- MVP = 승리 팀 내 최고 스코어 `(k+a)/max(1,d)` 로 자동 계산
- id 접두사: `s`=샘플(삭제 불가), `u`=사용자 등록

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
| POST | `/api/matches` | 내전 등록 |
| DELETE | `/api/matches/:id` | 사용자 매치 삭제 |
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
