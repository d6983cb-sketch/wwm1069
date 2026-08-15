-- Additive automatic image-recognition support for the independent hunt module.
-- This migration never deletes or rewrites Cos entries, votes, images, or hunt proofs.

create extension if not exists vector with schema extensions;

alter table public.hunt_events
  add column if not exists auto_match_enabled boolean not null default false,
  add column if not exists auto_match_threshold real not null default 0.78,
  add column if not exists auto_match_margin real not null default 0.04;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_events_auto_match_threshold_check'
      and conrelid = 'public.hunt_events'::regclass
  ) then
    alter table public.hunt_events
      add constraint hunt_events_auto_match_threshold_check
      check (auto_match_threshold between 0 and 1) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_events_auto_match_margin_check'
      and conrelid = 'public.hunt_events'::regclass
  ) then
    alter table public.hunt_events
      add constraint hunt_events_auto_match_margin_check
      check (auto_match_margin between 0 and 0.5) not valid;
  end if;
end $$;

alter table public.hunt_submissions
  add column if not exists auto_status text not null default 'not_run',
  add column if not exists auto_match_target_number integer,
  add column if not exists auto_similarity real,
  add column if not exists auto_candidates jsonb not null default '[]'::jsonb,
  add column if not exists auto_checked_at timestamptz,
  add column if not exists auto_model text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_submissions_auto_status_check'
      and conrelid = 'public.hunt_submissions'::regclass
  ) then
    alter table public.hunt_submissions
      add constraint hunt_submissions_auto_status_check
      check (auto_status in ('not_run', 'matched', 'uncertain', 'duplicate', 'error')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_submissions_auto_target_check'
      and conrelid = 'public.hunt_submissions'::regclass
  ) then
    alter table public.hunt_submissions
      add constraint hunt_submissions_auto_target_check
      check (auto_match_target_number is null or auto_match_target_number between 1 and 999) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_submissions_auto_similarity_check'
      and conrelid = 'public.hunt_submissions'::regclass
  ) then
    alter table public.hunt_submissions
      add constraint hunt_submissions_auto_similarity_check
      check (auto_similarity is null or auto_similarity between -1 and 1) not valid;
  end if;
end $$;

create table if not exists public.hunt_reference_points (
  id uuid primary key default gen_random_uuid(),
  hunt_event_id uuid not null references public.hunt_events(id) on delete restrict,
  target_number integer not null check (target_number between 1 and 999),
  label varchar(100),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hunt_reference_points_event_target_unique unique (hunt_event_id, target_number)
);

create table if not exists public.hunt_reference_images (
  id uuid primary key default gen_random_uuid(),
  reference_point_id uuid not null references public.hunt_reference_points(id) on delete restrict,
  image_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  embedding extensions.vector(768) not null,
  embedding_model text not null default 'gemini-embedding-2',
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hunt_reference_points_event_active_idx
  on public.hunt_reference_points (hunt_event_id, target_number)
  where is_active = true;
create index if not exists hunt_reference_points_created_by_idx
  on public.hunt_reference_points (created_by)
  where created_by is not null;
create index if not exists hunt_reference_points_updated_by_idx
  on public.hunt_reference_points (updated_by)
  where updated_by is not null;
create index if not exists hunt_reference_images_point_active_idx
  on public.hunt_reference_images (reference_point_id, created_at)
  where is_active = true;
create index if not exists hunt_reference_images_created_by_idx
  on public.hunt_reference_images (created_by)
  where created_by is not null;
create index if not exists hunt_submissions_auto_queue_idx
  on public.hunt_submissions (hunt_event_id, auto_status, submitted_at)
  where status = 'pending';

alter table public.hunt_reference_points enable row level security;
alter table public.hunt_reference_images enable row level security;

revoke all on table public.hunt_reference_points from anon, authenticated;
revoke all on table public.hunt_reference_images from anon, authenticated;
grant select, insert, update on table public.hunt_reference_points to service_role;
grant select, insert, update on table public.hunt_reference_images to service_role;

create or replace function public.match_hunt_reference_images(
  query_embedding extensions.vector(768),
  target_event uuid,
  match_count integer default 8
)
returns table (
  reference_image_id uuid,
  reference_point_id uuid,
  target_number integer,
  similarity double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    image.id,
    point.id,
    point.target_number,
    1 - (image.embedding OPERATOR(extensions.<=>) query_embedding) as similarity
  from public.hunt_reference_images image
  join public.hunt_reference_points point on point.id = image.reference_point_id
  where point.hunt_event_id = target_event
    and point.is_active = true
    and image.is_active = true
  order by image.embedding OPERATOR(extensions.<=>) query_embedding
  limit least(greatest(match_count, 1), 50)
$$;

revoke all on function public.match_hunt_reference_images(extensions.vector, uuid, integer) from public, anon, authenticated;
grant execute on function public.match_hunt_reference_images(extensions.vector, uuid, integer) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hunt-references', 'hunt-references', false, 10485760, array['image/jpeg', 'image/png'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
