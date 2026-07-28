import HomeClient from "@/app/components/HomeClient";
import { randomInt } from "node:crypto";
import SiteFooter from "@/app/components/SiteFooter";
import SiteHeader from "@/app/components/SiteHeader";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { EntryRecord, EventRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: eventData } = await admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const event = eventData as EventRecord | null;
  const { data: profile } = user ? await admin.from("profiles").select("nickname").eq("id", user.id).maybeSingle() : { data: null };
  const { data: rawEntries } = event
    ? await admin.from("entries").select("id,entry_code,owner_id,character_name,source_game,description,uses_ai_background,created_at,withdrawn_at").eq("event_id", event.id).eq("status", "approved").is("withdrawn_at", null)
    : { data: [] };
  const entryIds = (rawEntries ?? []).map((entry) => entry.id);
  const ownerIds = [...new Set((rawEntries ?? []).map((entry) => entry.owner_id))];
  const shouldExposeCounts = event?.leaderboard_mode !== "hidden";
  const [{ data: profiles }, { data: images }, { data: allVotes }, { data: announcement }, { data: ownVotes }] = await Promise.all([
    ownerIds.length ? admin.from("profiles").select("id,nickname,is_disqualified").in("id", ownerIds) : Promise.resolve({ data: [] }),
    entryIds.length ? admin.from("entry_images").select("entry_id,storage_path,position").in("entry_id", entryIds).order("position") : Promise.resolve({ data: [] }),
    shouldExposeCounts && entryIds.length
      ? admin.from("votes").select("entry_id").in("entry_id", entryIds)
      : Promise.resolve({ data: [] }),
    event ? admin.from("announcements").select("body").eq("event_id", event.id).eq("is_active", true).eq("audience", "all").is("archived_at", null).order("is_pinned", { ascending: false }).order("published_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    user && event ? supabase.from("votes").select("entry_id").eq("event_id", event.id).eq("voter_id", user.id) : Promise.resolve({ data: [] }),
  ]);
  const resultsPhase = event?.status === "results_published" || event?.status === "archived";
  const votingPhase = event?.status === "voting_open" || event?.status === "voting_closed";
  const showAuthors = resultsPhase
    ? event?.reveal_authors_after_results !== false
    : votingPhase
      ? event?.voting_identity_mode !== "anonymous"
      : event?.submission_identity_mode !== "anonymous";
  const entries: EntryRecord[] = (rawEntries ?? []).filter((entry) =>
    !profiles?.find((item) => item.id === entry.owner_id)?.is_disqualified
  ).map((entry) => ({
    id: entry.id,
    entry_code: entry.entry_code,
    character_name: entry.character_name,
    source_game: entry.source_game,
    description: entry.description,
    uses_ai_background: entry.uses_ai_background,
    created_at: entry.created_at,
    nickname: showAuthors
      ? profiles?.find((item) => item.id === entry.owner_id)?.nickname ?? "未知玩家"
      : "匿名參賽者",
    images: (images ?? []).filter((item) => item.entry_id === entry.id).map((item) => item.storage_path),
    vote_count: (allVotes ?? []).filter((vote) => vote.entry_id === entry.id).length,
  })).filter((entry) => entry.images.length > 0);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [entries[index], entries[swap]] = [entries[swap], entries[index]];
  }
  return (
    <>
      <SiteHeader nickname={profile?.nickname} />
      <HomeClient
        event={event}
        entries={entries}
        announcement={announcement?.body ?? null}
        nickname={profile?.nickname ?? null}
        needsProfile={Boolean(user && !profile)}
        initialVotes={(ownVotes ?? []).map((vote) => vote.entry_id)}
      />
      <SiteFooter />
    </>
  );
}
