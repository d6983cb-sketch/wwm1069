import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdminDiscordId } from "@/lib/admin-access";
import { canViewAnnouncement } from "@/lib/announcement-access";

async function viewerContext(userId: string, eventId: string) {
  const admin = createAdminClient();
  const [{ data: profile }, { data: role }, { data: entry }] = await Promise.all([
    admin.from("profiles").select("id,discord_id,is_disqualified").eq("id", userId).maybeSingle(),
    admin.from("admin_roles").select("is_active").eq("profile_id", userId).maybeSingle(),
    admin.from("entries").select("id").eq("event_id", eventId).eq("owner_id", userId).limit(1).maybeSingle(),
  ]);
  if (!profile) return null;
  return {
    profileId: profile.id,
    isDisqualified: profile.is_disqualified === true,
    isAdmin: isSuperAdminDiscordId(profile.discord_id) || role?.is_active === true,
    hasSubmission: Boolean(entry),
  };
}

export async function GET() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: event } = await admin.from("events").select("id").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!event) return NextResponse.json({ unreadCount: 0 });
  const viewer = await viewerContext(user.id, event.id);
  if (!viewer) return NextResponse.json({ unreadCount: 0 });
  const [{ data: announcements }, { data: receipts }] = await Promise.all([
    admin.from("announcements").select("id,audience,target_profile_id").eq("event_id", event.id).eq("is_active", true).is("archived_at", null).or("expires_at.is.null,expires_at.gt.now()"),
    admin.from("announcement_receipts").select("announcement_id,read_at").eq("profile_id", user.id),
  ]);
  const read = new Set((receipts ?? []).filter((item) => item.read_at).map((item) => item.announcement_id));
  const unreadCount = (announcements ?? []).filter(
    (announcement) => canViewAnnouncement(announcement, viewer) && !read.has(announcement.id),
  ).length;
  return NextResponse.json({ unreadCount }, { headers: { "cache-control": "no-store" } });
}

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
    .select("id,event_id,audience,target_profile_id,requires_ack,is_active,expires_at,archived_at")
    .eq("id", announcementId)
    .maybeSingle();
  if (!announcement || !announcement.is_active || announcement.archived_at || (announcement.expires_at && Date.parse(announcement.expires_at) < Date.now())) {
    return NextResponse.json({ error: "announcement_not_found", message: "找不到公告。" }, { status: 404 });
  }
  const viewer = await viewerContext(user.id, announcement.event_id);
  if (!viewer || !canViewAnnouncement(announcement, viewer)) {
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
