-- 매매 복기노트: Supabase SQL Editor에 통째로 붙여넣고 Run 하세요. 여러 번 실행해도 안전해요.

create table if not exists public.trades (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.weeks (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  doc jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 본인 데이터만 읽고 쓰기
alter table public.trades   enable row level security;
alter table public.weeks    enable row level security;
alter table public.settings enable row level security;

drop policy if exists "own trades" on public.trades;
create policy "own trades" on public.trades for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own weeks" on public.weeks;
create policy "own weeks" on public.weeks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 차트 사진 저장소 (비공개)
insert into storage.buckets (id, name, public)
values ('charts', 'charts', false)
on conflict (id) do nothing;

drop policy if exists "own charts read" on storage.objects;
create policy "own charts read" on storage.objects for select to authenticated
  using (bucket_id = 'charts' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own charts write" on storage.objects;
create policy "own charts write" on storage.objects for insert to authenticated
  with check (bucket_id = 'charts' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own charts delete" on storage.objects;
create policy "own charts delete" on storage.objects for delete to authenticated
  using (bucket_id = 'charts' and (storage.foldername(name))[1] = auth.uid()::text);

-- 시장 데이터 (코스피·코스닥 일별, 투자자별 순매수). 쓰기는 GitHub Actions의 secret 키만.
create table if not exists public.market_days (
  date date primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.market_days enable row level security;
drop policy if exists "read market" on public.market_days;
create policy "read market" on public.market_days for select to authenticated using (true);

-- AI 코치 분석 기록
create table if not exists public.coach_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  model text, period text, text text not null
);
alter table public.coach_reports enable row level security;
drop policy if exists "own coach" on public.coach_reports;
create policy "own coach" on public.coach_reports for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 영웅문 체결 내역 (진입·청산 시각, 보유시간, 물타기 자동 감지용)
create table if not exists public.fills (
  key text not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  doc jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.fills enable row level security;
drop policy if exists "own fills" on public.fills;
create policy "own fills" on public.fills for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 종목 뉴스 (매매일 전 거래일 ~ 매매일, GitHub Actions가 매시 채움). key = 날짜|종목명
create table if not exists public.news (
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.news enable row level security;
drop policy if exists "read news" on public.news;
create policy "read news" on public.news for select to authenticated using (true);

-- 참고한 기사 본문 (복기에 붙인 기사만, GitHub Actions가 매시 10분·40분에 채움). key = 기사 주소
create table if not exists public.articles (
  url text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.articles enable row level security;
drop policy if exists "read articles" on public.articles;
create policy "read articles" on public.articles for select to authenticated using (true);

-- 미국 지수·관련주 일별 종가 (GitHub Actions가 채움). data = {d: {날짜: [종가, 등락률%]}, name}
create table if not exists public.us_prices (
  sym text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.us_prices enable row level security;
drop policy if exists "read us prices" on public.us_prices;
create policy "read us prices" on public.us_prices for select to authenticated using (true);
