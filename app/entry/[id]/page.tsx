import { notFound } from "next/navigation";
import Link from "next/link";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import ImageCarousel from "@/app/components/ImageCarousel";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
  const [{ data: owner }, { data: images }, voteResult] = await Promise.all([
    admin.from("profiles").select("nickname,is_disqualified").eq("id", entry.owner_id).single(),
    admin.from("entry_images").select("id,storage_path,position,crop_x,crop_y,zoom,rotation,aspect_ratio").eq("entry_id", entry.id).order("position"),
    event?.leaderboard_mode === "hidden"
      ? Promise.resolve({ count: 0 })
      : admin.from("votes").select("*", { count: "exact", head: true }).eq("entry_id", entry.id),
  ]);
  if (owner?.is_disqualified) notFound();
  const count = voteResult.count;
  const resultsPhase = event?.status === "results_published" || event?.status === "archived";
  const votingPhase = event?.status === "voting_open" || event?.status === "voting_closed";
  const showAuthor = resultsPhase
    ? event?.reveal_authors_after_results !== false
    : votingPhase
      ? event?.voting_identity_mode !== "anonymous"
      : event?.submission_identity_mode !== "anonymous";
  return <>
    <SiteHeader nickname={profile?.nickname} />
    <main className="inner"><Link className="back" href="/">← 返回作品展廳</Link><section className="detail"><div><ImageCarousel images={images ?? []} alt={`${entry.character_name} Cos 作品`} /><span>作品 {entry.entry_code ?? `#${entry.id}`}</span></div><article><small>ENTRY · 獨立作品頁</small><h1>{entry.character_name}</h1><b>角色來源 · {entry.source_game}</b><h2>投稿者　{showAuthor ? owner?.nickname : "匿名參賽者"}</h2><p>{entry.description || "投稿者沒有填寫作品介紹。"}</p>{entry.uses_ai_background && <aside>此作品使用 AI 合成背景，原圖已提供管理員查核。</aside>}<p>{event?.leaderboard_mode === "hidden" ? "♥ 已獲得支持" : `♥ ${count ?? 0} 票`}</p><small>登入後可回到首頁投票。</small></article></section></main>
    <SiteFooter />
  </>;
}
