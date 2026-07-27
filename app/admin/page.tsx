import { notFound, redirect } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isConfiguredAdmin } from "@/lib/admin-access";
import type { EventRecord } from "@/lib/types";
import AdminClient from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { data: profile } = await admin.from("profiles").select("nickname,is_admin,discord_id").eq("id", user.id).single();
  if (!profile) notFound();
  const configuredAdmin = isConfiguredAdmin(profile.discord_id);
  if (!profile.is_admin && configuredAdmin) {
    await admin.from("profiles").update({ is_admin: true }).eq("id", user.id);
  }
  if (!profile.is_admin && !configuredAdmin) notFound();
  const { data: eventData } = await admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const event = eventData as EventRecord | null;
  const [{ data: rawEntries }, { data: rawPlayers }, { data: rawVotes }, { data: announcements }] = await Promise.all([
    event ? admin.from("entries").select("id,owner_id,character_name,source_game,created_at,uses_ai_background,original_image_path,status").eq("event_id", event.id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified,created_at").order("created_at", { ascending: false }),
    event ? admin.from("votes").select("id,entry_id,voter_id,created_at").eq("event_id", event.id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    event ? admin.from("announcements").select("id,body,published_at").eq("event_id", event.id).order("published_at", { ascending: false }).limit(20) : Promise.resolve({ data: [] }),
  ]);
  const players = rawPlayers ?? [];
  const entryIds = (rawEntries ?? []).map((entry) => entry.id);
  const { data: entryImages } = entryIds.length
    ? await admin.from("entry_images").select("entry_id,storage_path,position").in("entry_id", entryIds).order("position")
    : { data: [] };
  const entries = (rawEntries ?? []).map((entry) => ({
    ...entry,
    nickname: players.find((owner) => owner.id === entry.owner_id)?.nickname ?? "未知",
    images: (entryImages ?? []).filter((image) => image.entry_id === entry.id).map((image) => image.storage_path),
  }));
  const voteRecords = (rawVotes ?? []).map((vote) => ({
    id: vote.id,
    entry_id: vote.entry_id,
    created_at: vote.created_at,
    voter_nickname: players.find((player) => player.id === vote.voter_id)?.nickname ?? "未知玩家",
    character_name: entries.find((entry) => entry.id === vote.entry_id)?.character_name ?? "已刪除作品",
  }));
  return (
    <>
      <SiteHeader nickname={profile.nickname} />
      <main className="admin">
        <AdminClient
          event={event}
          entries={entries}
          players={players}
          votes={voteRecords}
          announcements={announcements ?? []}
          counts={{ players: players.length, entries: entries.length, votes: voteRecords.length }}
          currentAdminId={user.id}
        />
      </main>
    </>
  );
}
