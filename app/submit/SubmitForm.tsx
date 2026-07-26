"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { EventRecord } from "@/lib/types";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 90_000;
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type Preview = { file: File; url: string };

function fileExtension(file: File) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function storagePath(userId: string, kind: "entry" | "original", file: File, index = 0) {
  return `${userId}/${crypto.randomUUID()}-${kind}-${index + 1}.${fileExtension(file)}`;
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

function validateFiles(next: File[]) {
  if (next.length < 1 || next.length > MAX_FILES) return "請選擇 1 至 5 張 Cos 照片。";
  if (next.some((file) => !allowedTypes.has(file.type))) return "照片只支援 JPG、PNG 或 WEBP。";
  if (next.some((file) => file.size > MAX_FILE_BYTES)) return "每張照片不可超過 20 MB。";
  if (next.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
    return "全部照片合計不可超過 60 MB。";
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
  if (/row-level security|unauthorized|jwt/i.test(message)) return "登入狀態或圖片權限失效，請重新登入後再試。";
  if (/payload|too large|maximum|exceeded/i.test(message)) return "照片檔案過大，請縮小後再試。";
  if (/bucket.*not found/i.test(message)) return "圖片儲存空間尚未完成設定，請聯絡管理員。";
  return "投稿送出失敗，請確認網路後再試一次。";
}

export default function SubmitForm({ event, userId }: { event: EventRecord; userId: string }) {
  const [ai, setAi] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [original, setOriginal] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const previews = usePreviews(files);
  const originalFiles = useMemo(() => (original ? [original] : []), [original]);
  const originalPreviews = usePreviews(originalFiles);

  const addFiles = (selected: File[]) => {
    const unique = selected.filter(
      (candidate) =>
        !files.some(
          (current) =>
            current.name === candidate.name &&
            current.size === candidate.size &&
            current.lastModified === candidate.lastModified,
        ),
    );
    const next = [...files, ...unique].slice(0, MAX_FILES);
    const validation = validateFiles(next);
    if (validation) return setMessage(validation);
    setMessage(files.length + unique.length > MAX_FILES ? "最多 5 張，超出的照片沒有加入。" : "");
    setFiles(next);
  };

  const moveFile = (from: number, to: number) => {
    setFiles((current) => {
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
  };

  const chooseOriginal = (file: File | null) => {
    if (!file) return setOriginal(null);
    if (!allowedTypes.has(file.type)) {
      setOriginal(null);
      return setMessage("查核原圖只支援 JPG、PNG 或 WEBP。");
    }
    if (file.size > MAX_FILE_BYTES) {
      setOriginal(null);
      return setMessage("查核原圖不可超過 20 MB。");
    }
    setMessage("");
    setOriginal(file);
  };

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    const validation = validateFiles(files);
    if (validation) return setMessage(validation);
    if (ai && !original) return setMessage("使用 AI 背景時必須上傳查核原圖。");

    setBusy(true);
    setMessage("");
    const supabase = createClient();
    const form = new FormData(formEvent.currentTarget);

    try {
      let originalPath: string | null = null;
      if (original) {
        setProgress("正在上傳查核原圖…");
        originalPath = storagePath(userId, "original", original);
        const upload = await withTimeout(
          supabase.storage.from("cos-originals").upload(originalPath, original, {
            contentType: original.type,
            upsert: false,
          }),
          "原圖上傳逾時",
        );
        if (upload.error) throw upload.error;
      }

      const uploaded: string[] = [];
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
        uploaded.push(supabase.storage.from("cos-entries").getPublicUrl(path).data.publicUrl);
      }

      setProgress("正在建立投稿資料…");
      const { data: entry, error } = await supabase
        .from("entries")
        .insert({
          event_id: event.id,
          owner_id: userId,
          character_name: String(form.get("character_name")),
          source_game: String(form.get("source_game")),
          description: String(form.get("description") || "") || null,
          uses_ai_background: ai,
          original_image_path: originalPath,
        })
        .select("id")
        .single();

      if (error || !entry) {
        if (error?.code === "23505") throw new Error("duplicate_entry");
        throw error ?? new Error("entry_create_failed");
      }

      const imageRows = uploaded.map((storage_path, index) => ({
        entry_id: entry.id,
        storage_path,
        position: index + 1,
      }));
      const imageInsert = await supabase.from("entry_images").insert(imageRows);
      if (imageInsert.error) throw imageInsert.error;

      setProgress("投稿完成，正在返回首頁…");
      location.href = "/?submitted=1";
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === "duplicate_entry"
          ? "你已經投稿過，不能重複投稿。"
          : friendlyError(error),
      );
      setProgress("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="submit-form" onSubmit={submit}>
      <section>
        <b>01</b>
        <div>
          <h2>作品照片</h2>
          <p>1–5 張，可分次加入並選擇封面。</p>
          <label className={`upload ${files.length >= MAX_FILES ? "full" : ""}`}>
            <input type="file" multiple accept="image/jpeg,image/png,image/webp"
              disabled={busy || files.length >= MAX_FILES}
              onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }} />
            <i>＋</i>
            <strong>{files.length ? `繼續加入照片（${files.length} / ${MAX_FILES}）` : "加入照片"}</strong>
            <small>{files.length >= MAX_FILES ? "已達 5 張上限" : "可一次或分次選擇"}</small>
          </label>
          {previews.length > 0 && (
            <div className="upload-previews" aria-label="已選擇的作品照片">
              {previews.map((preview, index) => (
                <figure key={preview.url} className={index === 0 ? "is-cover" : ""}>
                  <img src={preview.url} alt={`作品照片預覽 ${index + 1}`} />
                  <figcaption>
                    <strong>{index === 0 ? "封面" : `第 ${index + 1} 張`}</strong>
                    <span className="preview-actions">
                      {index > 0 && (
                        <button type="button" disabled={busy} onClick={() => setCover(index)}>
                          設為封面
                        </button>
                      )}
                      <button type="button" disabled={busy || index === 0}
                        aria-label={`將第 ${index + 1} 張照片往前移`}
                        onClick={() => moveFile(index, index - 1)}>←</button>
                      <button type="button" disabled={busy || index === files.length - 1}
                        aria-label={`將第 ${index + 1} 張照片往後移`}
                        onClick={() => moveFile(index, index + 1)}>→</button>
                      <button type="button" className="remove" disabled={busy}
                        aria-label={`移除第 ${index + 1} 張照片`}
                        onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                        移除
                      </button>
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </section>

      <section>
        <b>02</b>
        <div className="fields">
          <label>Cos 角色名稱<input name="character_name" required maxLength={40} disabled={busy} /></label>
          <label>角色來源遊戲<input name="source_game" required maxLength={40} disabled={busy} /></label>
          <label>作品介紹（選填）<textarea name="description" rows={5} maxLength={500} disabled={busy} /></label>
        </div>
      </section>

      <section>
        <b>03</b>
        <div>
          <label className="check">
            <input type="checkbox" checked={ai} disabled={busy} onChange={(event) => setAi(event.target.checked)} />
            <span><strong>使用 AI 合成背景</strong><small>人物本身禁止使用 AI 生成。</small></span>
          </label>
          {ai && (
            <>
              <label>查核原圖（僅管理員可查看）
                <input type="file" required accept="image/jpeg,image/png,image/webp" disabled={busy}
                  onChange={(event) => chooseOriginal(event.target.files?.[0] ?? null)} />
              </label>
              {originalPreviews[0] && (
                <div className="original-preview">
                  <img src={originalPreviews[0].url} alt="查核原圖預覽" />
                  <button type="button" disabled={busy} onClick={() => setOriginal(null)}>移除原圖</button>
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
        <button className="primary" disabled={busy}>{busy ? "正在送出…" : "確認送出投稿"}</button>
      </div>
    </form>
  );
}
