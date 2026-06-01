# ClaudeClaw Whisper 語音轉錄指南

ClaudeClaw daemon 收到語音訊息（LINE / Telegram / Slack / Discord）時，會自動把
音訊轉成文字再送給 Agent 主對話。本文說明轉錄管線的架構、安裝、模型選擇、
prompt 機制，以及詞語表怎麼改。

---

## 目錄

1. [整體架構](#1-整體架構)
2. [安裝](#2-安裝)
3. [設定（settings.json）](#3-設定settingsjson)
4. [模型選擇](#4-模型選擇)
5. [Prompt 機制](#5-prompt-機制)
6. [詞語表 — 去哪改](#6-詞語表--去哪改)
7. [檔案位置一覽](#7-檔案位置一覽)
8. [疑難排解](#8-疑難排解)

---

## 1. 整體架構

ClaudeClaw 抽象出三個 engine，依平台 + 設定自動選一個：

```
語音檔 (.ogg / .m4a / .wav / ...)
   │
   ▼
ensureWavInput  ── ogg-opus-decoder (.ogg) / ffmpeg (其他)
   │
   ▼
resolveEngine ──┐
                ├─ stt.baseUrl 有設    →  api engine        (送外部 STT 伺服器)
                ├─ mac arm64 (預設)   →  mlx engine        (Apple Silicon 加速)
                └─ 其他                →  whispercpp engine (內建 binary fallback)
   │
   ▼
transcribe(prompt = 詞表)
   │
   ▼
{ text, vocabHint }  ──→  附在 Agent prompt 內送給主對話 Claude
```

選擇優先序（`whisper.engine = "auto"` 時）：

1. `stt.baseUrl` 有值 → API
2. mac arm64 → MLX
3. 其他 → whisper.cpp

可用 `whisper.engine` 顯式覆寫成 `"mlx" / "whispercpp" / "api"`。

---

## 2. 安裝

### MLX engine（Apple Silicon）

Wrapper 腳本隨 plugin 一起下載，**不需要外部 skill**。Python venv 是
user-global、跨 plugin 升級存活，**全機器只裝一次**：

```
<plugin>/whisper/wrapper.py            ← Python wrapper（隨 git，跟著 plugin 走）
~/.claude/claudeclaw/mlx-env/          ← venv + mlx-whisper 套件（user-level，共用）
```

第一次任何 agent 在 mac 上收到語音時自動觸發安裝（不需手動執行）：

1. 找 Homebrew Python（`python3.13 / 3.12 / 3.11`，避開 `/usr/bin/python3` 系統版）
2. `python3 -m venv ~/.claude/claudeclaw/mlx-env`
3. `pip install mlx-whisper`（~150MB、~1-2 min）

> **沒 Homebrew Python？** `brew install python@3.12` 後再轉錄即可。

### 模型下載

第一次轉錄時 `mlx_whisper` 從 Hugging Face 下載模型 weights 到：

```
~/.cache/huggingface/hub/
```

**user 級全域共用**。第一個 agent 用 `large-v3-turbo` 觸發 ~1.5GB 下載；其他
agent 也用 `large-v3-turbo` 直接 cache hit。換模型才另外下載。

### whisper.cpp engine（fallback）

非 mac arm64 平台會走這個。每個 agent 自己一份 binary + ggml model：

```
<agent-root>/.claude/claudeclaw/whisper/
├── bin/whisper-cli             ← whisper.cpp 執行檔
├── lib/                        ← 共享函式庫（部分平台需要）
└── models/ggml-base.en.bin     ← ~150MB
```

也是 lazy 下載 — 第一次轉錄觸發。

### API engine

設好 `stt.baseUrl` 即可，不需本機安裝任何東西。Agent 會走 OpenAI 相容的
`/v1/audio/transcriptions` POST。

---

## 3. 設定（settings.json）

`<agent>/.claude/claudeclaw/settings.json` 內的 `whisper.*` 區塊：

```jsonc
{
  "whisper": {
    "engine": "auto",            // auto / mlx / whispercpp / api
    "model": "large-v3-turbo",   // mlx engine 用，其他 engine 忽略
    "language": ""               // 空 = auto-detect；zh / en / ja...
  },
  "stt": {
    "baseUrl": "",               // 設了就走 api engine（最高優先）
    "model": ""                  // api engine 模型名（預設 Systran/faster-whisper-large-v3）
  }
}
```

每個 agent 各自設定 — 不同 agent 可以用不同 model。

---

## 4. 模型選擇

mlx engine 支援的 model（短名稱）：

| 短名稱 | 大小 | 速度 | 品質 | 備註 |
|--------|------|------|------|------|
| `tiny` | ~75MB | 最快 | 差 | 不推薦 |
| `base` | ~145MB | 很快 | 普通 | |
| `small` | ~480MB | 快 | OK | |
| `medium` | ~1.5GB | 中 | 好 | |
| `large-v3` | ~3GB | 慢 | 很好 | OpenAI 完整 large |
| **`large-v3-turbo`（預設）** | ~1.5GB | 中（≈small） | 接近 large | OpenAI 2024 turbo |

> **為何預設 turbo？** Apple Silicon 上 turbo 速度近 small 但品質近 large，
> 中文 / 多語表現都不錯。MLX 加速讓最高階下一階變得可行。

切換模型只需改 `whisper.model`，下次轉錄生效。第一次跑某 model 會從 HF 下載，
之後 cache hit。

> **whispercpp / api engine 的 model**：whispercpp v1 只有 `base.en` 寫死；
> api 用 `stt.model` 欄位，不看 `whisper.model`。

---

## 5. Prompt 機制

ClaudeClaw 用兩層提升轉錄正確性：

### Layer 1：餵給 Whisper 做 biasing

把詞表組成一句話，當作 `initial_prompt` 餵 Whisper。模型會在轉錄時偏向這些
詞彙。實際送出的字串長這樣：

```
以下內容可能包含以下常用詞彙：Tiger、王小明、ClaudeClaw、Felix、Eleven、...。
```

各 engine 接收方式：

| Engine | 機制 |
|--------|------|
| mlx | `--prompt-file <merged-prompt.txt>` |
| whispercpp | `--prompt "<text>"` |
| api | multipart form 的 `prompt` 欄 |

> **限制**：Whisper `initial_prompt` 上限約 244 tokens（中文 ~150 字），超過會
> 截斷。把最重要的詞放詞表前面。

### Layer 2：附 hint 給主對話 Claude

轉錄結果送給 Agent 時，會多附一行：

```
agent 常用詞參考（轉錄結果若有怪字，請優先用同音相符的下列詞替換）：
Tiger、王小明、ClaudeClaw、Felix、Eleven、...
```

Claude 看到怪字可自己用同音聯想對回詞表。零額外 LLM call。

### 為何不做「替換對應表」？

實測語音轉錄錯字不固定（同一個正字會有十幾種誤聽），維護 `舊→新` 對應表
反而沒效率。做兩層 biasing + LLM 自然修正，CP 值更高。

---

## 6. 詞語表 — 去哪改

詞表檔分兩層，疊加去重後使用：

### 全域詞表（跨 agent 共用）

**檔案**：`~/.claude/whisper/vocab.txt`

放這裡的詞所有 agent 都會自動讀到。建議只放：

- 跨 agent 都會講到的人名（Tiger、王小明）
- 自家組織 / 系統名（ClaudeClaw、TigerAgentKit）

**不要**放場景特化的詞（醫療術語、某 agent 內部術語等）— 會佔用全域 244 token
配額，影響其他場景。

### Agent 詞表（場景特化）

**檔案**：`<agent-root>/_claude/whisper/vocab.txt`

各 agent 自己的專有詞彙。例如：

- Felix：醫療人名 / 藥物 / 治療術語
- Eleven：家庭成員 / 食物 / 居家用品
- Dev：開發術語 / 其他 agent 名

### 格式

```
# 註解（# 開頭，不會進 prompt）
# 一行一詞 或用逗號 / 中文逗號分隔

Tiger, 王小明
ClaudeClaw
agent-bus
```

- 註解可放任意位置，parser 會 skip
- 空行忽略
- 中英都可
- 詞順序 = 重要性順序（後面會被截斷）

### 編輯後何時生效

**下一次轉錄就生效** — `loadVocab()` 每次轉錄都重讀檔，**不需要 restart daemon**。

### 看實際送給 Whisper 的字串

每次轉錄時，合併後的 prompt 會寫到：

```
<agent-root>/_claude/whisper/merged-prompt.txt
```

這是 ClaudeClaw 真正餵給 Whisper 的字串（已截斷到 ~150 字）。Debug「為什麼
Whisper 沒聽出某個詞」時可以看這個檔。

---

## 7. 檔案位置一覽

```
~/.claude/
├── whisper/vocab.txt                    # 全域詞表（手動編輯）
└── claudeclaw/mlx-env/                  # MLX 共用 venv（user-level，跨 plugin 升級存活）

<plugin-root>/
└── whisper/wrapper.py                   # MLX Python wrapper（隨 plugin git）

~/.cache/huggingface/hub/                # MLX 模型 weights（user 級全域共用）

<agent-root>/
├── .claude/claudeclaw/
│   ├── settings.json                   # whisper.* / stt.* 設定
│   └── whisper/                        # （whisper.cpp engine 用）
│       ├── bin/whisper-cli             # whisper.cpp 執行檔
│       ├── lib/                        # shared libs
│       ├── models/ggml-base.en.bin     # whisper.cpp 模型
│       └── tmp/                        # 中間 wav 檔
└── _claude/whisper/                     # 詞表 + debug 輸出
    ├── vocab.txt                       # Agent 詞表（手動編輯）
    └── merged-prompt.txt               # 自動寫，每次轉錄覆寫
```

### 每個檔案用途速查

| 檔案 | 編輯者 | 用途 |
|------|--------|------|
| `~/.claude/whisper/vocab.txt` | 人手 | 全域共用詞表 |
| `<agent>/_claude/whisper/vocab.txt` | 人手 | Agent 場景詞表 |
| `<agent>/_claude/whisper/merged-prompt.txt` | ClaudeClaw 自動 | 上次轉錄餵 Whisper 的字串（debug 用） |
| `<agent>/.claude/claudeclaw/settings.json` | 人手 / `claudeclaw start` | engine + model + language |
| `<plugin>/whisper/wrapper.py` | 不要動（隨 plugin） | MLX 包裝層 |
| `~/.claude/claudeclaw/mlx-env/` | 不要動 | 共用 Python venv |
| `~/.cache/huggingface/hub/` | 不要動 | MLX 模型 weights |
| `<agent>/.claude/claudeclaw/whisper/{bin,lib,models}/` | 不要動 | whisper.cpp 自管 |

---

## 8. 疑難排解

### MLX 安裝失敗（找不到 Python）

```
python3 not found — install Homebrew Python (brew install python@3.12) and retry
```

→ 跑 `brew install python@3.12` 後再發語音觸發轉錄。

### MLX 安裝失敗（pip install）

通常是網路問題或 mlx-whisper 套件版本衝突。手動跑：

```bash
~/.claude/claudeclaw/mlx-env/bin/pip install --upgrade mlx-whisper
```

或刪掉 venv 重來：

```bash
rm -rf ~/.claude/claudeclaw/mlx-env
# 下次轉錄會自動重裝
```

### 轉錄結果亂掉 / 沒聽出詞表內的詞

1. 確認詞表有寫對：開 `<agent>/_claude/whisper/vocab.txt`
2. 看實際送進 Whisper 的字串：`<agent>/_claude/whisper/merged-prompt.txt`
3. 全域 + Agent 詞表合併可能超過 244 token 上限被截斷 — 把重要的詞放前面

### 轉錄速度太慢 / 太快但品質差

- 慢：mac arm64 上應 ≤ 3 秒（10 秒語音）。如果跑 large-v3 改 `large-v3-turbo`
- 快但差：從 `tiny / base` 升到 `medium / large-v3-turbo`

### 想強制走某 engine（不用 auto）

設 `whisper.engine = "mlx" / "whispercpp" / "api"`。設 `"mlx"` 但平台非 mac arm64
會 raise，這是預期行為。

### Daemon 用舊版 code（改了 source 沒生效）

Daemon 是 long-running process，source 改了不會自動載：

```bash
# 對某個 agent
/claudeclaw:restart

# 或對全部 agent（透過 hub）
curl -X POST -H "Authorization: Bearer $(cat ~/.claude/claudeclaw/hub/auth.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["primary"])')" \
  http://127.0.0.1:$(cat ~/.claude/claudeclaw/hub/hub.port)/api/agents/restart-all
```

詞表檔不需要 restart（每次轉錄重讀）— 只有 source code 改才需要。
