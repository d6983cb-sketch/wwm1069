"use client";

import { useState } from "react";

type Notice = {
  id: number;
  title: string | null;
  body: string;
  announcement_type: string;
  published_at: string;
  requires_ack: boolean;
  read: boolean;
  acknowledged: boolean;
};

export default function NotificationList({ notices }: { notices: Notice[] }) {
  const [items, setItems] = useState(notices);
  const [busy, setBusy] = useState<number | null>(null);

  const mark = async (notice: Notice, acknowledge: boolean) => {
    setBusy(notice.id);
    try {
      const response = await fetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ announcementId: notice.id, acknowledge }),
      });
      if (response.ok) {
        setItems((current) => current.map((item) =>
          item.id === notice.id
            ? { ...item, read: true, acknowledged: item.acknowledged || acknowledge }
            : item,
        ));
      }
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) return <div className="empty-state"><i>信</i><h3>目前沒有公告</h3><p>新公告會顯示在這裡。</p></div>;
  return (
    <section className="notification-list">
      {items.map((notice) => (
        <article key={notice.id} className={notice.read ? "" : "unread"}>
          <header><small>{notice.announcement_type}</small><time>{new Date(notice.published_at).toLocaleString("zh-TW")}</time></header>
          <h2>{notice.title || "活動公告"}</h2>
          <p>{notice.body}</p>
          <div>
            {!notice.read && <button disabled={busy === notice.id} onClick={() => mark(notice, false)}>標記已讀</button>}
            {notice.requires_ack && !notice.acknowledged && <button className="primary" disabled={busy === notice.id} onClick={() => mark(notice, true)}>我已確認</button>}
            {notice.acknowledged && <span>✓ 已確認</span>}
          </div>
        </article>
      ))}
    </section>
  );
}

