import { redirect } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import SubmitForm from "./SubmitForm";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRecord } from "@/lib/types";
import { isSubmissionOpen } from "@/lib/types";
import MySubmission from "./MySubmission";

export const dynamic = "force-dynamic";

export default async function SubmitPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const [{ data: profile }, { data: eventData }] = await Promise.all([
    admin.from("profiles").select("nickname,is_disqualified").eq("id", user.id).maybeSingle(),
    admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!profile) redirect("/");
  const event = eventData as EventRecord | null;
  const { data: existingEntry } = event
    ? await admin.from("entries").select("id,entry_code,character_name,source_game,created_at,uses_ai_background,original_image_path,withdrawn_at,status").eq("event_id", event.id).eq("owner_id", user.id).maybeSingle()
    : { data: null };
  const { data: ownImages } = existingEntry
    ? await admin.from("entry_images").select("id,storage_path,position,crop_x,crop_y,zoom,rotation,aspect_ratio").eq("entry_id", existingEntry.id).order("position")
    : { data: [] };
  return <>
    <SiteHeader nickname={profile.nickname} />
    <main className="inner">
      <header className="page-title"><small>SUBMISSION · 投稿</small><h1>留下一幅江湖之相</h1><p>每人僅能投稿一次，完成送出後不可修改、刪除或重新投稿。</p></header>
      {profile.is_disqualified
        ? <div className="empty-state"><i>止</i><h3>目前無法投稿</h3><p>此帳號目前已被取消活動資格。</p></div>
        : existingEntry
          ? <MySubmission entry={{ ...existingEntry, images: ownImages ?? [] }} canEditCrop={Boolean(event && isSubmissionOpen(event))} eventStatus={event?.status} />
          : event && isSubmissionOpen(event)
        ? <SubmitForm event={event} userId={user.id} />
        : <div className="empty-state"><i>止</i><h3>目前未開放投稿</h3><p>請留意首頁公告與活動時間。</p></div>}
    </main>
    <SiteFooter />
  </>;
}
