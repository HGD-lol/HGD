# 협곡단 · 내전 기록실 API

롤 내전 기록 앱(아티팩트)을 **Node.js + Express** REST API 백엔드로 재구성한 프로젝트입니다.
단원 명단·내전 전적·전적 순위·팀 밸런서 기능을 JSON API로 제공하며, 사용자가 등록한 내전은
`data/matches.json` 파일에 영속됩니다. (샘플 전적 26경기는 로스터 기반으로 부팅 시 결정론적으로 생성)

원본 아티팩트 UI를 그대로 이식한 **웹 프런트엔드**가 포함되어 있어 서버 실행 후 바로 사용할 수 있습니다.
프런트엔드의 모든 데이터는 이 API를 `fetch`/WebSocket 으로 호출합니다.

| 페이지 | 경로 | 내용 |
|---|---|---|
| 메인 | `/` | 대시보드·명단·기록·순위(점수)·듀오 궁합·이윤성 듀오·밸런서·내전 등록 |
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
- `RIOT_API_KEY` — 라이엇 API 키 (티어 조회 · 듀오 섹션 경기 기록)
- `DUO_ANCHOR` — 듀오 섹션 기준 계정 닉네임 (기본 `어나니머스#kali`, 명단에 있어야 함) · `DUO_ID_PAGES`(기본 5) · `DUO_DETAIL_BUDGET`(기본 40)

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
- **내전 달력**: 대시보드 맨 아래, 깃허브 잔디처럼 최근 1년 동안 내전이 있었던 날을 주 단위 격자로 표시한다.
  경기 수에 따라 5단계 색, 마우스를 올리면 날짜와 협곡/칼바람 경기 수, 클릭하면 내전 기록 탭으로. 시즌과 무관하게 전체 기록(KST 날짜 기준)을 쓴다. `GET /api/matches/calendar`
- **업데이트 게시판**: 관리자 페이지 `업데이트 게시판` 탭에서 제목/내용을 쓰고 저장하면 메인 화면 `업데이트` 탭에 바로 공개된다.
  상단 고정, 수정, 삭제 지원. 최근 7일 안에 올라온 글은 `NEW` 배지와 탭 숫자로 표시. 본문은 평문이며 줄바꿈 유지, `- ` 로 시작하는 줄은 목록, URL 은 링크로 보인다.
  저장소는 Supabase `updates` 테이블 — 최초 1회 [`sql/updates.sql`](sql/updates.sql) 을 SQL Editor 에서 실행. `src/routes/updates.js`
- **실시간 팀 경매**: 방 생성 → 코드 공유 → 캡틴들이 각 기기에서 접속해 동시 입찰.
  서버가 타이머·낙찰을 소유(`src/auction/`), WebSocket `/ws/auction` 으로 상태 브로드캐스트.

- **내 이름 선택**: 헤더의 `👤 내 이름` 버튼으로 단원 명단에서 자기 이름을 고르면 브라우저 `localStorage`(`hgd.me`)에 단원 id 만 저장된다.
  로그인·비밀번호 없음. 고르면 대시보드 히어로에 내 점수·순위·다음 순위까지 격차·시즌 전적·최근 내전 카드가 뜬다.
- **MVP 투표**: 내 이름을 고른 단원이 경기 카드 가운데 결과 칸 첫 줄의 `🗳 MVP 투표` 버튼으로 그 경기 참가자(용병 제외, 본인 제외) 중 1명에게 투표한다.
  결과(득표 현황)는 누구나 보지만 투표 버튼은 내 이름을 고른 뒤에만 활성화된다(미등록이면 `내 이름 등록 후 투표` 로 표시되고 누르면 이름 선택창이 뜬다).
  1표라도 받은 선수는 경기 카드의 이름 오른쪽 위에 득표 수가 붙고, 모든 선수 칩과 가운데 칸은 같은 높이의 `배지 줄`을 첫 줄로 갖는다. MVP(단독 최다 득표자, 표가 없으면 관리자 지정) 칩의 배지 줄 왼쪽에 금색 `👑 MVP`, 표를 받은 칩의 배지 줄에 득표 수, 가운데 칸의 배지 줄에 투표 버튼이 놓여 한 줄로 정렬된다. 칩(이름이든 득표 수든)에 마우스를 올리면 뜨는 선수 상세 카드 맨 아래에 "이 경기 MVP 투표 n표 / 전체 · 투표: 이름들" 섹션이 붙는다(별도 툴팁 없음). 동률·투표 전은 가운데 날짜 옆에 글자로 표시. 투표·MVP 정보가 전혀 없는 옛 경기는 배지 줄을 접어 카드 높이가 이전과 같다.
  한 경기에 1인 1표, 다시 누르면 덮어쓰고 `표 취소` 도 된다. **경기 후 14일**(`src/routes/matches.js` 의 `VOTE_WINDOW_DAYS`)이 지나면 마감.
  - MVP 확정 규칙: 표가 하나라도 있으면 **최다 득표자**가 MVP, 동률이면 MVP 없음(`동률` 표시). 표가 없으면 관리자가 지정한 값(`manualMvpId`) 그대로.
  - 투표 결과는 `store.allMatches()` 가 돌려주는 사본의 `p.mvp` 에 반영되므로 전적 순위의 MVP 횟수·`최다 MVP` 배지가 자동으로 따라간다.
  - API: `PUT /api/matches/:id/vote` `{ voterId, mvpId }` · `DELETE /api/matches/:id/vote` `{ voterId }` → 갱신된 매치를 돌려준다.
    `GET /api/matches` 의 각 매치에 `votes: { total, counts, ballots, leaderId, tie }`(표가 없으면 `null`)와 `manualMvpId` 가 붙는다. 누가 누구에게 투표했는지(`ballots`)는 공개다.
  - 저장소는 Supabase `mvp_votes` 테이블 — 최초 1회 [`sql/mvp_votes.sql`](sql/mvp_votes.sql) 을 SQL Editor 에서 실행. 테이블이 없으면 부팅 로그에 경고가 뜨고 메모리에서만 동작(재시작하면 표가 사라짐).
  - 신원은 `localStorage` 자기 신고라 남의 이름으로 투표하는 걸 기술적으로 막지는 않는다(동아리 규모 전제). 경기를 삭제하면 그 경기의 표도 같이 지운다.

- **이윤성과의 듀오 (라이엇 실제 경기)**: 헤더의 `이윤성 듀오` 탭(독립 페이지). 내전 기록이 아니라 **라이엇 match-v5 전적**을 받아,
  기준 계정(`어나니머스#kali`, 환경변수 `DUO_ANCHOR` 로 변경)의 최근 경기에서 **같은 팀에 있었던 단원**을 찾아 단원별 경기수·승/패·승률·
  최근 10경기 결과·현재 연승/연패·이윤성 KDA·단원 KDA·평균 CS(분당 CS 포함, 양쪽)·단원이 자주 쓴 챔피언·포지션·마지막 경기 시각을 표로 보여준다.
  열 제목(단원·경기·승·패·승률·최근(연승/연패)·KDA·CS·마지막)을 누르면 그 열로 정렬되고 다시 누르면 방향이 바뀐다(기본: 경기 수 많은 순, Perfect KDA 는 최상위).
  위에는 단원과 함께한 경기(승/패), 함께할 때 승률·함께한 단원 수, 가장 많이 함께한 단원, 찰떡 듀오(3경기 이상 최고 승률) 타일이 있고(단원 없이 뛴 경기는 화면에 내지 않는다), 표의 이름을 누르면 아래
  `최근 듀오 경기` 목록이 그 단원과 함께한 경기만으로 걸러진다(챔피언 아이콘·KDA·포지션·멀티킬, 상대팀에 있던 단원도 표시).
  큐 칩은 `전체`/`랭크`(솔랭+자랭) 두 개만 둔다(API 의 `group` 파라미터는 normal/aram/custom/other 도 그대로 받는다). 3분 안에 끝난 다시하기 경기는 승패에서 뺀다.
  - 단원 매칭: 참가자 `puuid` 가 명단 계정의 PUUID 와 같거나, `riotIdGameName#riotIdTagline` 이 명단 닉네임(부계정 포함, 대소문자·공백 무시)과 같으면 그 단원.
    둘 다 아니면 외부인으로 집계에서 빠진다(API 응답의 `frequentOutsiders` 에 2경기 이상 같은 팀이었던 미등록 계정이 남아 있지만 화면에는 표시하지 않는다).
  - 받아오기: 섹션의 `⟳`(누구나) → `POST /api/duo/sync`. 한 번에 **경기 id 최대 500개(100개씩 5호출) + 경기 상세 40건**만 받고
    남은 수(`remaining`)를 돌려주므로 화면은 남은 게 있으면 바로 한 번 더(총 2라운드), 그래도 남으면 `⟳ 를 다시 눌러 이어서` 안내를 띄운다.
    id 목록은 10분간 캐시해 이어받기 라운드는 첫 페이지 1호출만 쓴다. 앱 한도(2분 100회)에 걸리면(429) 그 지점에서 멈추고 받은 것까지 저장한다.
    새 경기가 없었던 동기화 뒤 2분은 라이엇을 다시 부르지 않는다(관리자 `?force=1`). 마지막 동기화가 30분 넘게 지났으면 탭을 열 때 한 번 자동으로 받아온다.
    기준 계정에 PUUID 가 없으면 account-v1 로 받아 단원 계정에 저장한다.
  - 저장소: Supabase `riot_matches` — 최초 1회 [`sql/riot_matches.sql`](sql/riot_matches.sql) 을 SQL Editor 에서 실행.
    경기 하나를 참가자 10명의 `{puuid, riotId, champ, teamId, win, k, d, a, pos, lvl, cs, gold, dmg, vision, multi}` 로 압축해(≈3KB, 원본 ≈80KB) `data`(jsonb) 에 넣는다.
    테이블이 없으면 부팅 로그에 경고가 뜨고 메모리에서만 동작(재시작하면 다시 받아야 한다). 레코드는 특정 선수에 묶이지 않아 나중에 다른 단원 기준으로도 재사용할 수 있다.
  - API: `GET /api/duo?group=ranked|normal|aram|custom|other` → `{ anchor, cached, persisted, sync:{lastAt,inProgress,stale,remaining,error}, summary, partners[], games[], frequentOutsiders[] }`
    · `POST /api/duo/sync` → 같은 본문 + `result:{skipped, added, remaining, errors[], stopped}`. 코드: `src/lib/duo.js`(압축·집계), `src/routes/duo.js`(동기화·예산), `src/lib/riot.js`(`fetchMatchIds`/`fetchMatch`).

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
- 경기 기록(듀오 섹션): `GET {region}/lol/match/v5/matches/by-puuid/{puuid}/ids?start=&count=100` → `GET {region}/lol/match/v5/matches/{matchId}`.
  메서드 한도 `2000:10` 으로 넉넉하지만 앱 한도(2분 100회)를 같이 쓰므로 `src/routes/duo.js` 가 한 번에 받는 양을 제한한다
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
- `tier` = **관리자가 고른 `baseTier` 우선** → `baseTier` 가 `언랭` 이면 라이엇 조회 티어(`soloTier`) → 그것도 없으면 `언랭`
- `baseTier` = 시트/관리자가 직접 넣은 티어. DB `members.tier` 에 저장되는 것은 항상 이쪽이라 조회 결과가 수동 값을 덮어쓰지 않는다
- 라이엇 값을 쓰고 싶으면 편집 패널의 `티어(수동)` 를 `언랭` 으로 두면 된다
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

**접속 기록(dashboard_config)** — 푸터에 표시되는 `마지막 접속` / `오늘 접속 N명`
- `last_visit_at` : 직전 방문 시각
- `visit_date`, `visit_ips` : 오늘(KST) 접속 건수와 IP 해시별 마지막 집계 시각. 같은 IP 는 1시간 안의 재방문을 한 건으로 묶고, 1시간이 지나면 새 건으로 센다
- 컬럼 추가 쿼리: [`sql/visitors.sql`](sql/visitors.sql) — 없으면 서버 재시작 시 오늘 접속자 수가 0 부터 다시 센다

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
| GET | `/api/matches/calendar` | 최근 1년 날짜별 내전 수 (대시보드 내전 달력용, `?days=`) |
| POST | `/api/matches` | 내전 등록 (저장 시 `pending` 행 삭제) |
| DELETE | `/api/matches/:id` | 사용자 매치 삭제 |
| GET | `/api/pending` | 선택 중인 선수 (새로고침 복원) |
| PUT | `/api/pending` | 선택 상태 저장 — `{mode, playerIds, mercenaries}` |
| DELETE | `/api/pending` | 선택 초기화 |
| PUT | `/api/matches/:id` | 내전 수정 (관리자) |
| DELETE | `/api/matches/:id` | 내전 삭제 (관리자) |
| GET | `/api/stats` | 전적 순위 (`?minGames=3&sort=wr|score|streak&order=`) |
| GET | `/api/synergy` · `/api/synergy/:id` | 내전 기반 듀오/맞대결 조합 통계 (`?minGames=&mode=&season=`) |
| GET | `/api/duo` | 라이엇 실제 경기 기반 듀오 통계 — 기준 단원과 같은 팀이었던 단원별 승률·KDA (`?group=ranked|normal|aram|custom|other`) |
| POST | `/api/duo/sync` | 라이엇에서 기준 단원의 최근 경기 받아오기 (공개, 호출 예산·쿨다운, 관리자 `?force=1`) |
| GET | `/api/scores` | 단원 자체 점수 순위 |
| POST | `/api/balance` | 팀 밸런서 |
| POST | `/api/admin/login` · `logout` · `GET me` | 관리자 인증 |
| POST/PATCH/DELETE | `/api/admin/members[/:id]` | 단원 추가/편집/삭제 (관리자) |
| POST | `/api/auction/rooms` | 경매방 생성 (WS `/ws/auction`) |
| GET | `/api/updates` | 업데이트 게시판 목록 (고정글 → 최신순, `?limit=`) |
| GET | `/api/updates/:id` | 게시글 하나 |
| POST/PATCH/DELETE | `/api/updates[/:id]` | 업데이트 작성/수정/삭제 (관리자) — `{title, content, pinned}` |
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
    riot.js               라이엇 API (계정 PUUID · 솔로랭크 · match-v5 경기 기록 · 레이트 리밋)
    duo.js                라이엇 경기 압축 레코드 + 듀오 집계 (이윤성과의 듀오)
    sample.js             결정론적 샘플 전적 생성
    auth.js               관리자 비밀번호 + HMAC 쿠키 세션
  auction/
    rooms.js              경매방 인메모리 상태·타이머·낙찰 로직
    ws.js                 /ws/auction WebSocket 핸들러
  store.js                매치·오버레이 저장소 (JSON 영속 + 통계 캐시)
  routes/                 members · matches · stats · scores · balance · dashboard · admin · auction · updates · synergy · badges · duo
sql/updates.sql           업데이트 게시판 테이블 생성 쿼리 (Supabase SQL Editor 에서 1회 실행)
sql/riot_matches.sql      라이엇 경기 캐시 테이블 (듀오 섹션) — Supabase SQL Editor 에서 1회 실행
sql/seasons.sql           시즌 테이블 RLS 해제 + 기본 시즌 보강 (부팅 시 `POST seasons: 401` 경고가 나면 1회 실행)
data/matches.json         사용자 등록 내전 (런타임 생성)
data/members-override.json 관리자 단원 편집/추가/삭제 (런타임 생성)
```
