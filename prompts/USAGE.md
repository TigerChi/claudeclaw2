# ClaudeClaw 使用指南

你正運行在 ClaudeClaw daemon 裡。以下是**跨平台 / 全域**的功能與精簡用法。
平台專屬的輸出 directive（Slack / LINE / Telegram / Discord）由各平台 session 自動注入，不在此列。
要深入時讀 plugin 的詳細文件（路徑見最後一節）。

plugin 根目錄：`~/.claude/plugins/marketplaces/claudeclaw2/`

---

## 一、跨 agent 通訊（agent-bus）

### `[send-agent:<name>] ... [/send-agent]`
在回覆裡寫 `[send-agent:eleven]幫我確認 X[/send-agent]`，daemon 解析後透過 agent-bus 送給另一個 agent（收到別人訊息要回覆時也用這個）。
**查誰在線**：讀 `~/.claude/agent-bus/registry.json`，`status: "online"` 的才收得到。
詳見 docs/AGENT-BUS.md。

---

## 二、主動 / 排程行為

### Heartbeat（定期喚醒）
daemon 會定期用 heartbeat prompt 喚醒你巡檢。**沒事要回報就回 `HEARTBEAT_OK`**（開頭精確這字串），會被靜音、不轉發到任何平台。

### Cron 排程任務
建排程：寫 markdown 到 `.claude/claudeclaw/jobs/<name>.md`（schema 見系統提示「Scheduled jobs」段）。管理用 `/claudeclaw2:jobs`。詳見 commands/jobs.md。

---

## 三、Session 模型
- **全域 session**（DM / 一般）vs **每個 thread / 群組獨立 session**（Slack/Discord thread、LINE/TG 群組）。
- prompt 開頭可能帶 **inbox**（你上次發言後這個頻道發生的事，含代你發出的訊息）— 那是「已發生」的背景，**不要重貼或重發**。
- `/claudeclaw2:clear` 清空當前 session 重開。

---

## 四、管理指令（多為人操作，你知道存在即可）
- daemon 生命週期：`/claudeclaw2:status` `/start` `/stop` `/restart` `/config` `/logs`
- **Hub**（多 agent 儀表板 + reverse proxy）：`/claudeclaw2:hub` — 詳見 docs/HUB-GUIDE.md
- **LINE webhook proxy**（多 agent 共用一個 port）：`/claudeclaw2:proxy`
- 平台狀態：`/claudeclaw2:slack` `/line` `/telegram` `/discord`
- 技能：`/claudeclaw2:create-skill`（建）`/install-skill`（裝）

---

## 五、詳細文件（要深入時讀）
都在 `~/.claude/plugins/marketplaces/claudeclaw2/` 下：

| 主題 | 文件 |
|------|------|
| agent-bus 跨 agent 通訊 | docs/AGENT-BUS.md |
| Hub 用法 / 架構 | docs/HUB-GUIDE.md / docs/HUB-INTERNALS.md |
| 多 session（thread） | docs/MULTI_SESSION.md |
| 平台存取控制 / 配對 | docs/Channel_Guide.md |
| LINE 設定 | docs/LINE-GUIDE.md |
| 語音轉錄 | docs/WHISPER-GUIDE.md |
| 對話內指令（/cancel 等） | docs/CHAT-COMMANDS.md |
| 平台輸出 directive | prompts/{slack,line,telegram,discord}/DIRECTIVES.md |
