-- Production Supabase schema for the Discord guild Cos event.
-- Run in the Supabase SQL editor after enabling Discord in Authentication.

create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  discord_id text not null unique,
  nickname varchar(20) not null unique check (char_length(trim(nickname)) between 1 and 20),
  is_admin boolean not null default false,
  is_disqualified boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  submission_starts_at timestamptz not null,
  submission_ends_at timestamptz not null,
  voting_starts_at timestamptz not null,
  voting_ends_at timestamptz not null,
  submissions_locked boolean not null default false,
  voting_locked boolean not null default false,
  allow_admin_crop_after_submission boolean not null default false,
  voting_override text not null default 'auto'
    check (voting_override in ('auto', 'open', 'closed')),
  leaderboard_mode text not null default 'hidden'
    check (leaderboard_mode in ('hidden', 'live', 'final')),
  created_at timestamptz not null default now()
);

create table public.entries (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  character_name varchar(40) not null,
  source_game varchar(40) not null,
  description varchar(500),
  uses_ai_background boolean not null default false,
  original_image_path text,
  status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected', 'disqualified')),
  created_at timestamptz not null default now(),
  unique (event_id, owner_id),
  check (not uses_ai_background or original_image_path is not null)
);

create table public.entry_images (
  id bigint generated always as identity primary key,
  entry_id bigint not null references public.entries(id) on delete cascade,
  storage_path text not null,
  position smallint not null check (position between 1 and 5),
  crop_x double precision not null default 0 check (crop_x between -50 and 50),
  crop_y double precision not null default 0 check (crop_y between -50 and 50),
  zoom double precision not null default 1 check (zoom between 1 and 3),
  rotation double precision not null default 0 check (rotation between -180 and 180),
  aspect_ratio text not null default '4/5' check (aspect_ratio = '4/5'),
  crop_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (entry_id, position)
);

create table public.votes (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  entry_id bigint not null references public.entries(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  ip_hash text,
  created_at timestamptz not null default now(),
  unique (event_id, entry_id, voter_id)
);

create index votes_event_voter_idx on public.votes(event_id, voter_id);
create index entries_event_status_idx on public.entries(event_id, status);

create table public.announcements (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.events(id) on delete cascade,
  body text not null,
  published_at timestamptz not null default now()
);

create or replace function public.enforce_five_votes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.event_id::text || ':' || new.voter_id::text));
  if (
    select count(*) from public.votes
    where event_id = new.event_id and voter_id = new.voter_id
  ) >= 5 then
    raise exception 'vote_limit_reached';
  end if;
  return new;
end;
$$;

create trigger votes_limit_before_insert
before insert on public.votes
for each row execute function public.enforce_five_votes();

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.entries enable row level security;
alter table public.entry_images enable row level security;
alter table public.votes enable row level security;
alter table public.announcements enable row level security;

create policy "public event reading" on public.events for select using (true);
create policy "approved entry reading" on public.entries for select
  using (status = 'approved' or owner_id = auth.uid());
create policy "entry image reading" on public.entry_images for select
  using (exists (
    select 1 from public.entries e
    where e.id = entry_id and (e.status = 'approved' or e.owner_id = auth.uid())
  ));
create policy "announcement reading" on public.announcements for select using (true);
create policy "own profile reading" on public.profiles for select using (id = auth.uid());
create policy "own profile creation" on public.profiles for insert with check (id = auth.uid());
create policy "own entry creation" on public.entries for insert with check (owner_id = auth.uid());
create policy "own entry image creation" on public.entry_images for insert
  with check (exists (select 1 from public.entries e where e.id = entry_id and e.owner_id = auth.uid()));
create policy "own votes reading" on public.votes for select using (voter_id = auth.uid());
create policy "own vote creation" on public.votes for insert with check (voter_id = auth.uid());
create policy "own vote cancellation" on public.votes for delete using (voter_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('cos-entries', 'cos-entries', true), ('cos-originals', 'cos-originals', false)
on conflict (id) do update set public = excluded.public;

create policy "authenticated entry uploads" on storage.objects for insert
  to authenticated with check (
    bucket_id = 'cos-entries' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "authenticated original uploads" on storage.objects for insert
  to authenticated with check (
    bucket_id = 'cos-originals' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "public entry images" on storage.objects for select
  using (bucket_id = 'cos-entries');
