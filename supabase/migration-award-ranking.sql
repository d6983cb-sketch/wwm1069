-- Automatic rank-based awards.
-- This migration only adds award configuration. It never updates entries,
-- votes, vote counts, profiles, entry images, or Storage objects.

alter table public.awards
  add column if not exists ranking_position integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.awards'::regclass
      and conname = 'awards_ranking_position_check'
  ) then
    alter table public.awards
      add constraint awards_ranking_position_check
      check (ranking_position is null or ranking_position between 1 and 999)
      not valid;
  end if;

  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.award_rules'::regclass
      and conname = 'award_rules_tie_handling_check'
      and pg_get_constraintdef(oid) not like '%earliest_reached_votes%'
  ) then
    alter table public.award_rules
      drop constraint award_rules_tie_handling_check;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.award_rules'::regclass
      and conname = 'award_rules_tie_handling_check'
  ) then
    alter table public.award_rules
      add constraint award_rules_tie_handling_check
      check (tie_handling in (
        'joint',
        'admin_decision',
        'earliest_submission',
        'earliest_reached_votes',
        'unresolved'
      ))
      not valid;
  end if;
end
$$;

create index if not exists awards_event_ranking_position_idx
  on public.awards (event_id, ranking_position)
  where ranking_position is not null and is_archived = false;
