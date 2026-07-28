import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canShowAwards } from "@/lib/types";
import { calculateAwardRanking, isTieHandling } from "@/lib/award-ranking";

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
    winners: ResultEntry[];
    unresolvedTie: boolean;
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
      { data: exclusions },
    ] = await Promise.all([
      ids.length ? admin.from("votes").select("entry_id,created_at").in("entry_id", ids) : Promise.resolve({ data: [] }),
      ids.length ? admin.from("entry_images").select("entry_id,storage_path,position").in("entry_id", ids).eq("position", 1) : Promise.resolve({ data: [] }),
      ownerIds.length ? admin.from("profiles").select("id,nickname,is_disqualified").in("id", ownerIds) : Promise.resolve({ data: [] }),
      admin.from("award_rules").select("*").eq("event_id", event.id).maybeSingle(),
      admin.from("awards").select("*").eq("event_id", event.id).eq("is_archived", false).order("sort_order"),
      admin.from("award_assignments").select("*"),
      admin.from("award_exclusions").select("award_a_id,award_b_id").eq("event_id", event.id),
    ]);
    const tieHandling = isTieHandling(rules?.tie_handling) ? rules.tie_handling : "joint";
    const source = (entries ?? []).filter(
      (entry) => !owners?.find((owner) => owner.id === entry.owner_id)?.is_disqualified,
    ).map((entry) => ({
      ...entry,
      nickname: owners?.find((owner) => owner.id === entry.owner_id)?.nickname ?? "未知玩家",
      image: images?.find((image) => image.entry_id === entry.id)?.storage_path ?? "",
      votes: 0,
      rank: 0,
    }));
    const ranking = calculateAwardRanking(
      source.map((entry) => ({ id: entry.id, created_at: entry.created_at })),
      votes ?? [],
      tieHandling,
    );
    ranked = ranking.map((position) => {
      const entry = source.find((item) => item.id === position.entryId);
      return {
        ...entry!,
        votes: position.votes,
        rank: position.rank,
      };
    });
    const submissionAwardCounts = new Map<number, number>();
    const playerAwardCounts = new Map<string, number>();
    const submissionAwardIds = new Map<number, Set<string>>();
    customAwards = (awards ?? []).filter((award) => award.is_active).map((award) => {
      const automaticCandidates = award.ranking_position
        ? ranked.filter((entry) => entry.rank === award.ranking_position)
        : [];
      const assignment = assignments?.find((item) => item.award_id === award.id);
      const assignedWinner = ranked.find((entry) => entry.id === assignment?.submission_id);
      const proposedWinners = award.ranking_position
        ? (
          automaticCandidates.length <= 1
            ? automaticCandidates
            : tieHandling === "joint"
              ? automaticCandidates
              : assignedWinner && automaticCandidates.some((entry) => entry.id === assignedWinner.id)
                ? [assignedWinner]
                : []
        )
        : assignedWinner ? [assignedWinner] : [];
      const automaticWinners = proposedWinners.filter((winner) => {
        const submissionCount = submissionAwardCounts.get(winner.id) ?? 0;
        const playerCount = playerAwardCounts.get(winner.owner_id) ?? 0;
        const priorAwardIds = submissionAwardIds.get(winner.id) ?? new Set<string>();
        const mutuallyExclusive = (exclusions ?? []).some((rule) => (
          rule.award_a_id === award.id && priorAwardIds.has(rule.award_b_id)
          || rule.award_b_id === award.id && priorAwardIds.has(rule.award_a_id)
        ));
        if (mutuallyExclusive) return false;
        if (rules?.allow_multiple_per_submission === false && submissionCount > 0) return false;
        if (rules?.max_awards_per_submission && submissionCount >= rules.max_awards_per_submission) return false;
        if (rules?.allow_multiple_per_player === false && playerCount > 0) return false;
        if (rules?.max_awards_per_player && playerCount >= rules.max_awards_per_player) return false;
        if (
          rules?.top_three_can_receive_special === false
          && award.award_type !== "ranking"
          && winner.rank <= 3
        ) return false;
        submissionAwardCounts.set(winner.id, submissionCount + 1);
        playerAwardCounts.set(winner.owner_id, playerCount + 1);
        submissionAwardIds.set(winner.id, new Set([...priorAwardIds, award.id]));
        return true;
      });
      return {
        id: award.id,
        name: award.name,
        description: award.description,
        winners: automaticWinners,
        unresolvedTie: proposedWinners.length > 0 && automaticWinners.length === 0
          || automaticCandidates.length > 1 && automaticWinners.length === 0,
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
              {published && award.winners.length ? award.winners.map((winner) => (
                <Link href={`/entry/${winner.id}`} key={winner.id}>
                  {winner.image && <Image src={winner.image} alt={winner.character_name} width={120} height={120} />}
                  <span><b>{winner.entry_code ?? `#${winner.id}`} · {winner.character_name}</b><small>{showAuthors ? winner.nickname : "匿名參賽者"}</small></span>
                </Link>
              )) : <strong>{published && award.unresolvedTie ? "同票，尚待依規則決定" : "尚未公布"}</strong>}
            </article>
          )) : <p className="muted">目前尚未建立自訂獎項。</p>}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
