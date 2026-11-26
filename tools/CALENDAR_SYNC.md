# 週會日曆同步步驟（給排程使用）

使用者的 Google 日曆有一個每週五重複的「週會」活動，說明欄含有 `[團隊看板週會]`。
使用者在看板網頁上可以改單週時間或設「這週不開」，這裡的步驟把那一週的日曆活動調成一致。

1. 執行 `node "C:\Users\user\Desktop\pro\tools\remind.mjs" --meeting`，看輸出的一行：
   - `UNCHANGED ...`：日曆已經一致，結束，什麼都不做。
   - `MEETING <日期> <HH:MM 或 SKIP> <名稱>`：繼續下面的步驟。
2. 用 Google 日曆連接器的 `list_events`，在主要日曆查 `<日期>T00:00:00` 到 `<日期>T23:59:59`、`fullText` 為「團隊看板週會」的活動。
3. **只能處理單次活動**：`id` 裡有底線 `_`、而且有 `recurringEventId` 的那一筆。
   **絕對不要刪除或修改整個重複系列**（`id` 沒有底線的那一筆），也不要動其他任何活動。
   - 時間是 `SKIP`：用 `delete_event` 刪除那一筆單次活動，`notificationLevel` 設 `NONE`。找不到就當作已完成。
   - 時間是 `HH:MM`：
     - 找到了：如果開始時間不是 `<日期> HH:MM`，用 `update_event` 把 `startTime` 改成 `<日期>THH:MM:00`、`endTime` 改成一小時後、`summary` 改成 `<名稱>`，`notificationLevel` 設 `NONE`。
     - 找不到（之前那週被設成不開而刪掉了）：用 `create_event` 建一個不重複的單次活動：`summary` 為 `<名稱>`、時間同上、`description` 為「[團隊看板週會] 由團隊看板同步。」、`overrideReminders` 為 `[{"method":"popup","minutes":30}]`、`notificationLevel` 設 `NONE`，不要加任何與會者。
4. 成功後執行 `node "C:\Users\user\Desktop\pro\tools\remind.mjs" --mark-synced`。失敗就不要執行，下次排程會再試，並在回報中說明。
