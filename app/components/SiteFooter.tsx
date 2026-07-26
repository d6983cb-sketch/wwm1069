import Link from "next/link";

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div><b>江湖百相錄</b><span>Discord 公會內部 Cos 投稿與投票活動</span></div>
      <Link href="/rules">活動規則</Link>
      <Link href="/admin">管理入口</Link>
      <small>原創非官方活動網站 · 不使用任何官方素材</small>
    </footer>
  );
}
