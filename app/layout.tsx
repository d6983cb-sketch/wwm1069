import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "江湖百相錄｜公會 Cos 盛會",
  description: "Discord 公會 Cos 投稿與投票網站",
  other: { "codex-preview": "development" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
