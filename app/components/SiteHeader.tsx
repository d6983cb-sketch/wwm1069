"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

export default function SiteHeader({ nickname }: { nickname?: string | null }) {
  const pathname = usePathname();
  const login = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: `${location.origin}/auth/callback?next=/`,
        scopes: "identify guilds",
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
        <Link className={pathname === "/rules" ? "active" : ""} href="/rules">活動規則</Link>
        <Link className={pathname === "/awards" ? "active" : ""} href="/awards">頒獎頁</Link>
        {nickname && <Link className={pathname === "/notifications" ? "active" : ""} href="/notifications">通知</Link>}
      </nav>
      <button className="discord" onClick={nickname ? logout : login}>
        ◉ {nickname ? `${nickname} · 登出` : "Discord 登入"}
      </button>
    </header>
  );
}
