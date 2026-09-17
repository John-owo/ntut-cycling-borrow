# Supabase 後端

GitHub Pages 只提供前端；持久資料與權限由 Supabase 管理。請使用免費專案，不建立付費資源。

1. 在 Supabase SQL Editor 執行 `migrations/001_borrow.sql` 一次。使用 PostgreSQL 內建 SHA-256，不需要額外 extension。
2. 在 Authentication 為社長、副社長各自建立不同使用者，停用公開註冊。把各自 Auth UUID 加入允許名單：`insert into private.admins(user_id) values ('實際 UUID');`。勿以 user metadata 授權。
3. 前端只設定 Project URL 與 anon/publishable key。service_role、資料庫密碼不得放在 GitHub、前端或瀏覽器。
4. 管理員登入後，透過 `admin_settings` 設定實際總車數與 HTTPS 聯絡入口。初始總車數是 null，尚不能登記。

RPC 名稱與參數：`summary()`、`register(p_student_id,p_name,p_contact_type,p_contact,p_token)`、`lookup(p_token)`、`admin_records()`、`admin_action(p_id,p_action,p_bike_note)`、`admin_settings(p_total,p_contact_url)`。回傳 JSON 與本機 API 相同；錯誤由 PostgREST 的 `message` 欄位轉成前端 error。管理登入/登出使用 Supabase Auth，登入結果由 adapter 轉成本機 token/username/expires 格式。私人表不在 API exposed schema，亦不向 anon/authenticated 開放表權限；RLS 全數啟用。

查詢碼由瀏覽器產生 32 bytes 隨機值，轉為 64 位 lowercase hex；DB 只保存 SHA-256。查詢必須持有完整查詢碼，不接受學號或流水號。所有異動鎖定同一 settings row，保證庫存、有效學號、順位一致；重送同查詢碼與相同資料回原紀錄，相同終態操作不重寫 audit。

學號會去除頭尾空白並轉大寫，避免大小寫造成重複登記。聯絡方式固定接受 `phone`、`line`、`instagram`，聯絡內容維持自由填寫。

## 真 PostgreSQL 驗證方案

`tests/postgres.test.mjs` 已使用 PGlite 的真正 PostgreSQL 引擎執行原始 migration，驗證权限、幹部 UUID、查詢碼隔離、重送、順位、超借拒絕、歸還、取消與 audit；SHA-256 使用 PostgreSQL 內建函式，沒有模擬雜湊。PGlite 僅單一連線，此測試不證明兩個雲端連線的並行交車行為。使用隔離測試資料庫或新的 Supabase 測試專案完成下列驗證，勿在營運資料庫放測試社員。

- 純 PostgreSQL 測試需先建立 `anon` / `authenticated` roles、`auth.users(id uuid)` 及 `auth.uid()`（讀取 `request.jwt.claim.sub`），再用 psql `ON_ERROR_STOP=1` 執行 migration。Supabase 本身已有這些物件。
- 以 `SET ROLE anon` 驗證直接讀取 private 表失敗；summary 只回匿名數字；admin RPC 不可執行。以 authenticated 的非幹部 UUID 驗證所有 admin RPC 拒絕。
- 建立兩位測試幹部 UUID 放 allowlist，`SET LOCAL request.jwt.claim.sub='UUID'` 模擬測試身分；設定一台、登記兩人，重送相同碼 id 不變，不同码同學號失敗，未知查詢碼查不到資料。
- 兩個 psql sessions 同時呼叫不同人的 lend：恰好一個成功，另個無庫存；borrowed=1。重 lend、重 return 不增加 audit，不造成負數。先借後登記者應可越序交車，剩下的人重新排序。
- 已借學號重登記失敗；總車數降至借出數以下失敗；cancel 僅允許 waiting。還車不重回佇列，歷史仍可查，audit 記不同 UUID。
- 中斷／重新連線後查詢同碼仍存在。兩裝置經真 PostgREST 與 Auth 驗證相同數字與最新順位，再驗證無效／過期 JWT、跨帳號私人隔離。

本 migration 已通過嵌入式 PostgreSQL 測試，尚未在託管 Supabase、真 PostgREST / Auth 或多連線環境執行；正式部署仍需上述驗證。Supabase 的 API 限流/CAPTCHA 配置應在營運前依公開登記量確認；SQL 功能本身不宣稱已提供本機 HTTP 限流。
