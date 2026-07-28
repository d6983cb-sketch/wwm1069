"use client";

import { useEffect, useMemo, useState } from "react";
import { ADMIN_PERMISSIONS, type AdminPermission, type AdminPermissions } from "@/lib/admin-access";

type Player = {
  id: string;
  discord_id: string;
  nickname: string;
  is_admin: boolean;
  admin_role?: { permissions: AdminPermissions; is_active: boolean } | null;
};

const labels: Record<AdminPermission, string> = {
  player_manager: "玩家管理",
  eligibility_manager: "玩家資格管理",
  submission_viewer: "投稿查看",
  submission_manager: "投稿管理",
  event_manager: "活動狀態管理",
  award_manager: "獎項管理",
  award_assigner: "得獎指派",
  announcement_manager: "公告管理",
  report_viewer: "匯出資料",
  statistics_viewer: "查看統計",
  audit_viewer: "查看操作紀錄",
};

export default function AdminRoleManager({ players, currentAdminId }: { players: Player[]; currentAdminId: string }) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Player | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<AdminPermissions>({});

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

  const request = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, idempotencyKey: crypto.randomUUID() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message ?? "權限變更失敗。");
  };

  const changeRole = async (player: Player) => {
    const active = player.admin_role?.is_active ?? player.is_admin;
    const makeAdmin = !active;
    if (player.discord_id === "635371564979716106") return setMessage("最高管理員權限由伺服器固定，不能修改。");
    if (!makeAdmin) {
      if (!confirm(`即將移除「${player.nickname}」（${player.discord_id}）的管理權限。此帳號將無法進入後台。`)) return;
      if (prompt("請輸入「確認移除」以繼續") !== "確認移除") return;
    } else if (!confirm(`確定給予「${player.nickname}」（${player.discord_id}）一般管理員身分？之後仍需設定細項權限。`)) return;
    setBusyId(player.id);
    setMessage("");
    try {
      await request({ type: "player_admin", playerId: player.id, isAdmin: makeAdmin });
      setMessage(makeAdmin ? "已啟用一般管理員；請接著設定權限。" : "已移除一般管理員權限。");
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "權限變更失敗。");
    } finally {
      setBusyId(null);
    }
  };

  const openPermissions = (player: Player) => {
    setEditing(player);
    setPermissionDraft(player.admin_role?.permissions ?? {});
  };

  const savePermissions = async () => {
    if (!editing) return;
    setBusyId(editing.id);
    try {
      await request({ type: "admin_permissions", playerId: editing.id, permissions: permissionDraft });
      setMessage(`已更新「${editing.nickname}」的細項權限。`);
      setEditing(null);
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "權限儲存失敗。");
    } finally {
      setBusyId(null);
    }
  };

  if (!visible) return null;

  return (
    <section className="admin-content admin-role-manager" aria-label="管理權限設定">
      <header className="admin-heading"><div><small>ADMIN ROLES</small><h1>管理權限設定</h1></div></header>
      <p className="muted">只有最高管理員可啟用、停用一般管理員及設定細項權限。一般管理員不能自行擴權。</p>
      <label className="admin-search">搜尋玩家<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入暱稱或 Discord ID" /></label>
      <article className="table player-table">
        {filtered.length ? filtered.map((player) => {
          const isSuper = player.discord_id === "635371564979716106";
          const active = isSuper || player.admin_role?.is_active === true;
          return <div key={player.id}>
            <span><b>{player.nickname}</b>{isSuper ? <small>唯一最高管理員</small> : active && <small>一般管理員</small>}</span>
            <code>{player.discord_id}</code>
            <i>{active ? "具有管理權限" : "一般玩家"}</i>
            <span className="row-actions">
              {!isSuper && active && <button disabled={busyId !== null} onClick={() => openPermissions(player)}>編輯權限</button>}
              <button
                className={active && !isSuper ? "danger" : ""}
                disabled={busyId !== null || isSuper || player.id === currentAdminId}
                onClick={() => void changeRole(player)}
              >
                {busyId === player.id ? "處理中…" : isSuper ? "不可移除" : player.id === currentAdminId ? "目前帳號" : active ? "移除管理員" : "設為一般管理員"}
              </button>
            </span>
          </div>;
        }) : <p className="muted">找不到符合的玩家。</p>}
      </article>
      {message && <div className="toast">{message}</div>}
      {editing && <div className="backdrop" onMouseDown={(event) => event.currentTarget === event.target && setEditing(null)}>
        <section className="modal permission-modal">
          <button className="close" onClick={() => setEditing(null)}>×</button>
          <i className="modal-seal">權</i><h2>{editing.nickname} 的權限</h2>
          <p><code>{editing.discord_id}</code></p>
          <div className="permission-grid">
            {ADMIN_PERMISSIONS.map((permission) => <label key={permission}>
              <input type="checkbox" checked={permissionDraft[permission] === true} onChange={(event) => setPermissionDraft((current) => ({ ...current, [permission]: event.target.checked }))} />
              <span>{labels[permission]}</span>
            </label>)}
          </div>
          <button className="primary" disabled={busyId !== null} onClick={savePermissions}>{busyId ? "儲存中…" : "儲存權限"}</button>
        </section>
      </div>}
    </section>
  );
}
