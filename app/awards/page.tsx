import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canShowAwards } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AwardsPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: profile }, { data: event }] = await Promise.all([
    user ? admin.from("profiles").select("nickname").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  let winners: Array<{ id: number; character_name: string; source_game: string; nickname: string; image: string; votes: number }> = [];
  if (canShowAwards(event)) {
    const { data: entries } = await admin.from("entries").select("id,owner_id,character_name,source_game").eq("event_id", event.id).eq("status", "approved");
    const ids = (entries ?? []).map((entry) => entry.id);
    const ownerIds = [...new Set((entries ?? []).map((entry) => entry.owner_id))];
    const [{ data: votes }, { data: images }, { data: owners }] = await Promise.all([
      ids.length ? admin.from("votes").select("entry_id").in("entry_id", ids) : Promise.resolve({ data: [] }),
      ids.length ? admin.from("entry_images").select("entry_id,storage_path,position").in("entry_id", ids).eq("position", 1) : Promise.resolve({ data: [] }),
      ownerIds.length ? admin.from("profiles").select("id,nickname").in("id", ownerIds) : Promise.resolve({ data: [] }),
    ]);
    winners = (entries ?? []).map((entry) => ({
      id: entry.id,
      character_name: entry.character_name,
      source_game: entry.source_game,
      nickname: owners?.find((owner) => owner.id === entry.owner_id)?.nickname ?? "未知",
      image: images?.find((image) => image.entry_id === entry.id)?.storage_path ?? "",
      votes: votes?.filter((vote) => vote.entry_id === entry.id).length ?? 0,
    })).sort((a, b) => b.votes - a.votes).slice(0, 3);
  }
  return <><SiteHeader nickname={profile?.nickname} /><main className="inner"><header className="page-title"><small>RESULTS · 最終揭榜</small><h1>一朝入畫，名動江湖</h1><p>投票截止並由管理員公布後，前三名會顯示於此。</p></header>{winners.length ? <section className="podium">{winners.map((entry, index) => <article className={index === 0 ? "winner first" : "winner"} key={entry.id}><span>{["壹", "貳", "參"][index]}</span><a href={`/entry/${entry.id}`}><Image src={entry.image} alt={entry.character_name} fill sizes="(max-width: 760px) 100vw, 33vw" /></a><div><small>第 {index + 1} 名</small><h2>{entry.character_name}</h2><p>{entry.nickname} · {entry.source_game}</p><b>♥ {entry.votes} 票</b></div></article>)}</section> : <div className="empty-state"><i>榜</i><h3>排行榜尚未公布</h3><p>投票截止後由管理員開啟結果。</p></div>}</main><SiteFooter /></>;
}
