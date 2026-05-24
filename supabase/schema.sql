create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  migrated_local_data_at timestamptz
);

create table if not exists public.history_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('image','video','audio','3d')),
  prompt text,
  created_at timestamptz not null default now(),
  media_path text,
  thumbnail_path text,
  meta_json jsonb not null default '{}'::jsonb
);
create index if not exists history_items_user_created_idx on public.history_items(user_id, created_at desc);
do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'history_items'
      and constraint_name = 'history_items_type_check'
  ) then
    alter table public.history_items drop constraint history_items_type_check;
  end if;
  alter table public.history_items
    add constraint history_items_type_check check (type in ('image','video','audio','3d'));
end $$;

create table if not exists public.text_preset_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('title','char')),
  lang text not null,
  value text not null,
  state text not null check (state in ('custom','removed_default')),
  created_at timestamptz not null default now()
);
create index if not exists text_preset_overrides_user_kind_idx on public.text_preset_overrides(user_id, kind, lang);

create table if not exists public.design_preset_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  builtin_id text not null,
  hidden boolean not null default false,
  name_override text,
  created_at timestamptz not null default now()
);
create unique index if not exists design_preset_overrides_user_builtin_idx on public.design_preset_overrides(user_id, builtin_id);

create table if not exists public.custom_design_presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  image_path text,
  created_at timestamptz not null default now()
);
create index if not exists custom_design_presets_user_created_idx on public.custom_design_presets(user_id, created_at);

alter table public.profiles enable row level security;
alter table public.history_items enable row level security;
alter table public.text_preset_overrides enable row level security;
alter table public.design_preset_overrides enable row level security;
alter table public.custom_design_presets enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (auth.uid() = id);

drop policy if exists history_items_own_all on public.history_items;
create policy history_items_own_all on public.history_items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists text_preset_overrides_own_all on public.text_preset_overrides;
create policy text_preset_overrides_own_all on public.text_preset_overrides for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists design_preset_overrides_own_all on public.design_preset_overrides;
create policy design_preset_overrides_own_all on public.design_preset_overrides for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists custom_design_presets_own_all on public.custom_design_presets;
create policy custom_design_presets_own_all on public.custom_design_presets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('history-media', 'history-media', false)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
values ('history-thumbnails', 'history-thumbnails', false)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
values ('custom-design-presets', 'custom-design-presets', false)
on conflict (id) do nothing;

drop policy if exists "history media own" on storage.objects;
create policy "history media own" on storage.objects
for all to authenticated
using (bucket_id = 'history-media' and auth.uid()::text = (storage.foldername(name))[1])
with check (bucket_id = 'history-media' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "history thumbs own" on storage.objects;
create policy "history thumbs own" on storage.objects
for all to authenticated
using (bucket_id = 'history-thumbnails' and auth.uid()::text = (storage.foldername(name))[1])
with check (bucket_id = 'history-thumbnails' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "design presets own" on storage.objects;
create policy "design presets own" on storage.objects
for all to authenticated
using (bucket_id = 'custom-design-presets' and auth.uid()::text = (storage.foldername(name))[1])
with check (bucket_id = 'custom-design-presets' and auth.uid()::text = (storage.foldername(name))[1]);
