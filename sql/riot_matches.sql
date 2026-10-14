-- 라이엇 실제 경기 캐시 (match-v5) — 듀오 통계(이윤성과의 듀오)용
-- Supabase SQL Editor 에서 실행
create table if not exists public.riot_matches (
  match_id      text        primary key,          -- 'KR_8417904700'
  anchor_puuid  text,                             -- 누구의 전적을 받다가 가져온 경기인지 (기록용)
  game_at       timestamptz,                      -- 경기 시작 시각
  queue_id      integer,                          -- 420 솔랭 · 440 자랭 · 450 칼바람 · 0 사용자 설정 …
  data          jsonb       not null,             -- 압축 레코드 (src/lib/duo.js compactMatch — 참가자 10명의 KDA·챔피언·팀)
  created_at    timestamptz not null default now()
);

create index if not exists riot_matches_game_at_idx on public.riot_matches (game_at desc);

-- 서버는 publishable(anon) 키로 접근하므로 다른 테이블과 같은 방식으로 RLS 를 끈다.
alter table public.riot_matches disable row level security;
