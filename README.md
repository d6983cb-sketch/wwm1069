# 燕雲 · 俠影誌

Discord 公會 Cos 投稿與投票網站（Next.js App Router / TypeScript / Tailwind / Supabase）。

## 啟動

1. 安裝 Node.js 20+。
2. `npm install`
3. 複製 `.env.example` 為 `.env.local`，填入 Supabase 與 Discord OAuth 設定。
4. 在 Supabase SQL Editor 執行 `supabase/schema.sql`。
5. `npm run dev`

目前介面已包含首頁、隨機/排序/搜尋、作品詳情、Rules、管理後台視覺與 Supabase schema。Discord OAuth、Storage 上傳、Server Actions 投票與管理員權限是下一階段接線點。
