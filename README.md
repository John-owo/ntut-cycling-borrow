# 北科大自由車社借車 MVP

公開品牌：北科大自由車社／NTUT CYCLING CLUB。

部署目標：GitHub Pages 前端 + Supabase 免費方案資料庫與管理登入。不需要另購網域。
目前本機版可實際保存登記、查詢順位、借出、歸還、取消與設定；Supabase 資料庫已套用 001／002，公開 API 與匿名權限隔離已實測；兩位幹部實際登入仍須完成驗證。不要把本機測試當作完整雲端验收。

## 本機操作

Node.js 24 以上。前端及本機服務無執行期套件依賴。

```powershell
node server/start.mjs
```

開啟 http://127.0.0.1:4173 。初始車數未設定，資料保存在 `data/bikes.sqlite`（Git 忽略）。關閉再啟動仍保存。服務預設只接受本機連線，不是正式託管。

建立本機個別管理員：在自己的終端設定 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 環境變數，再執行 `node server/setup-admin.mjs`。密碼至少 12 字元；不要把密碼提交到 Git。兩位幹部各建一個帳號。這些本機帳號與 Supabase 帳號分開。

登入 `admin.html` 後填實際總車數、正式社團 HTTPS 聯絡入口。此專案不預填真實車數／帳號／借用紀錄。`tests/serve-qa.mjs` 僅供隔離的合成資料測試，不作正式營運。

## 雲端設定

1. 在自己的 Supabase 免費專案依序執行 `supabase/migrations/001_borrow.sql`、`002_opening_loans.sql`。先確認是專用新專案，避免与既有同名表衝突。此 migration 用 transaction，一次執行；請勿在含正式資料的專案任意重跑或刪表。
2. 在 Supabase Auth 建立兩位幹部各自的登入身分，將各自 UUID 加入 `private.admins`。詳見 `supabase/README.md`。一般註冊用戶不會自動取得管理權；前端沒有幹部自行註冊功能。關閉不需要的公開 Auth signup。
3. GitHub 儲存庫的 Actions variables 設定 `SUPABASE_URL` 與 `SUPABASE_PUBLISHABLE_KEY`（公開 publishable／anon key，不是 secret/service_role key）。私人金鑰與資料庫密碼不能進 GitHub Pages。
4. GitHub Pages 的來源選 GitHub Actions。workflow 只會發布 `public/`，不包含本機資料庫或 SQL source；正式網站無需 Node 伺服器。
5. 登入網站管理端，填實際總車數、社團联絡入口。先用隔離測試專案驗證登入、匿名隔離、登記、跨裝置查詢、交車與收車，再開放社員使用。

尚未設定兩個公開變數時，CI 執行測試、跳過正式發布，不以空後端交付可用系統。若需要本機檢查雲端前端，把 `public/config.js` 設成 Supabase 模式；只可放公開連線資訊。

## 業務預設

- 每人一台；同學號（去除頭尾空白、統一大寫）同時至多一筆等候／借用中紀錄。
- 登記以成功寫入的序號排序，不依前端送出時間；取消／交車退出等候。
- 排隊 p；尚未借出 R；p > R 時備取 p−R，否則顯示可能涵蓋，不保證有適合車。
- 幹部可為非首位交車，不擅自訂定保留、逾時、交車優先權。
- 歸還只結束借用，不重新入列。庫存從紀錄計算，不另外維護可漂移的數字。
- 私人查詢碼為 256-bit 隨機值；只儲存 hash，查詢不接受猜學號／流水號。查詢碼是持有者憑證，請私下保存。遺失時由幹部核對並協助處理，沒有不安全的學號找回入口。
- 瀏覽器只保存查詢碼或本次管理登入憑證；業務資料在伺服器。本機與雲端資料庫不自動互相搬移。
- 每 15 秒更新、切回頁面更新；失敗清楚標示舊資料，超過 45 秒標示過期。後端仍再次檢查狀態與庫存。
- 無線上選車、完整會員、付款、電子簽名、預約時段或自動通知。
- 匿名登記有節流（全站每分鐘 15／每小時 90／每日 300 次，同一來源網路每 10 分鐘 10 次），超限回 429 並提示稍後再試；幹部可批次取消垃圾登記。詳見 `supabase/README.md`。
- 備份：幹部以 `node scripts/export-backup.mjs` 匯出完整 JSON 到 `backups/`；Supabase Auth 公開註冊已關閉，新增幹部需在 Dashboard 建帳號再加入 `private.admins`。

## 驗證與限制

```powershell
npm.cmd ci
npm.cmd test
```

SQLite 測試使用真 HTTP 與磁碟資料庫，包含並行最後一台、冪等、取消、歸還、越序交車、資料保存與權限。PostgreSQL 測試使用 PGlite 真 PostgreSQL 引擎執行 migration 與角色隔離；Auth 的使用者身分在測試內模擬，並非 Supabase Auth 的 live 驗證。PGlite 單連線不等於雲端跨連線併發證據。

正式上線前待驗證：Supabase Auth 登入、Data API grants、兩位管理員實際權限、GitHub Pages 跨裝置連線、正式資料備份與復原安排。免費服務額度與暫停政策依供應商當時規則；未啟用任何付費方案。公開登記沒有學籍驗證；同學號去重不代表身分已核驗。操作紀錄限幹部查看，請由社團決定適當的資料保留期間。

本機展示不等於正式社團驗收。Sites 沒有用於此專案的發布。

## 既有借用

啟用前已借出但尚無社員明細的車，以獨立期初借出數量保存，不建立假學號或假社員。公開已借出為期初尚未歸還加上網站正式借用中的數量。幹部在「借用中」確認每次實際收到的台數，歸還以永久操作識別碼防止重送扣重；預計歸還日不自動更改庫存。未來新增車輛僅在實際到位後修改總數。

GitHub Pages： https://john-owo.github.io/ntut-cycling-borrow/ （部署與正式驗證狀態以 Actions／本次交付為準）。
