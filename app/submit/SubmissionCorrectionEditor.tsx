"use client";

import { useEffect, useMemo, useState } from "react";
import ImageCropEditor from "@/app/components/ImageCropEditor";
import SubmissionImage from "@/app/components/SubmissionImage";
import {
  compressReplacementPhoto,
  replacementFileExtension,
  replacementUploadError,
  validateReplacementPhoto,
  withUploadTimeout,
} from "@/lib/client-image-upload";
import { createClient } from "@/lib/supabase/browser";
import type { SubmissionEditGrant } from "@/lib/submission-corrections";
import {
  DEFAULT_SUBMISSION_IMAGE_CROP,
  normalizeSubmissionImage,
  type SubmissionImageCrop,
  type SubmissionImageRecord,
} from "@/lib/types";

export default function SubmissionCorrectionEditor({
  entryId,
  userId,
  grant,
  images,
}: {
  entryId: number;
  userId: string;
  grant: SubmissionEditGrant;
  images: SubmissionImageRecord[];
}) {
  const [files, setFiles] = useState<Record<number, File>>({});
  const [crops, setCrops] = useState<Record<number, SubmissionImageCrop>>({});
  const [busy, setBusy] = useState(false);
  const [processingImageId, setProcessingImageId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const allowed = useMemo(
    () => images
      .map(normalizeSubmissionImage)
      .filter((image) => grant.allowed_positions.includes(image.position))
      .sort((left, right) => left.position - right.position),
    [grant.allowed_positions, images],
  );
  const selectedFiles = useMemo(
    () => allowed.filter((image) => files[image.id]).map((image) => ({
      image,
      file: files[image.id],
      url: URL.createObjectURL(files[image.id]),
    })),
    [allowed, files],
  );
  useEffect(
    () => () => selectedFiles.forEach((item) => URL.revokeObjectURL(item.url)),
    [selectedFiles],
  );
  const previews = selectedFiles.map(({ image, url }) => ({
    ...image,
    storage_path: url,
    ...(crops[image.id] ?? DEFAULT_SUBMISSION_IMAGE_CROP),
  }));

  const choose = async (image: SubmissionImageRecord, file: File | null) => {
    if (!file) return;
    const validation = validateReplacementPhoto(file);
    if (validation) return setMessage(validation);
    setProcessingImageId(image.id);
    setMessage("");
    try {
      const compressed = await compressReplacementPhoto(file);
      setFiles((current) => ({ ...current, [image.id]: compressed }));
      setCrops((current) => ({
        ...current,
        [image.id]: { ...DEFAULT_SUBMISSION_IMAGE_CROP },
      }));
      setMessage(`第 ${image.position} 張替換照片已準備好，請確認裁切預覽。`);
    } catch (error) {
      setMessage(replacementUploadError(error));
    } finally {
      setProcessingImageId(null);
    }
  };

  const save = async () => {
    if (!previews.length) return setMessage("請至少選擇一張需要替換的照片。");
    if (!confirm(`確定送出 ${previews.length} 張修正照片？舊照片會保留於管理紀錄中。`)) return;
    setBusy(true);
    setMessage("");
    const supabase = createClient();
    const uploadedPaths: string[] = [];
    try {
      const replacements = [];
      for (const preview of previews) {
        const file = files[preview.id];
        const path = `${userId}/${crypto.randomUUID()}-correction-entry-${preview.id}.${replacementFileExtension(file)}`;
        const upload = await withUploadTimeout(
          supabase.storage.from("cos-entries").upload(path, file, {
            contentType: file.type,
            upsert: false,
          }),
          `第 ${preview.position} 張照片上傳逾時`,
        );
        if (upload.error) throw upload.error;
        uploadedPaths.push(path);
        replacements.push({
          imageId: preview.id,
          storagePath: path,
          cropX: preview.crop_x,
          cropY: preview.crop_y,
          zoom: preview.zoom,
          rotation: preview.rotation,
        });
      }
      const response = await fetch("/api/submissions/images/replace", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          entryId,
          grantId: grant.id,
          replacements,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "correction_failed");
      setMessage(body.message ?? "修正照片已儲存。");
      setFiles({});
      setCrops({});
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      if (uploadedPaths.length) {
        await fetch("/api/submissions/images/replace", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storagePaths: uploadedPaths }),
        }).catch(() => undefined);
      }
      setMessage(replacementUploadError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="submission-correction">
      <header>
        <small>SPECIAL CORRECTION · 指定作品修正</small>
        <h3>管理員已開放照片修正</h3>
        <p>{grant.reason || "請依活動規範替換指定照片。"}</p>
        <b>期限：{new Date(grant.expires_at).toLocaleString("zh-TW")}</b>
      </header>
      <p className="muted">只能替換下列指定圖片；角色資料、投稿時間、作品編號與票數都不會改變。</p>
      <div className="correction-slots">
        {allowed.map((image) => (
          <article key={image.id}>
            <span>第 {image.position} 張</span>
            <SubmissionImage image={image} alt={`目前第 ${image.position} 張作品照片`} />
            <label className="correction-file">
              {processingImageId === image.id ? "處理照片中…" : files[image.id] ? "重新選擇" : "選擇替換照片"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy || processingImageId !== null}
                onChange={(event) => {
                  void choose(image, event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </label>
            {files[image.id] && (
              <button type="button" disabled={busy} onClick={() => {
                setFiles((current) => {
                  const next = { ...current };
                  delete next[image.id];
                  return next;
                });
                setCrops((current) => {
                  const next = { ...current };
                  delete next[image.id];
                  return next;
                });
              }}>取消替換這張</button>
            )}
          </article>
        ))}
      </div>
      {previews.length > 0 && (
        <>
          <h4>新照片展示預覽</h4>
          <ImageCropEditor
            images={previews}
            disabled={busy}
            onChange={(next) => setCrops(Object.fromEntries(next.map((image) => [
              image.id,
              {
                crop_x: image.crop_x,
                crop_y: image.crop_y,
                zoom: image.zoom,
                rotation: image.rotation,
                aspect_ratio: image.aspect_ratio,
              },
            ])))}
          />
          <button className="primary" type="button" disabled={busy || processingImageId !== null} onClick={save}>
            {busy ? "正在儲存修正…" : `儲存 ${previews.length} 張修正照片`}
          </button>
        </>
      )}
      {message && <p className="form-error" role="status">{message}</p>}
    </section>
  );
}
