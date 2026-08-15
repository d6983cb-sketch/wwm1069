"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { taipeiInputToIso, toTaipeiInput } from "@/lib/taipei-datetime";
import { createClient } from "@/lib/supabase/browser";
import { compressReplacementPhoto, sha256File, validateReplacementPhoto, withUploadTimeout } from "@/lib/client-image-upload";
import type { HuntEventRecord, HuntRankingRow, HuntReferencePoint, HuntSubmissionRecord } from "@/lib/hunt";

type ReviewRow = HuntSubmissionRecord & {
  signedUrl: string | null;
  nickname: string;
  discordId: string;
  disqualified: boolean;
};

const statusLabels = { pending: "待審核", correct: "正確", incorrect: "錯誤", duplicate: "重複" };

type ReferencePreview = {
  id: string;
  file: File;
  url: string;
};

function replaceInputFiles(input: HTMLInputElement | null, previews: ReferencePreview[]) {
  if (!input) return;
  const transfer = new DataTransfer();
  for (const preview of previews) transfer.items.add(preview.file);
  input.files = transfer.files;
}

function ReferenceImagePicker({ disabled, compact = false }: { disabled: boolean; compact?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewsRef = useRef<ReferencePreview[]>([]);
  const [previews, setPreviews] = useState<ReferencePreview[]>([]);
  const [selectionMessage, setSelectionMessage] = useState("");

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);
  useEffect(() => () => {
    for (const preview of previewsRef.current) URL.revokeObjectURL(preview.url);
  }, []);

  const selectFiles = (fileList: FileList | null) => {
    for (const preview of previews) URL.revokeObjectURL(preview.url);
    const files = Array.from(fileList ?? []);
    const accepted: ReferencePreview[] = [];
    const errors: string[] = [];
    for (const file of files.slice(0, 10)) {
      const validation = validateReplacementPhoto(file);
      if (validation) errors.push(`${file.name}：${validation}`);
      else accepted.push({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) });
    }
    if (files.length > 10) errors.push("每次最多選擇 10 張照片。");
    replaceInputFiles(inputRef.current, accepted);
    setPreviews(accepted);
    setSelectionMessage(errors.length ? errors.join(" ") : accepted.length ? `已選擇 ${accepted.length} 張` : "尚未選擇照片");
  };

  const removePreview = (id: string) => {
    const removed = previews.find((preview) => preview.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    const next = previews.filter((preview) => preview.id !== id);
    replaceInputFiles(inputRef.current, next);
    setPreviews(next);
    setSelectionMessage(next.length ? `已選擇 ${next.length} 張` : "尚未選擇照片");
  };

  return <div className={`hunt-reference-picker${compact ? " compact" : ""}`}>
    <label className="hunt-file">
      <span>{compact ? "選擇更多輔助辨識照片" : "選擇 1–10 張參考圖"}</span>
      <small>{previews.length ? `已選 ${previews.length} 張，可再次選擇以更換` : compact ? "不會覆蓋原有照片，選取後立即預覽" : "選取後會立即顯示預覽"}</small>
      <input
        ref={inputRef}
        name="referenceFiles"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        required
        disabled={disabled}
        onChange={(event) => selectFiles(event.currentTarget.files)}
      />
    </label>
    {selectionMessage && <small className="hunt-reference-selection-message" aria-live="polite">{selectionMessage}</small>}
    {previews.length > 0 && <div className="hunt-reference-previews" aria-label="準備上傳的參考圖預覽">
      {previews.map((preview, index) => <figure key={preview.id}>
        <Image src={preview.url} width={180} height={135} alt={`參考圖預覽 ${index + 1}`} unoptimized />
        <figcaption><span title={preview.file.name}>第 {index + 1} 張 · {preview.file.name}</span><button type="button" disabled={disabled} onClick={() => removePreview(preview.id)}>移除</button></figcaption>
      </figure>)}
    </div>}
  </div>;
}

function defaultInput(offsetDays: number) {
  return toTaipeiInput(new Date(Date.now() + offsetDays * 86400000).toISOString());
}

export default function HuntAdminClient({ event, submissions, ranking, referencePoints, canConfigure, canReview, aiConfigured }: {
  event: HuntEventRecord | null;
  submissions: ReviewRow[];
  ranking: HuntRankingRow[];
  referencePoints: HuntReferencePoint[];
  canConfigure: boolean;
  canReview: boolean;
  aiConfigured: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const action = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/hunt", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? "設定已儲存。" : "操作失敗。"));
      if (response.ok) setTimeout(() => location.reload(), 450);
    } catch {
      setMessage("網路連線失敗，資料尚未變更。");
    } finally {
      setBusy(false);
    }
  };

  const saveEvent = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
    const nextStatus = String(form.get("status"));
    const photoRevealAtValue = String(form.get("photoRevealAt") ?? "").trim();
    const revealPlayerPhotos = form.get("revealPlayerPhotos") === "on";
    const revealAnswerPhotos = form.get("revealAnswerPhotos") === "on";
    if ((revealPlayerPhotos || revealAnswerPhotos) && !photoRevealAtValue) {
      setMessage("開啟照片公開功能時，必須設定公開時間。");
      return;
    }
    if ((revealPlayerPhotos || revealAnswerPhotos) && Date.parse(taipeiInputToIso(photoRevealAtValue)) <= Date.now()) {
      if (!confirm("照片公開時間已經到達；儲存後，已勾選的玩家照片或答案照片會立即對所有訪客公開。確定儲存？")) return;
    }
    if (["closed", "results_published", "archived"].includes(nextStatus)) {
      if (!confirm(`確定將尋物活動切換為「${nextStatus}」？這會立即影響玩家上傳及排行榜。`)) return;
    }
    await action({
      type: "hunt_event_save",
      eventId: event?.id,
      title: form.get("title"),
      description: form.get("description"),
      totalTargets: Number(form.get("totalTargets")),
      startsAt: taipeiInputToIso(String(form.get("startsAt"))),
      endsAt: taipeiInputToIso(String(form.get("endsAt"))),
      status: nextStatus,
      leaderboardMode: form.get("leaderboardMode"),
      showTargetImage: form.get("showTargetImage") === "on",
      autoMatchEnabled: form.get("autoMatchEnabled") === "on",
      autoMatchThreshold: Number(form.get("autoMatchThreshold")),
      autoMatchMargin: Number(form.get("autoMatchMargin")),
      photoRevealAt: photoRevealAtValue ? taipeiInputToIso(photoRevealAtValue) : null,
      revealPlayerPhotos,
      revealAnswerPhotos,
    });
  };

  const uploadReferences = async (formEvent: FormEvent<HTMLFormElement>, fixedTargetNumber?: number) => {
    formEvent.preventDefault();
    if (!event) return setMessage("請先建立尋物活動。");
    const form = new FormData(formEvent.currentTarget);
    const targetNumber = fixedTargetNumber ?? Number(form.get("targetNumber"));
    const label = fixedTargetNumber == null ? String(form.get("label") ?? "") : "";
    const input = formEvent.currentTarget.elements.namedItem("referenceFiles") as HTMLInputElement | null;
    const selectedFiles = [...(input?.files ?? [])];
    const files = selectedFiles.slice(0, 10);
    if (!files.length) return setMessage("請至少選擇一張點位參考圖。");
    if (selectedFiles.length > 10) return setMessage("每次最多新增 10 張輔助辨識照片。");
    setBusy(true);
    setMessage("正在建立圖片辨識索引，請勿關閉頁面…");
    try {
      const supabase = createClient();
      for (const source of files) {
        const validation = validateReplacementPhoto(source);
        if (validation) throw new Error(validation);
        const file = await compressReplacementPhoto(source, "image/jpeg");
        const fileHash = await sha256File(file);
        const signResponse = await fetch("/api/admin/hunt", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
          body: JSON.stringify({ type: "hunt_reference_upload_url", eventId: event.id, targetNumber, mimeType: file.type, fileHash }),
        });
        const signBody = await signResponse.json().catch(() => ({}));
        if (!signResponse.ok) throw new Error(signBody.message || "無法取得上傳權限。");
        const { error: uploadError } = await withUploadTimeout(
          supabase.storage.from("hunt-references").uploadToSignedUrl(signBody.path, signBody.token, file, { contentType: file.type }),
          "upload_timeout",
        );
        if (uploadError) throw new Error("參考圖上傳失敗。");
        const createResponse = await fetch("/api/admin/hunt", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
          body: JSON.stringify({ type: "hunt_reference_create", eventId: event.id, targetNumber, label, imagePath: signBody.path, mimeType: file.type, fileHash }),
        });
        const createBody = await createResponse.json().catch(() => ({}));
        if (!createResponse.ok) throw new Error(createBody.message || "辨識索引建立失敗。");
      }
      setMessage(`H${String(targetNumber).padStart(3, "0")} 的 ${files.length} 張參考圖已建立。`);
      setTimeout(() => location.reload(), 500);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "參考圖建立失敗。");
    } finally {
      setBusy(false);
    }
  };

  const saveReferencePoint = async (formEvent: FormEvent<HTMLFormElement>, referencePointId: string) => {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
    await action({
      type: "hunt_reference_point_update",
      referencePointId,
      label: form.get("label"),
    });
  };

  const review = async (formEvent: FormEvent<HTMLFormElement>, submissionId: number) => {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
    const status = String(form.get("status"));
    if (!confirm(`確定將照片 #${submissionId} 判定為「${statusLabels[status as keyof typeof statusLabels] ?? status}」？`)) return;
    await action({
      type: "hunt_review",
      submissionId,
      status,
      targetNumber: form.get("targetNumber"),
      reviewNote: form.get("reviewNote"),
    });
  };

  return <>
    <header className="admin-heading">
      <div><small>HIDDEN OBJECT HUNT</small><h1>尋物活動管理</h1></div>
      <div className="csv-actions"><Link href="/admin">返回百相後台</Link><Link href="/hunt" target="_blank">查看玩家頁面</Link></div>
    </header>
    {message && <p className="toast" role="status">{message}</p>}

    {canConfigure && <section className="hunt-admin-settings">
      <h2>活動設定</h2>
      <form className="event-form settings-form" onSubmit={saveEvent}>
        <label>活動名稱<input name="title" maxLength={100} defaultValue={event?.title ?? "找找物品在哪裡"} required /></label>
        <label>活動開始（台北時間）<input name="startsAt" type="datetime-local" defaultValue={event ? toTaipeiInput(event.starts_at) : defaultInput(1)} required /></label>
        <label>活動結束（台北時間）<input name="endsAt" type="datetime-local" defaultValue={event ? toTaipeiInput(event.ends_at) : defaultInput(8)} required /></label>
        <label>藏物總數<input name="totalTargets" type="number" min={1} max={999} defaultValue={event?.total_targets ?? 10} required /></label>
        <label>活動狀態<select name="status" defaultValue={event?.status ?? "draft"}>
          <option value="draft">草稿</option><option value="open">開放上傳</option><option value="closed">停止上傳</option><option value="results_published">公布結果</option><option value="archived">封存</option>
        </select></label>
        <label>排行榜顯示<select name="leaderboardMode" defaultValue={event?.leaderboard_mode ?? "hidden"}>
          <option value="hidden">活動期間隱藏</option><option value="live">即時公開</option><option value="final">結果公布後顯示</option>
        </select></label>
        <label className="setting-check"><input name="showTargetImage" type="checkbox" defaultChecked={event?.show_target_image === true} /><span><b>向玩家顯示目標物參考圖片</b><small>關閉時只顯示活動文字，不顯示圖一。</small></span></label>
        <fieldset className="hunt-reveal-settings">
          <legend>照片定時公開</legend>
          <label>公開時間（台北時間）<input name="photoRevealAt" type="datetime-local" defaultValue={event?.photo_reveal_at ? toTaipeiInput(event.photo_reveal_at) : ""} /><small>時間未到以前，伺服器不會提供他人投稿或答案照片的觀看網址。</small></label>
          <label className="setting-check"><input name="revealPlayerPhotos" type="checkbox" defaultChecked={event?.reveal_player_photos === true} /><span><b>公開玩家正確照片</b><small>只公開已由管理員確認為正確的照片，不公開待審、錯誤或重複照片。</small></span></label>
          <label className="setting-check"><input name="revealAnswerPhotos" type="checkbox" defaultChecked={event?.reveal_answer_photos === true} /><span><b>公開答案／點位參考照片</b><small>公開啟用中的點位名稱與輔助辨識參考圖。</small></span></label>
        </fieldset>
        <label className="setting-check"><input name="autoMatchEnabled" type="checkbox" defaultChecked={event?.auto_match_enabled === true} disabled={!aiConfigured} /><span><b>開啟上傳後自動辨識</b><small>{aiConfigured ? "立即顯示暫定點位與數量，人工審核後才成為正式結果。" : "尚未設定 Gemini API Key，因此目前不能開啟。"}</small></span></label>
        <label>辨識相似度門檻<input name="autoMatchThreshold" type="number" min={0.5} max={0.99} step={0.01} defaultValue={event?.auto_match_threshold ?? 0.78} /><small>建議先使用 0.78；數值越高越嚴格。</small></label>
        <label>第一、第二候選最小差距<input name="autoMatchMargin" type="number" min={0} max={0.3} step={0.01} defaultValue={event?.auto_match_margin ?? 0.04} /><small>差距不足時自動轉人工審核，建議 0.04。</small></label>
        <label>活動說明<textarea name="description" maxLength={2000} defaultValue={event?.description ?? "在建築範圍內找出被藏起來的物品。它可能被樹叢或建築遮擋，只露出一小部分。每找到一個請拍照上傳。"} /></label>
        <button className="primary" disabled={busy}>{busy ? "儲存中…" : event ? "儲存尋物活動設定" : "建立尋物活動"}</button>
      </form>
    </section>}

    {canConfigure && event && <section className="hunt-reference-manager">
      <header><div><h2>自動辨識點位圖庫</h2><p>每個 H 點位建議上傳 2–3 張不同距離或角度的照片。這些參考圖只有後台可看。</p></div><b className={aiConfigured ? "ai-ready" : "ai-missing"}>{aiConfigured ? "AI 已連線" : "缺少 API Key"}</b></header>
      <form onSubmit={uploadReferences}>
        <label>點位<select name="targetNumber" required>{Array.from({ length: event.total_targets }, (_, index) => index + 1).map((number) => <option value={number} key={number}>H{String(number).padStart(3, "0")}</option>)}</select></label>
        <label>點位名稱（選填）<input name="label" maxLength={100} placeholder="例如：竹林入口石牆" /></label>
        <ReferenceImagePicker disabled={busy || !aiConfigured} />
        <button className="primary" disabled={busy || !aiConfigured}>{busy ? "建立索引中…" : "上傳並建立辨識索引"}</button>
      </form>
      <div className="hunt-reference-grid">
        {referencePoints.length ? referencePoints.map((point) => <article key={point.id}>
          <header><b>H{String(point.target_number).padStart(3, "0")}</b><span>{point.label || "未命名點位"}</span><small>{point.images.filter((image) => image.is_active).length} 張啟用</small></header>
          <div className="hunt-reference-point-tools">
            <form onSubmit={(formEvent) => saveReferencePoint(formEvent, point.id)}>
              <label>點位名稱<input name="label" maxLength={100} defaultValue={point.label ?? ""} placeholder="例如：竹林入口石牆" /></label>
              <button type="submit" disabled={busy}>儲存名稱</button>
            </form>
            <form onSubmit={(formEvent) => uploadReferences(formEvent, point.target_number)}>
              <ReferenceImagePicker compact disabled={busy || !aiConfigured} />
              <button type="submit" className="primary" disabled={busy || !aiConfigured}>{busy ? "建立索引中…" : "新增照片並建立索引"}</button>
            </form>
          </div>
          <div>{point.images.map((reference) => <figure key={reference.id} className={reference.is_active ? "" : "inactive"}>
            {reference.signedUrl ? <Image src={reference.signedUrl} width={240} height={180} alt={`H${point.target_number} 參考圖`} unoptimized /> : <span>圖片無法載入</span>}
            <figcaption><span>{reference.is_active ? "啟用" : "已停用"}</span><div>
              {!reference.is_active && <button type="button" disabled={busy} onClick={() => action({ type: "hunt_reference_reprocess", referenceImageId: reference.id })}>重新建立</button>}
              {reference.is_active && <button type="button" disabled={busy} onClick={() => confirm("確定停用這張參考圖？Storage 原圖不會刪除。") && action({ type: "hunt_reference_deactivate", referenceImageId: reference.id })}>停用</button>}
            </div></figcaption>
          </figure>)}</div>
        </article>) : <p className="muted">尚未建立點位參考圖；沒有參考圖時，玩家上傳仍會保留並轉人工審核。</p>}
      </div>
    </section>}

    <section className="hunt-admin-stats">
      <article><b>{submissions.length}</b><span>照片總數</span></article>
      <article><b>{submissions.filter((item) => item.status === "pending").length}</b><span>待審核</span></article>
      <article><b>{submissions.filter((item) => item.status === "correct").length}</b><span>正確紀錄</span></article>
      <article><b>{ranking.length}</b><span>已找到玩家</span></article>
    </section>

    {canReview && <section className="hunt-review-list">
      <h2>照片審核</h2>
      {submissions.length ? submissions.map((submission) => <article key={submission.id} className={submission.status}>
        <div className="hunt-review-photo">
          {submission.signedUrl ? <a href={submission.signedUrl} target="_blank"><Image src={submission.signedUrl} width={520} height={390} alt={`尋物審核照片 ${submission.id}`} unoptimized /></a> : <span>照片無法載入</span>}
        </div>
        <div>
          <header><b>#{submission.id} · {submission.nickname}</b><code>{submission.discordId}</code></header>
          <p>{submission.player_note || "玩家未填寫說明"}</p>
          <time>{new Date(submission.submitted_at).toLocaleString("zh-TW")}</time>
          <b className={`hunt-status ${submission.status}`}>{statusLabels[submission.status]}</b>
          <div className={`hunt-auto-result ${submission.auto_status}`}>
            <b>自動辨識：</b>{submission.auto_status === "matched" ? `暫定 H${String(submission.auto_match_target_number).padStart(3, "0")}` : submission.auto_status === "duplicate" ? "疑似重複點位" : submission.auto_status === "uncertain" ? "不確定，需人工判定" : submission.auto_status === "error" ? "辨識未完成" : "尚未執行"}
            {submission.auto_similarity != null && <small>向量候選 {Math.round(submission.auto_similarity * 100)}%</small>}
            {submission.auto_verification_confidence != null && <small>視覺核對 {Math.round(submission.auto_verification_confidence * 100)}%</small>}
            {submission.auto_verification?.reason && <small>{submission.auto_verification.reason}</small>}
            <button type="button" disabled={busy || !aiConfigured} onClick={() => action({ type: "hunt_submission_reprocess", submissionId: submission.id })}>以二階段視覺重新辨識</button>
          </div>
          {submission.disqualified && <strong className="form-error">此玩家已取消資格</strong>}
          <form onSubmit={(formEvent) => review(formEvent, submission.id)}>
            <label>判定<select name="status" defaultValue={submission.status === "pending" ? "correct" : submission.status}>
              <option value="correct">正確</option><option value="incorrect">錯誤</option><option value="duplicate">重複</option>
            </select></label>
            <label>藏物編號<select name="targetNumber" defaultValue={submission.matched_target_number ?? submission.auto_match_target_number ?? ""}>
              <option value="">不指定</option>
              {Array.from({ length: event?.total_targets ?? 0 }, (_, index) => index + 1).map((number) => <option value={number} key={number}>H{String(number).padStart(3, "0")}</option>)}
            </select></label>
            <label>審核說明<input name="reviewNote" maxLength={500} defaultValue={submission.review_note ?? ""} placeholder="可告知錯誤或重複原因" /></label>
            <button disabled={busy || submission.disqualified}>儲存審核結果</button>
          </form>
        </div>
      </article>) : <p className="muted">目前沒有上傳照片。</p>}
    </section>}

    <section className="hunt-ranking hunt-admin-ranking"><h2>尋物排行榜</h2>
      {ranking.length ? ranking.map((row) => <article key={row.profileId}><b>第 {row.rank} 名</b><span>{row.nickname}</span><strong>{row.correctCount} 個</strong></article>) : <p className="muted">尚無正確紀錄。</p>}
    </section>
  </>;
}
