import { redirect } from "next/navigation";
import SiteHeader from "@/app/components/SiteHeader";
import SiteFooter from "@/app/components/SiteFooter";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSuperAdminDiscordId } from "@/lib/admin-access";
import NotificationList from "./NotificationList";
import { canViewAnnouncement } from "@/lib/announcement-access";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const [{ data: profile }, { data: event }] = await Promise.all([
    admin.from("profiles").select("id,discord_id,nickname,is_disqualified").eq("id", user.id).maybeSingle(),
    admin.from("events").select("id").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!profile || !event) redirect("/");
  const [{ data: ownEntry }, { data: role }, { data: announcements }, { data: receipts }] = await Promise.all([
    admin.from("entries").select("id").eq("event_id", event.id).eq("owner_id", user.id).maybeSingle(),
    admin.from("admin_roles").select("is_active").eq("profile_id", user.id).maybeSingle(),
    admin.from("announcements").select("*").eq("event_id", event.id).eq("is_active", true).is("archived_at", null).or("expires_at.is.null,expires_at.gt.now()").order("is_pinned", { ascending: false }).order("published_at", { ascending: false }),
    admin.from("announcement_receipts").select("*").eq("profile_id", user.id),
  ]);
  const isAdmin = isSuperAdminDiscordId(profile.discord_id) || role?.is_active === true;
  const visible = (announcements ?? []).filter((announcement) => canViewAnnouncement(announcement, {
    profileId: user.id,
    isDisqualified: profile.is_disqualified === true,
    isAdmin,
    hasSubmission: Boolean(ownEntry),
  })).map((announcement) => {
    const receipt = receipts?.find((item) => item.announcement_id === announcement.id);
    return {
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      announcement_type: announcement.announcement_type,
      published_at: announcement.published_at,
      requires_ack: announcement.requires_ack,
      read: Boolean(receipt?.read_at),
      acknowledged: Boolean(receipt?.acknowledged_at),
    };
  });
  return (
    <>
      <SiteHeader nickname={profile.nickname} />
      <main className="inner">
        <header className="page-title"><small>NOTICES · 通知中心</small><h1>江湖傳書</h1><p>查看活動公告、個人通知與待確認事項。</p></header>
        <NotificationList notices={visible} />
      </main>
      <SiteFooter />
    </>
  );
}
