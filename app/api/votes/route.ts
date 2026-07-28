import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isVotingOpen } from "@/lib/types";

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { entryId, action } = await request.json();
  if (!Number.isInteger(entryId) || !["add", "remove"].includes(action)) {
    return NextResponse.json({ error: "invalid_vote" }, { status: 400 });
  }
  const { data: voter } = await admin.from("profiles").select("is_disqualified").eq("id", user.id).maybeSingle();
  if (!voter || voter.is_disqualified) {
    return NextResponse.json({ error: "voter_unavailable" }, { status: 403 });
  }
  const { data: entry } = await admin.from("entries").select("id,event_id,status,withdrawn_at").eq("id", entryId).single();
  if (!entry || entry.status !== "approved" || entry.withdrawn_at) return NextResponse.json({ error: "entry_unavailable" }, { status: 404 });
  const { data: event } = await admin.from("events").select("*").eq("id", entry.event_id).single();
  if (!isVotingOpen(event)) {
    return NextResponse.json({ error: "voting_closed", message: "目前活動狀態不允許新增或取消投票。" }, { status: 422 });
  }
  const result = action === "remove"
    ? await admin.from("votes").delete().eq("entry_id", entry.id).eq("voter_id", user.id)
    : await admin.from("votes").insert({ event_id: entry.event_id, entry_id: entry.id, voter_id: user.id });
  if (result.error) {
    const code = result.error.message.includes("vote_limit_reached")
      ? "vote_limit_reached"
      : result.error.code === "23505" ? "duplicate_vote" : "vote_failed";
    return NextResponse.json({ error: code }, { status: 400 });
  }
  const { count } = await admin.from("votes").select("*", { count: "exact", head: true }).eq("event_id", entry.event_id).eq("voter_id", user.id);
  return NextResponse.json({ ok: true, used: count ?? 0 });
}
