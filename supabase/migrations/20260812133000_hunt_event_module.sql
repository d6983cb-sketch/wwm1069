-- Independent hidden-object hunt module.
-- This migration does not update or delete Cos entries, votes, or their Storage objects.

create table if not exists public.hunt_events (
  id uuid primary key default gen_random_uuid(),
  title varchar(100) not null,
  description text,
  target_image_path text not null default '/images/hunt-target.webp',
  show_target_image boolean not null default false,
  total_targets integer not null default 1 check (total_targets between 1 and 999),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'results_published', 'archived')),
  leaderboard_mode text not null default 'hidden' check (leaderboard_mode in ('hidden', 'live', 'final')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hunt_events_time_order check (starts_at < ends_at)
);

create table if not exists public.hunt_submissions (
  id bigint generated always as identity primary key,
  hunt_event_id uuid not null references public.hunt_events(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  image_path text not null,
  file_hash char(64) not null,
  player_note varchar(200),
  status text not null default 'pending' check (status in ('pending', 'correct', 'incorrect', 'duplicate')),
  matched_target_number integer check (matched_target_number is null or matched_target_number between 1 and 999),
  duplicate_of_id bigint references public.hunt_submissions(id) on delete restrict,
  review_note varchar(500),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint hunt_submission_review_shape check (
    (status = 'pending' and reviewed_at is null)
    or (status <> 'pending' and reviewed_at is not null)
  )
);

create unique index if not exists hunt_submissions_player_file_unique
  on public.hunt_submissions (hunt_event_id, profile_id, file_hash);

create unique index if not exists hunt_submissions_player_correct_target_unique
  on public.hunt_submissions (hunt_event_id, profile_id, matched_target_number)
  where status = 'correct' and matched_target_number is not null;

create index if not exists hunt_submissions_review_queue_idx
  on public.hunt_submissions (hunt_event_id, status, submitted_at);

create index if not exists hunt_submissions_player_idx
  on public.hunt_submissions (hunt_event_id, profile_id, submitted_at desc);

-- PostgreSQL does not add indexes for foreign keys automatically. These keep
-- profile checks and safe RESTRICT / SET NULL operations efficient.
create index if not exists hunt_events_created_by_idx
  on public.hunt_events (created_by)
  where created_by is not null;

create index if not exists hunt_submissions_profile_id_idx
  on public.hunt_submissions (profile_id);

create index if not exists hunt_submissions_duplicate_of_idx
  on public.hunt_submissions (duplicate_of_id)
  where duplicate_of_id is not null;

create index if not exists hunt_submissions_reviewed_by_idx
  on public.hunt_submissions (reviewed_by)
  where reviewed_by is not null;

alter table public.hunt_events enable row level security;
alter table public.hunt_submissions enable row level security;

-- Tables are intentionally server-only. Players upload files directly to their
-- own Storage folder, while all metadata mutations pass through validated APIs.
revoke all on table public.hunt_events from anon, authenticated;
revoke all on table public.hunt_submissions from anon, authenticated;
revoke all on sequence public.hunt_submissions_id_seq from anon, authenticated;

-- Only the server-side service role can read or mutate activity metadata.
-- Players never receive this key and interact through validated API routes.
grant select, insert, update on table public.hunt_events to service_role;
grant select, insert, update on table public.hunt_submissions to service_role;
grant usage, select on sequence public.hunt_submissions_id_seq to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'hunt-proofs',
  'hunt-proofs',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "players upload own hunt proofs" on storage.objects;
create policy "players upload own hunt proofs"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'hunt-proofs'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
);

-- Owners may only read their own proof file through an authenticated request.
-- The application normally uses short-lived signed URLs created server-side.
drop policy if exists "players read own hunt proofs" on storage.objects;
create policy "players read own hunt proofs"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'hunt-proofs'
  and owner_id = (select auth.uid())::text
);
