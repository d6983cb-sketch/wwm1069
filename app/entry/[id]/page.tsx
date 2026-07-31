import { notFound } from "next/navigation";
import Link from "next/link";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import ImageCarousel from "@/app/components/ImageCarousel";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  applyActiveImageRevisions,
  applyImageDisplaySettings,
  type EntryImageDisplaySetting,
  type EntryImageRevision,
} from "@/lib/submission-corrections";

export const dynamic = "force-dynamic";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: entry }, { data: profile }] = await Promise.all([
    admin.from("entries").select("*").eq("id", Number(id)).eq("status", "approved").is("withdrawn_at", null).maybeSingle(),
    user ? admin.from("profiles").select("nickname").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!entry) notFound();
  const { data: event } = await admin.from("events").select("leaderboard_mode,status,submission_identity_mode,voting_identity_mode,reveal_authors_after_results").eq("id", entry.event_id).single();
  const isOwner = user?.id === entry.owner_id;
  const { data: originalRevision } = await admin
    .from("entry_original_image_revisions")
    .select("storage_object_path")
    .eq("entry_id", entry.id)
    .eq("is_active", true)
    .maybeSingle();
  const activeOriginalPath = originalRevision?.storage_object_path ?? entry.original_image_path;
  const [{ data: owner }, { data: images }, voteResult, originalResult, { data: correctionGrant }] = await Promise.all([
    admin.from("profiles").select("nickname,is_disqualified").eq("id", entry.owner_id).single(),
    admin.from("entry_images").select("id,storage_path,position,crop_x,crop_y,zoom,rotation,aspect_ratio").eq("entry_id", entry.id).order("position"),
    event?.leaderboard_mode === "hidden"
      ? Promise.resolve({ count: 0 })
      : admin.from("votes").select("*", { count: "exact", head: true }).eq("entry_id", entry.id),
    entry.uses_ai_background && activeOriginalPath
      ? admin.storage.from("cos-originals").createSignedUrl(activeOriginalPath, 60 * 60)
      : Promise.resolve({ data: null }),
    isOwner
      ? admin.from("submission_edit_grants")
          .select("id")
          .eq("entry_id", entry.id)
          .eq("grantee_profile_id", entry.owner_id)
          .eq("is_active", true)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (owner?.is_disqualified) notFound();
  const imageIds = (images ?? []).map((image) => image.id);
  const [{ data: imageRevisions }, { data: displaySettings }] = imageIds.length
    ? await Promise.all([
        admin.from("entry_image_revisions")
          .select("id,entry_id,image_id,display_storage_path,crop_x,crop_y,zoom,rotation,aspect_ratio,is_active,created_at")
          .in("image_id", imageIds)
          .eq("is_active", true),
        admin.from("entry_image_display_settings")
          .select("image_id,entry_id,display_position,is_hidden")
          .in("image_id", imageIds),
      ])
    : [{ data: [] }, { data: [] }];
  const displayedImages = applyImageDisplaySettings(
    applyActiveImageRevisions(images ?? [], imageRevisions as EntryImageRevision[] | null),
    displaySettings as EntryImageDisplaySetting[] | null,
  );
  const count = voteResult.count;
  const resultsPhase = event?.status === "results_published" || event?.status === "archived";
  const votingPhase = event?.status === "voting_open" || event?.status === "voting_closed";
  const showAuthor = resultsPhase
    ? event?.reveal_authors_after_results !== false
    : votingPhase
      ? event?.voting_identity_mode !== "anonymous"
      : event?.submission_identity_mode !== "anonymous";
  const originalImage = originalResult.data;
  const galleryImages = originalImage?.signedUrl
    ? [
        ...displayedImages,
        {
          storage_path: originalImage.signedUrl,
          position: displayedImages.length + 1,
          label: "AI 合成前原圖",
        },
      ]
    : displayedImages;
  return <>
    <SiteHeader nickname={profile?.nickname} />
    <main className="inner"><Link className="back" href="/">← 返回作品展廳</Link><section className="detail"><div><ImageCarousel images={galleryImages} alt={`${entry.character_name} Cos 作品`} /><span>作品 {entry.entry_code ?? `#${entry.id}`}</span></div><article><small>ENTRY · 獨立作品頁</small><h1>{entry.character_name}</h1><b>角色來源 · {entry.source_game}</b><h2>投稿者　{showAuthor ? owner?.nickname : "匿名參賽者"}</h2><p>{entry.description || "投稿者沒有填寫作品介紹。"}</p>{entry.uses_ai_background && <aside>{originalImage?.signedUrl ? "此作品使用 AI 合成背景，作品相簿最後一張為合成前原圖。" : "此作品使用 AI 合成背景，原圖暫時無法載入。"}</aside>}<p>{event?.leaderboard_mode === "hidden" ? "♥ 已獲得支持" : `♥ ${count ?? 0} 票`}</p>{correctionGrant && <div className="entry-owner-actions"><Link className="primary entry-edit-link" href="/submit#submission-correction">編輯作品圖片</Link><small>此按鈕僅投稿者本人於修正授權有效期間可見。</small></div>}<small>登入後可回到首頁投票。</small></article></section></main>
    <SiteFooter />
  </>;
}
