"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { taipeiInputToIso, toTaipeiInput } from "@/lib/taipei-datetime";
import type { HuntEventRecord, HuntRankingRow, HuntSubmissionRecord } from "@/lib/hunt";

type ReviewRow = HuntSubmissionRecord & {
  signedUrl: string | null;
  nickname: string;
  discordId: string;
  disqualified: boolean;
};

const statusLabels = { pending: "待審核", correct: "正確", incorrect: "錯誤", duplicate: "重複" };

function defaultInput(offsetDays: number) {
  return toTaipeiInput(new Date(Date.now() + offsetDays * 86400000).toISOString());
}

export default function HuntAdminClient({ event, submissions, ranking, canConfigure, canReview }: {
  event: HuntEventRecord | null;
  submissions: ReviewRow[];
  ranking: HuntRankingRow[];
  canConfigure: boolean;
  canReview: boolean;
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
        <label>活動說明<textarea name="description" maxLength={2000} defaultValue={event?.description ?? "在建築範圍內找出被藏起來的物品。它可能被樹叢或建築遮擋，只露出一小部分。每找到一個請拍照上傳。"} /></label>
        <button className="primary" disabled={busy}>{busy ? "儲存中…" : event ? "儲存尋物活動設定" : "建立尋物活動"}</button>
      </form>
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
          {submission.disqualified && <strong className="form-error">此玩家已取消資格</strong>}
          <form onSubmit={(formEvent) => review(formEvent, submission.id)}>
            <label>判定<select name="status" defaultValue={submission.status === "pending" ? "correct" : submission.status}>
              <option value="correct">正確</option><option value="incorrect">錯誤</option><option value="duplicate">重複</option>
            </select></label>
            <label>藏物編號<select name="targetNumber" defaultValue={submission.matched_target_number ?? ""}>
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
