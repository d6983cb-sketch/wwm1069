"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import ImageCropEditor from "@/app/components/ImageCropEditor";
import SubmissionImage from "@/app/components/SubmissionImage";
import { normalizeSubmissionImage, type EventRecord, type SubmissionImageRecord } from "@/lib/types";
import type { AdminPermissions } from "@/lib/admin-access";
import { taipeiInputToIso, toTaipeiInput } from "@/lib/taipei-datetime";
import type { SubmissionEditGrant } from "@/lib/submission-corrections";

type AdminTab = "overview" | "entries" | "votes" | "players" | "settings" | "announcements" | "awards" | "backups" | "audit";
type PendingEntry = {
  id: number;
  entry_code: string | null;
  event_id: string;
  character_name: string;
  source_game: string;
  created_at: string;
  nickname: string;
  uses_ai_background: boolean;
  original_image_path: string | null;
  status: string;
  withdrawn_at: string | null;
  images: SubmissionImageRecord[];
  correction_grant: SubmissionEditGrant | null;
  revision_count: number;
};
type AdminPlayer = {
  id: string;
  discord_id: string;
  nickname: string;
  is_admin: boolean;
  is_disqualified: boolean;
  admin_note?: string | null;
  admin_role?: { permissions: AdminPermissions; is_active: boolean } | null;
  created_at: string;
};
type VoteRecord = {
  id: number;
  entry_id: number;
  created_at: string;
  voter_nickname: string;
  character_name: string;
};
type AnnouncementRecord = {
  id: number;
  title: string | null;
  body: string;
  published_at: string;
  is_active: boolean;
  announcement_type: string;
  audience: string;
  target_profile_id: string | null;
  requires_ack: boolean;
  is_pinned: boolean;
  expires_at: string | null;
};
type AwardRecord = {
  id: string;
  name: string;
  description: string | null;
  award_type: string;
  ranking_position: number | null;
  sort_order: number;
  is_active: boolean;
  is_archived: boolean;
};
type AssignmentRecord = { id: string; award_id: string; submission_id: number };
type AwardRankingRecord = {
  entryId: number;
  entryCode: string;
  characterName: string;
  nickname: string;
  rank: number;
  votes: number;
  reachedAt: string | null;
  hasEqualVotes: boolean;
};
type SnapshotRecord = { id: string; created_at: string; created_by: string | null };
type AuditRecord = {
  id: number;
  actor_discord_id: string | null;
  actor_nickname: string | null;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  failure_reason: string | null;
  created_at: string;
};

const tabs: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "總覽" },
  { id: "entries", label: "投稿管理" },
  { id: "votes", label: "投票紀錄" },
  { id: "players", label: "玩家管理" },
  { id: "settings", label: "活動設定" },
  { id: "announcements", label: "公告管理" },
  { id: "awards", label: "獎項管理" },
  { id: "backups", label: "備份與匯出" },
  { id: "audit", label: "操作紀錄" },
];

const statusText: Record<string, string> = {
  pending: "待審核",
  approved: "已通過",
  rejected: "已拒絕",
  disqualified: "已取消資格",
};

function readTaipeiDate(form: FormData, name: string) {
  return taipeiInputToIso(String(form.get(name) ?? ""));
}

export default function AdminClient({
  event,
  entries,
  players,
  votes,
  announcements,
  counts,
  permissions,
  isSuperAdmin,
  awards,
  assignments,
  awardRules,
  awardRanking,
  snapshots,
  auditLogs,
}: {
  event: EventRecord | null;
  entries: PendingEntry[];
  players: AdminPlayer[];
  votes: VoteRecord[];
  announcements: AnnouncementRecord[];
  counts: { players: number; entries: number; votes: number };
  permissions: AdminPermissions;
  isSuperAdmin: boolean;
  awards: AwardRecord[];
  assignments: AssignmentRecord[];
  awardRules: Record<string, unknown> | null;
  awardRanking: AwardRankingRecord[];
  snapshots: SnapshotRecord[];
  auditLogs: AuditRecord[];
}) {
  const [activeTab, setActiveTab] = useState<AdminTab>(event ? "overview" : "settings");
  const [message, setMessage] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<AdminPlayer | null>(null);
  const [selectedAwardEntry, setSelectedAwardEntry] = useState<Record<string, string>>({});
  const [selectedAwardRank, setSelectedAwardRank] = useState<Record<string, string>>({});
  const [editingCropEntry, setEditingCropEntry] = useState<PendingEntry | null>(null);
  const [adminCropImages, setAdminCropImages] = useState<SubmissionImageRecord[]>([]);
  const [grantingEntry, setGrantingEntry] = useState<PendingEntry | null>(null);
  const [renderedAt] = useState(() => Date.now());
  const can = (permission: keyof AdminPermissions) => isSuperAdmin || permissions[permission] === true;
  const visibleTabs = useMemo(() => tabs.filter((tab) => {
    const allowed = (permission: keyof AdminPermissions) => isSuperAdmin || permissions[permission] === true;
    if (tab.id === "entries") return allowed("submission_viewer") || allowed("submission_manager");
    if (tab.id === "votes") return allowed("statistics_viewer") || allowed("report_viewer");
    if (tab.id === "players") return allowed("player_manager") || allowed("eligibility_manager") || isSuperAdmin;
    if (tab.id === "settings") return allowed("event_manager");
    if (tab.id === "announcements") return allowed("announcement_manager");
    if (tab.id === "awards") return allowed("award_manager") || allowed("award_assigner");
    if (tab.id === "backups") return allowed("report_viewer");
    if (tab.id === "audit") return allowed("audit_viewer");
    return true;
  }), [isSuperAdmin, permissions]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const hash = location.hash.replace("#", "") as AdminTab;
      if (visibleTabs.some((tab) => tab.id === hash)) setActiveTab(hash);
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleTabs]);

  const selectTab = (tab: AdminTab) => {
    setActiveTab(tab);
    history.replaceState(null, "", `#${tab}`);
  };

  const action = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey: crypto.randomUUID() }),
      });
      const body = await response.json().catch(() => ({}));
      if (
        response.status === 409
        && body.error === "award_conflict"
        && Array.isArray(body.conflicts)
        && confirm(`此指派有規則衝突：\n\n${body.conflicts.join("\n")}\n\n仍要由管理員確認指派嗎？`)
      ) {
        return action({ ...payload, confirmConflict: true });
      }
      const errors: Record<string, string> = {
        invalid_event_order: "時間順序不正確：投稿開始 ＜ 投稿截止 ≤ 投票開始 ＜ 投票截止。",
        invalid_event_time: "日期或時間格式不正確。",
        invalid_announcement: "公告不可只有空白，且最多 1000 字。",
      };
      setMessage(response.ok ? body.message ?? "設定已儲存。" : body.message ?? errors[body.error] ?? "操作失敗，請稍後重試。");
      if (response.ok) setTimeout(() => location.reload(), 500);
      return response.ok;
    } catch {
      setMessage("網路連線失敗，資料尚未變更，請稍後重試。");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createEvent = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
    await action({
      type: "event_create",
      title: form.get("title"),
      submissionStarts: readTaipeiDate(form, "submission_starts"),
      submissionEnds: readTaipeiDate(form, "submission_ends"),
      votingStarts: readTaipeiDate(form, "voting_starts"),
      votingEnds: readTaipeiDate(form, "voting_ends"),
    });
  };

  const updateEvent = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!event) return;
    const form = new FormData(formEvent.currentTarget);
    const nextStatus = String(form.get("status") ?? "auto");
    const privacyChanged =
      form.get("submission_identity_mode") !== (event.submission_identity_mode ?? "named")
      || form.get("voting_identity_mode") !== (event.voting_identity_mode ?? "named")
      || (form.get("reveal_authors_after_results") === "on") !== (event.reveal_authors_after_results !== false);
    if (["voting_closed", "archived"].includes(nextStatus) || privacyChanged) {
      if (!confirm(`即將儲存活動狀態「${nextStatus}」及顯示設定。這會立即影響玩家可執行的操作與作者顯示。`)) return;
      if (prompt("請輸入「確認切換」以繼續") !== "確認切換") return;
    }
    await action({
      type: "event",
      eventId: event.id,
      changes: {
        title: form.get("title"),
        submission_starts_at: readTaipeiDate(form, "submission_starts"),
        submission_ends_at: readTaipeiDate(form, "submission_ends"),
        voting_starts_at: readTaipeiDate(form, "voting_starts"),
        voting_ends_at: readTaipeiDate(form, "voting_ends"),
        submissions_locked: form.get("submissions_locked") === "on",
        voting_locked: form.get("voting_locked") === "on",
        voting_override: form.get("voting_override"),
        leaderboard_mode: form.get("leaderboard_mode"),
        status: nextStatus === "auto" ? null : nextStatus,
        submission_identity_mode: form.get("submission_identity_mode"),
        voting_identity_mode: form.get("voting_identity_mode"),
        reveal_authors_after_results: form.get("reveal_authors_after_results") === "on",
        allow_admin_crop_after_submission: form.get("allow_admin_crop_after_submission") === "on",
      },
    });
  };

  const openCropEditor = (entry: PendingEntry) => {
    setEditingCropEntry(entry);
    setAdminCropImages(entry.images.map(normalizeSubmissionImage));
    setMessage("");
  };

  const saveAdminCrops = async () => {
    if (!editingCropEntry) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/submissions/images/crop", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({
          entryId: editingCropEntry.id,
          images: adminCropImages.map(({ id, crop_x, crop_y, zoom, rotation }) => ({
            imageId: id, cropX: crop_x, cropY: crop_y, zoom, rotation,
          })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? "圖片展示位置已儲存。" : "圖片位置儲存失敗。"));
      if (response.ok) {
        setEditingCropEntry(null);
        setTimeout(() => location.reload(), 500);
      }
    } finally {
      setBusy(false);
    }
  };

  const regenerateDisplay = async (entry: PendingEntry) => {
    if (!confirm(`重新產生作品 ${entry.entry_code ?? `#${entry.id}`} 的展示快取？原圖、投稿與票數都不會改變。`)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/submissions/images/crop", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({ entryId: entry.id }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? "展示快取已重新產生。" : "操作失敗。"));
    } finally {
      setBusy(false);
    }
  };

  const permanentlyDeleteEntry = async (entry: PendingEntry) => {
    const entryLabel = entry.entry_code ?? `#${entry.id}`;
    if (!confirm(
      `即將永久刪除作品 ${entryLabel}（${entry.character_name}）。\n\n`
      + "投稿、作品圖片、查核原圖、相關投票與得獎指派都會永久刪除，且無法復原。",
    )) return;
    const confirmation = prompt(`請輸入「永久刪除 ${entryLabel}」以繼續`);
    if (confirmation !== `永久刪除 ${entryLabel}`) {
      setMessage("確認文字不正確，作品未刪除。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/entries/${entry.id}`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          confirmation,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? "作品已永久刪除。" : "永久刪除失敗。"));
      if (response.ok) setTimeout(() => location.reload(), 700);
    } catch {
      setMessage("網路連線失敗，請重新整理後確認作品是否仍存在。");
    } finally {
      setBusy(false);
    }
  };

  const createCorrectionGrant = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!grantingEntry) return;
    const form = new FormData(formEvent.currentTarget);
    const allowedPositions = form.getAll("allowed_position").map(Number);
    if (!allowedPositions.length) {
      setMessage("請至少選擇一張允許替換的圖片。");
      return;
    }
    if (!confirm(
      `確定開放玩家「${grantingEntry.nickname}」修正作品 ${grantingEntry.entry_code ?? `#${grantingEntry.id}`} 的第 ${allowedPositions.join("、")} 張圖片？`,
    )) return;
    const ok = await action({
      type: "entry_edit_grant_create",
      entryId: grantingEntry.id,
      allowedPositions,
      expiresAt: readTaipeiDate(form, "expires_at"),
      reason: form.get("reason"),
    });
    if (ok) setGrantingEntry(null);
  };

  const revokeCorrectionGrant = async (entry: PendingEntry) => {
    if (!entry.correction_grant) return;
    const label = entry.entry_code ?? `#${entry.id}`;
    if (!confirm(`確定撤銷玩家「${entry.nickname}」對作品 ${label} 的圖片修正權限？已完成的修訂不會自動消失。`)) return;
    if (prompt("請輸入「確認撤銷」以繼續") !== "確認撤銷") {
      setMessage("確認文字不正確，權限未撤銷。");
      return;
    }
    await action({
      type: "entry_edit_grant_revoke",
      grantId: entry.correction_grant.id,
    });
  };

  const announce = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!event) return;
    const form = new FormData(formEvent.currentTarget);
    await action({
      type: "announcement",
      eventId: event.id,
      title: form.get("title"),
      body: form.get("body"),
      announcementType: form.get("announcement_type"),
      audience: form.get("audience"),
      targetProfileId: form.get("target_profile_id"),
      isPinned: form.get("is_pinned") === "on",
      requiresAck: form.get("requires_ack") === "on",
      expiresAt: form.get("expires_at") ? readTaipeiDate(form, "expires_at") : null,
    });
  };

  const savePlayer = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!editingPlayer) return;
    const form = new FormData(formEvent.currentTarget);
    const ok = await action({
      type: "player_update",
      playerId: editingPlayer.id,
      nickname: form.get("nickname"),
      note: form.get("note"),
    });
    if (ok) setEditingPlayer(null);
  };

  const downloadCsv = (filename: string, header: string[], rows: Array<Array<string | number | boolean>>) => {
    const escape = (cell: string | number | boolean) => `"${String(cell).replaceAll('"', '""')}"`;
    const csv = [header, ...rows].map((row) => row.map(escape).join(",")).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportEntries = () => downloadCsv(
    "cos-entries.csv",
    ["投稿ID", "角色名稱", "來源遊戲", "投稿者", "投稿時間", "狀態"],
    entries.map((entry) => [entry.id, entry.character_name, entry.source_game, entry.nickname, entry.created_at, statusText[entry.status] ?? entry.status]),
  );
  const exportPlayers = () => downloadCsv(
    "cos-players.csv",
    ["Discord ID", "活動暱稱", "管理員", "取消資格", "加入時間"],
    players.map((player) => [player.discord_id, player.nickname, player.is_admin, player.is_disqualified, player.created_at]),
  );
  const exportVotes = () => downloadCsv(
    "cos-votes.csv",
    ["投票ID", "投稿ID", "投票者", "角色名稱", "投票時間"],
    votes.map((vote) => [vote.id, vote.entry_id, vote.voter_nickname, vote.character_name, vote.created_at]),
  );

  const filteredPlayers = useMemo(() => {
    const query = playerQuery.trim().toLocaleLowerCase();
    if (!query) return players;
    return players.filter(
      (player) =>
        player.nickname.toLocaleLowerCase().includes(query) ||
        player.discord_id.toLocaleLowerCase().includes(query),
    );
  }, [playerQuery, players]);

  const sidebar = (
    <aside aria-label="管理功能">
      <b>百相後台 <i>管</i></b>
      {visibleTabs.map((tab) => (
        <button
          type="button"
          className={activeTab === tab.id ? "on" : ""}
          aria-current={activeTab === tab.id ? "page" : undefined}
          onClick={() => selectTab(tab.id)}
          key={tab.id}
        >
          {tab.label}
        </button>
      ))}
    </aside>
  );

  const createEventPanel = (
    <section className="admin-content">
      <header className="page-title">
        <small>ADMIN CONSOLE</small>
        <h1>建立第一場活動</h1>
        <p>設定投稿及投票時間後，網站會自動依時間切換活動階段。</p>
      </header>
      <form className="event-form" onSubmit={createEvent}>
        <label>活動名稱<input name="title" required /></label>
        <label>投稿開始（台北時間）<input name="submission_starts" type="datetime-local" required /></label>
        <label>投稿截止（台北時間）<input name="submission_ends" type="datetime-local" required /></label>
        <label>投票開始（台北時間）<input name="voting_starts" type="datetime-local" required /></label>
        <label>投票截止（台北時間）<input name="voting_ends" type="datetime-local" required /></label>
        <button className="primary" disabled={busy}>建立活動</button>
      </form>
      {message && <p className="form-error">{message}</p>}
    </section>
  );

  if (!event) return <>{sidebar}{createEventPanel}</>;

  return (
    <>
      {sidebar}
      <section className="admin-content">
        {activeTab === "overview" && (
          <>
            <header className="admin-heading">
              <div><small>ADMIN CONSOLE</small><h1>活動總覽</h1></div>
              <div className="csv-actions">
                <button onClick={exportEntries}>⇩ 投稿 CSV</button>
                <button onClick={exportPlayers}>⇩ 玩家 CSV</button>
                <button onClick={exportVotes}>⇩ 投票 CSV</button>
              </div>
            </header>
            <div className="stats">
              <article><b>{counts.players}</b><span>已登入玩家</span></article>
              <article><b>{counts.entries}</b><span>總投稿</span></article>
              <article><b>{counts.votes}</b><span>總投票數</span></article>
              <article><b>{event.leaderboard_mode === "hidden" ? "隱藏" : "公開"}</b><span>排行榜</span></article>
            </div>
            <div className="panels">
              <article><h2>活動控制</h2>
                <label><span><b>鎖定投稿</b><small>鎖定後不接受新投稿</small></span><input type="checkbox" checked={event.submissions_locked} disabled={busy} onChange={(e) => action({ type: "event", eventId: event.id, changes: { submissions_locked: e.target.checked } })} /></label>
                <label><span><b>投票權限</b><small>可依時間自動切換或立即開放</small></span>
                  <select value={event.voting_override ?? "auto"} disabled={busy} onChange={(e) => action({ type: "event", eventId: event.id, changes: { voting_override: e.target.value } })}>
                    <option value="auto">依排程</option><option value="open">立即開放</option><option value="closed">暫停投票</option>
                  </select>
                </label>
                <label><span><b>公開排行榜</b><small>公開票數及前三名</small></span><input type="checkbox" checked={event.leaderboard_mode !== "hidden"} disabled={busy} onChange={(e) => action({ type: "event", eventId: event.id, changes: { leaderboard_mode: e.target.checked ? "final" : "hidden" } })} /></label>
              </article>
              <article><h2>最新公告</h2>
                <p className="announcement-preview">{announcements[0]?.body ?? "目前沒有公告。"}</p>
                <button type="button" className="section-link" onClick={() => selectTab("announcements")}>前往公告管理</button>
              </article>
            </div>
            <article className="table"><h2>投稿概況</h2><p className="muted">新投稿會自動通過並顯示於作品展廳；管理員仍可查看、取消資格或復原撤回，正式資料不會被硬刪除。</p></article>
          </>
        )}

        {activeTab === "entries" && (
          <>
            <header className="admin-heading"><div><small>ENTRIES</small><h1>投稿管理</h1></div><button onClick={exportEntries}>⇩ 投稿 CSV</button></header>
            <article className="table admin-table">
              {entries.length ? entries.map((entry) => (
                <div key={entry.id}>
                  <b>{entry.entry_code ?? `#${entry.id}`}</b>
                  <a className="admin-entry-preview" href={`/entry/${entry.id}`} target="_blank">
                    {entry.images[0] ? <SubmissionImage image={entry.images[0]} alt={`${entry.character_name} 作品預覽`} /> : <span>無照片</span>}
                  </a>
                  <span><b>{entry.character_name}</b><small>{entry.source_game}</small></span>
                  <span>{entry.nickname}</span>
                  <i>{entry.withdrawn_at ? "已撤回" : statusText[entry.status] ?? entry.status}</i>
                  <span>
                    {entry.original_image_path ? <a target="_blank" href={`/api/admin/original/${entry.id}`}>查看原圖</a> : "無原圖"}
                    {entry.revision_count > 0 && <small>修訂 {entry.revision_count} 次</small>}
                  </span>
                  <span className="row-actions">
                    <a href={`/entry/${entry.id}`} target="_blank">查看作品</a>
                    {can("submission_manager") && <button disabled={busy} onClick={() => openCropEditor(entry)}>編輯圖片</button>}
                    {can("submission_manager") && !entry.correction_grant && (
                      <button disabled={busy} onClick={() => {
                        setGrantingEntry(entry);
                        setMessage("");
                      }}>開放玩家修正</button>
                    )}
                    {can("submission_manager") && entry.correction_grant && (
                      <>
                        <span className="grant-status">
                          {Date.parse(entry.correction_grant.expires_at) > renderedAt ? "修正授權中" : "修正授權已到期"}
                        </span>
                        <button className="danger" disabled={busy} onClick={() => revokeCorrectionGrant(entry)}>撤銷修正權限</button>
                      </>
                    )}
                    {can("submission_manager") && <button disabled={busy} onClick={() => regenerateDisplay(entry)}>重新生成展示圖</button>}
                    {can("submission_manager") && <button className="danger" disabled={busy} onClick={() => confirm(`確定取消作品 ${entry.entry_code ?? `#${entry.id}`} 的參賽資格？投稿、圖片與投票都會保留。`) && action({ type: "entry_status", entryId: entry.id, status: "disqualified" })}>取消資格</button>}
                    {can("submission_manager") && entry.status !== "approved" && <button disabled={busy} onClick={() => confirm(`確定恢復作品 ${entry.entry_code ?? `#${entry.id}`} 的公開狀態？`) && action({ type: "entry_status", entryId: entry.id, status: "approved" })}>恢復展示</button>}
                    {can("submission_manager") && entry.withdrawn_at && <button disabled={busy} onClick={() => (
                      confirm(`確定復原作品 ${entry.entry_code ?? `#${entry.id}`}？只有投稿開放期間可執行。`)
                      && prompt("請輸入「確認復原」以繼續") === "確認復原"
                      && action({ type: "entry_restore", entryId: entry.id })
                    )}>復原撤回</button>}
                    {isSuperAdmin && <button className="danger permanent-delete" disabled={busy} onClick={() => permanentlyDeleteEntry(entry)}>永久刪除作品</button>}
                  </span>
                </div>
              )) : <p className="muted">目前沒有投稿。</p>}
            </article>
          </>
        )}

        {activeTab === "votes" && (
          <>
            <header className="admin-heading"><div><small>VOTES</small><h1>投票紀錄</h1></div></header>
            <article className="table compact-table">
              {votes.length ? votes.map((vote) => (
                <div key={vote.id}>
                  <b>#{vote.id}</b><span>{vote.voter_nickname}</span><span>{vote.character_name}</span><time>{new Date(vote.created_at).toLocaleString("zh-TW")}</time>
                </div>
              )) : <p className="muted">目前沒有投票紀錄。</p>}
            </article>
          </>
        )}

        {activeTab === "players" && (
          <>
            <header className="admin-heading"><div><small>PLAYERS</small><h1>玩家管理</h1></div></header>
            <label className="admin-search">搜尋玩家<input value={playerQuery} onChange={(event) => setPlayerQuery(event.target.value)} placeholder="輸入暱稱或 Discord ID" /></label>
            <article className="table player-table">
              {filteredPlayers.length ? filteredPlayers.map((player) => (
                <div key={player.id}>
                  <span><b>{player.nickname}</b>{player.is_admin && <small>管理員</small>}</span>
                  <code>{player.discord_id}</code>
                  <i>{player.is_disqualified ? "已取消資格" : "正常"}</i>
                  <span className="row-actions">
                    {can("player_manager") && <button disabled={busy} onClick={() => setEditingPlayer(player)}>編輯玩家</button>}
                    {can("eligibility_manager") && <button
                      className={player.is_disqualified ? "" : "danger"}
                      disabled={busy || player.discord_id === "635371564979716106"}
                      onClick={() => confirm(`${player.is_disqualified ? "恢復" : "取消"}「${player.nickname}」（${player.discord_id}）的參賽資格？`) && action({ type: "player_disqualify", playerId: player.id, disqualified: !player.is_disqualified })}
                    >
                      {player.is_disqualified ? "恢復資格" : "取消資格"}
                    </button>}
                  </span>
                </div>
              )) : <p className="muted">找不到符合的玩家。</p>}
            </article>
          </>
        )}

        {activeTab === "settings" && (
          <>
            <header className="admin-heading"><div><small>EVENT SETTINGS</small><h1>活動設定</h1></div></header>
            {Date.parse(event.voting_ends_at) - Date.parse(event.voting_starts_at) < 10 * 60 * 1000 && (
              <div className="toast" role="alert">
                目前投票期間只有 {Math.max(0, Math.round((Date.parse(event.voting_ends_at) - Date.parse(event.voting_starts_at)) / 60000))} 分鐘，請確認投票截止時間是否正確。
              </div>
            )}
            <form className="event-form settings-form" onSubmit={updateEvent}>
              <label>活動名稱<input name="title" defaultValue={event.title} required /></label>
              <label>投稿開始（台北時間）<input name="submission_starts" type="datetime-local" defaultValue={toTaipeiInput(event.submission_starts_at)} required /></label>
              <label>投稿截止（台北時間）<input name="submission_ends" type="datetime-local" defaultValue={toTaipeiInput(event.submission_ends_at)} required /></label>
              <label>投票開始（台北時間）<input name="voting_starts" type="datetime-local" defaultValue={toTaipeiInput(event.voting_starts_at)} required /></label>
              <label>投票截止（台北時間）<input name="voting_ends" type="datetime-local" defaultValue={toTaipeiInput(event.voting_ends_at)} required /></label>
              <label>排行榜模式
                <select name="leaderboard_mode" defaultValue={event.leaderboard_mode}>
                  <option value="hidden">活動期間隱藏票數</option>
                  <option value="live">即時公開票數</option>
                  <option value="final">公布最終結果</option>
                </select>
              </label>
              <label>活動狀態
                <select name="status" defaultValue={event.status ?? "auto"}>
                  <option value="auto">依活動時間自動切換</option>
                  <option value="draft">草稿</option>
                  <option value="submission_open">投稿開放</option>
                  <option value="submission_closed">投稿截止</option>
                  <option value="voting_open">投票開放</option>
                  <option value="voting_closed">投票截止</option>
                  <option value="results_published">結果公布</option>
                  <option value="archived">活動封存</option>
                </select>
              </label>
              <label>投稿期間作者顯示
                <select name="submission_identity_mode" defaultValue={event.submission_identity_mode ?? "named"}>
                  <option value="named">實名</option><option value="anonymous">匿名</option>
                </select>
              </label>
              <label>投票期間作者顯示
                <select name="voting_identity_mode" defaultValue={event.voting_identity_mode ?? "named"}>
                  <option value="named">實名</option><option value="anonymous">匿名</option>
                </select>
              </label>
              <label className="setting-check"><input name="reveal_authors_after_results" type="checkbox" defaultChecked={event.reveal_authors_after_results !== false} /><span><b>結果公布後顯示作者</b><small>關閉時頒獎頁仍維持匿名</small></span></label>
              <label>投票權限
                <select name="voting_override" defaultValue={event.voting_override ?? "auto"}>
                  <option value="auto">依排程自動開放</option>
                  <option value="open">立即開放投票</option>
                  <option value="closed">暫停投票</option>
                </select>
              </label>
              <label className="setting-check"><input name="submissions_locked" type="checkbox" defaultChecked={event.submissions_locked} /><span><b>鎖定投稿</b><small>停止接受新投稿</small></span></label>
              <label className="setting-check"><input name="voting_locked" type="checkbox" defaultChecked={event.voting_locked} /><span><b>鎖定投票</b><small>即使狀態為投票開放，也停止投票與取消投票</small></span></label>
              <label className="setting-check"><input name="allow_admin_crop_after_submission" type="checkbox" defaultChecked={event.allow_admin_crop_after_submission === true} /><span><b>投稿截止後允許管理員調整圖片</b><small>只修改展示位置，不更換或覆蓋圖片</small></span></label>
              <button className="primary" disabled={busy}>儲存活動設定</button>
            </form>
          </>
        )}

        {activeTab === "announcements" && (
          <>
            <header className="admin-heading"><div><small>ANNOUNCEMENTS</small><h1>公告管理</h1></div></header>
            <div className="announcement-layout">
              <article><h2>發布新公告</h2><form className="announce-form" onSubmit={announce}>
                <input name="title" maxLength={120} placeholder="公告標題（選填）" />
                <select name="announcement_type" defaultValue="general"><option value="general">一般公告</option><option value="submission">投稿提醒</option><option value="voting">投票提醒</option><option value="rules">規則更新</option><option value="awards">得獎公告</option><option value="maintenance">系統維護</option></select>
                <select name="audience" defaultValue="all"><option value="all">所有人</option><option value="participants">參賽者</option><option value="submitters">已投稿者</option><option value="admins">管理員</option><option value="player">指定玩家</option></select>
                <select name="target_profile_id" defaultValue=""><option value="">未指定玩家</option>{players.map((player) => <option key={player.id} value={player.id}>{player.nickname} · {player.discord_id}</option>)}</select>
                <textarea name="body" maxLength={5000} required rows={7} placeholder="輸入公告內容" />
                <label>到期時間（選填，台北時間）<input type="datetime-local" name="expires_at" /></label>
                <label><input type="checkbox" name="is_pinned" /> 置頂</label>
                <label><input type="checkbox" name="requires_ack" /> 要求玩家確認</label>
                <button className="primary" disabled={busy}>發布公告</button>
              </form></article>
              <article><h2>公告紀錄</h2>{announcements.length ? announcements.map((announcement) => <div className="announcement-item" key={announcement.id}>
                <time>{new Date(announcement.published_at).toLocaleString("zh-TW")} · {announcement.is_active ? "啟用" : "已撤下"}</time>
                {announcement.title && <b>{announcement.title}</b>}
                <p>{announcement.body}</p>
                {announcement.expires_at && <small>到期：{new Date(announcement.expires_at).toLocaleString("zh-TW")}</small>}
                <button disabled={busy} onClick={() => {
                  const title = prompt("公告標題", announcement.title ?? "") ?? announcement.title ?? "";
                  const body = prompt("公告內容", announcement.body);
                  if (!body?.trim()) return;
                  void action({
                    type: "announcement_update",
                    eventId: event.id,
                    announcementId: announcement.id,
                    title,
                    body,
                    announcementType: announcement.announcement_type,
                    audience: announcement.audience,
                    targetProfileId: announcement.target_profile_id,
                    isPinned: announcement.is_pinned,
                    isActive: announcement.is_active,
                    requiresAck: announcement.requires_ack,
                    expiresAt: announcement.expires_at,
                  });
                }}>編輯公告</button>
                {announcement.is_active && <button
                  className="danger"
                  disabled={busy}
                  onClick={() => confirm(`確定撤下公告「${announcement.title || `#${announcement.id}`}」？紀錄會保留。`) && action({ type: "announcement_archive", announcementId: announcement.id })}
                >撤下公告</button>}
              </div>) : <p className="muted">目前沒有公告。</p>}</article>
            </div>
          </>
        )}

        {activeTab === "awards" && (
          <>
            <header className="admin-heading"><div><small>AWARDS</small><h1>獎項管理</h1></div></header>
            {can("award_manager") && <form className="award-create" onSubmit={(formEvent) => {
              formEvent.preventDefault();
              const form = new FormData(formEvent.currentTarget);
              void action({
                type: "award_create",
                eventId: event.id,
                name: form.get("name"),
                description: form.get("description"),
                rankingPosition: Number(form.get("ranking_position")),
                sortOrder: awards.length,
              });
            }}>
              <input name="name" maxLength={80} required placeholder="新增獎項名稱" />
              <input name="description" maxLength={1000} placeholder="獎項說明" />
              <select name="ranking_position" defaultValue="0" aria-label="得獎方式">
                <option value="0">手動選擇得獎作品</option>
                {Array.from({ length: 20 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>票數排名第 {index + 1} 名</option>
                ))}
              </select>
              <button className="primary" disabled={busy}>新增獎項</button>
            </form>}
            <section className="award-admin-list">
              {awards.length ? awards.map((award, awardIndex) => {
                const assigned = assignments.find((item) => item.award_id === award.id);
                const automaticCandidates = award.ranking_position
                  ? awardRanking.filter((item) => item.rank === award.ranking_position)
                  : [];
                const automaticWinner = automaticCandidates.length === 1 ? automaticCandidates[0] : null;
                return <article key={award.id} className={award.is_archived ? "archived" : ""}>
                  <header><div><h2>{award.name}</h2><p>{award.description || "無說明"}</p></div><span>{award.is_archived ? "已封存" : award.is_active ? "啟用" : "停用"}</span></header>
                  {can("award_manager") && !award.is_archived && <div className="row-actions">
                    <button disabled={busy || awardIndex === 0} onClick={() => action({ type: "award_reorder", eventId: event.id, awardId: award.id, direction: "up" })}>上移</button>
                    <button disabled={busy || awardIndex === awards.length - 1} onClick={() => action({ type: "award_reorder", eventId: event.id, awardId: award.id, direction: "down" })}>下移</button>
                    {!award.is_active && <button disabled={busy} onClick={() => action({
                      type: "award_update",
                      eventId: event.id,
                      awardId: award.id,
                      name: award.name,
                      description: award.description,
                      rankingPosition: award.ranking_position,
                      sortOrder: award.sort_order,
                      isActive: true,
                    })}>重新啟用</button>}
                  </div>}
                  {award.ranking_position ? (
                    <p>
                      自動獎項：第 {award.ranking_position} 名 ·{" "}
                      {automaticWinner
                        ? `${automaticWinner.entryCode} ${automaticWinner.characterName}（${automaticWinner.votes} 票）`
                        : automaticCandidates.length > 1
                          ? `目前有 ${automaticCandidates.length} 件作品同票，請調整同票規則`
                          : "目前尚無符合此名次的作品"}
                    </p>
                  ) : (
                    <p>目前指派：{assigned ? entries.find((entry) => entry.id === assigned.submission_id)?.entry_code ?? `#${assigned.submission_id}` : "尚未公布"}</p>
                  )}
                  {can("award_manager") && !award.is_archived && <button disabled={busy} onClick={() => {
                    const name = prompt("獎項名稱", award.name)?.trim();
                    if (!name) return;
                    const description = prompt("獎項說明", award.description ?? "") ?? award.description ?? "";
                    void action({
                      type: "award_update",
                      eventId: event.id,
                      awardId: award.id,
                      name,
                      description,
                      rankingPosition: award.ranking_position,
                      sortOrder: award.sort_order,
                      isActive: award.is_active,
                    });
                  }}>編輯獎項</button>}
                  {can("award_manager") && !award.is_archived && <div className="award-rank-setting">
                    <label htmlFor={`award-rank-${award.id}`}>得獎方式</label>
                    <select
                      id={`award-rank-${award.id}`}
                      value={selectedAwardRank[award.id] ?? String(award.ranking_position ?? 0)}
                      onChange={(e) => setSelectedAwardRank((current) => ({ ...current, [award.id]: e.target.value }))}
                    >
                      <option value="0">手動選擇得獎作品</option>
                      {Array.from({ length: 20 }, (_, index) => (
                        <option key={index + 1} value={index + 1}>票數排名第 {index + 1} 名</option>
                      ))}
                    </select>
                    <button disabled={busy} onClick={() => action({
                      type: "award_update",
                      eventId: event.id,
                      awardId: award.id,
                      name: award.name,
                      description: award.description,
                      rankingPosition: Number(selectedAwardRank[award.id] ?? award.ranking_position ?? 0),
                      sortOrder: award.sort_order,
                      isActive: award.is_active,
                    })}>儲存得獎方式</button>
                  </div>}
                  {can("award_assigner") && !award.is_archived && (
                    !award.ranking_position
                    || (
                      automaticCandidates.length > 1
                      && (
                        awardRules?.tie_handling === "admin_decision"
                        || awardRules?.allow_manual_tie_winner === true
                      )
                    )
                  ) && <div className="award-assign">
                    <select value={selectedAwardEntry[award.id] ?? String(assigned?.submission_id ?? "")} onChange={(e) => setSelectedAwardEntry((current) => ({ ...current, [award.id]: e.target.value }))}>
                      <option value="">選擇得獎作品</option>
                      {(award.ranking_position
                        ? automaticCandidates.map((candidate) => entries.find((entry) => entry.id === candidate.entryId)).filter((entry): entry is PendingEntry => Boolean(entry))
                        : entries.filter((entry) => !entry.withdrawn_at && entry.status === "approved")
                      ).map((entry) => <option key={entry.id} value={entry.id}>{entry.entry_code ?? `#${entry.id}`} · {entry.character_name} · {entry.nickname}</option>)}
                    </select>
                    <button disabled={busy || !selectedAwardEntry[award.id] && !assigned} onClick={() => action({ type: "award_assignment_set", eventId: event.id, awardId: award.id, submissionId: Number(selectedAwardEntry[award.id] ?? assigned?.submission_id) })}>{award.ranking_position ? "決選指定" : "指派"}</button>
                    {assigned && <button className="danger" disabled={busy} onClick={() => confirm(`確定解除「${award.name}」的得獎作品？`) && action({ type: "award_assignment_remove", awardId: award.id })}>解除</button>}
                  </div>}
                  {can("award_manager") && !award.is_archived && <button disabled={busy} onClick={() => confirm(`確定停用或封存獎項「${award.name}」？`) && action({ type: "award_archive", awardId: award.id, archive: Boolean(assigned) })}>{assigned ? "封存獎項" : "停用獎項"}</button>}
                </article>;
              }) : <p className="muted">目前尚未建立獎項。</p>}
            </section>
            {can("award_manager") && <form className="award-rules" onSubmit={(formEvent) => {
              formEvent.preventDefault();
              const form = new FormData(formEvent.currentTarget);
              void action({
                type: "award_rules",
                eventId: event.id,
                allowMultiplePerSubmission: form.get("allow_multiple_submission") === "on",
                allowMultiplePerPlayer: form.get("allow_multiple_player") === "on",
                topThreeCanReceiveSpecial: form.get("top_three_special") === "on",
                maxAwardsPerPlayer: Number(form.get("max_player")),
                maxAwardsPerSubmission: Number(form.get("max_submission")),
                tieHandling: form.get("tie_handling"),
                allowManualTieWinner: form.get("manual_tie") === "on",
              });
            }}>
              <h2>得獎衝突規則</h2>
              <label><input type="checkbox" name="allow_multiple_submission" defaultChecked={awardRules?.allow_multiple_per_submission !== false} /> 同一作品可獲多個獎</label>
              <label><input type="checkbox" name="allow_multiple_player" defaultChecked={awardRules?.allow_multiple_per_player !== false} /> 同一玩家可獲多個獎</label>
              <label><input type="checkbox" name="top_three_special" defaultChecked={awardRules?.top_three_can_receive_special !== false} /> 前三名可再獲特別獎</label>
              <label>每位玩家最多獎項<input type="number" name="max_player" min={1} defaultValue={String(awardRules?.max_awards_per_player ?? "")} /></label>
              <label>每件作品最多獎項<input type="number" name="max_submission" min={1} defaultValue={String(awardRules?.max_awards_per_submission ?? "")} /></label>
              <label>同票處理<select name="tie_handling" defaultValue={String(awardRules?.tie_handling ?? "joint")}><option value="joint">並列名次</option><option value="admin_decision">管理員決選</option><option value="earliest_submission">較早投稿</option><option value="earliest_reached_votes">較早達到目前票數</option><option value="unresolved">保持未決定</option></select></label>
              <label><input type="checkbox" name="manual_tie" defaultChecked={awardRules?.allow_manual_tie_winner === true} /> 允許管理員手動指定同票優勝者</label>
              <button className="primary" disabled={busy}>儲存衝突規則</button>
            </form>}
          </>
        )}

        {activeTab === "backups" && (
          <>
            <header className="admin-heading"><div><small>BACKUP & EXPORT</small><h1>備份與匯出</h1></div><button disabled={busy} onClick={() => action({ type: "snapshot", eventId: event.id })}>建立活動快照</button></header>
            <div className="export-grid">
              {[
                ["players", "玩家名單"],
                ["entries", "投稿名單"],
                ["vote_stats", "投票統計"],
                ["leaderboard", "排行榜"],
                ["awards", "得獎名單"],
                ["award_settings", "獎項設定"],
                ["announcements", "公告紀錄"],
                ...(can("audit_viewer") ? [["audit", "操作紀錄"]] : []),
                ...(isSuperAdmin ? [["vote_details", "完整投票明細"]] : []),
              ].map(([kind, label]) => <a key={kind} href={`/api/admin/export?kind=${kind}`}>下載 {label} CSV</a>)}
            </div>
            <section className="snapshot-list"><h2>活動快照</h2>{snapshots.length ? snapshots.map((snapshot) => <a key={snapshot.id} href={`/api/admin/snapshots/${snapshot.id}`}>{new Date(snapshot.created_at).toLocaleString("zh-TW")} · {snapshot.id}</a>) : <p className="muted">尚未建立快照。</p>}</section>
          </>
        )}

        {activeTab === "audit" && (
          <>
            <header className="admin-heading"><div><small>AUDIT LOG</small><h1>操作紀錄</h1></div><a href="/api/admin/export?kind=audit">匯出 CSV</a></header>
            <article className="table audit-table">{auditLogs.length ? auditLogs.map((log) => <div key={log.id}><b>#{log.id}</b><span>{log.actor_nickname}<small>{log.actor_discord_id}</small></span><code>{log.action_type}</code><span>{log.target_type} · {log.target_id}</span><i>{log.result}</i><time>{new Date(log.created_at).toLocaleString("zh-TW")}</time>{isSuperAdmin && <button disabled={busy} onClick={() => confirm(`準備依操作紀錄 #${log.id} 執行安全復原。投票、票數與投稿核心欄位不會被覆蓋。`) && prompt("請輸入「確認復原」以繼續") === "確認復原" && action({ type: "safe_restore", auditId: log.id })}>安全復原</button>}</div>) : <p className="muted">目前沒有操作紀錄。</p>}</article>
          </>
        )}

        {message && <div className="toast">{message}</div>}
      </section>
      {editingCropEntry && <div className="backdrop" onMouseDown={(event) => event.currentTarget === event.target && !busy && setEditingCropEntry(null)}>
        <section className="modal crop-modal">
          <button className="close" type="button" disabled={busy} onClick={() => setEditingCropEntry(null)}>×</button>
          <small>作品 {editingCropEntry.entry_code ?? `#${editingCropEntry.id}`}</small>
          <h2>編輯圖片展示位置</h2>
          <p>每張圖片獨立設定；原圖、圖片網址、投稿內容與票數不會改變。</p>
          <ImageCropEditor images={adminCropImages} onChange={(next) => setAdminCropImages(
            next.map((image) => ({ ...image, id: image.id! })),
          )} disabled={busy} />
          <div className="crop-save-actions">
            <button type="button" className="primary" disabled={busy} onClick={saveAdminCrops}>{busy ? "儲存中…" : "儲存全部圖片位置"}</button>
            <button type="button" disabled={busy} onClick={() => setEditingCropEntry(null)}>取消</button>
          </div>
        </section>
      </div>}
      {grantingEntry && <div className="backdrop" onMouseDown={(event) => event.currentTarget === event.target && !busy && setGrantingEntry(null)}>
        <section className="modal correction-grant-modal">
          <button className="close" type="button" disabled={busy} onClick={() => setGrantingEntry(null)}>×</button>
          <small>SPECIAL CORRECTION</small>
          <h2>開放指定作品圖片修正</h2>
          <p>
            玩家：<b>{grantingEntry.nickname}</b><br />
            作品：<b>{grantingEntry.entry_code ?? `#${grantingEntry.id}`} · {grantingEntry.character_name}</b>
          </p>
          <p className="muted">只授權這位投稿者修改這件作品的指定照片；作品資料、投稿時間與票數都不會變動。</p>
          <form className="name-form" onSubmit={createCorrectionGrant}>
            <fieldset>
              <legend>允許替換的圖片</legend>
              <div className="grant-position-grid">
                {grantingEntry.images.map((image) => (
                  <label key={image.id}>
                    <input type="checkbox" name="allowed_position" value={image.position} defaultChecked />
                    <SubmissionImage image={image} alt={`第 ${image.position} 張作品照片`} />
                    <span>第 {image.position} 張</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              修正期限（台北時間）
              <input
                name="expires_at"
                type="datetime-local"
                min={toTaipeiInput(new Date(renderedAt + 5 * 60 * 1000).toISOString())}
                max={toTaipeiInput(new Date(renderedAt + 7 * 24 * 60 * 60 * 1000).toISOString())}
                defaultValue={toTaipeiInput(new Date(renderedAt + 24 * 60 * 60 * 1000).toISOString())}
                required
              />
            </label>
            <label>
              修正原因／說明
              <textarea name="reason" rows={4} maxLength={500} placeholder="例如：第 2 張照片不符合活動規範，請於期限內替換。" required />
            </label>
            <button className="primary" disabled={busy}>{busy ? "建立授權中…" : "確認開放修正"}</button>
          </form>
        </section>
      </div>}
      {editingPlayer && <div className="backdrop" onMouseDown={(e) => e.currentTarget === e.target && !busy && setEditingPlayer(null)}>
        <section className="modal">
          <button className="close" type="button" disabled={busy} onClick={() => setEditingPlayer(null)}>×</button>
          <i className="modal-seal">人</i><h2>編輯玩家</h2>
          <p>Discord ID：<code>{editingPlayer.discord_id}</code>（不可修改）</p>
          <form className="name-form" onSubmit={savePlayer}>
            <label>活動暱稱<input name="nickname" defaultValue={editingPlayer.nickname} maxLength={20} required /></label>
            <label>管理備註<textarea name="note" defaultValue={editingPlayer.admin_note ?? ""} maxLength={1000} rows={4} /></label>
            <button className="primary" disabled={busy}>{busy ? "儲存中…" : "儲存玩家資料"}</button>
          </form>
        </section>
      </div>}
    </>
  );
}
