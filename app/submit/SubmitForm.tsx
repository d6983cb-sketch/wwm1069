"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { EventRecord } from "@/lib/types";

export default function SubmitForm({ event, userId }: { event: EventRecord; userId: string }) {
  const [ai, setAi] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [original, setOriginal] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (files.length < 1 || files.length > 5) return setMessage("請上傳 1 至 5 張 Cos 照片。");
    if (ai && !original) return setMessage("使用 AI 背景時必須上傳查核原圖。");
    setBusy(true); setMessage("");
    const supabase = createClient();
    const form = new FormData(formEvent.currentTarget);
    const stamp = Date.now();
    let originalPath: string | null = null;
    if (original) {
      originalPath = `${userId}/${stamp}-original-${original.name}`;
      const upload = await supabase.storage.from("cos-originals").upload(originalPath, original, { upsert: false });
      if (upload.error) { setBusy(false); return setMessage("原圖上傳失敗，請稍後重試。"); }
    }
    const uploaded: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const path = `${userId}/${stamp}-${index + 1}-${files[index].name}`;
      const upload = await supabase.storage.from("cos-entries").upload(path, files[index], { upsert: false });
      if (upload.error) { setBusy(false); return setMessage("作品照片上傳失敗，請稍後重試。"); }
      uploaded.push(supabase.storage.from("cos-entries").getPublicUrl(path).data.publicUrl);
    }
    const { data: entry, error } = await supabase.from("entries").insert({
      event_id: event.id,
      owner_id: userId,
      character_name: String(form.get("character_name")),
      source_game: String(form.get("source_game")),
      description: String(form.get("description") || "") || null,
      uses_ai_background: ai,
      original_image_path: originalPath,
    }).select("id").single();
    if (error || !entry) {
      setBusy(false);
      return setMessage(error?.code === "23505" ? "你已經投稿過，不能重複投稿。" : "投稿建立失敗，請稍後重試。");
    }
    const imageRows = uploaded.map((storage_path, index) => ({ entry_id: entry.id, storage_path, position: index + 1 }));
    const imageInsert = await supabase.from("entry_images").insert(imageRows);
    setBusy(false);
    if (imageInsert.error) return setMessage("照片資料寫入失敗，請聯絡管理員。");
    location.href = "/?submitted=1";
  };
  return <form className="submit-form" onSubmit={submit}>
    <section><b>01</b><div><h2>上傳 Cos 照片</h2><p>最少 1 張、最多 5 張。</p><label className="upload"><input type="file" multiple required accept="image/jpeg,image/png,image/webp" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} /><i>＋</i><strong>{files.length ? `已選擇 ${files.length} 張照片` : "選擇照片"}</strong><small>JPG、PNG 或 WEBP</small></label></div></section>
    <section><b>02</b><div className="fields"><label>Cos 角色名稱<input name="character_name" required maxLength={40} /></label><label>角色來源遊戲<input name="source_game" required maxLength={40} /></label><label>作品介紹（選填）<textarea name="description" rows={5} maxLength={500} /></label></div></section>
    <section><b>03</b><div><label className="check"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /><span><strong>使用 AI 合成背景</strong><small>人物本身禁止使用 AI 生成。</small></span></label>{ai && <label>查核原圖（僅管理員可查看）<input type="file" required accept="image/jpeg,image/png,image/webp" onChange={(e) => setOriginal(e.target.files?.[0] ?? null)} /></label>}</div></section>
    <div className="submit-end"><div><p>送出後不可修改、刪除或重新投稿。</p>{message && <strong className="form-error">{message}</strong>}</div><button className="primary" disabled={busy}>{busy ? "正在送出…" : "確認送出投稿"}</button></div>
  </form>;
}
