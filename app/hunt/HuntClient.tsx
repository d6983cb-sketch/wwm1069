"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import {
  compressReplacementPhoto,
  replacementFileExtension,
  replacementUploadError,
  sha256File,
  validateReplacementPhoto,
  withUploadTimeout,
} from "@/lib/client-image-upload";
import {
  calculateHuntProgress,
  canShowHuntAnswerPhotos,
  canShowHuntPlayerPhotos,
  canShowHuntRanking,
  hasReachedHuntPhotoRevealTime,
  isHuntOpen,
  type HuntEventRecord,
  type HuntPublicAnswerPhoto,
  type HuntPublicPlayerPhoto,
  type HuntRankingRow,
  type HuntSubmissionRecord,
} from "@/lib/hunt";

type OwnSubmission = HuntSubmissionRecord & { signedUrl: string | null };
type PendingPhotoStatus = "ready" | "processing" | "success" | "error";
type PendingPhoto = {
  id: string;
  file: File;
  previewUrl: string;
  status: PendingPhotoStatus;
  message: string;
};

const MAX_BATCH_PHOTOS = 22;

const statusLabels = {
  pending: "等待審核",
  correct: "正確",
  incorrect: "不正確",
  duplicate: "重複",
};

export default function HuntClient({
  event,
  userId,
  nickname,
  disqualified,
  submissions,
  ranking,
  publicPlayerPhotos,
  publicAnswerPhotos,
}: {
  event: HuntEventRecord | null;
  userId: string | null;
  nickname: string | null;
  disqualified: boolean;
  submissions: OwnSubmission[];
  ranking: HuntRankingRow[];
  publicPlayerPhotos: HuntPublicPlayerPhoto[];
  publicAnswerPhotos: HuntPublicAnswerPhoto[];
}) {
  const router = useRouter();
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const photosRef = useRef<PendingPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const progressKey = submissions.map((submission) => `${submission.id}:${submission.status}:${submission.auto_status}`).join("|");
  const calculatedProgress = calculateHuntProgress(submissions);
  const [optimisticProgress, setOptimisticProgress] = useState<{ key: string; value: ReturnType<typeof calculateHuntProgress> } | null>(null);
  const liveProgress = optimisticProgress?.key === progressKey ? optimisticProgress.value : calculatedProgress;
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  useEffect(() => () => {
    for (const photo of photosRef.current) URL.revokeObjectURL(photo.previewUrl);
  }, []);
  const open = isHuntOpen(event);
  const photoRevealReached = hasReachedHuntPhotoRevealTime(event);
  const showPlayerPhotos = canShowHuntPlayerPhotos(event);
  const showAnswerPhotos = canShowHuntAnswerPhotos(event);

  const signIn = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${location.origin}/auth/callback?next=/hunt`,
        scopes: "identify email guilds",
      },
    });
  };

  const selectPhotos = (fileList: FileList | null) => {
    if (!fileList?.length || busy) return;
    const selected = Array.from(fileList);
    const existing = new Set(photos.map((photo) => `${photo.file.name}:${photo.file.size}:${photo.file.lastModified}`));
    const available = Math.max(0, MAX_BATCH_PHOTOS - photos.length);
    const nextPhotos: PendingPhoto[] = [];
    const errors: string[] = [];

    for (const file of selected.slice(0, available)) {
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
      if (existing.has(fingerprint)) continue;
      const validation = validateReplacementPhoto(file);
      if (validation) {
        errors.push(`${file.name}：${validation}`);
        continue;
      }
      existing.add(fingerprint);
      nextPhotos.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: "ready",
        message: "等待送出",
      });
    }

    setPhotos((current) => [...current, ...nextPhotos]);
    if (selected.length > available) errors.push(`每次最多選擇 ${MAX_BATCH_PHOTOS} 張照片。`);
    setMessage(errors.length ? errors.join(" ") : nextPhotos.length ? `已選擇 ${photos.length + nextPhotos.length} 張照片。` : "沒有新增照片。");
  };

  const removePendingPhoto = (id: string) => {
    if (busy) return;
    setPhotos((current) => {
      const removed = current.find((photo) => photo.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((photo) => photo.id !== id);
    });
  };

  const updatePendingPhoto = (id: string, update: Partial<Pick<PendingPhoto, "status" | "message">>) => {
    setPhotos((current) => current.map((photo) => photo.id === id ? { ...photo, ...update } : photo));
  };

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    const queuedPhotos = photos.filter((photo) => photo.status !== "success");
    if (!queuedPhotos.length || !userId || !event) return;
    // React's currentTarget is only guaranteed while the event handler is
    // running synchronously. Read the form before image compression/upload;
    // otherwise currentTarget can be null by the time the awaited work ends.
    const form = new FormData(formEvent.currentTarget);
    const playerNote = String(form.get("playerNote") ?? "");
    setBusy(true);
    setMessage(`正在依序處理 1 / ${queuedPhotos.length} 張…`);
    const completedIds = new Set<string>();
    let completed = 0;
    let failed = 0;

    for (const [index, photo] of queuedPhotos.entries()) {
      let imagePath: string | null = null;
      updatePendingPhoto(photo.id, { status: "processing", message: event.auto_match_enabled ? "上傳並排隊辨識中…" : "上傳中…" });
      setMessage(`正在依序處理 ${index + 1} / ${queuedPhotos.length} 張…`);
      try {
        const compressed = await compressReplacementPhoto(photo.file, "image/jpeg");
        const fileHash = await sha256File(compressed);
        const preflightResponse = await fetch("/api/hunt/submissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileHash }),
        });
        const preflightBody = await preflightResponse.json().catch(() => ({}));
        if (!preflightResponse.ok) {
          throw new Error(preflightBody.message || "尋物照片目前無法送出。");
        }
        imagePath = `${userId}/${crypto.randomUUID()}-proof.${replacementFileExtension(compressed)}`;
        const supabase = createClient();
        const { error: uploadError } = await withUploadTimeout(
          supabase.storage.from("hunt-proofs").upload(imagePath, compressed, { upsert: false, contentType: compressed.type }),
          "upload_timeout",
        );
        if (uploadError) throw uploadError;
        const response = await fetch("/api/hunt/submissions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imagePath, fileHash, playerNote }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.message || body.error || "submission_failed");
        completed += 1;
        completedIds.add(photo.id);
        updatePendingPhoto(photo.id, { status: "success", message: body.message ?? "已送出" });
        if (body.progress) setOptimisticProgress({ key: progressKey, value: body.progress });
      } catch (error) {
        failed += 1;
        console.error("[hunt-upload] submission failed", {
          stage: imagePath ? "create-record" : "upload-proof",
          fileName: photo.file.name,
          error,
        });
        const fallback = replacementUploadError(error);
        const errorMessage = error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
          ? error.message
          : fallback === "照片修正失敗，原作品仍保持不變。"
            ? "尋物照片上傳失敗，請稍後重試。"
            : fallback;
        updatePendingPhoto(photo.id, { status: "error", message: errorMessage });
      }
    }

    setBusy(false);
    setMessage(failed
      ? `批次處理完成：成功 ${completed} 張、失敗 ${failed} 張。失敗照片仍保留，可再次送出。`
      : `${completed} 張照片已全部送出並完成自動辨識。`);
    setPhotos((current) => current.filter((photo) => {
      if (!completedIds.has(photo.id)) return true;
      URL.revokeObjectURL(photo.previewUrl);
      return false;
    }));
    router.refresh();
  };

  const removeSubmission = async (submission: OwnSubmission) => {
    if (submission.status === "correct") return;
    if (!confirm(`確定刪除尋物投稿 #${submission.id}？照片與審核紀錄會一併刪除，且無法復原。`)) return;
    setDeletingId(submission.id);
    setMessage("");
    try {
      const response = await fetch("/api/hunt/submissions", {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({ submissionId: submission.id }),
      });
      const body = await response.json().catch(() => ({}));
      setMessage(body.message ?? (response.ok ? "投稿已刪除。" : "刪除失敗。"));
      if (response.ok) router.refresh();
    } catch {
      setMessage("網路連線失敗，投稿尚未刪除。");
    } finally {
      setDeletingId(null);
    }
  };

  if (!event) {
    return <div className="empty-state"><i>尋</i><h3>尋物活動尚未建立</h3><p>管理員完成設定後會在此開放。</p></div>;
  }

  return (
    <>
      <header className="page-title hunt-title">
        <small>HIDDEN OBJECT HUNT · 尋物活動</small>
        <h1>{event.title}</h1>
        <p>{event.description || "在建築範圍內找出被藏起來的指定物品，拍照後送交審核。"}</p>
      </header>

      <section className="hunt-intro">
        <article className="hunt-target">
          <h2>要找的物品</h2>
          {event.show_target_image ? (
            <Image src={event.target_image_path} width={299} height={297} alt="尋物活動目標物參考圖" priority />
          ) : (
            <div className="hunt-hidden-target"><i>?</i><b>參考圖片目前未公開</b><span>請依活動公告提供的線索尋找。</span></div>
          )}
        </article>
        <article className="hunt-summary">
          <h2>活動資訊</h2>
          <dl>
            <div><dt>藏物總數</dt><dd>{event.total_targets}</dd></div>
            <div><dt>暫定找到</dt><dd>{liveProgress.provisionalCount}</dd></div>
            <div><dt>人工確認</dt><dd>{liveProgress.confirmedCount}</dd></div>
            <div><dt>活動狀態</dt><dd>{open ? "進行中" : event.status === "results_published" ? "結果公布" : "未開放"}</dd></div>
          </dl>
          <p>每找到一個物品請上傳一張照片。自動辨識會立即更新暫定數量，最後仍以管理員人工審核為準。</p>
        </article>
      </section>

      <section className="hunt-upload-panel">
        <h2>上傳找到的照片</h2>
        {!userId ? (
          <button className="primary" onClick={signIn}>使用 Discord 登入後上傳</button>
        ) : disqualified ? (
          <p className="form-error">此帳號目前沒有活動參加資格。</p>
        ) : !open ? (
          <p className="muted">目前未開放上傳。</p>
        ) : (
          <form onSubmit={submit}>
            <label className="hunt-file">
              <span>{photos.length ? `繼續選擇照片（已選 ${photos.length} 張）` : "選擇一張或多張照片"}</span>
              <small>可從相簿一次選取，最多 {MAX_BATCH_PHOTOS} 張</small>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={(event) => {
                selectPhotos(event.target.files);
                event.currentTarget.value = "";
              }} />
            </label>
            {photos.length > 0 && <div className="hunt-batch-preview" aria-label="準備上傳的照片">
              {photos.map((photo, index) => <article key={photo.id} className={`hunt-batch-photo ${photo.status}`}>
                <Image src={photo.previewUrl} width={240} height={180} alt={`準備上傳的尋物照片 ${index + 1}`} unoptimized />
                <span><b>第 {index + 1} 張</b><small>{photo.message}</small></span>
                <button type="button" disabled={busy} onClick={() => removePendingPhoto(photo.id)} aria-label={`移除第 ${index + 1} 張照片`}>移除</button>
              </article>)}
            </div>}
            <label>補充說明（選填）<textarea name="playerNote" maxLength={200} placeholder="例如：在樹叢旁、屋簷後方找到" /></label>
            <button className="primary" disabled={busy || !photos.length}>{busy ? (event.auto_match_enabled ? "依序自動辨識中…" : "依序送出中…") : event.auto_match_enabled ? `送出 ${photos.length} 張並自動辨識` : `送出 ${photos.length} 張等待審核`}</button>
          </form>
        )}
        {message && <p className="hunt-message" role="status">{message}</p>}
      </section>

      {nickname && <section className="hunt-own-list">
        <h2>{nickname}的上傳紀錄</h2>
        {submissions.length ? <div>
          {submissions.map((submission) => <article key={submission.id}>
            {submission.signedUrl ? <Image src={submission.signedUrl} width={320} height={240} alt={`尋物照片 ${submission.id}`} unoptimized /> : <span className="muted">照片暫時無法載入</span>}
            <b className={`hunt-status ${submission.status}`}>{statusLabels[submission.status]}</b>
            {submission.matched_target_number && <span>藏物 H{String(submission.matched_target_number).padStart(3, "0")}</span>}
            {submission.status === "pending" && submission.auto_status === "matched" && submission.auto_match_target_number && <span className="hunt-auto-player">暫定 H{String(submission.auto_match_target_number).padStart(3, "0")} · 視覺信心 {Math.round((submission.auto_verification_confidence ?? 0) * 100)}%<small>等待人工確認</small></span>}
            {submission.status === "pending" && submission.auto_status === "duplicate" && <span className="hunt-auto-player warning">疑似重複點位，暫不重複計數<small>等待人工確認</small></span>}
            {submission.status === "pending" && submission.auto_status === "uncertain" && <span className="hunt-auto-player warning">自動辨識不確定<small>已轉人工審核</small></span>}
            {submission.status === "pending" && submission.auto_status === "error" && <span className="hunt-auto-player warning">自動辨識未完成<small>已轉人工審核，照片不需重傳</small></span>}
            {submission.review_note && <small>{submission.review_note}</small>}
            <time>{new Date(submission.submitted_at).toLocaleString("zh-TW")}</time>
            {open && submission.status !== "correct" && <button
              type="button"
              className="hunt-delete"
              disabled={busy || deletingId !== null}
              onClick={() => removeSubmission(submission)}
            >{deletingId === submission.id ? "刪除中…" : "刪除這筆錯誤投稿"}</button>}
          </article>)}
        </div> : <p className="muted">尚未上傳照片。</p>}
      </section>}

      {(event.reveal_player_photos || event.reveal_answer_photos) && <section className="hunt-public-photos">
        <header>
          <div><h2>活動照片公開區</h2><p>只有管理員人工確認正確的玩家照片與啟用中的答案照片會在這裡顯示。</p></div>
          {event.photo_reveal_at && <time>{photoRevealReached ? "已公開" : `預計 ${new Date(event.photo_reveal_at).toLocaleString("zh-TW")} 公開`}</time>}
        </header>
        {!photoRevealReached ? (
          <div className="hunt-photo-locked"><i>鎖</i><b>公開時間尚未到達</b><span>其他玩家的投稿照片與答案圖仍保持隱藏。</span></div>
        ) : <>
          {event.reveal_player_photos && <div className="hunt-public-photo-group">
            <h3>玩家找到的正確照片</h3>
            {showPlayerPhotos && publicPlayerPhotos.length ? <div className="hunt-public-photo-grid">
              {publicPlayerPhotos.map((photo) => <figure key={`player-${photo.id}`}>
                <Image src={photo.signedUrl} width={360} height={270} alt={`${photo.nickname} 找到的 H${String(photo.targetNumber).padStart(3, "0")}`} unoptimized />
                <figcaption><b>H{String(photo.targetNumber).padStart(3, "0")}</b><span>{photo.nickname}</span></figcaption>
              </figure>)}
            </div> : <p className="muted">目前沒有可公開的正確照片。</p>}
          </div>}
          {event.reveal_answer_photos && <div className="hunt-public-photo-group">
            <h3>答案與點位參考照片</h3>
            {showAnswerPhotos && publicAnswerPhotos.length ? <div className="hunt-public-photo-grid">
              {publicAnswerPhotos.map((photo) => <figure key={`answer-${photo.id}`}>
                <Image src={photo.signedUrl} width={360} height={270} alt={`H${String(photo.targetNumber).padStart(3, "0")} 答案照片`} unoptimized />
                <figcaption><b>H{String(photo.targetNumber).padStart(3, "0")}</b><span>{photo.label || "未命名點位"}</span></figcaption>
              </figure>)}
            </div> : <p className="muted">目前沒有啟用中的答案照片。</p>}
          </div>}
        </>}
      </section>}

      <section className="hunt-ranking">
        <h2>尋物活動排行榜</h2>
        {canShowHuntRanking(event) ? (
          ranking.length ? ranking.map((row) => <article key={row.profileId}>
            <b>第 {row.rank} 名</b><span>{row.nickname}</span><strong>{row.correctCount} 個</strong>
          </article>) : <p className="muted">目前尚無正確紀錄。</p>
        ) : <div className="hunt-ranking-hidden">排行榜目前未公開，結果公布後會顯示。</div>}
      </section>
    </>
  );
}
