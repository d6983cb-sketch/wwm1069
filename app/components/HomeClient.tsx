"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { EntryRecord, EventRecord } from "@/lib/types";
import { eventPhase } from "@/lib/types";

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
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [profileOpen, setProfileOpen] = useState(needsProfile);
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const phase = eventPhase(event);
  const showCounts = event?.leaderboard_mode !== "hidden";
  const votingOpen = phase === "投票中";
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
    return [...list].sort(() => Math.random() - 0.5);
  }, [entries, query, sort]);

  const discordLogin = async () => {
    await createClient().auth.signInWithOAuth({
      provider: "discord",
      options: { redirectTo: `${location.origin}/auth/callback?next=/` },
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
    const response = await fetch("/api/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: confirmId, action: remove ? "remove" : "add" }),
    });
    const body = await response.json();
    if (!response.ok) {
      setMessage(body.error === "vote_limit_reached" ? "五票都已使用。" : "目前無法投票，請稍後再試。");
    } else {
      setVotes(remove ? votes.filter((id) => id !== confirmId) : [...votes, confirmId]);
      setMessage(remove ? "已取消投票，票數已返還。" : "投票完成。");
    }
    setConfirmId(null);
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
          <div className="hero-image"><img src="/images/hero.webp" alt="原創武俠 Cos 主視覺" /><span>一身入畫・百相成章</span></div>
        </section>
        <aside className="notice"><b>最新公告</b><span>♢</span><p>{announcement || "目前沒有新公告。"}</p></aside>
        <section className="gallery">
          <header>
            <div><small>ENTRIES · 參賽展廳</small><h2>入畫之作</h2></div>
            <div className="tools">
              <label>⌕ <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋投稿者、角色或遊戲" /></label>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="random">🎲 隨機排列</option><option value="high">♥ 票數高→低</option>
                <option value="low">♥ 票數低→高</option><option value="new">◷ 最新投稿</option><option value="old">◴ 最早投稿</option>
              </select>
              <b>♥ 剩餘 {5 - votes.length} / 5</b>
            </div>
          </header>
          {shown.length ? (
            <div className="grid">
              {shown.map((entry, index) => (
                <article className="card" key={entry.id} style={{ animationDelay: `${index * 55}ms` }}>
                  <Link className="photo" href={`/entry/${entry.id}`}>
                    <img src={entry.images[0]} alt={`${entry.character_name} Cos 作品`} />
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    {entry.uses_ai_background && <i>AI 背景</i>}
                  </Link>
                  <div className="card-body">
                    <i className="mini-seal">{entry.nickname[0]}</i>
                    <div><h3>{entry.nickname}</h3><p>{entry.character_name}</p><small>{entry.source_game}</small></div>
                    <button
                      className={votes.includes(entry.id) ? "heart voted" : "heart"}
                      disabled={!votingOpen}
                      onClick={() => nickname ? setConfirmId(entry.id) : discordLogin()}
                    >{votes.includes(entry.id) ? "♥" : "♡"}</button>
                  </div>
                  <div className="support">♥ {showCounts ? `${entry.vote_count} 票` : "已獲得支持"}</div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state"><i>空</i><h3>目前還沒有公開作品</h3><p>通過管理員審核的投稿會顯示在這裡。</p></div>
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
            <div className="modal-actions"><button onClick={() => setConfirmId(null)}>再想一下</button><button className="primary" onClick={vote}>確認</button></div>
          </section>
        </div>
      )}
      {message && <div className="toast" onClick={() => setMessage("")}>{message}</div>}
    </>
  );
}
