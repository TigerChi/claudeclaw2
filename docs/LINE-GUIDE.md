# ClaudeClaw LINE Bot 完整使用指南

本文件說明 ClaudeClaw 的 LINE Messaging API 整合如何運作、如何設定、以及各項功能的使用方式。
供 Agent 和使用者參考。

---

## 目錄

1. [整體架構](#1-整體架構)
2. [前置準備](#2-前置準備)
3. [設定說明](#3-設定說明)
4. [Webhook Proxy（多 Agent 共用）](#4-webhook-proxy多-agent-共用)
5. [啟動與運作](#5-啟動與運作)
6. [訊息處理](#6-訊息處理)
7. [群組行為與 Mention 政策](#7-群組行為與-mention-政策)
8. [使用者授權與 Pairing 配對](#8-使用者授權與-pairing-配對)
9. [語音訊息處理](#9-語音訊息處理)
10. [安全性層級](#10-安全性層級)
11. [常用操作](#11-常用操作)
12. [疑難排解](#12-疑難排解)

---

## 1. 整體架構

```
LINE 使用者
  │
  ▼
LINE Server
  │
  ▼
ngrok（公開 URL → localhost）
  │
  ▼
LINE Webhook Proxy（:18789，共用，按 path 分流）
  │
  ├─ /line/felix  → Agent Felix daemon (:18801)
  ├─ /line/eleven → Agent Eleven daemon (:18802)
  └─ /line/beo    → Agent Beo daemon (:18803)
                       │
                       ▼
                    Claude Code session
                    （讀寫 Agent 工作目錄的檔案、執行指令）
                       │
                       ▼
                    回覆文字 → LINE API → 使用者看到訊息
```

**每個 Agent 是獨立的 Claude Code session**，有自己的：
- 工作目錄（程式碼、文件）
- CLAUDE.md（人格設定）
- settings.json（LINE token、安全設定等）
- session.json（對話記憶）

**Proxy 是共用的**，負責把不同 path 的 webhook 轉發到對應 Agent 的內部 port。

---

## 2. 前置準備

### 2.1 建立 LINE Messaging API Channel

1. 前往 [LINE Developers Console](https://developers.line.biz)
2. 建立 Provider（如果還沒有）
3. 建立新的 **Messaging API** channel
4. 取得以下資訊：
   - **Channel Access Token**（長效版）：Messaging API → Channel access token → 點「Issue」
   - **Channel Secret**：Basic settings → Channel secret

### 2.2 設定 Webhook URL

在 LINE Developers Console → Messaging API：
- **Webhook URL**: `https://<你的公開 URL>/<webhookPath>`
  例如：`https://xxx.ngrok-free.dev/line/felix`
- **Use webhook**: 開啟
- **Auto-reply messages**: 關閉（不然 LINE 官方自動回覆會干擾 bot）

### 2.3 本機 Tunnel（開發用）

LINE webhook 需要公開的 HTTPS URL。本機開發用 ngrok：

```bash
ngrok http 18789
```

拿到的 URL（如 `https://xxx.ngrok-free.dev`）設到 LINE Developers Console 的 Webhook URL。

---

## 3. 設定說明

設定檔位置：`<Agent 工作目錄>/.claude/claudeclaw/settings.json`

### 3.1 LINE 完整設定結構

```jsonc
{
  "line": {
    // === 必填 ===
    "channelAccessToken": "long-lived-token...",    // LINE Channel Access Token
    "channelSecret": "hex-secret...",               // LINE Channel Secret（用於 webhook 簽章驗證）

    // === 使用者授權 ===
    "allowedUserIds": ["U..."],      // 允許使用的 LINE user ID 清單
                                      // 空陣列 [] = 所有人都能用
                                      // 非空 = 只有列出的人能用

    // === Pairing 配對（使用者自助加入白名單）===
    "pairing": {
      "enabled": true,                // 啟用配對功能
      "code": "my-secret-code",       // 配對密碼（初始化時自動產生，可自行修改）
      "welcomeMessage": "Hi! 請輸入配對碼以開始使用。",    // 陌生人收到的提示
      "successMessage": "✅ 配對成功！現在可以開始對話了。"  // 配對成功的回覆
    },

    // === 群組行為 ===
    "requireMention": true,           // 群組中是否要 @mention bot 才回應（預設 true）
    "groups": {                        // 個別群組覆寫設定（key = group ID）
      "Cabc123...": {
        "requireMention": false        // 此群組免 @mention
      }
    },

    // === Webhook 設定 ===
    "webhookPort": 18801,             // 本機內部 port（每個 Agent 要不同）
    "webhookPath": "/line/felix"      // Webhook 路徑（每個 Agent 要不同）
  }
}
```

### 3.2 各欄位詳細說明

| 欄位 | 型別 | 必填 | 預設值 | 說明 |
|---|---|---|---|---|
| `channelAccessToken` | string | ✅ | — | 從 LINE Developers Console 取得 |
| `channelSecret` | string | ✅ | — | 用於驗證 webhook 請求的簽章 |
| `allowedUserIds` | string[] | ❌ | `[]` | 空 = 全部人都能用。LINE user ID 格式：`U` + 32 個 hex 字元 |
| `pairing.enabled` | boolean | ❌ | `false` | 只有 `allowedUserIds` 非空時才有意義 |
| `pairing.code` | string | ❌ | `""` | 初始化時由 AI 自動產生 10 字元隨機碼。可自行修改 |
| `pairing.welcomeMessage` | string | ❌ | 有預設 | 陌生人 DM bot 時看到的提示訊息 |
| `pairing.successMessage` | string | ❌ | 有預設 | 配對成功後的回覆 |
| `requireMention` | boolean | ❌ | `true` | 群組中是否要求 @mention bot 名稱才回應 |
| `groups` | object | ❌ | `{}` | 個別群組的設定覆寫。key 是 group ID（`C` 開頭）或 room ID（`R` 開頭） |
| `webhookPort` | number | ❌ | `18789` | 本機 webhook server 的 port。**多 Agent 時每個要不同** |
| `webhookPath` | string | ❌ | `/webhook` | Webhook URL 的 path 部分。建議用 `/line/<agent名稱>` |

### 3.3 修改設定

直接編輯 settings.json 即可。Daemon 每 30 秒自動 hot-reload，**不需要重啟**就能生效。

以下情況需要重啟 daemon：
- `channelAccessToken` 或 `channelSecret` 變更
- `webhookPort` 變更

---

## 4. Webhook Proxy（多 Agent 共用）

當多個 Agent 都使用 LINE 時，需要一個 Proxy 共用一個 port 並按 path 分流。

### 4.1 為什麼需要 Proxy

LINE webhook 透過 ngrok 進來只能指向一個 port。多個 Agent 各自開 webhook server 會搶 port。
Proxy 聽一個共用 port（預設 18789），根據 URL path 轉發到各 Agent 的內部 port。

### 4.2 Proxy 設定

Proxy 設定檔：`~/.claude/claudeclaw/proxy-config.json`

```jsonc
{
  "port": 18789,       // Proxy 對外 port（ngrok 指向這裡）
  "bind": "0.0.0.0"   // Bind address
}
```

### 4.3 各 Agent 的 port 分配

每個 Agent 的 `webhookPort` 必須唯一且不能跟 Proxy 的 port 相同：

| Agent | webhookPort | webhookPath |
|---|---|---|
| Proxy（對外） | 18789 | — |
| Felix | 18801 | /line/felix |
| Eleven | 18802 | /line/eleven |
| Beo | 18808 | /line/beo |

### 4.4 Proxy 指令

```
/claudeclaw:proxy           # 查看狀態（從任何 Agent 執行皆可）
/claudeclaw:proxy start     # 啟動 Proxy
/claudeclaw:proxy stop      # 停止 Proxy
```

CLI 版本：
```bash
bun run <claudeclaw>/src/index.ts proxy start
bun run <claudeclaw>/src/index.ts proxy stop
bun run <claudeclaw>/src/index.ts proxy status
```

### 4.5 自動偵測

- **Agent 自動偵測**：Proxy 啟動時掃描 `~/.claude/projects/` 找出所有安裝了 ClaudeClaw 的 Agent 工作目錄，讀取各自的 settings.json，自動建立路由表。不需要手動註冊 Agent。
- **定期重掃**：每 15 秒重新掃描，新 Agent 上線或設定變更會自動偵測。
- **Health check**：每 30 秒檢查各 Agent 的 daemon 是否在線。
- **衝突偵測**：自動檢測重複的 path 或 port，在 log 中顯示警告。

### 4.6 查看狀態

瀏覽器：`http://localhost:18789/status`（JSON）

終端：
```bash
curl http://localhost:18789/status
```

Log：
```bash
tail -f ~/.claude/claudeclaw/proxy.log
```

### 4.7 單 Agent 模式

如果只有一個 Agent 使用 LINE，不需要 Proxy。Agent 的 daemon 直接聽 webhookPort，ngrok 直接指向該 port 即可。

---

## 5. 啟動與運作

### 5.1 啟動流程

**多 Agent（建議）：**
```
1. 啟動 Proxy：    /claudeclaw:proxy start
2. 啟動 Agent A：  /claudeclaw:start（在 Agent A 的工作目錄）
3. 啟動 Agent B：  /claudeclaw:start（在 Agent B 的工作目錄）
```

Daemon 啟動時會自動偵測 Proxy 是否在運行，並顯示：
```
LINE: proxy detected, using internal :18801
LINE: enabled (via proxy)
```

**單 Agent：**
```
1. /claudeclaw:start（直接啟動，不需要 Proxy）
```

### 5.2 停止

```
/claudeclaw:stop              # 停止當前 Agent 的 daemon
/claudeclaw:proxy stop        # 停止 Proxy（影響所有 Agent 的 LINE 收訊）
```

### 5.3 Hot-reload

以下設定改完 30 秒內自動生效，不需要重啟：
- `allowedUserIds`（白名單增減）
- `pairing`（開關、密碼、訊息）
- `requireMention`（群組 mention 政策）
- `groups`（個別群組覆寫）
- `security`（安全層級）

---

## 6. 訊息處理

### 6.1 支援的訊息類型

| 類型 | 處理方式 |
|---|---|
| **文字** | 直接作為 prompt 輸入給 Claude |
| **圖片** | 下載到 `inbox/line/`，Claude 用 Read 工具查看圖片 |
| **語音** | 下載後用 Whisper 轉文字，文字作為 prompt |
| **影片** | 下載到 `inbox/line/`，告知 Claude 有影片檔 |
| **檔案** | 下載到 `inbox/line/`，Claude 用 Read 工具讀取 |
| **貼圖** | 轉成文字描述（sticker keywords） |
| **位置** | 轉成文字（地名、地址、座標） |

### 6.2 回覆格式

- LINE 不支援 markdown，Agent 的回覆必須是**純文字**
- 超過 4500 字元自動分段（LINE 單則上限 5000 字）
- 優先使用 Reply API（免費），超時（30 秒）自動 fallback 到 Push API

### 6.3 Loading 動畫

收到訊息後，bot 會自動顯示 LINE 的 loading 動畫（三個跳動的點），直到 Claude 回覆完成。每 18 秒自動續期（LINE 上限 20 秒/次）。

### 6.4 訊息去重

同一則訊息在 10 秒內重複收到會被自動忽略（LINE webhook 可能重送）。

---

## 7. 群組行為與 Mention 政策

### 7.1 DM（私訊）

DM 不受 mention 政策影響。只要通過使用者授權（allowedUserIds / pairing），bot 就會回應所有 DM 訊息。

### 7.2 群組中的回應規則

```
收到群組訊息
  │
  ├── 使用者不在 allowedUserIds？ → 忽略
  │
  ├── 查 mention 政策：
  │   1. 這個群組有在 groups[chatId].requireMention 設值？ → 用這個
  │   2. 沒有？ → 用全域 requireMention（預設 true）
  │
  ├── requireMention = true？
  │   ├── 訊息中有 @<bot display name>？ → 回應
  │   └── 沒有？ → 忽略
  │
  └── requireMention = false？ → 回應所有訊息
```

### 7.3 設定範例

**所有群組都要 @mention（預設）：**
```jsonc
"requireMention": true,
"groups": {}
```

**所有群組都免 @mention：**
```jsonc
"requireMention": false,
"groups": {}
```

**只有特定群組免 @mention：**
```jsonc
"requireMention": true,
"groups": {
  "Cfamily_group_id": { "requireMention": false }
}
```

### 7.4 如何取得 Group ID

群組訊息進來時，daemon log 會印出 group ID：
```
[13:05] Line 戚禎庭(U708a...) in group C8035...: "hello"
```

`C8035...` 就是 group ID，可以加到 `groups` 設定裡。

---

## 8. 使用者授權與 Pairing 配對

### 8.1 開放模式（預設）

```jsonc
"allowedUserIds": []    // 空陣列 = 所有人都能用
```

所有 LINE 使用者都能 DM bot、在群組中 @mention bot。

### 8.2 白名單模式

```jsonc
"allowedUserIds": ["U708a61e8a1227945158a4c4920b4e15a"]
```

只有列出的 user ID 能使用 bot。其他人的訊息完全被忽略。

### 8.3 Pairing 配對（白名單 + 自助加入）

當 `allowedUserIds` 非空且 `pairing.enabled = true` 時，陌生人可以透過密碼自助加入白名單。

**流程：**
1. 陌生人 DM bot → 收到 `welcomeMessage`（提示輸入配對碼）
2. 陌生人輸入錯誤密碼 → 再次收到 `welcomeMessage`
3. 陌生人輸入正確的 `pairing.code` → 收到 `successMessage`
   - 該 user ID 自動寫入 `allowedUserIds`（持久化到 settings.json）
   - 之後可以正常使用 bot
4. 之後該使用者再發訊息 → 正常對話

**安全注意事項：**
- Pairing 只在 DM 中觸發（群組不會觸發）
- 只有文字訊息能配對（圖片/語音/檔案不會觸發）
- 配對碼是共用密碼模式，洩漏了任何人都能用。定期更換密碼可降低風險
- 初始化時 AI 會自動產生 10 字元隨機碼，建議不要用簡單密碼

### 8.4 如何取得 User ID

使用者的 LINE user ID 會在以下場合出現：
- Daemon log：`Line 戚禎庭(U708a61e8...) in DM: "hello"`
- Pairing 成功時自動寫入 settings.json
- 無法從 LINE app 介面直接查看（需要透過 bot 互動取得）

---

## 9. 語音訊息處理

### 9.1 運作方式

```
使用者發送語音訊息
  → LINE server 推送 webhook（audio type）
  → Daemon 下載音檔（m4a 格式）到 inbox/line/
  → ffmpeg 轉換 m4a → wav（16kHz mono PCM）
  → Whisper.cpp 語音辨識 → 文字
  → 文字作為 prompt 送給 Claude
  → Claude 回覆
```

### 9.2 需求

- **ffmpeg**：用於轉換 LINE 的 m4a 格式。macOS: `brew install ffmpeg`
- **Whisper 模型**：首次使用時自動下載（base.en, ~75MB）
- Whisper binary 也會自動下載，不需要手動安裝

### 9.3 外部 STT API（可選）

如果不想用本機 Whisper，可以設定外部 STT API：

```jsonc
{
  "stt": {
    "baseUrl": "http://localhost:8000",    // OpenAI-compatible STT API
    "model": "Systran/faster-whisper-large-v3"
  }
}
```

設定了 `stt.baseUrl` 後，會使用外部 API 取代本機 Whisper，支援 m4a 直接送出，不需要 ffmpeg。

---

## 10. 安全性層級

`security.level` 控制 Agent 在處理 LINE 訊息時可以使用的工具：

| Level | Read/Grep/Glob | Write/Edit | Bash | WebSearch | 目錄限制 |
|---|---|---|---|---|---|
| `locked` | ✅ | ❌ | ❌ | ❌ | 限專案目錄 |
| `strict` | ✅ | ✅ | ❌ | ❌ | 限專案目錄 |
| `moderate`（預設） | ✅ | ✅ | ✅ | ✅ | 限專案目錄 |
| `unrestricted` | ✅ | ✅ | ✅ | ✅ | **無限制** |

設定方式：
```jsonc
"security": {
  "level": "moderate",
  "allowedTools": [],        // 額外允許的工具（在 strict/locked 上加開）
  "disallowedTools": []      // 額外禁止的工具
}
```

---

## 11. 常用操作

### 新增一個 LINE Agent

1. 在 LINE Developers Console 建立新的 Messaging API channel（或用同一個 channel 的不同 webhook path）
2. 在 Agent 的 settings.json 設定 LINE：
   ```jsonc
   "line": {
     "channelAccessToken": "你的 token",
     "channelSecret": "你的 secret",
     "allowedUserIds": [],
     "webhookPort": 18804,          // 選一個沒被用的 port
     "webhookPath": "/line/myagent" // 選一個沒被用的 path
   }
   ```
3. 在 LINE Developers Console 設 Webhook URL：`https://<ngrok>/line/myagent`
4. 確認 Proxy 在跑（`/claudeclaw:proxy`），啟動 Agent（`/claudeclaw:start`）

### 暫時關閉某 Agent 的 LINE

把 `channelAccessToken` 設成空字串：
```jsonc
"channelAccessToken": ""
```
Hot-reload 30 秒後 LINE 通道會自動關閉。其他通道（Slack、Telegram 等）不受影響。

### 更換配對密碼

直接改 settings.json：
```jsonc
"pairing": {
  "code": "new-password-here"
}
```
Hot-reload 生效。已配對的使用者不受影響（他們已在 allowedUserIds 中）。

### 移除某使用者的權限

從 `allowedUserIds` 中刪除該 user ID，hot-reload 後該使用者就無法使用了。

### 讓 bot 在某群組免 @mention

```jsonc
"groups": {
  "C你的群組ID": { "requireMention": false }
}
```

---

## 12. 疑難排解

### LINE 傳訊息沒有回應

1. **檢查 daemon 有在跑嗎？**
   ```bash
   /claudeclaw:status
   ```

2. **檢查 Proxy 有在跑嗎？**（多 Agent 時）
   ```bash
   /claudeclaw:proxy
   ```
   確認你的 Agent 顯示 🟢

3. **檢查 ngrok 有在跑嗎？**
   ```bash
   curl http://127.0.0.1:4040/api/tunnels
   ```

4. **檢查 Webhook URL 設對了嗎？**
   LINE Developers Console → Messaging API → Webhook URL
   應該是 `https://<ngrok-url><webhookPath>`

5. **看 daemon log：**
   ```bash
   tail -50 <Agent 工作目錄>/.claude/claudeclaw/logs/daemon.log
   ```

### 「port is already in use」

- 有其他 Agent 或 Proxy 佔了這個 port
- 解法：改 `webhookPort` 成不同的值，或啟動 Proxy

### 語音訊息無法辨識

- 確認有安裝 ffmpeg：`which ffmpeg`
- 看 daemon log 有沒有 whisper 相關錯誤
- Whisper 模型首次使用會自動下載，需要網路

### Pairing 不生效

- 確認 `allowedUserIds` 不是空陣列（空陣列 = 全開放，不需要配對）
- 確認 `pairing.enabled = true` 且 `pairing.code` 不是空字串
- Pairing 只在 DM 觸發，群組中不會觸發
- 密碼必須完全一致（區分大小寫）

### 群組中 bot 不回應

- 檢查 `requireMention` 設定
- 確認 @mention 的名稱是 bot 的 **display name**（在 LINE Developers Console 設定的）
- 看 daemon log 有沒有 `Skip group message (mention required)`

### 已配對但無法使用

- 確認 user ID 有在 `allowedUserIds` 中（看 settings.json）
- 可能是 hot-reload 還沒生效（等 30 秒）
- 極端情況：daemon 寫入 settings.json 失敗，看 daemon log 的 error

---

## 附錄：檔案位置一覽

| 檔案 | 位置 | 用途 |
|---|---|---|
| Agent 設定 | `<Agent>/.claude/claudeclaw/settings.json` | LINE token、安全設定等 |
| Claude Session | `<Agent>/.claude/claudeclaw/session.json` | Agent 的對話記憶 |
| Thread Sessions | `<Agent>/.claude/claudeclaw/sessions.json` | 各 thread 的對話記憶 |
| 執行日誌 | `<Agent>/.claude/claudeclaw/logs/` | 每次 LINE 訊息處理的日誌 |
| 收到的媒體 | `<Agent>/.claude/claudeclaw/inbox/line/` | 下載的圖片、語音、檔案 |
| Cron Jobs | `<Agent>/.claude/claudeclaw/jobs/` | 排程工作 |
| LINE Directives | `<claudeclaw>/prompts/line/DIRECTIVES.md` | LINE 行為規則（注入給 Claude） |
| Proxy 設定 | `~/.claude/claudeclaw/proxy-config.json` | Proxy port、bind |
| Proxy PID | `~/.claude/claudeclaw/proxy.pid` | Proxy 的 process ID |
| Proxy Log | `~/.claude/claudeclaw/proxy.log` | Proxy 運行日誌 |
| Whisper | `<Agent>/.claude/claudeclaw/whisper/` | 語音辨識 binary + model |
