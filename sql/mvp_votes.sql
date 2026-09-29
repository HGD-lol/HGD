-- MVP 투표 (단원이 메인 화면에서 자기 이름을 고른 뒤 경기별로 1표)
-- Supabase SQL Editor 에서 실행
create table if not exists public.mvp_votes (
  match_id    text        not null,          -- matches.id ('u1727…')
  voter_id    integer     not null,          -- 투표한 단원 id
  mvp_id      integer     not null,          -- 표를 받은 단원 id
  updated_at  timestamptz not null default now(),
  primary key (match_id, voter_id)           -- 한 경기에 한 사람 1표, 다시 누르면 덮어쓴다
);

create index if not exists mvp_votes_match_idx on public.mvp_votes (match_id);

-- 서버는 publishable(anon) 키로 접근하므로 updates 테이블과 같은 방식으로 RLS 를 끈다.
alter table public.mvp_votes disable row level security;
