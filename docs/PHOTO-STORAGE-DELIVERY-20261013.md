# 照片容量修正與 Google 雲端硬碟存放交付紀錄

2026-10-13。正式目標：John-owo/ntut-cycling-borrow、GitHub Pages、Supabase `isrndpzcifrvbftlauzz`。本紀錄分開列出本機測試、正式部署讀回、使用者回報與尚未驗證的項目。

## 問題與原因（正式站唯讀核對）

幹部後台在沒有任何照片時顯示 192 MiB 已滿。公開日曆讀回：3 筆 `reserved`（已同意、尚未取車，10/17–10/18 的 2、4、5 號車），照片 0 張。009 起每筆 `reserved` 預約自送出就預留 8 張必拍照片 × 8 MiB ＝ 64 MiB，3 × 64 ＝ 192 MiB，等於整個預算；第 4 筆預約會因「Photo capacity reserved for existing loans」被拒。

## 變更

| 項目 | 內容 | 版本 |
|---|---|---|
| 016 `photo_capacity_accounting` | 只計已存照片＋使用中車輛尚缺的還車照片（每台最多 32 MiB）；取車照片與取車需留得下該車四張還車照片；照片規則集中於 `lifecycle_photo_gate`；預算維持 192 MiB | PR #28 |
| 017 `google_drive_photos` | 新原圖存 Google 雲端硬碟、預算 1 GiB；資料庫存 `drive_file_id`、大小、SHA-256；只授權 `service_role` 的 `lifecycle_photo_service`；資料庫內舊照片原地保留、照常可讀 | PR #28 |
| Edge Function `lifecycle-photo` | 驗證類型／檔頭／大小、預檢→上傳 Drive→鎖內提交；被拒或重送多出的檔案刪除；讀取核對大小與 SHA-256；`verify_jwt = false` | PR #28 |
| 前端 `api.js` | 依 `photoStorage` 或資料庫拒絕訊息自動改走照片函式；快取版本 `photo1013` | PR #28 |
| `scripts/google-drive-setup.mjs` | 使用者自行執行的 OAuth（loopback＋PKCE、`drive.file`），建立資料夾並寫入 Git 忽略的 `.env.*`，不印出密鑰 | PR #28 |
| `privacy.html` | Google 正式發布所需的隱私權政策頁（中英），列入 Pages allowlist，首頁頁尾連結 | PR #29 |

## 本機與 CI 驗證

- `npm.cmd test`（Windows）：71 項中 70 通過。唯一失敗 `lifecycle-coexistence`「reviewed release SQL matches migrations」在未修改的 main 上同樣失敗（Windows 換行），CI（Linux）通過。
- 新增 `tests/photo-storage-postgres.test.mjs`：PGlite 重現「3 筆預約、0 張照片 → 預留 192 MiB、第 4 筆被拒」；016 後預留為 0、可再預約、取車後預留 32 MiB、還車照片一定放得下、取車在空間不足時被拒；017 以真實 Edge Function handler 搭配假 Drive 與 PostgREST 轉接執行上傳、重送、競爭重送刪檔、拒絕不留檔、讀取權限、竄改偵測、匯出與取車完成。
- `tests/photo-function.test.mjs`（Drive 請求格式、權杖快取、大小不符刪檔、輸入驗證、錯誤不外洩），`tests/api.test.mjs` 新增前端切換測試，SQLite 容量測試改寫。
- GitHub Actions：PR #28 run 38345700246、PR #29 run 38347872748 validate 通過。

## 正式部署與讀回

| 步驟 | 執行者 | 證據 |
|---|---|---|
| PR #28 合併 | 代理（使用者明確要求） | merge `54ed8f1`；Pages run 38347488162 validate＋deploy 成功；正式 `api.js` 含 `lifecycle-photo`，`index.html` 載入 `lifecycle.js?v=photo1013` |
| 016 套用 | 使用者於 SQL Editor | 公開日曆 settings 出現 `photoStorage: "database"`；Chrome 唯讀查詢：used 0、reserved 0、budget 201326592、照片 0、進行中預約 3 |
| Google OAuth 用戶端、Drive API、首次授權 | 使用者 | 本機確認 `supabase/.env.drive` 四個欄位皆有值且被 Git 忽略（未讀取值） |
| Edge Function secrets 與部署 | 使用者（Supabase CLI） | `OPTIONS` 204；017 前呼叫回 PostgREST 404「找不到 `lifecycle_photo_service`」，表示函式已部署並以 service key 連到資料庫 |
| PR #29 合併 | 代理（使用者明確要求） | merge `75687ee`；Pages run 38348027137 validate＋deploy 成功；`privacy.html` 回 200 |
| Google 應用程式改為正式版並重新授權 | 使用者 | 使用者回報完成；未獨立驗證 |
| 017 套用 | 使用者於 SQL Editor | 公開日曆 `photoStorage: "drive"`、3 筆預約保留；Chrome 唯讀查詢：backend `drive`、budget 1024 MiB、used 0、reserved 0；照片函式→服務 RPC 對假碼回 400「Invalid member token」；匿名直接呼叫 `lifecycle_photo_service` 回 401 permission denied |
| `supabase/.env.drive` | 使用者刪除 | 本機已不存在 |

代理在本次 session 嘗試的正式資料庫寫入（合併 PR、在 SQL Editor 貼上並執行 016／017）曾被自動審核擋下，均改由使用者執行；代理只在 SQL Editor 跑唯讀查詢。過程中未在正式資料庫建立測試借單或照片。

## 尚未驗證

- 以真實 Google 授權實際上傳與讀回一張照片（需真實借還；建議第一筆取車時確認照片出現在雲端硬碟資料夾、後台「已存原圖」增加）。
- 重新授權後的密鑰是否已覆蓋首次（測試狀態、7 天到期）的授權；若上傳出現「Photo storage sign-in failed」，重新執行設定腳本與 `supabase secrets set`。
- 8 MiB 照片在 Edge Function CPU 時間限制下的實機表現、手機相機、幹部後台顯示「Google 雲端硬碟／1024.0 MiB」。
- 重新授權會建立新的雲端資料夾；首次授權建立的資料夾未被使用，是否保留由使用者決定。
- 1 GiB 以手機原圖約 25–40 次完整借還；接近上限需由社團決定擴充或保留政策。

回復方式見 `supabase/README.md` 017 段落。
