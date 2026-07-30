"use client";

import { useState } from "react";
import ImageCropEditor from "@/app/components/ImageCropEditor";
import SubmissionImage from "@/app/components/SubmissionImage";
import { normalizeSubmissionImage, type SubmissionImageRecord } from "@/lib/types";
import type { SubmissionEditGrant } from "@/lib/submission-corrections";
import type { EntryImageDisplaySetting } from "@/lib/submission-corrections";
import SubmissionCorrectionEditor from "./SubmissionCorrectionEditor";

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
  images: SubmissionImageRecord[];
};

export default function MySubmission({
  entry,
  eventStatus,
  canEditCrop,
  userId,
  correctionGrant,
  correctionImages,
  correctionDisplaySettings,
}: {
  entry: OwnEntry;
  eventStatus?: string | null;
  canEditCrop: boolean;
  userId: string;
  correctionGrant: SubmissionEditGrant | null;
  correctionImages: SubmissionImageRecord[];
  correctionDisplaySettings: EntryImageDisplaySetting[] | null;
}) {
  const [withdrawn, setWithdrawn] = useState(Boolean(entry.withdrawn_at));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editingImages, setEditingImages] = useState(false);
  const [images, setImages] = useState(entry.images.map(normalizeSubmissionImage));
  const canChange = eventStatus === "submission_open";
  const cropEditable = canEditCrop && !withdrawn;

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

  const saveCrops = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/submissions/images/crop", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({
          entryId: entry.id,
          images: images.map(({ id, crop_x, crop_y, zoom, rotation }) => ({
            imageId: id,
            cropX: crop_x,
            cropY: crop_y,
            zoom,
            rotation,
          })),
        }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? "圖片展示位置已儲存。" : "圖片位置儲存失敗。"));
      if (response.ok) setEditingImages(false);
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
          <SubmissionImage key={image.id} image={images[index] ?? image} alt={`投稿預覽 ${index + 1}`} />
        ))}
      </div>
      {editingImages && (
        <>
          <ImageCropEditor images={images} onChange={(next) => setImages(
            next.map((image) => ({ ...image, id: image.id! })),
          )} disabled={busy} />
          <div className="crop-save-actions">
            <button type="button" className="primary" disabled={busy} onClick={saveCrops}>{busy ? "儲存中…" : "儲存全部圖片位置"}</button>
            <button type="button" disabled={busy} onClick={() => {
              setImages(entry.images.map(normalizeSubmissionImage));
              setEditingImages(false);
            }}>取消</button>
          </div>
        </>
      )}
      <dl>
        <div><dt>公開圖片</dt><dd>{entry.images.length} 張</dd></div>
        <div><dt>查核原圖</dt><dd>{entry.original_image_path ? "已上傳（僅管理員可見）" : "不需要"}</dd></div>
        <div><dt>投稿狀態</dt><dd>{withdrawn ? "已撤回" : entry.status}</dd></div>
        <div><dt>顯示模式</dt><dd>依活動匿名／實名設定</dd></div>
      </dl>
      {correctionGrant && !withdrawn && (
        <SubmissionCorrectionEditor
          entryId={entry.id}
          userId={userId}
          grant={correctionGrant}
          images={correctionImages}
          displaySettings={correctionDisplaySettings}
        />
      )}
      {canChange && (
        <div className="own-submission-actions">
          {cropEditable && <button type="button" disabled={busy} onClick={() => setEditingImages((current) => !current)}>{editingImages ? "關閉圖片編輯" : "編輯圖片位置"}</button>}
          <button type="button" className={withdrawn ? "" : "danger"} disabled={busy} onClick={change}>
            {busy ? "處理中…" : withdrawn ? "復原投稿" : "撤回整筆投稿"}
          </button>
        </div>
      )}
      {!canChange && <p className="muted">投稿截止或投票開始後不可撤回。</p>}
      {message && <p className="form-error">{message}</p>}
    </section>
  );
}
