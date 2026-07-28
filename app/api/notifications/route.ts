import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized", message: "請先登入。" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const announcementId = Number(body.announcementId);
  if (!Number.isInteger(announcementId)) {
    return NextResponse.json({ error: "invalid_announcement", message: "公告編號不正確。" }, { status: 400 });
  }
  const { data: announcement } = await admin
    .from("announcements")
    .select("id,audience,target_profile_id,requires_ack,is_active,expires_at")
    .eq("id", announcementId)
    .maybeSingle();
  if (!announcement || !announcement.is_active || (announcement.expires_at && Date.parse(announcement.expires_at) < Date.now())) {
    return NextResponse.json({ error: "announcement_not_found", message: "找不到公告。" }, { status: 404 });
  }
  if (announcement.audience === "player" && announcement.target_profile_id !== user.id) {
    return NextResponse.json({ error: "forbidden", message: "你無法查看這則通知。" }, { status: 403 });
  }
  const now = new Date().toISOString();
  const payload = {
    announcement_id: announcementId,
    profile_id: user.id,
    read_at: now,
    acknowledged_at: body.acknowledge === true && announcement.requires_ack ? now : null,
  };
  const { error } = await admin
    .from("announcement_receipts")
    .upsert(payload, { onConflict: "announcement_id,profile_id" });
  if (error) return NextResponse.json({ error: "receipt_failed", message: "狀態更新失敗。" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

