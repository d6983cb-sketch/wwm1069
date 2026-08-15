import { notFound, redirect } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuperAdminDiscordId, type AdminPermissions } from "@/lib/admin-access";
import { calculateHuntRanking, type HuntEventRecord, type HuntReferenceImage, type HuntReferencePoint, type HuntSubmissionRecord } from "@/lib/hunt";
import HuntAdminClient from "./HuntAdminClient";

export const dynamic = "force-dynamic";

export default async function HuntAdminPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { data: profile } = await admin.from("profiles").select("id,nickname,discord_id").eq("id", user.id).maybeSingle();
  if (!profile) notFound();
  const isSuperAdmin = isSuperAdminDiscordId(profile.discord_id);
  const { data: role } = isSuperAdmin ? { data: null } : await admin.from("admin_roles").select("permissions,is_active").eq("profile_id", user.id).maybeSingle();
  const permissions = (role?.permissions ?? {}) as AdminPermissions;
  const canConfigure = isSuperAdmin || permissions.event_manager === true;
  const canReview = isSuperAdmin || permissions.submission_manager === true;
  if (!isSuperAdmin && (!role?.is_active || (!canConfigure && !canReview))) notFound();

  const { data: eventData } = await admin.from("hunt_events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const event = eventData as HuntEventRecord | null;
  const { data: submissionData } = event
    ? await admin.from("hunt_submissions").select("*").eq("hunt_event_id", event.id).order("submitted_at", { ascending: false })
    : { data: [] };
  const submissions = (submissionData ?? []) as HuntSubmissionRecord[];
  const [{ data: pointData }, { data: referenceData }] = event ? await Promise.all([
    admin.from("hunt_reference_points").select("id,hunt_event_id,target_number,label,is_active,created_at").eq("hunt_event_id", event.id).order("target_number"),
    admin.from("hunt_reference_images").select("id,reference_point_id,image_path,mime_type,embedding_model,is_active,created_at").order("created_at"),
  ]) : [{ data: [] }, { data: [] }];
  const referencesWithUrls = await Promise.all(((referenceData ?? []) as HuntReferenceImage[]).map(async (reference) => {
    const { data } = await admin.storage.from("hunt-references").createSignedUrl(reference.image_path, 60 * 30);
    return { ...reference, signedUrl: data?.signedUrl ?? null };
  }));
  const referencePoints = ((pointData ?? []) as Omit<HuntReferencePoint, "images">[]).map((point) => ({
    ...point,
    images: referencesWithUrls.filter((reference) => reference.reference_point_id === point.id),
  }));
  const profileIds = [...new Set(submissions.map((item) => item.profile_id))];
  const { data: players } = profileIds.length
    ? await admin.from("profiles").select("id,nickname,discord_id,is_disqualified").in("id", profileIds)
    : { data: [] };
  const rows = await Promise.all(submissions.map(async (submission) => {
    const { data } = await admin.storage.from("hunt-proofs").createSignedUrl(submission.image_path, 60 * 30);
    const player = players?.find((item) => item.id === submission.profile_id);
    return {
      ...submission,
      signedUrl: data?.signedUrl ?? null,
      nickname: player?.nickname ?? "未知玩家",
      discordId: player?.discord_id ?? "",
      disqualified: player?.is_disqualified === true,
    };
  }));
  const ranking = calculateHuntRanking(submissions, (players ?? []).filter((item) => !item.is_disqualified));

  return <>
    <SiteHeader nickname={profile.nickname} />
    <main className="inner hunt-admin-page">
      <HuntAdminClient event={event} submissions={rows} ranking={ranking} referencePoints={referencePoints} canConfigure={canConfigure} canReview={canReview} aiConfigured={Boolean(process.env.GEMINI_API_KEY?.trim())} />
    </main>
    <SiteFooter />
  </>;
}
