-- Restore the original desktop home-card ratio for every presentation surface.
-- Only presentation metadata changes; entries, votes, paths, order and Storage
-- objects remain untouched.
begin;

alter table public.entry_images
  drop constraint if exists entry_images_aspect_ratio_check;

alter table public.entry_images
  alter column aspect_ratio set default '4/3';

update public.entry_images
set aspect_ratio = '4/3'
where aspect_ratio is distinct from '4/3';

alter table public.entry_images
  add constraint entry_images_aspect_ratio_check
  check (aspect_ratio = '4/3')
  not valid;

alter table public.entry_images
  validate constraint entry_images_aspect_ratio_check;

commit;
