import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isConfiguredAdmin } from "@/lib/admin-access";
import { hasValidTimeline } from "@/lib/types";

const eventDateFields = [
  "submission_starts_at",
  "submission_ends_at",
  "voting_starts_at",
  "voting_ends_at",
] as const;

function normalizeZonedDate(value: unknown) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function entryStoragePath(value: string) {
  if (!value.startsWith("http")) return value;
  try {
    const marker = "/storage/v1/object/public/cos-entries/";
    const pathname = new URL(value).pathname;
    const index = pathname.indexOf(marker);
    return index >= 0 ? decodeURIComponent(pathname.slice(index + marker.length)) : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: profile } = await admin.from("profiles").select("is_admin,discord_id").eq("id", user.id).single();
  const configuredAdmin = isConfiguredAdmin(profile?.discord_id);
  if (!profile?.is_admin && configuredAdmin) {
    await admin.from("profiles").update({ is_admin: true }).eq("id", user.id);
  }
  if (!profile?.is_admin && !configuredAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json();
  if (body.type === "entry_status") {
    const { error } = await admin.from("entries").update({ status: body.status }).eq("id", body.entryId);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 400 });
  } else if (body.type === "entry_delete") {
    const [{ data: entry }, { data: images }] = await Promise.all([
      admin.from("entries").select("original_image_path").eq("id", body.entryId).maybeSingle(),
      admin.from("entry_images").select("storage_path").eq("entry_id", body.entryId),
    ]);
    const { error } = await admin.from("entries").delete().eq("id", body.entryId);
    if (error) return NextResponse.json({ error: "delete_failed" }, { status: 400 });
    const paths = (images ?? []).map((image) => entryStoragePath(image.storage_path)).filter((path): path is string => Boolean(path));
    if (paths.length) await admin.storage.from("cos-entries").remove(paths);
    if (entry?.original_image_path) await admin.storage.from("cos-originals").remove([entry.original_image_path]);
  } else if (body.type === "event") {
    const allowed = ["title", "submission_starts_at", "submission_ends_at", "voting_starts_at", "voting_ends_at", "submissions_locked", "voting_locked", "voting_override", "leaderboard_mode"];
    const changes = Object.fromEntries(Object.entries(body.changes ?? {}).filter(([key]) => allowed.includes(key)));
    for (const field of eventDateFields) {
      if (!(field in changes)) continue;
      const normalized = normalizeZonedDate(changes[field]);
      if (!normalized) return NextResponse.json({ error: "invalid_event_time" }, { status: 400 });
      changes[field] = normalized;
    }
    if ("title" in changes) {
      changes.title = String(changes.title ?? "").trim();
      if (!changes.title) return NextResponse.json({ error: "invalid_event_title" }, { status: 400 });
    }
    if (eventDateFields.some((field) => field in changes)) {
      const { data: current } = await admin.from("events").select("*").eq("id", body.eventId).maybeSingle();
      if (!current || !hasValidTimeline({ ...current, ...changes })) return NextResponse.json({ error: "invalid_event_order" }, { status: 400 });
    }
    const { error } = await admin.from("events").update(changes).eq("id", body.eventId);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 400 });
  } else if (body.type === "event_create") {
    const submissionStarts = normalizeZonedDate(body.submissionStarts);
    const submissionEnds = normalizeZonedDate(body.submissionEnds);
    const votingStarts = normalizeZonedDate(body.votingStarts);
    const votingEnds = normalizeZonedDate(body.votingEnds);
    if (!submissionStarts || !submissionEnds || !votingStarts || !votingEnds) return NextResponse.json({ error: "invalid_event_time" }, { status: 400 });
    const title = String(body.title ?? "").trim();
    if (!title || !hasValidTimeline({ submission_starts_at: submissionStarts, submission_ends_at: submissionEnds, voting_starts_at: votingStarts, voting_ends_at: votingEnds })) {
      return NextResponse.json({ error: "invalid_event_order" }, { status: 400 });
    }
    const { error } = await admin.from("events").insert({ title, submission_starts_at: submissionStarts, submission_ends_at: submissionEnds, voting_starts_at: votingStarts, voting_ends_at: votingEnds, leaderboard_mode: "hidden" });
    if (error) return NextResponse.json({ error: "create_failed" }, { status: 400 });
  } else if (body.type === "announcement") {
    const announcement = String(body.body ?? "").trim();
    if (!announcement || announcement.length > 1000) return NextResponse.json({ error: "invalid_announcement" }, { status: 400 });
    const { error } = await admin.from("announcements").insert({ event_id: body.eventId, body: announcement });
    if (error) return NextResponse.json({ error: "announcement_failed" }, { status: 400 });
  } else if (body.type === "player_disqualify") {
    const disqualified = Boolean(body.disqualified);
    const { error } = await admin.from("profiles").update({ is_disqualified: disqualified }).eq("id", body.playerId);
    if (error) return NextResponse.json({ error: "player_update_failed" }, { status: 400 });
    const entryUpdate = disqualified
      ? admin.from("entries").update({ status: "disqualified" }).eq("owner_id", body.playerId)
      : admin.from("entries").update({ status: "approved" }).eq("owner_id", body.playerId).eq("status", "disqualified");
    const { error: entryError } = await entryUpdate;
    if (entryError) return NextResponse.json({ error: "entry_update_failed" }, { status: 400 });
  } else if (body.type === "player_admin") {
    const targetId = String(body.playerId ?? "");
    const makeAdmin = Boolean(body.isAdmin);
    if (!targetId) return NextResponse.json({ error: "invalid_player" }, { status: 400 });
    if (targetId === user.id && !makeAdmin) return NextResponse.json({ error: "cannot_remove_self" }, { status: 400 });
    const { data: target } = await admin.from("profiles").select("discord_id,is_admin").eq("id", targetId).maybeSingle();
    if (!target) return NextResponse.json({ error: "player_not_found" }, { status: 404 });
    if (!makeAdmin && isConfiguredAdmin(target.discord_id)) return NextResponse.json({ error: "protected_admin" }, { status: 400 });
    const { error } = await admin.from("profiles").update({ is_admin: makeAdmin }).eq("id", targetId);
    if (error) return NextResponse.json({ error: "player_admin_update_failed" }, { status: 400 });
  } else {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
