"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import {
  compressReplacementPhoto,
  replacementFileExtension,
  replacementUploadError,
  validateReplacementPhoto,
  withUploadTimeout,
} from "@/lib/client-image-upload";
import { calculateHuntProgress, canShowHuntRanking, isHuntOpen, type HuntEventRecord, type HuntRankingRow, type HuntSubmissionRecord } from "@/lib/hunt";

type OwnSubmission = HuntSubmissionRecord & { signedUrl: string | null };

const statusLabels = {
  pending: "等待審核",
  correct: "正確",
  incorrect: "不正確",
  duplicate: "重複",
};

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function HuntClient({
  event,
  userId,
  nickname,
  disqualified,
  submissions,
  ranking,
}: {
  event: HuntEventRecord | null;
  userId: string | null;
  nickname: string | null;
  disqualified: boolean;
  submissions: OwnSubmission[];
  ranking: HuntRankingRow[];
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const open = isHuntOpen(event);

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

  const submit = async (formEvent: FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (!file || !userId || !event) return;
    // React's currentTarget is only guaranteed while the event handler is
    // running synchronously. Read the form before image compression/upload;
    // otherwise currentTarget can be null by the time the awaited work ends.
    const form = new FormData(formEvent.currentTarget);
    const playerNote = String(form.get("playerNote") ?? "");
    const validation = validateReplacementPhoto(file);
    if (validation) return setMessage(validation);
    setBusy(true);
    setMessage("正在處理照片…");
    let imagePath: string | null = null;
    try {
      const compressed = await compressReplacementPhoto(file, "image/jpeg");
      const fileHash = await sha256(compressed);
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
      setFile(null);
      setPreview(null);
      setMessage(body.message ?? "照片已送出，等待審核。");
      router.refresh();
    } catch (error) {
      console.error("[hunt-upload] submission failed", {
        stage: imagePath ? "create-record" : "upload-proof",
        error,
      });
      const fallback = replacementUploadError(error);
      setMessage(error instanceof Error && /[\u4e00-\u9fff]/.test(error.message)
        ? error.message
        : fallback === "照片修正失敗，原作品仍保持不變。"
          ? "尋物照片上傳失敗，請重新整理後再試一次。"
          : fallback);
    } finally {
      setBusy(false);
    }
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

  const progress = calculateHuntProgress(submissions);
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
            <div><dt>暫定找到</dt><dd>{progress.provisionalCount}</dd></div>
            <div><dt>人工確認</dt><dd>{progress.confirmedCount}</dd></div>
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
              <span>{file ? "更換照片" : "選擇照片"}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                if (next) {
                  const validation = validateReplacementPhoto(next);
                  if (validation) setMessage(validation);
                  else {
                    setFile(next);
                    setPreview(URL.createObjectURL(next));
                    setMessage("");
                  }
                }
                event.currentTarget.value = "";
              }} />
            </label>
            {preview && <Image className="hunt-preview" src={preview} width={640} height={480} alt="準備上傳的尋物照片預覽" unoptimized />}
            <label>補充說明（選填）<textarea name="playerNote" maxLength={200} placeholder="例如：在樹叢旁、屋簷後方找到" /></label>
            <button className="primary" disabled={busy || !file}>{busy ? (event.auto_match_enabled ? "自動辨識中…" : "正在送出…") : event.auto_match_enabled ? "送出並立即辨識" : "送出等待審核"}</button>
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
            {submission.status === "pending" && submission.auto_status === "matched" && submission.auto_match_target_number && <span className="hunt-auto-player">暫定 H{String(submission.auto_match_target_number).padStart(3, "0")} · 相似度 {Math.round((submission.auto_similarity ?? 0) * 100)}%<small>等待人工確認</small></span>}
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
