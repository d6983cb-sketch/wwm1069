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
import type {
  EntryImageDisplaySetting,
  SubmissionEditGrant,
} from "@/lib/submission-corrections";
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
  displaySettings,
}: {
  entryId: number;
  userId: string;
  grant: SubmissionEditGrant;
  images: SubmissionImageRecord[];
  displaySettings: EntryImageDisplaySetting[] | null;
}) {
  const initialOrderedIds = useMemo(() => {
    const settings = new Map((displaySettings ?? []).map((setting) => [setting.image_id, setting]));
    return [...images]
      .sort((left, right) => (
        (settings.get(left.id)?.display_position ?? left.position)
        - (settings.get(right.id)?.display_position ?? right.position)
      ))
      .map((image) => image.id);
  }, [displaySettings, images]);
  const initialHiddenIds = useMemo(
    () => (displaySettings ?? [])
      .filter((setting) => setting.is_hidden)
      .map((setting) => setting.image_id)
      .sort((left, right) => left - right),
    [displaySettings],
  );
  const [replacementFiles, setReplacementFiles] = useState<Record<number, File>>({});
  const [additionFiles, setAdditionFiles] = useState<File[]>([]);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [orderedIds, setOrderedIds] = useState<number[]>(() => initialOrderedIds);
  const [hiddenIds, setHiddenIds] = useState<number[]>(() => initialHiddenIds);
  const [crops, setCrops] = useState<Record<number, SubmissionImageCrop>>({});
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("");
  const allowed = useMemo(
    () => images
      .map(normalizeSubmissionImage)
      .filter((image) => (
        grant.allowed_image_ids.includes(image.id)
        || grant.allowed_positions.includes(image.position)
      ))
      .sort((left, right) => left.position - right.position),
    [grant.allowed_image_ids, grant.allowed_positions, images],
  );
  const visibleImageCount = orderedIds.filter((id) => !hiddenIds.includes(id)).length;
  const additionCapacity = Math.max(0, 5 - visibleImageCount);
  const displayChanged = (
    JSON.stringify(orderedIds) !== JSON.stringify(initialOrderedIds)
    || JSON.stringify([...hiddenIds].sort((left, right) => left - right)) !== JSON.stringify(initialHiddenIds)
  );
  const selectedReplacements = useMemo(
    () => allowed.filter((image) => replacementFiles[image.id]).map((image) => ({
      image,
      file: replacementFiles[image.id],
      url: URL.createObjectURL(replacementFiles[image.id]),
    })),
    [allowed, replacementFiles],
  );
  const selectedAdditions = useMemo(
    () => additionFiles.map((file, index) => ({
      id: -(index + 1),
      file,
      url: URL.createObjectURL(file),
      position: visibleImageCount + index + 1,
    })),
    [additionFiles, visibleImageCount],
  );
  useEffect(
    () => () => {
      selectedReplacements.forEach((item) => URL.revokeObjectURL(item.url));
      selectedAdditions.forEach((item) => URL.revokeObjectURL(item.url));
    },
    [selectedAdditions, selectedReplacements],
  );

  const replacementPreviews = selectedReplacements.map(({ image, url }) => ({
    ...image,
    storage_path: url,
    ...(crops[image.id] ?? DEFAULT_SUBMISSION_IMAGE_CROP),
  }));
  const additionPreviews = selectedAdditions.map(({ id, url, position }) => ({
    id,
    storage_path: url,
    position,
    ...(crops[id] ?? DEFAULT_SUBMISSION_IMAGE_CROP),
  }));
  const previews = [...replacementPreviews, ...additionPreviews];

  const chooseReplacement = async (image: SubmissionImageRecord, file: File | null) => {
    if (!file) return;
    const validation = validateReplacementPhoto(file);
    if (validation) return setMessage(validation);
    setProcessing(true);
    setMessage("");
    try {
      const compressed = await compressReplacementPhoto(file);
      setReplacementFiles((current) => ({ ...current, [image.id]: compressed }));
      setCrops((current) => ({ ...current, [image.id]: { ...DEFAULT_SUBMISSION_IMAGE_CROP } }));
      setMessage(`第 ${image.position} 張替換照片已準備好，請確認下方預覽。`);
    } catch (error) {
      setMessage(replacementUploadError(error));
    } finally {
      setProcessing(false);
    }
  };

  const chooseAdditions = async (files: File[]) => {
    if (!files.length) return;
    if (files.length > additionCapacity) {
      setMessage(`最多只能再新增 ${additionCapacity} 張公開圖片。`);
      return;
    }
    const validation = files.map(validateReplacementPhoto).find(Boolean);
    if (validation) return setMessage(validation);
    setProcessing(true);
    setMessage("");
    try {
      const compressed: File[] = [];
      for (const file of files) compressed.push(await compressReplacementPhoto(file));
      setAdditionFiles(compressed);
      setCrops((current) => {
        const next = { ...current };
        compressed.forEach((_, index) => {
          next[-(index + 1)] = { ...DEFAULT_SUBMISSION_IMAGE_CROP };
        });
        return next;
      });
      setMessage(`已準備新增 ${compressed.length} 張圖片，請確認下方預覽。`);
    } catch (error) {
      setMessage(replacementUploadError(error));
    } finally {
      setProcessing(false);
    }
  };

  const chooseOriginal = (file: File | null) => {
    if (!file) return;
    const validation = validateReplacementPhoto(file);
    if (validation) return setMessage(validation);
    setOriginalFile(file);
    setMessage("新的 AI 合成前原圖已選擇；系統會保留原本查核原圖。");
  };

  const save = async () => {
    if (!previews.length && !originalFile && !displayChanged) {
      return setMessage("請至少選擇一項要修改的圖片。");
    }
    const summary = [
      replacementPreviews.length ? `替換 ${replacementPreviews.length} 張` : "",
      additionPreviews.length ? `新增 ${additionPreviews.length} 張` : "",
      originalFile ? "更換查核原圖" : "",
      displayChanged ? "更新圖片順序／顯示狀態" : "",
    ].filter(Boolean).join("、");
    if (!confirm(`確定送出：${summary}？所有舊檔案都會保留。`)) return;
    setBusy(true);
    setMessage("");
    const supabase = createClient();
    const uploadedEntryPaths: string[] = [];
    const uploadedOriginalPaths: string[] = [];
    try {
      const replacements = [];
      for (const preview of replacementPreviews) {
        const file = replacementFiles[preview.id];
        const path = `${userId}/${crypto.randomUUID()}-correction-entry-${preview.id}.${replacementFileExtension(file)}`;
        const upload = await withUploadTimeout(
          supabase.storage.from("cos-entries").upload(path, file, {
            contentType: file.type,
            upsert: false,
          }),
          `第 ${preview.position} 張照片上傳逾時`,
        );
        if (upload.error) throw upload.error;
        uploadedEntryPaths.push(path);
        replacements.push({
          imageId: preview.id,
          storagePath: path,
          cropX: preview.crop_x,
          cropY: preview.crop_y,
          zoom: preview.zoom,
          rotation: preview.rotation,
        });
      }

      const additions = [];
      for (let index = 0; index < additionPreviews.length; index += 1) {
        const preview = additionPreviews[index];
        const file = additionFiles[index];
        const path = `${userId}/${crypto.randomUUID()}-correction-add-${index + 1}.${replacementFileExtension(file)}`;
        const upload = await withUploadTimeout(
          supabase.storage.from("cos-entries").upload(path, file, {
            contentType: file.type,
            upsert: false,
          }),
          `新增第 ${index + 1} 張照片上傳逾時`,
        );
        if (upload.error) throw upload.error;
        uploadedEntryPaths.push(path);
        additions.push({
          storagePath: path,
          cropX: preview.crop_x,
          cropY: preview.crop_y,
          zoom: preview.zoom,
          rotation: preview.rotation,
        });
      }

      let originalStoragePath: string | null = null;
      if (originalFile) {
        originalStoragePath = `${userId}/${crypto.randomUUID()}-correction-original-1.${replacementFileExtension(originalFile)}`;
        const upload = await withUploadTimeout(
          supabase.storage.from("cos-originals").upload(originalStoragePath, originalFile, {
            contentType: originalFile.type,
            upsert: false,
          }),
          "查核原圖上傳逾時",
        );
        if (upload.error) throw upload.error;
        uploadedOriginalPaths.push(originalStoragePath);
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
          additions,
          imageStates: displayChanged
            ? orderedIds.map((imageId, index) => ({
                imageId,
                displayPosition: index + 1,
                isHidden: hiddenIds.includes(imageId),
              }))
            : [],
          originalStoragePath,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "correction_failed");
      setMessage(body.message ?? "修正圖片已儲存。");
      setReplacementFiles({});
      setAdditionFiles([]);
      setOriginalFile(null);
      setCrops({});
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      if (uploadedEntryPaths.length || uploadedOriginalPaths.length) {
        await fetch("/api/submissions/images/replace", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            entryStoragePaths: uploadedEntryPaths,
            originalStoragePaths: uploadedOriginalPaths,
          }),
        }).catch(() => undefined);
      }
      setMessage(replacementUploadError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="submission-correction" id="submission-correction">
      <header>
        <small>SPECIAL CORRECTION · 指定作品修正</small>
        <h3>管理員已開放照片修正</h3>
        <p>{grant.reason || "請依活動規範修正指定照片。"}</p>
        <b>期限：{new Date(grant.expires_at).toLocaleString("zh-TW")}</b>
      </header>
      <p className="muted">只會建立新的圖片版本；角色資料、投稿時間、作品編號、票數及舊檔案都不會改變。</p>

      {(grant.allow_reorder_images || grant.allow_remove_images) && (
        <section className="correction-extra">
          <h4>調整圖片順序與顯示</h4>
          <p>「移除」只會讓照片不再公開顯示，舊檔案仍由管理員保留。</p>
          <div className="correction-order-list">
            {orderedIds.map((imageId, index) => {
              const image = images.find((item) => item.id === imageId);
              if (!image) return null;
              const hidden = hiddenIds.includes(imageId);
              return (
                <article key={imageId} className={hidden ? "is-hidden" : ""}>
                  <SubmissionImage image={image} alt={`圖片順序 ${index + 1}`} />
                  <span>{hidden ? "已從展示移除" : `展示第 ${index + 1} 張`}</span>
                  {grant.allow_reorder_images && (
                    <div>
                      <button
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => setOrderedIds((current) => {
                          const next = [...current];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        })}
                      >上移</button>
                      <button
                        type="button"
                        disabled={busy || index === orderedIds.length - 1}
                        onClick={() => setOrderedIds((current) => {
                          const next = [...current];
                          [next[index], next[index + 1]] = [next[index + 1], next[index]];
                          return next;
                        })}
                      >下移</button>
                    </div>
                  )}
                  {grant.allow_remove_images && (
                    <button
                      type="button"
                      className={hidden ? "" : "danger"}
                      disabled={busy || (!hidden && visibleImageCount <= 1 && additionFiles.length === 0)}
                      onClick={() => setHiddenIds((current) => (
                        current.includes(imageId)
                          ? current.filter((id) => id !== imageId)
                          : [...current, imageId]
                      ))}
                    >{hidden ? "恢復顯示" : "移除圖片"}</button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {allowed.length > 0 && (
        <>
          <h4>替換指定公開圖片</h4>
          <div className="correction-slots">
            {allowed.map((image) => (
              <article key={image.id}>
                <span>第 {image.position} 張</span>
                <SubmissionImage image={image} alt={`目前第 ${image.position} 張作品照片`} />
                <label className="correction-file">
                  {replacementFiles[image.id] ? "重新選擇" : "選擇替換照片"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy || processing}
                    onChange={(event) => {
                      void chooseReplacement(image, event.target.files?.[0] ?? null);
                      event.target.value = "";
                    }}
                  />
                </label>
                {replacementFiles[image.id] && (
                  <button type="button" disabled={busy} onClick={() => {
                    setReplacementFiles((current) => {
                      const next = { ...current };
                      delete next[image.id];
                      return next;
                    });
                  }}>取消替換這張</button>
                )}
              </article>
            ))}
          </div>
        </>
      )}

      {grant.allow_add_images && additionCapacity > 0 && (
        <section className="correction-extra">
          <h4>新增公開作品圖片</h4>
          <p>目前 {images.length} 張，最多可以再新增 {additionCapacity} 張；新增後會排在現有圖片後方。</p>
          <label className="correction-file">
            {additionFiles.length ? `重新選擇（目前 ${additionFiles.length} 張）` : "選擇要新增的圖片"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={busy || processing}
              onChange={(event) => {
                void chooseAdditions(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </label>
          {additionFiles.length > 0 && (
            <button type="button" disabled={busy} onClick={() => setAdditionFiles([])}>取消全部新增圖片</button>
          )}
        </section>
      )}

      {grant.allow_replace_original && (
        <section className="correction-extra">
          <h4>更換 AI 合成前原圖</h4>
          <p>原圖會以原始檔案上傳，不重新壓縮；舊原圖仍保留於管理紀錄。</p>
          <label className="correction-file">
            {originalFile ? `已選擇：${originalFile.name}` : "選擇新的查核原圖"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy || processing}
              onChange={(event) => {
                chooseOriginal(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
          </label>
          {originalFile && (
            <button type="button" disabled={busy} onClick={() => setOriginalFile(null)}>取消更換原圖</button>
          )}
        </section>
      )}

      {previews.length > 0 && (
        <>
          <h4>公開圖片展示預覽</h4>
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
        </>
      )}
      {(previews.length > 0 || originalFile || displayChanged) && (
        <button className="primary" type="button" disabled={busy || processing} onClick={save}>
          {busy ? "正在儲存修正…" : "確認儲存全部修正"}
        </button>
      )}
      {processing && <p className="muted">正在處理圖片，請稍候…</p>}
      {message && <p className="form-error" role="status">{message}</p>}
    </section>
  );
}
