"use client";

import Image from "next/image";
import { useState } from "react";

type OwnEntry = {
  id: number;
  entry_code: string | null;
  character_name: string;
  source_game: string;
  created_at: string;
  uses_ai_background: boolean;
  original_image_path: string | null;
  withdrawn_at: string | null;
  status: string;
  images: Array<{ storage_path: string; position: number }>;
};

export default function MySubmission({ entry, eventStatus }: { entry: OwnEntry; eventStatus?: string | null }) {
  const [withdrawn, setWithdrawn] = useState(Boolean(entry.withdrawn_at));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canChange = eventStatus === "submission_open";

  const change = async () => {
    const action = withdrawn ? "restore" : "withdraw";
    const wording = withdrawn ? "確認復原" : "確認撤回";
    if (!confirm(`${wording}作品 ${entry.entry_code ?? `#${entry.id}`}？這不會刪除投稿或圖片。`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/submissions/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({ entryId: entry.id, action }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? (withdrawn ? "投稿已復原。" : "投稿已撤回。") : "操作失敗。"));
      if (response.ok) setWithdrawn(!withdrawn);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="own-submission">
      <header>
        <small>MY SUBMISSION · 我的投稿</small>
        <h2>{entry.entry_code ?? `#${entry.id}`}　{entry.character_name}</h2>
        <p>{entry.source_game} · {new Date(entry.created_at).toLocaleString("zh-TW")}</p>
      </header>
      <div className="own-submission-images">
        {entry.images.map((image, index) => (
          <Image key={image.storage_path} src={image.storage_path} alt={`投稿預覽 ${index + 1}`} width={260} height={260} />
        ))}
      </div>
      <dl>
        <div><dt>公開圖片</dt><dd>{entry.images.length} 張</dd></div>
        <div><dt>查核原圖</dt><dd>{entry.original_image_path ? "已上傳（僅管理員可見）" : "不需要"}</dd></div>
        <div><dt>投稿狀態</dt><dd>{withdrawn ? "已撤回" : entry.status}</dd></div>
        <div><dt>顯示模式</dt><dd>依活動匿名／實名設定</dd></div>
      </dl>
      {canChange && (
        <button type="button" className={withdrawn ? "" : "danger"} disabled={busy} onClick={change}>
          {busy ? "處理中…" : withdrawn ? "復原投稿" : "撤回整筆投稿"}
        </button>
      )}
      {!canChange && <p className="muted">投稿截止或投票開始後不可撤回。</p>}
      {message && <p className="form-error">{message}</p>}
    </section>
  );
}

