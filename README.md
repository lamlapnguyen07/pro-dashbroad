# 3D 團隊看板

純靜態網頁（Three.js），放在 GitHub Pages，手機與電腦都能看。

- 每個人一棟建築：Leader 是插旗的總部，Claude 是頂端有燈的建築，其他是團隊成員。
- 建築高度代表未完成的工作量，旁邊的方塊是任務：綠色完成、橘色進行中（會跳）、灰色待辦、紅色卡關（會閃）。
- 看板與信件摘要都加密，打開網頁輸入同一組密碼才看得到。

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
