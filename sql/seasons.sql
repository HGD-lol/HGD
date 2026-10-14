-- 시즌 테이블 — 부팅 로그의
--   [DB write error] Supabase POST seasons: 401 ... "new row violates row-level security policy for table "seasons""
-- 는 seasons 에 RLS 가 켜져 있어 서버(publishable/anon 키)가 읽지도 쓰지도 못해서 난다.
-- 서버는 시즌이 하나도 안 보이면 기본 시즌 's_default' 를 메모리에 만들고 DB 에 넣으려다 실패한다
-- (화면은 매치가 전부 's_default' 를 가리켜 그대로 동작하지만, 관리자 시즌 생성은 조용히 저장되지 않는다).
-- Supabase SQL Editor 에서 한 번 실행.

create table if not exists public.seasons (
  id          text        primary key,            -- 's_default', 's_1727…'
  name        text        not null,
  is_current  boolean     not null default false,
  created_at  timestamptz not null default now()
);

-- 다른 테이블과 같은 방식으로 RLS 를 끈다 (서버는 anon 키로 접근)
alter table public.seasons disable row level security;

-- 기존 매치가 모두 가리키는 기본 시즌이 없으면 넣어 둔다 (이미 현재 시즌이 있으면 현재로 만들지 않는다)
insert into public.seasons (id, name, is_current)
select 's_default', coalesce((select season from public.dashboard_config where id = 1), '시즌 1'),
       not exists (select 1 from public.seasons where is_current)
where not exists (select 1 from public.seasons where id = 's_default');
