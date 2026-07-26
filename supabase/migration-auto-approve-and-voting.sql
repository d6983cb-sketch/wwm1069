alter table public.entries alter column status set default 'approved';
update public.entries set status = 'approved' where status = 'pending';

alter table public.events
  add column if not exists voting_override text not null default 'auto';

alter table public.events
  drop constraint if exists events_voting_override_check;

alter table public.events
  add constraint events_voting_override_check
  check (voting_override in ('auto', 'open', 'closed'));

update public.events
set voting_override = 'open'
where id = (
  select id from public.events order by created_at desc limit 1
);
