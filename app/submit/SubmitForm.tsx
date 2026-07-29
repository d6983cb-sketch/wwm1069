"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import ImageCropEditor from "@/app/components/ImageCropEditor";
import {
  DEFAULT_SUBMISSION_IMAGE_CROP,
  type EventRecord,
  type SubmissionImageCrop,
} from "@/lib/types";

const MAX_FILES = 5;
const MAX_SOURCE_FILE_BYTES = 30 * 1024 * 1024;
const MAX_ORIGINAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const TARGET_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2560;
const UPLOAD_TIMEOUT_MS = 90_000;
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type Preview = { file: File; url: string };
type LoadedImage = { source: CanvasImageSource; width: number; height: number; close?: () => void };

function fileExtension(file: File) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function storagePath(userId: string, kind: "entry" | "original", file: File, index = 0) {
  return `${userId}/${crypto.randomUUID()}-${kind}-${index + 1}.${fileExtension(file)}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function withTimeout<T>(request: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), UPLOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadImage(file: File): Promise<LoadedImage> {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error("image_decode_failed"));
      next.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("image_compression_failed"))),
      type,
      quality,
    );
  });
}

async function compressImage(file: File) {
  const loaded = await loadImage(file);
  try {
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(loaded.width, loaded.height));
    let quality = 0.88;
    let result: Blob | null = null;
    let outputType = "image/webp";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const width = Math.max(1, Math.round(loaded.width * scale));
      const height = Math.max(1, Math.round(loaded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("canvas_unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(loaded.source, 0, 0, width, height);

      try {
        result = await canvasToBlob(canvas, outputType, quality);
      } catch {
        outputType = "image/jpeg";
        result = await canvasToBlob(canvas, outputType, quality);
      }

      canvas.width = 1;
      canvas.height = 1;
      if (result.size <= TARGET_FILE_BYTES) break;

      if (quality > 0.68) quality -= 0.07;
      else scale *= 0.86;
    }

    if (!result) throw new Error("image_compression_failed");
    const extension = outputType === "image/webp" ? "webp" : "jpg";
    const baseName = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([result], `${baseName}.${extension}`, {
      type: outputType,
      lastModified: file.lastModified,
    });
  } finally {
    loaded.close?.();
  }
}

function validateFiles(next: File[]) {
  if (next.length < 1 || next.length > MAX_FILES) return "請選擇 1 至 5 張 Cos 照片。";
  if (next.some((file) => !allowedTypes.has(file.type))) return "照片只支援 JPG、PNG 或 WEBP。";
  if (next.some((file) => file.size > MAX_SOURCE_FILE_BYTES)) return "每張原始照片不可超過 30 MB。";
  return "";
}

function validateCompressedFiles(next: File[]) {
  if (next.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    return "壓縮後的照片合計仍超過 12 MB，請減少照片張數或改用較小的照片。";
  }
  return "";
}

function usePreviews(files: File[]) {
  const previews = useMemo<Preview[]>(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );
  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews],
  );
  return previews;
}

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|逾時/i.test(message)) return "上傳時間過久，請確認網路後再試一次。";
  if (/decode|compression|canvas/i.test(message)) return "其中一張照片無法處理，請換成 JPG、PNG 或 WEBP 後再試。";
  if (/row-level security|unauthorized|jwt/i.test(message)) return "登入狀態或圖片權限失效，請重新登入後再試。";
  if (/payload|too large|maximum|exceeded/i.test(message)) return "照片檔案過大，請縮小後再試。";
  if (/bucket.*not found/i.test(message)) return "圖片儲存空間尚未完成設定，請聯絡管理員。";
  return "投稿送出失敗，請確認網路後再試一次。";
}

export default function SubmitForm({ event, userId }: { event: EventRecord; userId: string }) {
  const router = useRouter();
  const [ai, setAi] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [imageCrops, setImageCrops] = useState<SubmissionImageCrop[]>([]);
  const [original, setOriginal] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const previews = usePreviews(files);
  const originalFiles = useMemo(() => (original ? [original] : []), [original]);
  const originalPreviews = usePreviews(originalFiles);

  const addFiles = async (selected: File[]) => {
    const availableSlots = MAX_FILES - files.length;
    if (availableSlots <= 0) return;

    const selectedFiles = selected.slice(0, availableSlots);
    const validation = validateFiles(selectedFiles);
    if (validation) return setMessage(validation);

    const unique = selectedFiles.filter(
      (candidate) =>
        !files.some(
          (current) =>
            current.name === candidate.name &&
            current.size === candidate.size &&
            current.lastModified === candidate.lastModified,
        ),
    );
    if (!unique.length) return setMessage("這些照片已經加入。 ");

    setProcessing(true);
    setMessage("");
    try {
      const compressed: File[] = [];
      for (let index = 0; index < unique.length; index += 1) {
        setProgress(`正在壓縮照片 ${index + 1} / ${unique.length}…`);
        compressed.push(await compressImage(unique[index]));
      }
      const next = [...files, ...compressed];
      const compressedValidation = validateCompressedFiles(next);
      if (compressedValidation) return setMessage(compressedValidation);
      setFiles(next);
      setImageCrops((current) => [
        ...current,
        ...compressed.map(() => ({ ...DEFAULT_SUBMISSION_IMAGE_CROP })),
      ]);
      const saved = unique.reduce((total, file, index) => total + Math.max(0, file.size - compressed[index].size), 0);
      setMessage(
        selected.length > availableSlots
          ? `最多 5 張，超出的照片沒有加入。已節省約 ${formatFileSize(saved)}。`
          : `照片處理完成，已節省約 ${formatFileSize(saved)}。`,
      );
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      setProgress("");
      setProcessing(false);
    }
  };

  const moveFile = (from: number, to: number) => {
    setFiles((current) => {
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setImageCrops((current) => {
      if (to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const setCover = (index: number) => {
    setFiles((current) => {
      const next = [...current];
      const [cover] = next.splice(index, 1);
      next.unshift(cover);
      return next;
    });
    setImageCrops((current) => {
      const next = [...current];
      const [cover] = next.splice(index, 1);
      next.unshift(cover);
      return next;
    });
  };

  const chooseOriginal = (file: File | null) => {
    if (!file) return setOriginal(null);
    if (!allowedTypes.has(file.type)) {
      setOriginal(null);
      return setMessage("查核原圖只支援 JPG、PNG 或 WEBP。");
    }
    if (file.size > MAX_ORIGINAL_FILE_BYTES) {
      setOriginal(null);
      return setMessage("查核原圖不可超過 20 MB。");
    }
    setMessage("");
    setOriginal(file);
  };

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (processing) return setMessage("照片仍在處理中，請稍候。 ");
    const validation = validateFiles(files) || validateCompressedFiles(files);
    if (validation) return setMessage(validation);
    if (ai && !original) return setMessage("使用 AI 背景時必須上傳查核原圖。");

    setBusy(true);
    setMessage("");
    const supabase = createClient();
    const form = new FormData(formEvent.currentTarget);
    const uploadedPaths: string[] = [];
    let uploadedOriginalPath: string | null = null;

    try {
      if (ai && original) {
        setProgress("正在上傳查核原圖…");
        uploadedOriginalPath = storagePath(userId, "original", original);
        const upload = await withTimeout(
          supabase.storage.from("cos-originals").upload(uploadedOriginalPath, original, {
            contentType: original.type,
            upsert: false,
          }),
          "原圖上傳逾時",
        );
        if (upload.error) throw upload.error;
      }

      for (let index = 0; index < files.length; index += 1) {
        setProgress(`正在上傳作品照片 ${index + 1} / ${files.length}…`);
        const path = storagePath(userId, "entry", files[index], index);
        const upload = await withTimeout(
          supabase.storage.from("cos-entries").upload(path, files[index], {
            contentType: files[index].type,
            upsert: false,
          }),
          `第 ${index + 1} 張照片上傳逾時`,
        );
        if (upload.error) throw upload.error;
        uploadedPaths.push(path);
      }

      setProgress("正在建立投稿資料…");
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          characterName: form.get("character_name"),
          sourceGame: form.get("source_game"),
          description: form.get("description"),
          usesAiBackground: ai,
          originalPath: uploadedOriginalPath,
          imagePaths: uploadedPaths,
          imageCrops,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "entry_create_failed");

      setProgress("投稿完成，正在顯示你的作品…");
      router.replace("/submit?submitted=1");
    } catch (error) {
      if (uploadedPaths.length || uploadedOriginalPath) {
        await fetch("/api/submissions", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            imagePaths: uploadedPaths,
            originalPath: uploadedOriginalPath,
          }),
        }).catch(() => undefined);
      }
      setMessage(
        error instanceof Error && error.message === "duplicate_entry"
          ? "你已經投稿過，不能重複投稿。"
          : error instanceof Error && error.message === "submissions_closed"
            ? "投稿已截止或目前無法投稿。"
            : friendlyError(error),
      );
      setProgress("");
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || processing;

  return (
    <form className="submit-form" onSubmit={submit}>
      <section>
        <b>01</b>
        <div>
          <h2>作品照片</h2>
          <p>1–5 張，可分次加入並選擇封面；加入後會自動壓縮，每張約 2 MB。</p>
          <label className={`upload ${files.length >= MAX_FILES ? "full" : ""}`}>
            <input type="file" multiple accept="image/jpeg,image/png,image/webp"
              disabled={disabled || files.length >= MAX_FILES}
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }} />
            <i>＋</i>
            <strong>{processing ? "正在處理照片…" : files.length ? `繼續加入照片（${files.length} / ${MAX_FILES}）` : "加入照片"}</strong>
            <small>{files.length >= MAX_FILES ? "已達 5 張上限" : "JPG、PNG、WEBP；單張原檔最多 30 MB"}</small>
          </label>
          {previews.length > 0 && (
            <>
              <div className="upload-previews" aria-label="已選擇的作品照片">
                {previews.map((preview, index) => (
                  <figure key={preview.url} className={index === 0 ? "is-cover" : ""}>
                    <span className="submission-image">
                      {/* Blob preview intentionally uses a native image; next/image cannot optimize local object URLs. */}
                      <img
                        src={preview.url}
                        alt={`作品照片預覽 ${index + 1}`}
                        style={{
                          objectPosition: `${50 + (imageCrops[index]?.crop_x ?? 0)}% ${50 + (imageCrops[index]?.crop_y ?? 0)}%`,
                          transform: `scale(${imageCrops[index]?.zoom ?? 1}) rotate(${imageCrops[index]?.rotation ?? 0}deg)`,
                        }}
                      />
                    </span>
                    <figcaption>
                      <strong>{index === 0 ? "封面" : `第 ${index + 1} 張`} · {formatFileSize(preview.file.size)}</strong>
                      <span className="preview-actions">
                        {index > 0 && (
                          <button type="button" disabled={disabled} onClick={() => setCover(index)}>
                            設為封面
                          </button>
                        )}
                        <button type="button" disabled={disabled || index === 0}
                          aria-label={`將第 ${index + 1} 張照片往前移`}
                          onClick={() => moveFile(index, index - 1)}>←</button>
                        <button type="button" disabled={disabled || index === files.length - 1}
                          aria-label={`將第 ${index + 1} 張照片往後移`}
                          onClick={() => moveFile(index, index + 1)}>→</button>
                        <button type="button" className="remove" disabled={disabled}
                          aria-label={`移除第 ${index + 1} 張照片`}
                          onClick={() => {
                            setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
                            setImageCrops((current) => current.filter((_, itemIndex) => itemIndex !== index));
                          }}>
                          移除
                        </button>
                      </span>
                    </figcaption>
                  </figure>
                ))}
              </div>
              <ImageCropEditor
                images={previews.map((preview, index) => ({
                  storage_path: preview.url,
                  position: index + 1,
                  ...imageCrops[index],
                }))}
                disabled={disabled}
                onChange={(next) => setImageCrops(next.map(({ crop_x, crop_y, zoom, rotation, aspect_ratio }) => ({
                  crop_x, crop_y, zoom, rotation, aspect_ratio,
                })))}
              />
            </>
          )}
        </div>
      </section>

      <section>
        <b>02</b>
        <div className="fields">
          <label>Cos 角色名稱<input name="character_name" required maxLength={40} disabled={disabled} /></label>
          <label>角色來源遊戲<input name="source_game" required maxLength={40} disabled={disabled} /></label>
          <label>作品介紹（選填）<textarea name="description" rows={5} maxLength={500} disabled={disabled} /></label>
        </div>
      </section>

      <section>
        <b>03</b>
        <div>
          <label className="check">
            <input
              type="checkbox"
              checked={ai}
              disabled={disabled}
              onChange={(event) => {
                const checked = event.target.checked;
                setAi(checked);
                if (!checked) setOriginal(null);
              }}
            />
            <span><strong>使用 AI 合成背景</strong><small>人物本身禁止使用 AI 生成。</small></span>
          </label>
          {ai && (
            <>
              <label>查核原圖（僅管理員可查看，不會壓縮）
                <input type="file" required accept="image/jpeg,image/png,image/webp" disabled={disabled}
                  onChange={(event) => chooseOriginal(event.target.files?.[0] ?? null)} />
              </label>
              {originalPreviews[0] && (
                <div className="original-preview">
                  <img src={originalPreviews[0].url} alt="查核原圖預覽" />
                  <button type="button" disabled={disabled} onClick={() => setOriginal(null)}>移除原圖</button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <div className="submit-end">
        <div>
          <p>送出後不可修改、刪除或重新投稿。</p>
          {progress && <strong className="upload-progress" aria-live="polite">{progress}</strong>}
          {message && <strong className="form-error" role="alert">{message}</strong>}
        </div>
        <button className="primary" disabled={disabled}>{processing ? "正在處理照片…" : busy ? "正在送出…" : "確認送出投稿"}</button>
      </div>
    </form>
  );
}
