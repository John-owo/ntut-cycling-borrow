# Supabase 後端

## 濫用防護與幹部工具（003）

依序套用 001、002 後執行 `migrations/003_abuse_controls.sql`。內容：

- 匿名 `register` 節流：全站每分鐘 15 次、每小時 90 次、每日 300 次新登記嘗試；同一來源網路每 10 分鐘 10 次。來源以 `cf-connecting-ip`／`x-real-ip`／`x-forwarded-for` 最後一段的 SHA-256 記錄在 `private.register_attempts`，不存原始 IP，超過一天自動清除。重送既有查詢碼不計次。超限回傳 HTTP 429，訊息為「目前登記人數較多…」。上限寫在 `private.check_register_throttle()`，若社團活動需要放寬，另開 migration 調整。
- `admin_cancel_many(p_ids bigint[])`：一次取消多筆等候登記（最多 500 個 id），非等候中的 id 放在 `skipped`，每筆各寫一筆 `cancel` audit 並標記 `bulk:true`。用於清理垃圾登記。
- `admin_records()` 的 audit 只回最近 500 筆，`actor` 改為幹部 email（查不到時退回 UUID 字串），另附 `actorId`。
- `admin_export()`：完整 JSON 備份（settings、opening、records 含 token_hash、audit、opening_returns、admins email），呼叫本身寫入 `export` audit。本機對應 `GET /api/admin/export`、`POST /api/admin/cancel-many { ids }`。
- 備份指令：`node scripts/export-backup.mjs`，以環境變數 `BIKE_ADMIN_EMAIL`／`BIKE_ADMIN_PASSWORD` 提供幹部帳密，輸出到 `backups/`（Git 忽略）。檔案含個資，請私下保存。免費方案無自動備份且閒置 7 天會暫停專案，建議每學期至少匯出一次。
- 前端目前尚未提供批次取消與匯出按鈕；UI 改版完成後再接 `api.js` 路由。


## 期初借出盤點（002）

已套用的 `001_borrow.sql` 保持原樣，接著執行 `migrations/002_opening_loans.sql`。002 只建立期初盤點資料，初始尚未歸還數量為 0，不生成借用人或借用明細。實際期初數量、預計歸還日期及盤點註記，由授權的管理者使用一次性 SQL 初始化；先鎖定 settings row 並確認「期初尚未歸還＋網站借用中」不超過總車數。未到位的新車不計入總數。

借出總數包含期初盤點與網站借用中兩部分；備取與庫存檢查使用同一合併數量。預計歸還日期只是幹部提示，日期到了也不會自動減少借出數。

`admin_records()` 另回傳 `opening: { outstanding, expectedReturn, note }`；公開 summary 不回傳期初日期或註記。管理員實際收車後呼叫 `admin_return_opening(p_count, p_request_id)`，其中 request ID 為前端生成的 UUID。同一次操作重試必須沿用原 UUID，成功回傳 `{ receipt, opening, summary }`。receipt 保存 requestId、count、actor、at、remaining；相同 UUID 與 count 重送回原收據及最新摘要，相同 UUID 改變數量會被拒絕。

本機對應端點：`POST /api/admin/opening-return { count, requestId }`，仍需 bearer 管理憑證。開放一般社員的查詢功能無法讀取／操作期初盤點。

PGlite 測試會實際執行 001＋002，驗證合併庫存、不能降低至借出總數以下、歸還重試與 audit。SQLite HTTP 測試另驗證重啟後重試不會再次扣減。這些證據仍不代替 Supabase 託管環境的多連線並行及 Auth 驗證。

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
