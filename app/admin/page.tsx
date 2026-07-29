import { notFound, redirect } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuperAdminDiscordId, type AdminPermissions } from "@/lib/admin-access";
import type { EventRecord } from "@/lib/types";
import { calculateAwardRanking, isTieHandling } from "@/lib/award-ranking";
import AdminClient from "./AdminClient";
import AdminRoleManager from "./AdminRoleManager";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { data: profile } = await admin.from("profiles").select("id,nickname,is_admin,discord_id").eq("id", user.id).single();
  if (!profile) notFound();
  const isSuperAdmin = isSuperAdminDiscordId(profile.discord_id);
  const { data: ownRole } = isSuperAdmin
    ? { data: null }
    : await admin.from("admin_roles").select("permissions,is_active").eq("profile_id", user.id).maybeSingle();
  const permissions = (ownRole?.permissions ?? {}) as AdminPermissions;
  if (!isSuperAdmin && !ownRole?.is_active) notFound();
  const has = (permission: keyof AdminPermissions) => isSuperAdmin || permissions[permission] === true;
  const { data: eventData } = await admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const event = eventData as EventRecord | null;
  const [{ data: rawEntries }, { data: rawPlayers }, { data: rawVotes }, { data: announcements }] = await Promise.all([
    event && (has("submission_viewer") || has("submission_manager") || has("award_manager") || has("award_assigner"))
      ? admin.from("entries").select("id,entry_code,event_id,owner_id,character_name,source_game,created_at,uses_ai_background,original_image_path,status,withdrawn_at").eq("event_id", event.id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    has("player_manager") || has("eligibility_manager") || isSuperAdmin
      ? admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified,admin_note,created_at").order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    event && (has("statistics_viewer") || has("report_viewer") || has("award_manager") || has("award_assigner"))
      ? admin.from("votes").select("id,entry_id,voter_id,created_at").eq("event_id", event.id).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    event && has("announcement_manager")
      ? admin.from("announcements").select("id,title,body,announcement_type,audience,target_profile_id,is_active,is_pinned,requires_ack,published_at,expires_at").eq("event_id", event.id).order("published_at", { ascending: false }).limit(100)
      : Promise.resolve({ data: [] }),
  ]);
  const players = rawPlayers ?? [];
  const relatedProfileIds = [...new Set([
    ...(rawEntries ?? []).map((entry) => entry.owner_id),
    ...((has("statistics_viewer") || has("report_viewer"))
      ? (rawVotes ?? []).map((vote) => vote.voter_id)
      : []),
  ])];
  const { data: relatedProfiles } = relatedProfileIds.length
    ? await admin.from("profiles").select("id,nickname,is_disqualified").in("id", relatedProfileIds)
    : { data: [] };
  const entryIds = (rawEntries ?? []).map((entry) => entry.id);
  const { data: entryImages } = entryIds.length
    ? await admin.from("entry_images").select("id,entry_id,storage_path,position,crop_x,crop_y,zoom,rotation,aspect_ratio").in("entry_id", entryIds).order("position")
    : { data: [] };
  const entries = (rawEntries ?? []).map((entry) => ({
    ...entry,
    nickname: relatedProfiles?.find((owner) => owner.id === entry.owner_id)?.nickname ?? "未知",
    images: (entryImages ?? []).filter((image) => image.entry_id === entry.id),
  }));
  const voteRecords = (has("statistics_viewer") || has("report_viewer") ? rawVotes ?? [] : []).map((vote) => ({
    id: vote.id,
    entry_id: vote.entry_id,
    created_at: vote.created_at,
    voter_nickname: relatedProfiles?.find((player) => player.id === vote.voter_id)?.nickname ?? "未知玩家",
    character_name: entries.find((entry) => entry.id === vote.entry_id)?.character_name ?? "已刪除作品",
  }));
  const [
    { data: roleRows },
    { data: awards },
    { data: assignments },
    { data: awardRules },
    { data: snapshots },
    { data: auditLogs },
  ] = await Promise.all([
    isSuperAdmin ? admin.from("admin_roles").select("*") : Promise.resolve({ data: [] }),
    event && (has("award_manager") || has("award_assigner")) ? admin.from("awards").select("*").eq("event_id", event.id).order("sort_order") : Promise.resolve({ data: [] }),
    event && (has("award_manager") || has("award_assigner")) ? admin.from("award_assignments").select("*") : Promise.resolve({ data: [] }),
    event && has("award_manager") ? admin.from("award_rules").select("*").eq("event_id", event.id).maybeSingle() : Promise.resolve({ data: null }),
    event && has("report_viewer") ? admin.from("activity_snapshots").select("id,event_id,created_by,created_at").eq("event_id", event.id).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    has("audit_viewer") ? admin.from("audit_logs").select("id,actor_discord_id,actor_nickname,action_type,target_type,target_id,result,failure_reason,created_at").order("created_at", { ascending: false }).limit(200) : Promise.resolve({ data: [] }),
  ]);
  const tieHandling = isTieHandling(awardRules?.tie_handling) ? awardRules.tie_handling : "joint";
  const awardRanking = calculateAwardRanking(
    entries
      .filter((entry) => (
        entry.status === "approved"
        && !entry.withdrawn_at
        && !relatedProfiles?.find((profile) => profile.id === entry.owner_id)?.is_disqualified
      ))
      .map((entry) => ({ id: entry.id, created_at: entry.created_at })),
    (rawVotes ?? []).map((vote) => ({ entry_id: vote.entry_id, created_at: vote.created_at })),
    tieHandling,
  ).map((ranking) => {
    const entry = entries.find((item) => item.id === ranking.entryId);
    return {
      ...ranking,
      entryCode: entry?.entry_code ?? `#${ranking.entryId}`,
      characterName: entry?.character_name ?? "未知作品",
      nickname: entry?.nickname ?? "未知玩家",
    };
  });
  const playersWithRoles = players.map((player) => ({
    ...player,
    admin_role: roleRows?.find((role) => role.profile_id === player.id) ?? null,
  }));
  return (
    <>
      <SiteHeader nickname={profile.nickname} />
      <main className="admin">
        <AdminClient
          event={event}
          entries={entries}
          players={playersWithRoles}
          votes={voteRecords}
          announcements={announcements ?? []}
          counts={{ players: players.length, entries: entries.length, votes: voteRecords.length }}
          permissions={permissions}
          isSuperAdmin={isSuperAdmin}
          awards={awards ?? []}
          assignments={assignments ?? []}
          awardRules={awardRules}
          awardRanking={awardRanking}
          snapshots={snapshots ?? []}
          auditLogs={auditLogs ?? []}
        />
        {isSuperAdmin && <AdminRoleManager players={playersWithRoles} currentAdminId={user.id} />}
      </main>
    </>
  );
}
