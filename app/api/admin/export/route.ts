import { NextResponse } from "next/server";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(headers: string[], rows: unknown[][]) {
  return "\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "";
  const superOnly = kind === "vote_details";
  const permission = kind === "audit" ? "audit_viewer" : "report_viewer";
  const auth = await authorizeAdmin(request, permission, superOnly);
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const { data: event } = await admin.from("events").select("id").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!event) return NextResponse.json({ error: "event_not_found", message: "找不到活動。" }, { status: 404 });

  let headers: string[] = [];
  let rows: unknown[][] = [];
  const filename = `${kind}.csv`;

  if (kind === "players") {
    const { data } = await admin.from("profiles").select("id,discord_id,nickname,is_admin,is_disqualified,created_at").order("created_at");
    headers = ["Profile ID", "Discord ID", "活動暱稱", "管理員", "取消資格", "加入時間"];
    rows = (data ?? []).map((item) => [item.id, item.discord_id, item.nickname, item.is_admin, item.is_disqualified, item.created_at]);
  } else if (kind === "entries") {
    const [{ data }, { data: profiles }] = await Promise.all([
      admin.from("entries").select("id,entry_code,owner_id,character_name,source_game,status,withdrawn_at,created_at").eq("event_id", event.id).order("created_at"),
      admin.from("profiles").select("id,discord_id,nickname"),
    ]);
    headers = ["投稿 ID", "作品編號", "Profile ID", "Discord ID", "投稿者", "角色", "來源遊戲", "狀態", "撤回時間", "投稿時間"];
    rows = (data ?? []).map((item) => {
      const owner = profiles?.find((profile) => profile.id === item.owner_id);
      return [item.id, item.entry_code, item.owner_id, owner?.discord_id, owner?.nickname, item.character_name, item.source_game, item.status, item.withdrawn_at, item.created_at];
    });
  } else if (kind === "vote_stats" || kind === "leaderboard") {
    const [{ data: entries }, { data: votes }, { data: profiles }] = await Promise.all([
      admin.from("entries").select("id,entry_code,owner_id,character_name,source_game,created_at").eq("event_id", event.id),
      admin.from("votes").select("entry_id").eq("event_id", event.id),
      admin.from("profiles").select("id,nickname"),
    ]);
    const ranked = (entries ?? []).map((entry) => ({
      ...entry,
      nickname: profiles?.find((profile) => profile.id === entry.owner_id)?.nickname ?? "",
      count: votes?.filter((vote) => vote.entry_id === entry.id).length ?? 0,
    })).sort((a, b) => b.count - a.count || Date.parse(a.created_at) - Date.parse(b.created_at));
    headers = ["名次", "投稿 ID", "作品編號", "投稿者", "角色", "來源遊戲", "票數"];
    rows = ranked.map((entry, index) => [index + 1, entry.id, entry.entry_code, entry.nickname, entry.character_name, entry.source_game, entry.count]);
  } else if (kind === "vote_details") {
    const { data } = await admin.from("votes").select("id,event_id,entry_id,voter_id,created_at").eq("event_id", event.id).order("id");
    headers = ["投票 ID", "活動 ID", "投稿 ID", "投票者 Profile ID", "投票時間"];
    rows = (data ?? []).map((item) => [item.id, item.event_id, item.entry_id, item.voter_id, item.created_at]);
  } else if (kind === "awards" || kind === "award_settings") {
    const [{ data: awards }, { data: assignments }] = await Promise.all([
      admin.from("awards").select("*").eq("event_id", event.id).order("sort_order"),
      admin.from("award_assignments").select("*"),
    ]);
    headers = ["獎項 ID", "名稱", "說明", "類型", "順序", "啟用", "封存", "得獎投稿 ID"];
    rows = (awards ?? []).map((award) => [award.id, award.name, award.description, award.award_type, award.sort_order, award.is_active, award.is_archived, assignments?.find((item) => item.award_id === award.id)?.submission_id]);
  } else if (kind === "audit") {
    const { data } = await admin.from("audit_logs").select("*").order("created_at", { ascending: false });
    headers = ["ID", "操作者 Discord ID", "操作者暱稱", "操作", "對象類型", "對象 ID", "結果", "失敗原因", "時間", "Request ID"];
    rows = (data ?? []).map((item) => [item.id, item.actor_discord_id, item.actor_nickname, item.action_type, item.target_type, item.target_id, item.result, item.failure_reason, item.created_at, item.request_id]);
  } else if (kind === "announcements") {
    const { data } = await admin.from("announcements").select("*").eq("event_id", event.id).order("published_at");
    headers = ["ID", "標題", "內容", "類型", "對象", "指定玩家", "置頂", "啟用", "需確認", "發布時間", "到期時間"];
    rows = (data ?? []).map((item) => [item.id, item.title, item.body, item.announcement_type, item.audience, item.target_profile_id, item.is_pinned, item.is_active, item.requires_ack, item.published_at, item.expires_at]);
  } else {
    return NextResponse.json({ error: "invalid_export", message: "不支援的匯出項目。" }, { status: 400 });
  }

  await writeAuditLog({
    context: auth.context,
    actionType: "csv_export",
    targetType: "report",
    targetId: kind,
    afterData: { rowCount: rows.length },
  });
  return new NextResponse(csv(headers, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
