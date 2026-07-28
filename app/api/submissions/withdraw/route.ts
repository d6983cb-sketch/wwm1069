import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

async function actor() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await admin
    .from("profiles")
    .select("id,discord_id,nickname")
    .eq("id", user.id)
    .maybeSingle();
  return profile ? { user, profile, admin } : null;
}

export async function GET() {
  const current = await actor();
  if (!current) return NextResponse.json({ error: "unauthorized", message: "請先登入。" }, { status: 401 });
  const { data: event } = await current.admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!event) return NextResponse.json({ entry: null });
  const { data: entry } = await current.admin
    .from("entries")
    .select("id,entry_code,event_id,owner_id,character_name,source_game,description,uses_ai_background,original_image_path,status,created_at,withdrawn_at")
    .eq("event_id", event.id)
    .eq("owner_id", current.user.id)
    .maybeSingle();
  if (!entry) return NextResponse.json({ entry: null, eventStatus: event.status });
  const { data: images } = await current.admin
    .from("entry_images")
    .select("storage_path,position")
    .eq("entry_id", entry.id)
    .order("position");
  return NextResponse.json({
    entry: {
      ...entry,
      images: images ?? [],
      originalUploaded: Boolean(entry.original_image_path),
    },
    eventStatus: event.status,
  });
}

export async function POST(request: Request) {
  const current = await actor();
  if (!current) return NextResponse.json({ error: "unauthorized", message: "請先登入。" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const entryId = Number(body.entryId);
  const restore = body.action === "restore";
  if (!Number.isInteger(entryId)) {
    return NextResponse.json({ error: "invalid_entry", message: "投稿編號不正確。" }, { status: 400 });
  }
  const [{ data: event }, { data: before }] = await Promise.all([
    current.admin.from("events").select("id,status").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    current.admin.from("entries").select("id,entry_code,event_id,owner_id,withdrawn_at,withdrawal_reason").eq("id", entryId).eq("owner_id", current.user.id).maybeSingle(),
  ]);
  if (!before || !event || before.event_id !== event.id) {
    return NextResponse.json({ error: "entry_not_found", message: "找不到你的投稿。" }, { status: 404 });
  }
  if (event.status !== "submission_open") {
    return NextResponse.json({ error: "invalid_event_state", message: "只有投稿開放期間可以撤回或復原。" }, { status: 422 });
  }
  if (restore && !before.withdrawn_at) {
    return NextResponse.json({ ok: true, repeated: true });
  }
  if (!restore && before.withdrawn_at) {
    return NextResponse.json({ ok: true, repeated: true });
  }
  const changes = restore
    ? { withdrawn_at: null, withdrawn_by: null, withdrawal_reason: null }
    : {
      withdrawn_at: new Date().toISOString(),
      withdrawn_by: current.user.id,
      withdrawal_reason: String(body.reason ?? "投稿者自行撤回").trim().slice(0, 500),
    };
  const { data: after, error } = await current.admin
    .from("entries")
    .update(changes)
    .eq("id", entryId)
    .eq("owner_id", current.user.id)
    .select("id,entry_code,event_id,owner_id,withdrawn_at,withdrawal_reason")
    .single();
  if (error) {
    return NextResponse.json({ error: "withdrawal_failed", message: "投稿狀態更新失敗。" }, { status: 500 });
  }
  await current.admin.from("audit_logs").insert({
    actor_profile_id: current.profile.id,
    actor_discord_id: current.profile.discord_id,
    actor_nickname: current.profile.nickname,
    action_type: restore ? "entry_restore" : "entry_withdraw",
    target_type: "entry",
    target_id: String(entryId),
    before_data: before,
    after_data: after,
    request_id: request.headers.get("x-request-id")?.slice(0, 120) || crypto.randomUUID(),
  });
  return NextResponse.json({ ok: true, entry: after });
}

