-- Explicit super-admin-only application flow for irreversible entry deletion.
-- The database part is atomic. Storage objects are removed afterwards through
-- the Storage API, never by deleting rows from storage.objects.
begin;

create or replace function public.admin_permanently_delete_entry(target_entry_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target public.entries%rowtype;
  image_urls text[];
  votes_count integer;
  images_count integer;
  assignments_count integer;
  history_count integer;
begin
  select *
  into target
  from public.entries
  where id = target_entry_id
  for update;

  if not found then
    return null;
  end if;

  select coalesce(array_agg(storage_path order by position), array[]::text[])
  into image_urls
  from public.entry_images
  where entry_id = target_entry_id;

  delete from public.award_assignments
  where submission_id = target_entry_id;
  get diagnostics assignments_count = row_count;

  -- The existing vote trigger writes a final "removed" history row. All
  -- history for the deleted entry is removed immediately afterwards.
  delete from public.votes
  where entry_id = target_entry_id;
  get diagnostics votes_count = row_count;

  delete from public.vote_history
  where entry_id = target_entry_id;
  get diagnostics history_count = row_count;

  delete from public.entry_images
  where entry_id = target_entry_id;
  get diagnostics images_count = row_count;

  delete from public.entries
  where id = target_entry_id;

  return jsonb_build_object(
    'entry_id', target.id,
    'entry_code', target.entry_code,
    'character_name', target.character_name,
    'owner_id', target.owner_id,
    'original_image_path', target.original_image_path,
    'image_urls', to_jsonb(image_urls),
    'votes_deleted', votes_count,
    'images_deleted', images_count,
    'award_assignments_deleted', assignments_count,
    'vote_history_deleted', history_count
  );
end;
$$;

revoke all on function public.admin_permanently_delete_entry(bigint) from public;
revoke all on function public.admin_permanently_delete_entry(bigint) from anon;
revoke all on function public.admin_permanently_delete_entry(bigint) from authenticated;
grant execute on function public.admin_permanently_delete_entry(bigint) to service_role;

commit;
