# 3D 團隊看板

純靜態網頁（Three.js），放在 GitHub Pages，手機與電腦都能看。

- 每個人一棟建築：Leader 是插旗的總部，Claude 是頂端有燈的建築，其他是團隊成員。
- 建築高度代表未完成的工作量，旁邊的方塊是任務：綠色完成、橘色進行中（會跳）、灰色待辦、紅色卡關（會閃）。
- 看板、信件摘要、行程、週報都加密，打開網頁輸入同一組密碼才看得到。
- 前方廣場：✉️ 信件（重要信可一鍵轉成任務）、📅 會議廳（今天和明天的行程）、📈 週報塔（本週即時統計，加上每週五的週報）、⏰ 鐘塔（里程碑倒數）。
- 左上角「今日三件事」：在任務上按 ⭐ 標記，最多 3 件；沒有標記時自動挑你最急的 3 件。
- 交辦給 Claude：在 Claude 建築新增任務，下次打開 Claude 時會先逐件跟你確認（見 `CLAUDE.md`）。

## 排程與通知

- 每天早上 8 點：整理 Gmail 與 Google 日曆，加密推送，發一則通知。
- 每週五下午 5 點：整理週報放到週報塔，發一則通知。
- 通知會出現在電腦上；手機要開啟 Claude 的 Remote Control 才收得到。排程只在電腦與 Claude app 開著時執行。

## 主畫面圖示

`node tools/make-icons.mjs` 會重新產生 `icons/` 裡的圖示。iPhone 用 Safari「加入主畫面」，Android 用 Chrome「加到主畫面」。

## 在網頁上編輯

點建築可以新增任務、改狀態、指派負責人；「團隊」可以新增成員。

每台要編輯的裝置都要設定一次 GitHub 權杖（⚙️ 設定裡有步驟）：

1. 到 GitHub → Settings → Developer settings → Fine-grained tokens 建立權杖
2. Repository access 只選這個 repo
3. Permissions 只開 Contents：Read and write
4. 貼到網頁的 ⚙️ 設定

權杖只存在那台裝置的瀏覽器裡。沒有權杖時網頁是唯讀的。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` / `style.css` / `app.js` | 網頁本體 |
| `data/board.enc.json` | 加密後的看板資料（可公開） |
| `data/mail.enc.json` | 加密後的信件摘要（可公開） |
| `private/board.json` | 解密後的看板資料（不會上傳） |
| `private/mail-digest.json` | 未加密的信件摘要（不會上傳） |
| `private/password.txt` | 密碼，只放一行（不會上傳） |
| `tools/board.mjs` | 看板資料加密 / 解密 |
| `tools/encrypt-digest.mjs` | 信件摘要加密 |
| `tools/seal.mjs` | 行程（calendar）與週報（reports）加密 |
| `tools/make-icons.mjs` | 產生主畫面圖示 |
| `data/calendar.enc.json` / `data/reports.enc.json` | 加密後的行程與週報（排程產生） |
| `tools/serve.mjs` | 本機預覽（含模擬儲存） |

## 在電腦上改看板資料

網頁上的修改會直接存到 GitHub，所以先拉下最新版：

```bash
git pull --rebase
```

```bash
node tools/board.mjs decrypt
```

修改 `private/board.json` 後：

```bash
node tools/board.mjs encrypt
```

任務狀態：`done` 完成、`doing` 進行中、`todo` 待辦、`blocked` 卡關。

## 本機預覽

```bash
node tools/serve.mjs
```

開啟 http://localhost:4173 。本機預覽的修改會直接寫入這台電腦的檔案。

## 安全須知

- 加密檔是公開的，任何人都能下載後離線猜密碼，保護強度取決於密碼長度，建議 16 字以上。
- 每一版加密檔都會留在 GitHub 歷史紀錄；換密碼不會讓舊版失效。
- 提交訊息是公開的，網頁儲存時一律寫 `Update board`，不含任何內容。
- `private/` 已列在 `.gitignore`，請勿移除。
