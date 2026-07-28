-- Production feature expansion.
-- This migration is intentionally additive. It never deletes or recreates
-- profiles, entries, entry_images, votes, or Storage objects.

create extension if not exists pgcrypto;

-- Existing record extensions -------------------------------------------------

alter table public.profiles
  add column if not exists admin_note text;

alter table public.entries
  add column if not exists entry_code text,
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawn_by uuid,
  add column if not exists withdrawal_reason text;

alter table public.events
  add column if not exists status text,
  add column if not exists submission_identity_mode text not null default 'named',
  add column if not exists voting_identity_mode text not null default 'named',
  add column if not exists reveal_authors_after_results boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

alter table public.announcements
  add column if not exists title text,
  add column if not exists announcement_type text not null default 'general',
  add column if not exists expires_at timestamptz,
  add column if not exists is_pinned boolean not null default false,
  add column if not exists is_active boolean not null default true,
  add column if not exists requires_ack boolean not null default false,
  add column if not exists audience text not null default 'all',
  add column if not exists target_profile_id uuid,
  add column if not exists created_by uuid,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists archived_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_explicit_status_check'
  ) then
    alter table public.events add constraint events_explicit_status_check
      check (status is null or status in (
        'draft', 'submission_open', 'submission_closed', 'voting_open',
        'voting_closed', 'results_published', 'archived'
      )) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_submission_identity_mode_check'
  ) then
    alter table public.events add constraint events_submission_identity_mode_check
      check (submission_identity_mode in ('anonymous', 'named')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass
      and conname = 'events_voting_identity_mode_check'
  ) then
    alter table public.events add constraint events_voting_identity_mode_check
      check (voting_identity_mode in ('anonymous', 'named')) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.announcements'::regclass
      and conname = 'announcements_audience_check'
  ) then
    alter table public.announcements add constraint announcements_audience_check
      check (audience in ('all', 'participants', 'submitters', 'admins', 'player'))
      not valid;
  end if;
end
$$;

create unique index if not exists entries_entry_code_unique
  on public.entries (entry_code) where entry_code is not null;
create index if not exists entries_owner_withdrawn_idx
  on public.entries (owner_id, withdrawn_at);
create index if not exists announcements_visibility_idx
  on public.announcements (event_id, is_active, audience, published_at desc);

-- Fixed, stable work numbers. Only the new entry_code column is backfilled.
with unnumbered as (
  select id, row_number() over (order by created_at, id) as seq
  from public.entries
  where entry_code is null
)
update public.entries e
set entry_code = 'A' || lpad(unnumbered.seq::text, 3, '0')
from unnumbered
where e.id = unnumbered.id
  and e.entry_code is null;

create sequence if not exists public.entry_code_seq;

select setval(
  'public.entry_code_seq',
  greatest(
    coalesce((
      select max(nullif(regexp_replace(entry_code, '\D', '', 'g'), '')::bigint)
      from public.entries
      where entry_code is not null
    ), 0),
    1
  ),
  true
);

create or replace function public.assign_entry_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.entry_code is null then
    new.entry_code := 'A' || lpad(nextval('public.entry_code_seq')::text, 3, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists entries_assign_entry_code on public.entries;
create trigger entries_assign_entry_code
before insert on public.entries
for each row execute function public.assign_entry_code();

-- Administrator permissions --------------------------------------------------

create table if not exists public.admin_roles (
  profile_id uuid primary key references public.profiles(id) on delete restrict,
  permissions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.admin_roles (profile_id, permissions, is_active)
select
  id,
  jsonb_build_object(
    'player_manager', true,
    'eligibility_manager', true,
    'submission_viewer', true,
    'submission_manager', true,
    'event_manager', true,
    'award_manager', true,
    'award_assigner', true,
    'announcement_manager', true,
    'report_viewer', true,
    'statistics_viewer', true,
    'audit_viewer', false
  ),
  true
from public.profiles
where is_admin
  and discord_id <> '635371564979716106'
on conflict (profile_id) do nothing;

create or replace function public.is_super_admin(target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = target_user
      and discord_id = '635371564979716106'
  );
$$;

create or replace function public.has_admin_permission(
  permission_name text,
  target_user uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_super_admin(target_user)
    or exists (
      select 1
      from public.admin_roles ar
      where ar.profile_id = target_user
        and ar.is_active
        and coalesce((ar.permissions ->> permission_name)::boolean, false)
    );
$$;

-- Awards ---------------------------------------------------------------------

create table if not exists public.awards (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  name varchar(80) not null,
  description text,
  award_type text not null default 'custom',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  is_archived boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.award_assignments (
  id uuid primary key default gen_random_uuid(),
  award_id uuid not null unique references public.awards(id) on delete restrict,
  submission_id bigint not null references public.entries(id) on delete restrict,
  assigned_by uuid references public.profiles(id) on delete set null,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.award_rules (
  event_id uuid primary key references public.events(id) on delete restrict,
  allow_multiple_per_submission boolean not null default true,
  allow_multiple_per_player boolean not null default true,
  top_three_can_receive_special boolean not null default true,
  max_awards_per_player integer,
  max_awards_per_submission integer,
  tie_handling text not null default 'joint',
  allow_manual_tie_winner boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (max_awards_per_player is null or max_awards_per_player > 0),
  check (max_awards_per_submission is null or max_awards_per_submission > 0),
  check (tie_handling in ('joint', 'admin_decision', 'earliest_submission', 'unresolved'))
);

create table if not exists public.award_exclusions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  award_a_id uuid not null references public.awards(id) on delete restrict,
  award_b_id uuid not null references public.awards(id) on delete restrict,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (award_a_id <> award_b_id),
  unique (event_id, award_a_id, award_b_id)
);

create index if not exists awards_event_order_idx
  on public.awards (event_id, is_archived, is_active, sort_order);
create index if not exists award_assignments_submission_idx
  on public.award_assignments (submission_id);

-- Audit, snapshots and idempotency -------------------------------------------

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  actor_discord_id text,
  actor_nickname text,
  action_type text not null,
  target_type text,
  target_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  result text not null default 'success',
  failure_reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_cleanup_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  deleted_count integer not null default 0,
  succeeded boolean not null,
  failure_reason text
);

create table if not exists public.activity_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  snapshot_data jsonb not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.idempotency_keys (
  key text primary key,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  action_type text not null,
  response_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_actor_idx
  on public.audit_logs (actor_profile_id, created_at desc);
create index if not exists snapshots_event_created_idx
  on public.activity_snapshots (event_id, created_at desc);

-- Announcements and notifications -------------------------------------------

create table if not exists public.announcement_receipts (
  announcement_id bigint not null references public.announcements(id) on delete restrict,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  read_at timestamptz,
  acknowledged_at timestamptz,
  primary key (announcement_id, profile_id)
);

create index if not exists announcement_receipts_profile_idx
  on public.announcement_receipts (profile_id, read_at);

-- RLS ------------------------------------------------------------------------

alter table public.admin_roles enable row level security;
alter table public.awards enable row level security;
alter table public.award_assignments enable row level security;
alter table public.award_rules enable row level security;
alter table public.award_exclusions enable row level security;
alter table public.audit_logs enable row level security;
alter table public.audit_cleanup_runs enable row level security;
alter table public.activity_snapshots enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.announcement_receipts enable row level security;

-- Profile creation is server-only. This closes mass-assignment of is_admin,
-- is_disqualified and discord_id through the anon/authenticated client.
drop policy if exists "own profile creation" on public.profiles;

drop policy if exists "announcement reading" on public.announcements;
create policy "public active announcement reading" on public.announcements
for select
using (
  is_active
  and archived_at is null
  and audience = 'all'
  and (expires_at is null or expires_at > now())
);

drop policy if exists "approved entry reading" on public.entries;
create policy "approved entry reading" on public.entries
for select
using (
  owner_id = auth.uid()
  or (
    status = 'approved'
    and withdrawn_at is null
    and exists (
      select 1 from public.profiles p
      where p.id = entries.owner_id and not p.is_disqualified
    )
  )
);

drop policy if exists "entry image reading" on public.entry_images;
create policy "entry image reading" on public.entry_images
for select
using (
  exists (
    select 1
    from public.entries e
    join public.profiles p on p.id = e.owner_id
    where e.id = entry_images.entry_id
      and (
        e.owner_id = auth.uid()
        or (
          e.status = 'approved'
          and e.withdrawn_at is null
          and not p.is_disqualified
        )
      )
  )
);

-- Fix the ambiguous column references that previously compiled to
-- en.event_id = en.event_id.
drop policy if exists "own vote creation" on public.votes;
create policy "own vote creation" on public.votes
for insert
with check (
  votes.voter_id = auth.uid()
  and exists (
    select 1
    from public.entries en
    join public.events ev on ev.id = en.event_id
    join public.profiles p on p.id = auth.uid()
    where en.id = votes.entry_id
      and en.event_id = votes.event_id
      and en.status = 'approved'
      and en.withdrawn_at is null
      and not p.is_disqualified
      and (
        ev.status = 'voting_open'
        or (
          ev.status is null
          and (
            ev.voting_override = 'open'
            or (
              ev.voting_override = 'auto'
              and not ev.voting_locked
              and now() between ev.voting_starts_at and ev.voting_ends_at
            )
          )
        )
      )
  )
);

drop policy if exists "own vote cancellation" on public.votes;
create policy "own vote cancellation" on public.votes
for delete
using (
  votes.voter_id = auth.uid()
  and exists (
    select 1 from public.events ev
    where ev.id = votes.event_id
      and (
        ev.status = 'voting_open'
        or (
          ev.status is null
          and (
            ev.voting_override = 'open'
            or (
              ev.voting_override = 'auto'
              and not ev.voting_locked
              and now() between ev.voting_starts_at and ev.voting_ends_at
            )
          )
        )
      )
  )
);

create or replace function public.can_submit_to_event(target_event uuid, target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user = auth.uid()
    and exists (
      select 1
      from public.events e
      join public.profiles p on p.id = target_user
      where e.id = target_event
        and not e.submissions_locked
        and not p.is_disqualified
        and (
          e.status = 'submission_open'
          or (
            e.status is null
            and now() between e.submission_starts_at and e.submission_ends_at
          )
        )
    );
$$;

create or replace function public.can_upload_submission(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user = auth.uid()
    and exists (
      select 1
      from public.events e
      join public.profiles p on p.id = target_user
      where not e.submissions_locked
        and not p.is_disqualified
        and (
          e.status = 'submission_open'
          or (
            e.status is null
            and now() between e.submission_starts_at and e.submission_ends_at
          )
        )
        and not exists (
          select 1 from public.entries en
          where en.event_id = e.id
            and en.owner_id = target_user
        )
      order by e.created_at desc
      limit 1
    );
$$;

create or replace function public.enforce_five_votes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.event_id::text || ':' || new.voter_id::text));

  if not exists (
    select 1
    from public.entries en
    join public.events ev on ev.id = en.event_id
    join public.profiles p on p.id = new.voter_id
    where en.id = new.entry_id
      and en.event_id = new.event_id
      and en.status = 'approved'
      and en.withdrawn_at is null
      and not p.is_disqualified
      and (
        ev.status = 'voting_open'
        or (
          ev.status is null
          and (
            ev.voting_override = 'open'
            or (
              ev.voting_override = 'auto'
              and not ev.voting_locked
              and now() between ev.voting_starts_at and ev.voting_ends_at
            )
          )
        )
      )
  ) then
    raise exception 'vote_not_allowed';
  end if;

  if (
    select count(*) from public.votes
    where event_id = new.event_id and voter_id = new.voter_id
  ) >= 5 then
    raise exception 'vote_limit_reached';
  end if;
  return new;
end;
$$;

-- Safe, repeatable requested nickname correction -----------------------------

do $$
declare
  target_profile_id uuid;
  conflicting_profile_id uuid;
begin
  select id into target_profile_id
  from public.profiles
  where discord_id = '827363719566458931';

  if target_profile_id is null then
    raise exception 'Target Discord ID 827363719566458931 was not found';
  end if;

  select id into conflicting_profile_id
  from public.profiles
  where lower(trim(nickname)) = lower('久惟')
    and id <> target_profile_id
  limit 1;

  if conflicting_profile_id is not null then
    raise exception 'Nickname 久惟 is already used by another profile';
  end if;

  update public.profiles
  set nickname = '久惟'
  where id = target_profile_id
    and discord_id = '827363719566458931'
    and nickname = '久惟test';
end
$$;
