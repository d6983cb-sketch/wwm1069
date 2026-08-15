import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import HuntClient from "./HuntClient";
import {
  calculateHuntRanking,
  canShowHuntAnswerPhotos,
  canShowHuntPlayerPhotos,
  canShowHuntRanking,
  type HuntEventRecord,
  type HuntPublicAnswerPhoto,
  type HuntPublicPlayerPhoto,
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

  let publicPlayerPhotos: HuntPublicPlayerPhoto[] = [];
  if (event && canShowHuntPlayerPhotos(event)) {
    const { data: correctPhotos } = await admin
      .from("hunt_submissions")
      .select("id,profile_id,image_path,matched_target_number,submitted_at")
      .eq("hunt_event_id", event.id)
      .eq("status", "correct")
      .not("matched_target_number", "is", null)
      .order("matched_target_number")
      .order("submitted_at");
    const publicProfileIds = [...new Set((correctPhotos ?? []).map((item) => item.profile_id))];
    const { data: publicProfiles } = publicProfileIds.length
      ? await admin.from("profiles").select("id,nickname,is_disqualified").in("id", publicProfileIds)
      : { data: [] };
    const nicknameByProfile = new Map(
      (publicProfiles ?? []).filter((item) => !item.is_disqualified).map((item) => [item.id, item.nickname]),
    );
    const visiblePhotos = (correctPhotos ?? []).filter((item) => nicknameByProfile.has(item.profile_id) && item.matched_target_number);
    publicPlayerPhotos = (await Promise.all(visiblePhotos.map(async (submission) => {
      const { data } = await admin.storage.from("hunt-proofs").createSignedUrl(submission.image_path, 60 * 15);
      if (!data?.signedUrl || !submission.matched_target_number) return null;
      return {
        id: submission.id,
        targetNumber: submission.matched_target_number,
        nickname: nicknameByProfile.get(submission.profile_id) ?? "未知玩家",
        submittedAt: submission.submitted_at,
        signedUrl: data.signedUrl,
      } satisfies HuntPublicPlayerPhoto;
    }))).filter((item): item is HuntPublicPlayerPhoto => item !== null);
  }

  let publicAnswerPhotos: HuntPublicAnswerPhoto[] = [];
  if (event && canShowHuntAnswerPhotos(event)) {
    const { data: publicPoints } = await admin
      .from("hunt_reference_points")
      .select("id,target_number,label")
      .eq("hunt_event_id", event.id)
      .eq("is_active", true)
      .order("target_number");
    const pointById = new Map((publicPoints ?? []).map((point) => [point.id, point]));
    const pointIds = [...pointById.keys()];
    const { data: publicReferences } = pointIds.length
      ? await admin
        .from("hunt_reference_images")
        .select("id,reference_point_id,image_path")
        .in("reference_point_id", pointIds)
        .eq("is_active", true)
        .order("created_at")
      : { data: [] };
    publicAnswerPhotos = (await Promise.all((publicReferences ?? []).map(async (reference) => {
      const point = pointById.get(reference.reference_point_id);
      if (!point) return null;
      const { data } = await admin.storage.from("hunt-references").createSignedUrl(reference.image_path, 60 * 15);
      if (!data?.signedUrl) return null;
      return {
        id: reference.id,
        targetNumber: point.target_number,
        label: point.label,
        signedUrl: data.signedUrl,
      } satisfies HuntPublicAnswerPhoto;
    }))).filter((item): item is HuntPublicAnswerPhoto => item !== null);
  }

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
          publicPlayerPhotos={publicPlayerPhotos}
          publicAnswerPhotos={publicAnswerPhotos}
        />
      </main>
      <SiteFooter />
    </>
  );
}
