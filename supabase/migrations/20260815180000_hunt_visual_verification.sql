-- Additive-only metadata for the second-stage visual verification pipeline.
-- Existing submission, proof, vote, and Storage records remain untouched.

alter table public.hunt_submissions
  add column if not exists auto_verification jsonb,
  add column if not exists auto_verification_confidence real,
  add column if not exists auto_verification_model text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hunt_submissions_auto_verification_confidence_check'
      and conrelid = 'public.hunt_submissions'::regclass
  ) then
    alter table public.hunt_submissions
      add constraint hunt_submissions_auto_verification_confidence_check
      check (auto_verification_confidence is null or auto_verification_confidence between 0 and 1)
      not valid;
  end if;
end
$$;

comment on column public.hunt_submissions.auto_verification is
  'Structured second-stage visual verification result; never replaces manual review.';
comment on column public.hunt_submissions.auto_verification_confidence is
  'Visual verification confidence from 0 to 1.';
comment on column public.hunt_submissions.auto_verification_model is
  'Model used for the second-stage visual verification.';
