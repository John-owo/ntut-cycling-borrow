# 同一學號兩筆預約、預約前讀規範、逾期擋預約交付紀錄

2026-10-17。正式目標：John-owo/ntut-cycling-borrow、GitHub Pages、Supabase `isrndpzcifrvbftlauzz`。本紀錄分開列出本機測試、CI、正式部署讀回與尚未驗證的項目。

## 變更

| 項目 | 內容 | 版本 |
|---|---|---|
| 018 `two_bookings_terms_consent` | 同一學號最多兩筆有效預約（含待同意）、自己的時段不重疊；`apply`／`reserve` 必須帶 `accepted: true` 與目前 `termsVersion`，預約上記錄同意版本與時間；`settings.bookingConsent` | PR #34 |
| 019 `block_booking_while_overdue` | 有逾期未還的車時拒絕新預約，歸還後恢復；只重新定義 `lifecycle_member_window` | PR #36 |
| 前端 | 登記頁跳出幹部設定的借車規範，捲到底才能勾同意，同意前表單鎖住，每筆預約重新同意；兩筆／重疊／逾期提示 | PR #34、#36（`?v=overdue1017`） |
| 雲端拒絕訊息中文化 | `api.js` 把資料庫英文拒絕訊息換成本機伺服器的中文，英文模式照常翻譯 | PR #35 |
| 本機 Node/SQLite | 同步上述規則 | PR #34、#36 |

## 本機與 CI 驗證

- `npm test`（Windows）：80 項中 79 通過；唯一失敗 `014 closes the legacy queue…` 在未修改的 main 同樣失敗（Windows 換行），CI（Linux）通過。
- `tests/booking-limits-postgres.test.mjs`（PGlite 001–019）、`tests/booking-limits-http.test.mjs`（SQLite HTTP）、`tests/api.test.mjs` 拒絕訊息對照。
- 內建瀏覽器對隔離合成 QA 伺服器：規範對話框在首次公告後出現、捲到中段仍鎖、捲到底解鎖、同意前表單 `inert`；兩筆預約成功、第三筆前端擋下且伺服器回 409；375px 與英文模式。逾期提示未在瀏覽器實測。
- GitHub Actions validate：PR #34 run 39036551725、PR #35 run 39037771066、PR #36 run 39038649100。

## 正式部署與讀回

| 步驟 | 執行者 | 證據 |
|---|---|---|
| 前端（#34） | Pages run 39037678703 | 正式站載入 `lifecycle.js?v=terms1017`，規範對話框與鎖定表單存在、無主控台錯誤 |
| 前端（#35、#36） | 代理合併（使用者授權）、Pages run 39038718070 | 正式站載入 `lifecycle.js?v=overdue1017`、`api.js` 含逾期訊息對照 |
| 套用前唯讀核對 | 代理於 SQL Editor | 017 已裝、018 未裝；有效預約 7、總數 13 |
| 018、019 套用 | 代理於 SQL Editor（使用者授權） | 檔案取自 merge commit `c30b288`，SHA-256 018 `4c4f3c0e…`、019 `a60c2639…` 與 Git 一致；兩者皆「Success. No rows returned」 |
| 套用後唯讀讀回 | 代理於 SQL Editor | 同意欄位 2 個、019 函式含逾期檢查、`lifecycle_consent` 存在、`bookingConsent` true；anon 不能執行 private 函式、可執行 `public.lifecycle`；有效預約 7、總數 13（未變）、有同意紀錄 0 |
| 公開 API 拒絕驗證（不寫入） | 代理 | 公開日曆 `bookingConsent: true`、4 筆預約；缺同意欄位 → `Invalid application`；`accepted: false` → `Borrow terms must be accepted`；舊版本 → `Borrow terms changed; read them again` |

## 尚未驗證

- 正式站實際送出一筆含同意的預約、第三筆／重疊／逾期被拒（需要真實或測試學號寫入正式資料，未執行）。
- 幹部與社員的真人驗收。
- 託管環境多連線併發。
