-- Allow the server-only Supabase client to perform the owner-validated
-- hunt submission deletion implemented by /api/hunt/submissions.
-- Browser roles remain unable to delete rows directly.

revoke delete on table public.hunt_submissions from anon, authenticated;
grant delete on table public.hunt_submissions to service_role;
