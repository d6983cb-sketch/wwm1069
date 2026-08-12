import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import HuntClient from "./HuntClient";
import {
  calculateHuntRanking,
  canShowHuntRanking,
  type HuntEventRecord,
  type HuntSubmissionRecord,
} from "@/lib/hunt";

export const dynamic = "force-dynamic";

export default async function HuntPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: profile }, { data: eventData }] = await Promise.all([
    user ? admin.from("profiles").select("id,nickname,is_disqualified").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("hunt_events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const event = eventData as HuntEventRecord | null;
  const { data: ownData } = user && event
    ? await admin.from("hunt_submissions").select("*").eq("hunt_event_id", event.id).eq("profile_id", user.id).order("submitted_at", { ascending: false })
    : { data: [] };
  const ownSubmissions = await Promise.all(((ownData ?? []) as HuntSubmissionRecord[]).map(async (submission) => {
    const { data } = await admin.storage.from("hunt-proofs").createSignedUrl(submission.image_path, 60 * 30);
    return { ...submission, signedUrl: data?.signedUrl ?? null };
  }));

  let ranking: ReturnType<typeof calculateHuntRanking> = [];
  if (event && canShowHuntRanking(event)) {
    const { data: correct } = await admin
      .from("hunt_submissions")
      .select("profile_id,status,submitted_at")
      .eq("hunt_event_id", event.id)
      .eq("status", "correct");
    const profileIds = [...new Set((correct ?? []).map((item) => item.profile_id))];
    const { data: rankingProfiles } = profileIds.length
      ? await admin.from("profiles").select("id,nickname,is_disqualified").in("id", profileIds)
      : { data: [] };
    ranking = calculateHuntRanking(
      (correct ?? []) as Array<Pick<HuntSubmissionRecord, "profile_id" | "status" | "submitted_at">>,
      (rankingProfiles ?? []).filter((item) => !item.is_disqualified),
    );
  }

  return (
    <>
      <SiteHeader nickname={profile?.nickname ?? null} />
      <main className="inner hunt-page">
        <HuntClient
          event={event}
          userId={user?.id ?? null}
          nickname={profile?.nickname ?? null}
          disqualified={profile?.is_disqualified === true}
          submissions={ownSubmissions}
          ranking={ranking}
        />
      </main>
      <SiteFooter />
    </>
  );
}
