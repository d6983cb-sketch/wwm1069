-- Security and integrity hardening for the production Cos event.
-- Safe to run after schema.sql and migration-auto-approve-and-voting.sql.

create unique index if not exists profiles_nickname_ci_unique
  on public.profiles (lower(trim(nickname)));

create unique index if not exists entries_id_event_id_unique
  on public.entries (id, event_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'votes_entry_event_match'
  ) then
    alter table public.votes
      add constraint votes_entry_event_match
      foreign key (entry_id, event_id)
      references public.entries (id, event_id)
      on delete cascade
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_timeline_order'
  ) then
    alter table public.events
      add constraint events_timeline_order
      check (
        submission_starts_at < submission_ends_at
        and submission_ends_at <= voting_starts_at
        and voting_starts_at < voting_ends_at
      )
      not valid;
  end if;
end
$$;

create or replace function public.can_submit_to_event(target_event uuid, target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events e
    join public.profiles p on p.id = target_user
    where e.id = target_event
      and not e.submissions_locked
      and not p.is_disqualified
      and now() between e.submission_starts_at and e.submission_ends_at
  );
$$;

create or replace function public.can_upload_submission(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events e
    join public.profiles p on p.id = target_user
    where not e.submissions_locked
      and not p.is_disqualified
      and now() between e.submission_starts_at and e.submission_ends_at
      and not exists (
        select 1 from public.entries en
        where en.event_id = e.id and en.owner_id = target_user
      )
    order by e.created_at desc
    limit 1
  );
$$;

drop policy if exists "own entry creation" on public.entries;
create policy "own entry creation" on public.entries
for insert
with check (
  owner_id = auth.uid()
  and public.can_submit_to_event(event_id, auth.uid())
);

drop policy if exists "authenticated entry uploads" on storage.objects;
create policy "authenticated entry uploads" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'cos-entries'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
  and public.can_upload_submission(auth.uid())
);

drop policy if exists "authenticated original uploads" on storage.objects;
create policy "authenticated original uploads" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'cos-originals'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) in ('jpg', 'jpeg', 'png', 'webp')
  and public.can_upload_submission(auth.uid())
);

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
      and not p.is_disqualified
      and (
        ev.voting_override = 'open'
        or (
          ev.voting_override = 'auto'
          and not ev.voting_locked
          and now() between ev.voting_starts_at and ev.voting_ends_at
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

drop policy if exists "own vote creation" on public.votes;
create policy "own vote creation" on public.votes
for insert
with check (
  voter_id = auth.uid()
  and exists (
    select 1
    from public.entries en
    join public.events ev on ev.id = en.event_id
    join public.profiles p on p.id = auth.uid()
    where en.id = entry_id
      and en.event_id = event_id
      and en.status = 'approved'
      and not p.is_disqualified
      and (
        ev.voting_override = 'open'
        or (
          ev.voting_override = 'auto'
          and not ev.voting_locked
          and now() between ev.voting_starts_at and ev.voting_ends_at
        )
      )
  )
);

drop policy if exists "own vote cancellation" on public.votes;
create policy "own vote cancellation" on public.votes
for delete
using (
  voter_id = auth.uid()
  and exists (
    select 1 from public.events ev
    where ev.id = event_id
      and (
        ev.voting_override = 'open'
        or (
          ev.voting_override = 'auto'
          and not ev.voting_locked
          and now() between ev.voting_starts_at and ev.voting_ends_at
        )
      )
  )
);
