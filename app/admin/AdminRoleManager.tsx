"use client";

import { useEffect, useMemo, useState } from "react";

type Player = {
  id: string;
  discord_id: string;
  nickname: string;
  is_admin: boolean;
};

export default function AdminRoleManager({ players, currentAdminId }: { players: Player[]; currentAdminId: string }) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const sync = () => setVisible(location.hash === "#players");
    sync();
    window.addEventListener("hashchange", sync);
    const timer = window.setInterval(sync, 300);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.clearInterval(timer);
    };
  }, []);

  const filtered = useMemo(() => {
    const clean = query.trim().toLocaleLowerCase();
    if (!clean) return players;
    return players.filter((player) =>
      player.nickname.toLocaleLowerCase().includes(clean) || player.discord_id.includes(clean),
    );
  }, [players, query]);

  const changeRole = async (player: Player) => {
    const makeAdmin = !player.is_admin;
    const wording = makeAdmin ? "給予" : "移除";
    if (!confirm(`確定要${wording}「${player.nickname}」的管理權限？`)) return;
    setBusyId(player.id);
    setMessage("");
    try {
      const response = await fetch("/api/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "player_admin", playerId: player.id, isAdmin: makeAdmin }),
      });
      const body = await response.json().catch(() => ({}));
      const errors: Record<string, string> = {
        cannot_remove_self: "不能移除自己的管理權限。",
        protected_admin: "此帳號是系統指定管理員，不能在後台移除。",
        player_not_found: "找不到這位玩家。",
      };
      if (!response.ok) {
        setMessage(errors[body.error] ?? "權限變更失敗，請稍後重試。");
        return;
      }
      setMessage(makeAdmin ? "已給予管理權限。" : "已移除管理權限。");
      setTimeout(() => location.reload(), 500);
    } catch {
      setMessage("網路連線失敗，權限尚未變更。");
    } finally {
      setBusyId(null);
    }
  };

  if (!visible) return null;

  return (
    <section className="admin-content admin-role-manager" aria-label="管理權限設定">
      <header className="admin-heading">
        <div><small>ADMIN ROLES</small><h1>管理權限設定</h1></div>
      </header>
      <p className="muted">在此給予或移除網站管理權限。管理員可進入管理入口並操作活動、投稿、玩家、投票與公告。</p>
      <label className="admin-search">搜尋玩家
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入暱稱或 Discord ID" />
      </label>
      <article className="table player-table">
        {filtered.length ? filtered.map((player) => (
          <div key={player.id}>
            <span><b>{player.nickname}</b>{player.is_admin && <small>管理員</small>}</span>
            <code>{player.discord_id}</code>
            <i>{player.is_admin ? "具有管理權限" : "一般玩家"}</i>
            <button
              className={player.is_admin ? "danger" : ""}
              disabled={busyId !== null || player.id === currentAdminId}
              onClick={() => void changeRole(player)}
            >
              {busyId === player.id ? "處理中…" : player.id === currentAdminId ? "目前帳號" : player.is_admin ? "移除管理權限" : "給予管理權限"}
            </button>
          </div>
        )) : <p className="muted">找不到符合的玩家。</p>}
      </article>
      {message && <div className="toast">{message}</div>}
    </section>
  );
}
