-- Adds presentation-only metadata. This migration never rewrites entries,
-- votes, Storage paths, image order, or existing image URLs.
begin;

alter table public.entry_images
  add column if not exists crop_x double precision not null default 0,
  add column if not exists crop_y double precision not null default 0,
  add column if not exists zoom double precision not null default 1,
  add column if not exists rotation double precision not null default 0,
  add column if not exists aspect_ratio text not null default '4/5',
  add column if not exists crop_updated_at timestamptz;

alter table public.entry_images
  drop constraint if exists entry_images_crop_x_check,
  drop constraint if exists entry_images_crop_y_check,
  drop constraint if exists entry_images_zoom_check,
  drop constraint if exists entry_images_rotation_check,
  drop constraint if exists entry_images_aspect_ratio_check;

alter table public.entry_images
  add constraint entry_images_crop_x_check check (crop_x between -50 and 50) not valid,
  add constraint entry_images_crop_y_check check (crop_y between -50 and 50) not valid,
  add constraint entry_images_zoom_check check (zoom between 1 and 3) not valid,
  add constraint entry_images_rotation_check check (rotation between -180 and 180) not valid,
  add constraint entry_images_aspect_ratio_check check (aspect_ratio = '4/5') not valid;

alter table public.entry_images validate constraint entry_images_crop_x_check;
alter table public.entry_images validate constraint entry_images_crop_y_check;
alter table public.entry_images validate constraint entry_images_zoom_check;
alter table public.entry_images validate constraint entry_images_rotation_check;
alter table public.entry_images validate constraint entry_images_aspect_ratio_check;

alter table public.events
  add column if not exists allow_admin_crop_after_submission boolean not null default false;

-- Crop writes must pass through the server route, which checks ownership,
-- event state, and the submission_manager permission before using service role.
revoke update on table public.entry_images from anon, authenticated;

commit;
