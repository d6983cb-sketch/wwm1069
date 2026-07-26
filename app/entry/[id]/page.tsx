import { notFound } from "next/navigation";
import Link from "next/link";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: entry }, { data: profile }] = await Promise.all([
    admin.from("entries").select("*").eq("id", Number(id)).eq("status", "approved").maybeSingle(),
    user ? admin.from("profiles").select("nickname").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!entry) notFound();
  const [{ data: owner }, { data: images }, { count }] = await Promise.all([
    admin.from("profiles").select("nickname").eq("id", entry.owner_id).single(),
    admin.from("entry_images").select("storage_path").eq("entry_id", entry.id).order("position"),
    admin.from("votes").select("*", { count: "exact", head: true }).eq("entry_id", entry.id),
  ]);
  const { data: event } = await admin.from("events").select("leaderboard_mode").eq("id", entry.event_id).single();
  return <>
    <SiteHeader nickname={profile?.nickname} />
    <main className="inner"><Link className="back" href="/">← 返回作品展廳</Link><section className="detail"><div><img src={images?.[0]?.storage_path} alt={entry.character_name} /><span>作品 #{entry.id}</span></div><article><small>ENTRY · 獨立作品頁</small><h1>{entry.character_name}</h1><b>角色來源 · {entry.source_game}</b><h2>投稿者　{owner?.nickname}</h2><p>{entry.description || "投稿者沒有填寫作品介紹。"}</p>{entry.uses_ai_background && <aside>此作品使用 AI 合成背景，原圖已提供管理員查核。</aside>}<p>{event?.leaderboard_mode === "hidden" ? "♥ 已獲得支持" : `♥ ${count ?? 0} 票`}</p><small>登入後可回到首頁投票。</small></article></section></main>
    <SiteFooter />
  </>;
}
