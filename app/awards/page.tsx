import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canShowAwards } from "@/lib/types";

export const dynamic = "force-dynamic";

type ResultEntry = {
  id: number;
  entry_code: string | null;
  owner_id: string;
  character_name: string;
  source_game: string;
  created_at: string;
  nickname: string;
  image: string;
  votes: number;
  rank: number;
};

export default async function AwardsPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const [{ data: profile }, { data: event }] = await Promise.all([
    user ? admin.from("profiles").select("nickname").eq("id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const published = canShowAwards(event);
  let ranked: ResultEntry[] = [];
  let customAwards: Array<{
    id: string;
    name: string;
    description: string | null;
    winner: ResultEntry | null;
  }> = [];

  if (event) {
    const { data: entries } = await admin
      .from("entries")
      .select("id,entry_code,owner_id,character_name,source_game,created_at")
      .eq("event_id", event.id)
      .eq("status", "approved")
      .is("withdrawn_at", null);
    const ids = (entries ?? []).map((entry) => entry.id);
    const ownerIds = [...new Set((entries ?? []).map((entry) => entry.owner_id))];
    const [
      { data: votes },
      { data: images },
      { data: owners },
      { data: rules },
      { data: awards },
      { data: assignments },
    ] = await Promise.all([
      ids.length ? admin.from("votes").select("entry_id").in("entry_id", ids) : Promise.resolve({ data: [] }),
      ids.length ? admin.from("entry_images").select("entry_id,storage_path,position").in("entry_id", ids).eq("position", 1) : Promise.resolve({ data: [] }),
      ownerIds.length ? admin.from("profiles").select("id,nickname,is_disqualified").in("id", ownerIds) : Promise.resolve({ data: [] }),
      admin.from("award_rules").select("tie_handling").eq("event_id", event.id).maybeSingle(),
      admin.from("awards").select("*").eq("event_id", event.id).eq("is_archived", false).order("sort_order"),
      admin.from("award_assignments").select("*"),
    ]);
    const tieHandling = rules?.tie_handling ?? "joint";
    const source = (entries ?? []).filter(
      (entry) => !owners?.find((owner) => owner.id === entry.owner_id)?.is_disqualified,
    ).map((entry) => ({
      ...entry,
      nickname: owners?.find((owner) => owner.id === entry.owner_id)?.nickname ?? "未知玩家",
      image: images?.find((image) => image.entry_id === entry.id)?.storage_path ?? "",
      votes: votes?.filter((vote) => vote.entry_id === entry.id).length ?? 0,
      rank: 0,
    })).sort((a, b) =>
      b.votes - a.votes
      || (tieHandling === "earliest_submission" ? Date.parse(a.created_at) - Date.parse(b.created_at) : a.id - b.id),
    );
    let previousVotes: number | null = null;
    let currentRank = 0;
    ranked = source.map((entry, index) => {
      if (tieHandling === "earliest_submission" || previousVotes !== entry.votes) currentRank = index + 1;
      previousVotes = entry.votes;
      return { ...entry, rank: currentRank };
    });
    customAwards = (awards ?? []).filter((award) => award.is_active).map((award) => {
      const assignment = assignments?.find((item) => item.award_id === award.id);
      return {
        id: award.id,
        name: award.name,
        description: award.description,
        winner: ranked.find((entry) => entry.id === assignment?.submission_id) ?? null,
      };
    });
  }

  const showAuthors = event?.reveal_authors_after_results !== false;
  const podium = published ? ranked.filter((entry) => entry.rank <= 3) : [];

  return (
    <>
      <SiteHeader nickname={profile?.nickname} />
      <main className="inner">
        <header className="page-title">
          <small>RESULTS · 最終揭榜</small>
          <h1>一朝入畫，名動江湖</h1>
          <p>結果公布後顯示票數排名及管理員設定的自訂獎項。</p>
        </header>
        {podium.length ? (
          <section className="podium">
            {podium.map((entry) => (
              <article className={entry.rank === 1 ? "winner first" : "winner"} key={entry.id}>
                <span>{["壹", "貳", "參"][entry.rank - 1]}</span>
                <Link href={`/entry/${entry.id}`}>
                  {entry.image && <Image src={entry.image} alt={entry.character_name} fill sizes="(max-width: 760px) 100vw, 33vw" />}
                </Link>
                <div>
                  <small>第 {entry.rank} 名 · {entry.entry_code ?? `#${entry.id}`}</small>
                  <h2>{entry.character_name}</h2>
                  <p>{showAuthors ? entry.nickname : "匿名參賽者"} · {entry.source_game}</p>
                  <b>♥ {entry.votes} 票</b>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <div className="empty-state"><i>榜</i><h3>排行榜尚未公布</h3><p>投票截止後由管理員開啟結果。</p></div>
        )}
        <section className="custom-awards">
          <header><small>SPECIAL AWARDS</small><h2>自訂獎項</h2></header>
          {customAwards.length ? customAwards.map((award) => (
            <article key={award.id}>
              <div><h3>{award.name}</h3><p>{award.description || "未填寫獎項說明。"}</p></div>
              {published && award.winner ? (
                <Link href={`/entry/${award.winner.id}`}>
                  {award.winner.image && <Image src={award.winner.image} alt={award.winner.character_name} width={120} height={120} />}
                  <span><b>{award.winner.entry_code ?? `#${award.winner.id}`} · {award.winner.character_name}</b><small>{showAuthors ? award.winner.nickname : "匿名參賽者"}</small></span>
                </Link>
              ) : <strong>尚未公布</strong>}
            </article>
          )) : <p className="muted">目前尚未建立自訂獎項。</p>}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
