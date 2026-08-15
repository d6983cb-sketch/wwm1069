-- Additive-only controls for revealing hunt photos at a scheduled time.
-- Existing submissions, reference images, Storage objects and review results are untouched.
alter table public.hunt_events
  add column if not exists photo_reveal_at timestamptz,
  add column if not exists reveal_player_photos boolean not null default false,
  add column if not exists reveal_answer_photos boolean not null default false;

comment on column public.hunt_events.photo_reveal_at is
  'UTC instant after which enabled public hunt photo galleries may be served.';
comment on column public.hunt_events.reveal_player_photos is
  'When true, manually confirmed correct player proof photos may be shown after photo_reveal_at.';
comment on column public.hunt_events.reveal_answer_photos is
  'When true, active answer/reference photos may be shown after photo_reveal_at.';
