"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";

export default function SiteHeader({ nickname }: { nickname?: string | null }) {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (!nickname) return;
    let active = true;
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { unreadCount: 0 })
      .then((body) => active && setUnreadCount(Number(body.unreadCount) || 0))
      .catch(() => undefined);
    return () => { active = false; };
  }, [nickname, pathname]);
  const login = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${location.origin}/auth/callback?next=/`,
        scopes: "identify email guilds",
      },
    });
  };
  const logout = async () => {
    if (!window.confirm("確定要登出活動網站？")) return;
    await createClient().auth.signOut();
    location.href = "/";
  };
  return (
    <header className="top">
      <Link className="brand" href="/">江湖百相錄 <i>百相</i></Link>
      <nav>
        <Link className={pathname === "/" ? "active" : ""} href="/">作品</Link>
        <Link className={pathname.startsWith("/hunt") ? "active" : ""} href="/hunt">尋物活動</Link>
        <Link className={pathname === "/rules" ? "active" : ""} href="/rules">活動規則</Link>
        <Link className={pathname === "/awards" ? "active" : ""} href="/awards">頒獎頁</Link>
        {nickname && <Link className={pathname === "/notifications" ? "active" : ""} href="/notifications">通知{unreadCount > 0 && <span className="notice-badge" aria-label={`${unreadCount} 則未讀`}>{unreadCount > 99 ? "99+" : unreadCount}</span>}</Link>}
      </nav>
      <button className="discord" onClick={nickname ? logout : login}>
        ◉ {nickname ? `${nickname} · 登出` : "Discord 登入"}
      </button>
    </header>
  );
}
