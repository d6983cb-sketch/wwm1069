import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { entryId, action } = await request.json();
  const { data: entry } = await admin.from("entries").select("id,event_id,status").eq("id", entryId).single();
  if (!entry || entry.status !== "approved") return NextResponse.json({ error: "entry_unavailable" }, { status: 404 });
  const { data: event } = await admin.from("events").select("*").eq("id", entry.event_id).single();
  const now = Date.now();
  if (!event || event.voting_locked || now < Date.parse(event.voting_starts_at) || now > Date.parse(event.voting_ends_at)) {
    return NextResponse.json({ error: "voting_closed" }, { status: 400 });
  }
  const result = action === "remove"
    ? await supabase.from("votes").delete().eq("entry_id", entry.id).eq("voter_id", user.id)
    : await supabase.from("votes").insert({ event_id: entry.event_id, entry_id: entry.id, voter_id: user.id });
  if (result.error) {
    const code = result.error.message.includes("vote_limit_reached") ? "vote_limit_reached" : "vote_failed";
    return NextResponse.json({ error: code }, { status: 400 });
  }
  const { count } = await supabase.from("votes").select("*", { count: "exact", head: true }).eq("event_id", entry.event_id).eq("voter_id", user.id);
  return NextResponse.json({ ok: true, used: count ?? 0 });
}
