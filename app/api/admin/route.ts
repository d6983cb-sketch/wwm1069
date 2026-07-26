import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!profile?.is_admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await request.json();
  if (body.type === "entry_status") {
    const { error } = await admin.from("entries").update({ status: body.status }).eq("id", body.entryId);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 400 });
  } else if (body.type === "entry_delete") {
    const { error } = await admin.from("entries").delete().eq("id", body.entryId);
    if (error) return NextResponse.json({ error: "delete_failed" }, { status: 400 });
  } else if (body.type === "event") {
    const allowed = [
      "title",
      "submission_starts_at",
      "submission_ends_at",
      "voting_starts_at",
      "voting_ends_at",
      "submissions_locked",
      "voting_locked",
      "voting_override",
      "leaderboard_mode",
    ];
    const changes = Object.fromEntries(Object.entries(body.changes ?? {}).filter(([key]) => allowed.includes(key)));
    for (const field of eventDateFields) {
      if (!(field in changes)) continue;
      const normalized = normalizeZonedDate(changes[field]);
      if (!normalized) return NextResponse.json({ error: "invalid_event_time" }, { status: 400 });
      changes[field] = normalized;
    }
    const { error } = await admin.from("events").update(changes).eq("id", body.eventId);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 400 });
  } else if (body.type === "event_create") {
    const submissionStarts = normalizeZonedDate(body.submissionStarts);
    const submissionEnds = normalizeZonedDate(body.submissionEnds);
    const votingStarts = normalizeZonedDate(body.votingStarts);
    const votingEnds = normalizeZonedDate(body.votingEnds);
    if (!submissionStarts || !submissionEnds || !votingStarts || !votingEnds) {
      return NextResponse.json({ error: "invalid_event_time" }, { status: 400 });
    }
    const { error } = await admin.from("events").insert({
      title: body.title,
      submission_starts_at: submissionStarts,
      submission_ends_at: submissionEnds,
      voting_starts_at: votingStarts,
      voting_ends_at: votingEnds,
      leaderboard_mode: "hidden",
    });
    if (error) return NextResponse.json({ error: "create_failed" }, { status: 400 });
  } else if (body.type === "announcement") {
    const { error } = await admin.from("announcements").insert({
      event_id: body.eventId,
      body: body.body,
    });
    if (error) return NextResponse.json({ error: "announcement_failed" }, { status: 400 });
  } else if (body.type === "player_disqualify") {
    const disqualified = Boolean(body.disqualified);
    const { error } = await admin.from("profiles").update({ is_disqualified: disqualified }).eq("id", body.playerId);
    if (error) return NextResponse.json({ error: "player_update_failed" }, { status: 400 });
    if (disqualified) {
      const { error: entryError } = await admin.from("entries").update({ status: "disqualified" }).eq("owner_id", body.playerId);
      if (entryError) return NextResponse.json({ error: "entry_update_failed" }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
