"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { EventRecord } from "@/lib/types";
import { taipeiInputToIso, toTaipeiInput } from "@/lib/taipei-datetime";

type AdminTab = "overview" | "entries" | "votes" | "players" | "settings" | "announcements";
type PendingEntry = {
  id: number;
  character_name: string;
  source_game: string;
  created_at: string;
  nickname: string;
  uses_ai_background: boolean;
  original_image_path: string | null;
  status: string;
  images: string[];
};
type AdminPlayer = {
  id: string;
  discord_id: string;
  nickname: string;
  is_admin: boolean;
  is_disqualified: boolean;
  created_at: string;
};
type VoteRecord = {
  id: number;
  entry_id: number;
  created_at: string;
  voter_nickname: string;
  character_name: string;
};
type AnnouncementRecord = { id: number; body: string; published_at: string };

const tabs: { id: AdminTab; label: string }[] = [
  { id: "overview", label: "總覽" },
  { id: "entries", label: "投稿管理" },
  { id: "votes", label: "投票紀錄" },
  { id: "players", label: "玩家管理" },
  { id: "settings", label: "活動設定" },
  { id: "announcements", label: "公告管理" },
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
}: {
  event: EventRecord | null;
  entries: PendingEntry[];
  players: AdminPlayer[];
  votes: VoteRecord[];
  announcements: AnnouncementRecord[];
  counts: { players: number; entries: number; votes: number };
}) {
  const [activeTab, setActiveTab] = useState<AdminTab>(event ? "overview" : "settings");
  const [message, setMessage] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const hash = location.hash.replace("#", "") as AdminTab;
      if (tabs.some((tab) => tab.id === hash)) setActiveTab(hash);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

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
        body: JSON.stringify(payload),
      });
      setMessage(response.ok ? "設定已儲存。" : "操作失敗，請稍後重試。");
      if (response.ok) setTimeout(() => location.reload(), 500);
      return response.ok;
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
        voting_override: form.get("voting_override"),
        leaderboard_mode: form.get("leaderboard_mode"),
      },
    });
  };

  const announce = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!event) return;
    const form = new FormData(formEvent.currentTarget);
    await action({ type: "announcement", eventId: event.id, body: form.get("body") });
  };

  const exportCsv = () => {
    const header = "投稿ID,角色名稱,來源遊戲,投稿者,投稿時間,狀態\n";
    const rows = entries
      .map((entry) =>
        [entry.id, entry.character_name, entry.source_game, entry.nickname, entry.created_at, statusText[entry.status] ?? entry.status]
          .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + header + rows], { type: "text/csv;charset=utf-8" }));
    link.download = "cos-entries.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };

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
      {tabs.map((tab) => (
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
              <button onClick={exportCsv}>⇩ 匯出 CSV</button>
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
            <article className="table"><h2>投稿概況</h2><p className="muted">新投稿會自動通過並顯示於作品展廳；管理員仍可查看、取消資格或刪除。</p></article>
          </>
        )}

        {activeTab === "entries" && (
          <>
            <header className="admin-heading"><div><small>ENTRIES</small><h1>投稿管理</h1></div><button onClick={exportCsv}>⇩ 匯出 CSV</button></header>
            <article className="table admin-table">
              {entries.length ? entries.map((entry) => (
                <div key={entry.id}>
                  <b>#{entry.id}</b>
                  <a className="admin-entry-preview" href={`/entry/${entry.id}`} target="_blank">
                    {entry.images[0] ? <img src={entry.images[0]} alt={`${entry.character_name} 作品預覽`} /> : <span>無照片</span>}
                  </a>
                  <span><b>{entry.character_name}</b><small>{entry.source_game}</small></span>
                  <span>{entry.nickname}</span>
                  <i>{statusText[entry.status] ?? entry.status}</i>
                  <span>{entry.original_image_path ? <a target="_blank" href={`/api/admin/original/${entry.id}`}>查看原圖</a> : "無原圖"}</span>
                  <span className="row-actions">
                    <a href={`/entry/${entry.id}`} target="_blank">查看作品</a>
                    <button className="danger" disabled={busy} onClick={() => action({ type: "entry_status", entryId: entry.id, status: "disqualified" })}>取消資格</button>
                    <button className="danger" disabled={busy} onClick={() => confirm("確定永久刪除這筆投稿？") && action({ type: "entry_delete", entryId: entry.id })}>刪除</button>
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
                  <button
                    className={player.is_disqualified ? "" : "danger"}
                    disabled={busy || player.is_admin}
                    onClick={() => action({ type: "player_disqualify", playerId: player.id, disqualified: !player.is_disqualified })}
                  >
                    {player.is_disqualified ? "恢復資格" : "取消資格"}
                  </button>
                </div>
              )) : <p className="muted">找不到符合的玩家。</p>}
            </article>
          </>
        )}

        {activeTab === "settings" && (
          <>
            <header className="admin-heading"><div><small>EVENT SETTINGS</small><h1>活動設定</h1></div></header>
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
              <label>投票權限
                <select name="voting_override" defaultValue={event.voting_override ?? "auto"}>
                  <option value="auto">依排程自動開放</option>
                  <option value="open">立即開放投票</option>
                  <option value="closed">暫停投票</option>
                </select>
              </label>
              <label className="setting-check"><input name="submissions_locked" type="checkbox" defaultChecked={event.submissions_locked} /><span><b>鎖定投稿</b><small>停止接受新投稿</small></span></label>
              <button className="primary" disabled={busy}>儲存活動設定</button>
            </form>
          </>
        )}

        {activeTab === "announcements" && (
          <>
            <header className="admin-heading"><div><small>ANNOUNCEMENTS</small><h1>公告管理</h1></div></header>
            <div className="announcement-layout">
              <article><h2>發布新公告</h2><form className="announce-form" onSubmit={announce}><textarea name="body" maxLength={300} required rows={7} placeholder="輸入要顯示在首頁的公告" /><button className="primary" disabled={busy}>發布公告</button></form></article>
              <article><h2>公告紀錄</h2>{announcements.length ? announcements.map((announcement) => <div className="announcement-item" key={announcement.id}><time>{new Date(announcement.published_at).toLocaleString("zh-TW")}</time><p>{announcement.body}</p></div>) : <p className="muted">目前沒有公告。</p>}</article>
            </div>
          </>
        )}

        {message && <div className="toast">{message}</div>}
      </section>
    </>
  );
}
