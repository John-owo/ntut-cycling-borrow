# 資安說明（SECURITY.md）

北科大自由車社借車系統的資安假設、驗證模型、敏感元件、目前設定、已知剩餘風險與開發原則。
本文件為資安相關規範的權威來源；`README.md`、`supabase/README.md` 的相關段落為摘要，若有出入以本文件為準。
最後一次完整檢視：2026-09-20（第二輪深入檢查）。

## 1. 系統邊界與攻擊者模型

| 元件 | 位置 | 信任等級 |
| --- | --- | --- |
| 前端 `public/` | GitHub Pages（`https://john-owo.github.io/ntut-cycling-borrow/`） | 公開、靜態，攻擊者可完整閱讀 |
| 正式資料與權限 | Supabase PostgreSQL + PostgREST + Auth（`supabase/migrations/`） | 唯一的安全邊界 |
| 本機服務 `server/` | Node.js `node:http` + `node:sqlite`，只綁定 `127.0.0.1` | 本機操作／QA 用，不是正式託管 |
| CI | GitHub Actions（`.github/workflows/pages.yml`） | 只發布 `public/`，不接觸資料庫 |

假設攻擊者：可直接呼叫任何 Supabase RPC 與本機 API、可任意改寫 header／cookie／query／body、可大量發送請求、知道 framework 與程式碼。
前端驗證不是安全邊界；所有輸入驗證、權限檢查與庫存一致性都在資料庫函式（正式）或 `server/app.mjs`（本機）重做一次。

## 2. 驗證與授權模型

### 正式（Supabase）
- 匿名使用者只能呼叫 `summary()`、`register()`、`lookup()`。所有表都在 `private` schema，未曝露於 Data API，RLS 全部啟用且無 policy，`anon`／`authenticated` 對表與序列無任何權限。
- 所有公開函式為 `security definer` 並 `set search_path=''`；私有輔助函式對 `anon`／`authenticated` 一律 revoke。
- 幹部身分＝Supabase Auth 使用者 **且** UUID 在 `private.admins`。每個 `admin_*` 函式第一步呼叫 `private.require_admin()`；不使用 user metadata 或 email 判斷權限。
- Supabase Auth 公開註冊已關閉；新增幹部須在 Dashboard 建帳號再 `insert into private.admins`。
- 社員沒有帳號。憑證是 256-bit 隨機查詢碼（瀏覽器產生，64 位 hex），資料庫只存 SHA-256；查詢不接受學號或流水號。
- 幹部登入使用 Auth password grant；access token 與 refresh token 存在 `sessionStorage`（分頁關閉即清除）。這是既定決策，代價與限制見第 6 節。

### 本機（`server/app.mjs`）
- 管理員帳密以 scrypt（salt 16 bytes）雜湊儲存；登入時對不存在的帳號也做一次 scrypt 並用 `timingSafeEqual` 比較，避免帳號枚舉時間差。
- 登入成功回傳 32 bytes 隨機 bearer token，伺服器只存 SHA-256，8 小時絕對到期；每次登入會清除已過期的 session。
- 只接受 `Authorization: Bearer <64 hex>` 標頭，query string 與 cookie 不是憑證通道。
- 密碼 12 到 256 字元，由 `server/setup-admin.mjs` 以環境變數建立，不進 Git。

## 3. 敏感元件與資料

- `private.records`：學號、姓名、聯絡方式（個資）。只有幹部 RPC 與匿名持碼查詢能讀到單筆。公開 `summary()` 只回數字。
- `private.audit`：幹部操作紀錄，`admin_records()` 回最近 500 筆並顯示幹部 email；`admin_export()` 回全部並自我記錄一筆 `export`。
- 匯出檔（`scripts/export-backup.mjs`、幹部頁「匯出備份」）包含全部個資與 token hash，Git 忽略 `backups/`；請私下保存。
- `public/config.js`：只允許 Project URL 與 publishable／anon key。`scripts/pages-config.mjs` 在部署時拒絕 `sb_secret_` 與非 `anon` role 的 JWT；`tests/security.test.mjs` 掃描 `public/` 確認沒有 secret key、private key、`service_role` JWT。
- `private.register_attempts`：只存來源 IP 的 SHA-256 與時間，一天後清除。
- `data/bikes.sqlite`：本機資料庫，Git 忽略；不是正式資料。

## 4. 目前的安全設定

### 輸入驗證與資料一致性
- 學號 `^[a-zA-Z0-9-]{1,30}$` 去頭尾空白轉大寫；姓名≤80、聯絡≤200、備註／原因≤500，拒絕控制字元；新版六參數登記的 `contactType` 白名單為 `line|instagram`、`purpose` 為 `group_ride|personal_ride`。供已開啟舊頁面使用的五參數登記仍接受 `phone|line|instagram`；聯絡入口只接受 `https://`。
- 本機 API 用 `exact()` 拒絕多餘欄位（防 mass assignment），JSON 本文上限 8 KB，`Content-Type` 必須是 `application/json`（415）。本文以 `Buffer.concat` 後一次解碼，跨 TCP 分段的中文字不會被寫成替代字元。
- 聯絡入口在前端 `safeContact()` 與本機 `admin/settings` 都拒絕帶帳密（userinfo）的 URL；SQL 端只檢查 `https://` 前綴，前端顯示時仍會再過濾。
- 所有異動先鎖定 `private.settings` 單列（`for update`）／SQLite `BEGIN IMMEDIATE`，庫存由紀錄計算，不維護可漂移的計數。
- 交車、歸還、取消、期初歸還、已借出數量調整皆冪等；後兩者以前端 UUID 為操作識別碼，同 ID 不同內容回 409。

### 濫用防護
- 正式 `register()`：全站 15／分、90／時、300／日，同來源網路 10 次／10 分鐘（`private.check_register_throttle()`）。重送既有查詢碼不計次。
- 本機：每 IP 每路徑 120 次／分；`/api/admin/login` 另有每 IP 10 次／分（`loginLimit`），429 附 `Retry-After`。
- Supabase Auth 的 token endpoint 由供應商內建 IP 限流保護；幹部密碼強度由幹部負責。

### 瀏覽器端
- 所有 DOM 皆以 `textContent`／`createElement` 建立；`tests/security.test.mjs` 禁止 `innerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、inline script 與 inline event handler。
- `index.html`、`admin.html` 的 meta CSP：`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'`。最後一項讓 Chromium 在瀏覽器層直接封鎖 `innerHTML`、`eval` 等 DOM XSS sink（已在隔離 QA 驗證應用本身零違規）；Firefox／Safari 忽略此指令，仍靠程式碼規範。
- 幹部頁 `admin.js` 開頭檢查 `window.self!==window.top`，被嵌入其他網站時隱藏頁面、嘗試跳出並停止執行；這是 Pages 無法送 `frame-ancestors` 時的替代防護。
- 幹部頁閒置 30 分鐘（無指標／鍵盤／觸控／滾輪事件）自動登出並清除 `sessionStorage`，避免共用裝置上的輪詢無限延長 session。
- 以有效 Auth 帳號登入但不在幹部名單時，前端會呼叫 `/auth/v1/logout` 撤銷剛取得的 session，而不只是清除本機儲存。
- `<meta name="referrer" content="no-referrer">`；外部聯絡連結經 `safeContact()` 只放行不含帳密的 HTTPS，並加 `rel="noopener noreferrer"`。
- i18n 查表使用 `Object.hasOwn`，使用者輸入（如姓名 `constructor`）不會解析到原型屬性。
- `github.io` 在 HSTS preload 清單內，正式站一律 HTTPS。GitHub Pages 無法自訂回應標頭，因此 `frame-ancestors`、`Permissions-Policy` 等無法在正式站設定（見第 6 節）。

### 本機服務回應標頭
`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`、`Permissions-Policy`（關閉 camera／microphone／geolocation／payment／usb）、`X-Permitted-Cross-Domain-Policies: none`，以及與 meta 對齊並加上 `frame-ancestors 'none'` 的 CSP。

### CORS 與 Host
- 本機服務：帶 `Origin` 的請求必須在 `ALLOWED_ORIGINS` 或與自身相同，否則 403；回應 `Access-Control-Allow-Origin` 為該來源並 `Vary: Origin`，不使用 `*`，不送 `Allow-Credentials`。
- Host 允許清單：預設 `127.0.0.1`、`localhost`、`[::1]`（任意 port）加上 `ALLOWED_ORIGINS` 的主機名稱，其他 Host 回 421。這阻擋 DNS rebinding（攻擊者網域解析到 127.0.0.1 後借用同來源捷徑）。額外主機以 `ALLOWED_HOSTS` 加入。
- 正式站由 Supabase 處理 CORS；只用 bearer token，不用 cookie，因此沒有 CSRF 面。

### 供應鏈與 CI
- 無 production 依賴；唯一 dev 依賴 `@electric-sql/pglite` 已 lock。CI 執行 `npm ci`、`npm audit --audit-level=high`、`npm test` 後才發布。`pull_request` 也會跑 validate（Dependabot 更新先經測試），但 deploy 只在 push 到 main 時執行。
- Actions 全部釘 SHA；`permissions: contents: read`，deploy job 才有 `pages: write`／`id-token: write`。Dependabot 監看 npm 與 github-actions。
- GitHub 倉庫：main ruleset 禁止刪除與 force push，secret scanning + push protection 啟用，Actions 限 GitHub 官方與 verified creators。

### 2026-09-22 本機修補（尚未部署）

- Auth 更新改為同一時間共用一個請求，並檢查登入世代。舊 refresh 回應不能復活已登出 session，也不能清掉新的登入；登出立即清除本機憑證及畫面個資，匯出回應若晚於登出就不再下載。
- 本機 API 限流改為同來源共用預算。舊版將任意 path 納入 key，可用持續變換未知路徑繞過限流並增加記憶體用量。此修補只適用 Node 本機服務，不能當成 Supabase 的限流證據。
- 三項 Auth 競態測試對 `b9ba45c` 都失敗、修補後通過；未知路徑的 HTTP 節流回歸通過。細節見 `docs/LOCAL-DELIVERY-20260922.md`。

## 5. 驗證方式

```powershell
npm.cmd ci
npm.cmd test
```

- `tests/postgres.test.mjs`：以 PGlite 真 PostgreSQL 執行 001–004，驗證 anon／非幹部／幹部三種身分的 grants 與 RLS、`search_path` 硬化、查詢碼隔離、節流、冪等與 audit。
- `tests/backend.test.mjs`：本機 HTTP＋SQLite，涵蓋權限、並行最後一台、重啟後冪等、匯出、批次取消、節流。
- `tests/api.test.mjs`：前端 adapter 只用 publishable key 呼叫匿名 RPC、幹部 JWT 不外洩到公開呼叫、refresh 與拒絕流程。
- `tests/security.test.mjs`：本文件第 4 節的回歸測試（Host、登入限流、標頭與 Trusted Types、session、聯絡連結 userinfo、跨分段 UTF-8 本文、靜態檔白名單、公開檔案衛生、防嵌入與閒置登出存在、workflow 觸發與 SHA 釘定、i18n）。

這些測試不證明：Supabase 託管環境的多連線並行、真 Auth 登入、GitHub Pages 實際回應標頭。正式驗收見 README「驗證與限制」。

## 6. 已知剩餘風險（需人工或社團決定）

| 項目 | 說明 | 處理方式 |
| --- | --- | --- |
| Refresh token 存 `sessionStorage` | 同一 origin `john-owo.github.io` 上任何其他 Pages 專案若有 XSS 即可讀取。 | 既定決策：此帳號不再發布其他 Pages 專案；日後若需要，改為僅記憶體保存或獨立網域。 |
| 正式站無法設定回應標頭 | GitHub Pages 不支援 `frame-ancestors`、`Permissions-Policy`、COOP。點擊劫持目前靠 `admin.js` 的 JS 防嵌入與二次確認對話框緩解，JS 防護在 `sandbox` iframe 中仍可隱藏頁面，但不等於標頭。 | 若日後改用可設標頭的託管（Cloudflare Pages／自有網域），把第 4 節本機標頭搬過去。 |
| 幹部頁 localStorage 鍵名含幹部 email | 已借出數量調整的待重試操作以 `bike-borrowed-adjustment:<路徑>:<email>` 為鍵，登出後鍵名仍可能留在共用裝置。只揭露曾使用的幹部信箱，不含憑證。 | Informational；若要消除可改為雜湊鍵名。 |
| 使用者文字未過濾 Unicode 方向控制字元 | 姓名／備註可含 U+202E 等雙向覆寫字元，只影響幹部頁顯示順序，不能執行程式。SQL 與本機都已拒絕 ASCII 控制字元。 | Low；需要時在 `register()` 與本機 `text()` 同步加入 `\p{Cf}` 拒絕（需 migration）。 |
| 學號存在性可被探測 | `register()` 對已有效登記的學號回明確訊息，是既有社員自助行為。SQL 發生例外時，同交易的 throttle insert 也會 rollback，因此目前不能宣稱失敗探測受每來源／全站登記上限完整保護。 | 保留為未解風險；需要 API 邊界限流或另行設計不洩露存在性的登記回應。成功登記上限仍有效。本機 Node limiter 不代表正式 Supabase 已套用保護。 |
| 節流來源 IP 依賴代理標頭 | `private.client_hash()` 依序信任 `cf-connecting-ip`、`x-real-ip`、`x-forwarded-for` 最後一段。Supabase 位於 Cloudflare 後方時第一項可信；若供應商架構改變，per-client 節流可被偽造，全站上限仍有效。 | 觀察 Supabase 架構變動；必要時另開 migration 調整順序。 |
| 匿名 `summary()`／`lookup()` 無限流 | 每次呼叫成本低，但免費方案有配額；大量呼叫屬資源耗盡而非資料外洩。 | 依實際流量在 Supabase 設定 API rate limit／CAPTCHA；不在本專案內宣稱已解決。 |
| 幹部帳號無 MFA、密碼強度未強制 | Supabase Auth 預設無 MFA；本專案 UI 不支援 TOTP。 | 幹部使用密碼管理器與長密碼；社團可在 Dashboard 啟用 MFA 後再擴充 UI。 |
| 個資保留與刪除 | 未實作自動刪除；系統不會自行刪除任何真實資料。 | 由社團決定保留期間後另開 migration，不由開發者擅自訂定。 |
| 本機服務只適合 loopback | 無 TLS、無 HSTS、限流以 IP 為鍵。 | 若要對外，必須放在具 TLS 的反向代理後，設定 `ALLOWED_ORIGINS`／`ALLOWED_HOSTS`，並由代理補 `Strict-Transport-Security`。 |
| 真實幹部登入尚待驗證 | 幹部尚未在正式 `admin.html` 完成一次登入以確認 audit email 與匯出。 | 幹部自行登入確認；不需提供密碼給任何人或工具。 |

沒有發現任何已洩漏的憑證；倉庫與 Git 歷史中只有測試用假 key 與文件字樣，無需 rotation。

## 7. 未來開發必須遵守的原則

1. 任何新資料表放在 `private`，啟用 RLS、不建立 policy，並對 `anon`／`authenticated` revoke；只透過 `security definer set search_path=''` 的函式存取，幹部函式第一行呼叫 `private.require_admin()`。
2. 每個新 RPC／API 都要在資料庫層重做輸入驗證、長度上限與狀態機檢查；前端驗證只是體驗。
3. 有副作用的幹部操作要冪等（操作識別碼或相同終態不重寫），並寫 audit（含 actor）。
4. 前端只用 `textContent`／`createElement`；不得引入 `innerHTML`、inline script、第三方 script／CDN；新增外部連線來源必須同時更新兩個 HTML 的 meta CSP 與本機 CSP 標頭。
5. `public/` 永遠不得含 secret key、service_role、資料庫密碼或幹部帳密；只有 `scripts/pages-config.mjs` 可以寫 `config.js`。
6. 新增依賴前評估必要性；保持 production 零依賴；Actions 必須釘 SHA。
7. 修改本機 API 時，不得把憑證放進 URL、log 或錯誤訊息；500 一律回通用訊息。
8. 任何資安相關變更都要補到 `tests/security.test.mjs` 或對應測試，並更新本文件第 4、6 節。
9. 涉及真實資料的測試只能在隔離專案或可 rollback 的交易中進行；不得對正式站做 DoS 或破壞性測試。
