-- 내전 상세 데이터 (match-v5 에서 가져온 경기 정보 + 참가자별 스탯)
-- Supabase SQL Editor 에서 실행

-- 1) 경기 메타정보
create table if not exists public.match_details (
  match_id       text        primary key,              -- matches.id (내전 기록 FK)
  riot_match_id  text        not null unique,           -- 'KR_8417904700'
  game_at        timestamptz,                           -- 경기 시작 시각
  dur            integer,                               -- 경기 길이(초)
  queue_id       integer,                               -- 420 솔랭 · 0 사용자 설정 등
  game_mode      text,                                  -- CLASSIC, ARAM 등
  end_type       text,                                  -- remake / surrender / complete
  created_at     timestamptz not null default now()
);

-- 2) 참가자별 상세 스탯 (한 경기당 10행)
create table if not exists public.match_participants (
  id             bigint      generated always as identity primary key,
  match_id       text        not null references public.match_details(match_id) on delete cascade,
  member_id      integer,                               -- 단원 id (NULL 이면 외부인/용병)
  puuid          text,
  riot_id        text,                                  -- '닉네임#태그'
  team_id        integer     not null,                  -- 100(블루) / 200(레드)
  win            boolean     not null,

  -- 챔피언·포지션
  champion       text        not null,                  -- championName
  position       text,                                  -- 탑/정글/미드/원딜/서폿

  -- KDA
  kills          integer     not null default 0,
  deaths         integer     not null default 0,
  assists        integer     not null default 0,
  kda            numeric(6,2),                          -- (K+A)/D

  -- 레벨·CS·골드
  level          integer     not null default 0,
  cs             integer     not null default 0,        -- totalMinionsKilled + neutralMinionsKilled
  cs_per_min     numeric(5,2),                          -- CS / (dur/60)
  gold           integer     not null default 0,

  -- 딜량
  damage         integer     not null default 0,        -- totalDamageDealtToChampions
  damage_taken   integer     not null default 0,        -- totalDamageTaken
  damage_mitigated integer  not null default 0,         -- damageSelfMitigated
  heal           integer     not null default 0,        -- totalHeal + totalHealsOnTeammates
  shield         integer     not null default 0,        -- totalDamageShieldedOnTeammates

  -- 시야
  vision         integer     not null default 0,        -- visionScore
  wards_placed   integer     not null default 0,
  wards_killed   integer     not null default 0,
  control_wards  integer     not null default 0,        -- detectorWardsPlaced

  -- 킬 관여·멀티킬
  kill_participation integer not null default 0,        -- 킬 관여율 (0-100 %)
  double_kills   integer     not null default 0,
  triple_kills   integer     not null default 0,
  quadra_kills   integer     not null default 0,
  penta_kills    integer     not null default 0,
  first_blood    boolean     not null default false,

  -- 오브젝트
  turret_kills   integer     not null default 0,
  inhibitor_kills integer   not null default 0,

  -- 아이템 (게임 종료 시점)
  items          integer[]   not null default '{}',     -- [item0..item6]
  spells         integer[]   not null default '{}',     -- [summoner1Id, summoner2Id]

  -- CC
  cc_time        integer     not null default 0         -- timeCCingOthers (초)
);

create index if not exists match_participants_match_idx on public.match_participants (match_id);
create index if not exists match_participants_member_idx on public.match_participants (member_id) where member_id is not null;
create index if not exists match_participants_champion_idx on public.match_participants (champion);

-- RLS 비활성화
alter table public.match_details disable row level security;
alter table public.match_participants disable row level security;
