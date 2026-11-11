-- 대회(CK) — 팀·선수·대진표를 대회 1건당 1행(jsonb)으로 보관한다.
-- 관리자 페이지 'CK 대회' 탭에서 편집하고, 메인 화면 상단 배너와 대회 탭에 공개된다.
-- 경기 결과는 여기 저장하지 않고 대진에 연결된 내전 기록(matches.id)에서 계산한다.
-- Supabase SQL Editor 에서 한 번 실행. (없으면 서버 메모리에서만 동작하고 재시작하면 사라진다)

create table if not exists public.tournaments (
  id          text        primary key,            -- 'ck4', 'ck_…'
  data        jsonb       not null,               -- { name, subtitle, status, visible, teams[], matches[] } — src/lib/tournament.js
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 서버는 publishable(anon) 키로 접근하므로 다른 테이블과 같은 방식으로 RLS 를 끈다.
alter table public.tournaments disable row level security;
