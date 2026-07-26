"use client";

import Link from "next/link";
import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import ImageCarousel from "@/app/components/ImageCarousel";
import type { EntryRecord, EventRecord } from "@/lib/types";
import { eventPhase, isVotingOpen } from "@/lib/types";

type Sort = "random" | "high" | "low" | "new" | "old";

export default function HomeClient({
  event,
  entries,
  announcement,
  nickname,
  needsProfile,
  initialVotes,
}: {
  event: EventRecord | null;
  entries: EntryRecord[];
  announcement: string | null;
  nickname: string | null;
  needsProfile: boolean;
  initialVotes: number[];
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("random");
  const [votes, setVotes] = useState(initialVotes);
  const [voteCounts, setVoteCounts] = useState<Record<number, number>>(
    Object.fromEntries(entries.map((entry) => [entry.id, entry.vote_count])),
  );
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [voteBusy, setVoteBusy] = useState(false);
  const [profileOpen] = useState(needsProfile);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [randomOrder] = useState(() => entries.map((entry) => entry.id));
  const phase = eventPhase(event);
  const showCounts = event?.leaderboard_mode !== "hidden";
  const votingOpen = isVotingOpen(event, now);
  const deadline = event
    ? phase === "投稿中" ? Date.parse(event.submission_ends_at)
      : phase === "投票中" ? Date.parse(event.voting_ends_at)
        : null
    : null;
  const remaining = deadline ? Math.max(0, deadline - now) : 0;
  const countdown = deadline
    ? `${Math.floor(remaining / 86400000)} 天 ${Math.floor((remaining % 86400000) / 3600000)} 時 ${Math.floor((remaining % 3600000) / 60000)} 分`
    : phase;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("zh-Hant");
    const list = entries.filter((entry) =>
      [entry.nickname, entry.character_name, entry.source_game].some((text) =>
        text.toLocaleLowerCase("zh-Hant").includes(q),
      ),
    );
    if (sort === "high") return [...list].sort((a, b) => b.vote_count - a.vote_count);
    if (sort === "low") return [...list].sort((a, b) => a.vote_count - b.vote_count);
    if (sort === "new") return [...list].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (sort === "old") return [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    return [...list].sort((a, b) => randomOrder.indexOf(a.id) - randomOrder.indexOf(b.id));
  }, [entries, query, randomOrder, sort]);

  const discordLogin = async () => {
    await createClient().auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${location.origin}/auth/callback?next=/`,
        scopes: "identify guilds",
      },
    });
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: newName }),
    });
    const body = await response.json();
    if (body.error === "nickname_taken") return setMessage("這個暱稱已有人使用，請重新命名。");
    if (!response.ok) return setMessage("暱稱暫時無法儲存，請稍後再試。");
    location.reload();
  };

  const vote = async () => {
    if (confirmId === null) return;
    if (!nickname) return discordLogin();
    const remove = votes.includes(confirmId);
    setVoteBusy(true);
    try {
      const response = await fetch("/api/votes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryId: confirmId, action: remove ? "remove" : "add" }),
      });
      const body = await response.json();
      if (!response.ok) {
        const errors: Record<string, string> = {
          vote_limit_reached: "五票都已使用。",
          voting_closed: "目前尚未開放投票。",
          duplicate_vote: "你已經投過這件作品。",
          voter_unavailable: "此帳號目前無法參與投票。",
        };
        setMessage(errors[body.error] ?? "目前無法投票，請稍後再試。");
      } else {
        setVotes(remove ? votes.filter((id) => id !== confirmId) : [...votes, confirmId]);
        setVoteCounts((current) => ({
          ...current,
          [confirmId]: Math.max(0, (current[confirmId] ?? 0) + (remove ? -1 : 1)),
        }));
        setMessage(remove ? "已取消投票，票數已返還。" : "投票完成。");
      }
    } finally {
      setVoteBusy(false);
      setConfirmId(null);
    }
  };

  return (
    <>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <p>◇ 燕雲十六聲 Discord 公會活動 ◇</p>
            <h1>百相入畫<span>・</span><br />江湖 Cos 盛會</h1>
            <div className="count"><i>令</i><div><small>{deadline ? `${phase}截止` : "目前階段"}</small><strong>{countdown}</strong></div></div>
            <div className="hero-actions">
              <Link className="primary" href="/submit">我要投稿</Link>
              <Link href="/rules">查看規則</Link>
              <div><small>剩餘票數</small><b>{5 - votes.length} / 5</b></div>
            </div>
          </div>
          <div className="hero-image"><Image src="/images/hero.webp" alt="原創武俠 Cos 主視覺" fill priority sizes="(max-width: 760px) 100vw, 39vw" /><span>一身入畫・百相成章</span></div>
        </section>
        <aside className="notice"><b>最新公告</b><span>♢</span><p>{announcement || "目前沒有新公告。"}</p></aside>
        <section className="gallery">
          <header>
            <div><small>ENTRIES · 參賽展廳</small><h2>入畫之作</h2></div>
            <div className="tools">
              <label>⌕ <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋投稿者、角色或遊戲" /></label>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="random">🎲 隨機排列</option>
                {showCounts && <option value="high">♥ 票數高→低</option>}
                {showCounts && <option value="low">♥ 票數低→高</option>}
                <option value="new">◷ 最新投稿</option><option value="old">◴ 最早投稿</option>
              </select>
              <b>♥ 剩餘 {5 - votes.length} / 5</b>
            </div>
          </header>
          {shown.length ? (
            <div className="grid">
              {shown.map((entry, index) => (
                <article className="card" key={entry.id} style={{ animationDelay: `${index * 55}ms` }}>
                  <div className="photo">
                    <ImageCarousel images={entry.images} alt={`${entry.character_name} Cos 作品`} href={`/entry/${entry.id}`} compact />
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {entry.uses_ai_background && <i>AI 背景</i>}
                  </div>
                  <div className="card-body">
                    <i className="mini-seal">{entry.nickname[0]}</i>
                    <div><h3>{entry.nickname}</h3><p>{entry.character_name}</p><small>{entry.source_game}</small></div>
                    <button
                      className={votes.includes(entry.id) ? "heart voted" : "heart"}
                      disabled={!votingOpen || voteBusy}
                      title={votingOpen ? "投票" : "目前尚未開放投票"}
                      onClick={() => nickname ? setConfirmId(entry.id) : discordLogin()}
                    >{votes.includes(entry.id) ? "♥" : "♡"}</button>
                  </div>
                  <div className="support">♥ {showCounts ? `${voteCounts[entry.id] ?? 0} 票` : "已獲得支持"}</div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <i>空</i>
              <h3>{query.trim() ? "找不到符合條件的作品" : "目前還沒有公開作品"}</h3>
              <p>{query.trim() ? "請嘗試其他投稿者、角色或遊戲名稱。" : "完成投稿的作品會顯示在這裡。"}</p>
            </div>
          )}
        </section>
      </main>

      {profileOpen && (
        <div className="backdrop"><section className="modal">
          <i className="modal-seal">名</i><h2>留下活動暱稱</h2>
          <p>暱稱最長 20 字，設定後不可自行修改。</p>
          <form className="name-form" onSubmit={saveProfile}>
            <label>活動暱稱<input autoFocus maxLength={20} value={newName} onChange={(e) => setNewName(e.target.value)} required /></label>
            <small>{newName.length} / 20 · 不可空白或重複</small>
            <button className="primary">確認名號</button>
          </form>
        </section></div>
      )}
      {confirmId !== null && (
        <div className="backdrop" onMouseDown={(e) => e.currentTarget === e.target && setConfirmId(null)}>
          <section className="modal">
            <button className="close" onClick={() => setConfirmId(null)}>×</button>
            <i className="modal-seal">票</i><h2>{votes.includes(confirmId) ? "取消這一票？" : "確定投出一票？"}</h2>
            <p>{votes.includes(confirmId) ? "取消後會立即返還一票。" : "每件作品最多只能投一票。"}</p>
            <div className="modal-actions"><button disabled={voteBusy} onClick={() => setConfirmId(null)}>再想一下</button><button className="primary" disabled={voteBusy} onClick={vote}>{voteBusy ? "處理中…" : "確認"}</button></div>
          </section>
        </div>
      )}
      {message && <div className="toast" onClick={() => setMessage("")}>{message}</div>}
    </>
  );
}
