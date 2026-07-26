# Vercel + Supabase 正式部署

## Supabase

1. 建立 Supabase 專案。
2. 在 SQL Editor 執行 `supabase/schema.sql`。
3. 在 Authentication → Providers 啟用 Discord。
4. 把 Discord Developer Portal 的 Client ID 與 Client Secret 填入 Supabase。
5. 把 Supabase 顯示的 Discord callback URL 加入 Discord OAuth2 Redirects。
6. 在 Supabase URL Configuration 加入正式 Vercel 網址及
   `https://你的網域/auth/callback`。

## Vercel 環境變數

依 `.env.example` 設定：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`（Secret）
- `ADMIN_DISCORD_IDS`：管理員 Discord ID，可用逗號分隔多位
- `NEXT_PUBLIC_SITE_URL`

`SUPABASE_SERVICE_ROLE_KEY` 只能放在 Vercel 的伺服器環境變數，不可放入
Git 或提供給前端。

## 第一位管理員

部署前先在 `ADMIN_DISCORD_IDS` 填入管理員的 Discord ID。該帳號第一次以
Discord 登入並設定活動暱稱後，會自動取得管理員權限。

網站不包含範例投稿。資料庫尚未建立活動時，管理員登入 `/admin` 即可設定
第一場活動；首頁會顯示正式空狀態。
