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
