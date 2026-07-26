import HomeClient from "@/app/components/HomeClient";
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
    ? await admin.from("entries").select("id,owner_id,character_name,source_game,description,uses_ai_background,created_at").eq("event_id", event.id).eq("status", "approved")
    : { data: [] };
  const entryIds = (rawEntries ?? []).map((entry) => entry.id);
  const ownerIds = [...new Set((rawEntries ?? []).map((entry) => entry.owner_id))];
  const [{ data: profiles }, { data: images }, { data: allVotes }, { data: announcement }, { data: ownVotes }] = await Promise.all([
    ownerIds.length ? admin.from("profiles").select("id,nickname").in("id", ownerIds) : Promise.resolve({ data: [] }),
    entryIds.length ? admin.from("entry_images").select("entry_id,storage_path,position").in("entry_id", entryIds).order("position") : Promise.resolve({ data: [] }),
    entryIds.length ? admin.from("votes").select("entry_id").in("entry_id", entryIds) : Promise.resolve({ data: [] }),
    event ? admin.from("announcements").select("body").eq("event_id", event.id).order("published_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    user && event ? supabase.from("votes").select("entry_id").eq("event_id", event.id).eq("voter_id", user.id) : Promise.resolve({ data: [] }),
  ]);
  const entries: EntryRecord[] = (rawEntries ?? []).map((entry) => ({
    id: entry.id,
    character_name: entry.character_name,
    source_game: entry.source_game,
    description: entry.description,
    uses_ai_background: entry.uses_ai_background,
    created_at: entry.created_at,
    nickname: profiles?.find((item) => item.id === entry.owner_id)?.nickname ?? "匿名",
    images: (images ?? []).filter((item) => item.entry_id === entry.id).map((item) => item.storage_path),
    vote_count: (allVotes ?? []).filter((vote) => vote.entry_id === entry.id).length,
  })).filter((entry) => entry.images.length > 0);
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
