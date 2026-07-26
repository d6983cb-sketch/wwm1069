# 江湖百相錄

燕雲十六聲 Discord 公會 Cos 投稿與投票正式網站。

## 技術

- Next.js App Router、React、TypeScript、Tailwind CSS
- Supabase Authentication（Discord OAuth）
- Supabase PostgreSQL 與 Storage
- Vercel

## 正式功能

- Discord 是唯一登入方式，Discord ID 與活動暱稱皆不可重複。
- 每場活動每人只能投稿一次，作品照片 1–5 張。
- AI 背景作品必須上傳管理員專用查核原圖。
- 每人五票、每件作品最多一票，限制由 PostgreSQL 交易鎖與資料庫約束執行。
- 投稿、投票及排行榜依管理員設定與活動時間自動切換。
- 管理員可審核、取消資格、刪除投稿、鎖定流程、發布公告及匯出 CSV。
- 公開作品具有獨立網址；查核原圖使用短效簽名網址。

## 部署

完整設定步驟請見 `PRODUCTION_SETUP.md`，資料庫結構位於
`supabase/schema.sql`。GitHub `main` 分支更新後由 Vercel 自動部署。
