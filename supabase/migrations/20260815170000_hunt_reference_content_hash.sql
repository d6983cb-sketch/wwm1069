-- Additive-only exact duplicate protection for future hunt reference uploads.
-- Existing images, Storage objects, embeddings, submissions and votes are untouched.
alter table public.hunt_reference_images
  add column if not exists content_sha256 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_reference_images_content_sha256_check'
      and conrelid = 'public.hunt_reference_images'::regclass
  ) then
    alter table public.hunt_reference_images
      add constraint hunt_reference_images_content_sha256_check
      check (content_sha256 is null or content_sha256 ~ '^[a-f0-9]{64}$')
      not valid;
  end if;
end
$$;

create unique index if not exists hunt_reference_images_point_content_sha256_uidx
  on public.hunt_reference_images (reference_point_id, content_sha256)
  where content_sha256 is not null;

comment on column public.hunt_reference_images.content_sha256 is
  'SHA-256 of the exact uploaded bytes; used only to reject future duplicate reference uploads.';
