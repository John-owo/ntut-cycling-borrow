# 資安補強交付 — 2026-09-24

## 範圍與決策

保留匿名借車申請、交換生使用及幹部人工審核，不導入社員名單或學校信箱門檻。保留既有查詢碼與所有真實借用紀錄，不新增測試社員、不刪個資。基準版本 `73c10a758401596082dc532ee1980d13d62f64d9`。

## 已實作

- 006：持久化每來源請求計次，失敗登記不再回滾計數。兩版登記共用 30 次／10 分鐘，公開摘要／查詢共用 1200 次／分鐘；全站成功新增仍為 15／分鐘、90／小時、300／日。POST-only，拒絕唯讀交易及明確要求 tx=rollback 的請求。私有核心函式禁止 anon/authenticated 直接執行。
- 公開登記、重試、持碼查詢回傳明確欄位白名單；不再回傳聯絡方式、內部備註、查詢碼雜湊。本機與 Supabase 一致，幹部完整資料保留。
- 007：每次幹部 RPC 檢查即時 Auth session、有效期與幹部名單。已完成 MFA 的帳號要求 aal2。新 admin_session_status 僅回目前幹部的驗證狀態。
- 中英雙語驗證器設定／驗證 UI；幹部憑證僅在記憶體，新版清除舊 sessionStorage。重新整理需重登。尚未設定者保留登入與設定入口，不能宣稱全員強制 MFA。
- 正式部署 CSP 只允許目前 Supabase 專案連線；本機開發範本另留 localhost。資源版本統一為 security0924。

## 自動與模擬驗證

- `npm.cmd test`：37/37 通過。包括 PGlite 001–007 整合、authenticated/anon 權限、MFA 與撤銷 session、失敗計次、所有公開簽名、POST-only、rollback preference、資料白名單、非同步憑證競態、CSP 產物、本機 HTTP。
- `git diff --check`：通過。
- 專用 loopback `tests/serve-mfa-qa.mjs`，完全模擬 Auth、無雲端連線：未設定帳號登入與警示、明確點選設定、驗證成功、重新整理回登入、已設定帳號先顯示 MFA、錯誤碼拒絕、正確碼登入、中英文切換均通過瀏覽器操作。
- 模擬驗證不等於真人 Supabase enrollment；PGlite 單連線不等於正式多連線壓力測試。

## 正式資料庫證據

- 006、007 均已透過既有 Supabase 專案 SQL Editor 套用，回應 Success。貼入內容移除註解／空白後與已測試檔案長度和校驗值一致。
- 更新前後 records 皆 3 筆、admins 皆 2 位；未操作正式交車／歸還或新增登記。
- 直接 HTTP：summary POST 200，GET 405；invalid lookup 400，五參數與六參數 invalid register 都 400；tx=rollback 400；匿名 admin_session_status 401。公開回應 Cache-Control: no-store。
- 後續獨立 SQL 回讀：兩筆失敗登記計次保留為 2，證明實際 PostgREST 錯誤回應仍提交限流計數；private register/lookup core 與 officer helper 的相應 anon/authenticated EXECUTE 為 false。
- SQL 布林檢查確認既有資料經公開 projection 不含 contact/contactType/bikeNote/token_hash，未輸出真實個資。
- 確認正式 auth.sessions.not_after 欄位存在。當次 verified TOTP 數量為 0。

## 發布與剩餘驗收

前端 PR／CI／正式讀回結果待發布後補記。

仍需每位幹部本人登入並完成驗證器設定、重新登入挑戰及登出確認。不要把密碼、驗證器金鑰或一次性碼交給代理。取消／不確定結果不自動刪除 factor；達設定上限時提供管理者清理未完成設定的指引。

剩餘風險：來源 IP 依賴代理標頭、校園 NAT 共用額度、分散式／網路層濫用、社員查詢碼無撤銷期限與 localStorage、GitHub Pages 防嵌入回應標頭限制、個資保留策略。此次沒有移動網域、建立付費服務或刪除資料；沒有宣稱 DDoS 或人工作業風險全部消失。
