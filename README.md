# 3D 專案看板

純靜態網頁（Three.js），可直接放到 GitHub Pages，手機與電腦都能看。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` / `style.css` / `app.js` | 網頁本體 |
| `data/project.json` | 專案資料：階段、任務、團隊、里程碑。改這個檔就會更新畫面 |
| `data/mail.enc.json` | 加密後的信件摘要（可公開） |
| `private/mail-digest.json` | 未加密的信件摘要（不會上傳） |
| `private/password.txt` | 你的密碼，只放一行（不會上傳） |
| `tools/encrypt-digest.mjs` | 把摘要加密成 `data/mail.enc.json` |
| `tools/serve.mjs` | 本機預覽 |

任務狀態：`done` 完成、`doing` 進行中、`todo` 待辦、`blocked` 卡關。

## 本機預覽

```bash
node tools/serve.mjs
```

開啟 http://localhost:4173

## 信件摘要加密

1. 在 `private/password.txt` 寫入一組長密碼（建議 16 字以上的句子）。
2. 執行：

```bash
node tools/encrypt-digest.mjs
```

目前的 `data/mail.enc.json` 是範例資料，用示範密碼 `demo-lumi-2026` 加密。換成自己的密碼後重新加密即可。

## 安全須知

- 加密檔放在公開網站上，任何人都能下載並離線嘗試猜密碼，所以保護強度完全取決於密碼長度。
- 推上 GitHub 的每一版加密檔都會留在歷史紀錄裡；換密碼不會讓舊版失效。
- `private/` 已列在 `.gitignore`，請勿移除。
