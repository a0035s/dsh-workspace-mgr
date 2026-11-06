# dsh-workspace-mgr · 工作區守衛

[English](#english) · 繁體中文

工作區放在 E 盤，但每個任務還是會在 C 盤自己開產物目錄（`C:\w1`、`C:\hs`…逆向 APK 的 `dec/in/out/pack`），
一次 1–4 GB，12 個 App 累積 27 GB，而且沒有人記得清。

本插件負責「不再發生」，而不是「事後打掃」。

> 為什麼不是「掃描清理工具」：真正吃空間的從來不是 DSH 自己的緩存（全部加起來不到 3 MB），
> 而是 AI 在 shell 裡自己 `mkdir` 出來的野生工作目錄。那類目錄**路徑不可預測**，
> 事後只能推斷；所以主力放在**工具層硬攔**，掃描只當兜底與帳本。

## 四層

| 層 | 做法 | 強度 |
|---|---|---|
| ① 閘門 | `tools/pre-execute` 攔住落在受保護磁碟的**新**路徑（不存在的才攔，讀既有檔案照常放行），deny 的 reason 直接給出本會話 scratch 路徑 | 硬 |
| ② 收納 | 每個會話一個 `$DSH_HOME/scratch/<sessionId>/`，含 `.dsh-owner.json` 自證身分 | — |
| ③ 提示 | `systemPrompt` 區段明說產物只能落 scratch，並**注入當前會話的真實路徑**（不是模板） | 軟 |
| ④ 帳本 | 掃描 C 盤根目錄一層 + `%TEMP%\dsh-*` + scratch 子目錄，建索引；**只標記，永不自動刪** | 補漏 |
| ⑤ 事後觀測 | 每次 shell/write 執行後比對掃描根新增了什麼，記下「哪個會話、哪次工具呼叫、什麼時間」——連腳本內部偷偷建的目錄也抓得到 | 證據 |
| ⑥ 臨時目錄重定向 | `apply()` 裡把 `process.env.TEMP/TMP` 指到 `$DSH_HOME\cache\tmp`（`os.tmpdir()` 每次呼叫都重讀，故立即生效） | 硬 |

## 回收站（可還原 + 審計）

`recycle` 把目錄 `rename` 到**同一顆磁碟**的 `X:\_dsh-trash\<時間戳>-<名稱>\`：

```
_dsh-trash\<id>\
├─ manifest.json   ← 原始路徑、大小、檔案數、時間、會話
└─ payload\        ← 原目錄本體
```

- 同盤 rename = 即時，不複製（743 MB 目錄回收 < 1 秒）
- **回收不等於釋放空間**：資料還在原磁碟 `X:\_dsh-trash` 底下，要真的省空間必須 `purge`
- `restore` 搬回原位；原路徑被佔用時拒絕，不會覆蓋
- `purge` 才真的 `rm -rf`，需要 `confirm: true`，UI 上是二次點擊
- 每次 recycle / restore / purge 都寫進 `$DSH_HOME/workspace-mgr/audit.jsonl`

### 回收前的硬性校驗

磁碟根、`Windows` / `Program Files` / `ProgramData` / `Users` / `$Recycle.Bin`、
symlink / junction、`$DSH_HOME` 內部、scratch 根、臨時目錄 —— 一律拒絕。
且**只回收索引中 `state === 'confirmed'` 的項目**，避免介面誤觸。

## 判定規則

- `write` / `edit`：目標在受保護磁碟且不在白名單 → 拒絕
- `ops_bash` / `bash` / `pwsh` / `terminal_open`：命令中的受保護磁碟絕對路徑**不存在** → 拒絕（意圖新建）；**已存在** → 放行
- 白名單：會話 cwd、`$DSH_HOME`、scratch 根、`%TEMP%`、`C:\Windows`、`C:\Program Files*`、`allowRoots`

## 刻意不做

- 不改寫工具參數、不搬檔案（`pre-execute` 只能 allow/deny/cancel/ask）
- 不自動刪除任何東西（`autoCleanScratch` 預設 `false`）
- 不碰工作區註冊表、不刪會話

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: workspace-mgr
  name: 'dsh-workspace-mgr'
  config:
    gate: true
    protectDrives: ['C']
    # scratchRoot: 'E:\dsh\scratch'
    autoCleanScratch: false
    scratchTtlHours: 168
    scanRoots: ['C:\']
    scanDepth: 1
```

## HTTP

- `GET  /api/workspace-mgr/status`
- `POST /api/workspace-mgr/scan`
- `POST /api/workspace-mgr/mark` `{ path, state }`，state = `pending|confirmed|dismissed`
- `POST /api/workspace-mgr/dry-run` `{ paths? }` — 只回預覽
- `GET  /api/workspace-mgr/trash` — 列出所有磁碟回收站項目
- `POST /api/workspace-mgr/recycle` `{ paths, confirm:true }` — 移入同盤回收站
- `POST /api/workspace-mgr/restore` `{ id }` — 還原
- `POST /api/workspace-mgr/purge` `{ id, confirm:true }` — 永久刪除

## 已知取捨

shell 命令裡只要出現「不存在於受保護磁碟的絕對路徑」，就會被擋 —— 即使那只是
`node -e "...'C:\\x'..."` 這種字串。無法從命令字串區分「要寫」還是「只是提到」，
所以選了寧可誤擋。繞法：把腳本寫成檔案再執行，命令行裡就不會出現該路徑。

## 索引

`$DSH_HOME/workspace-mgr/index.json`，含 `firstSeen / lastScan / bytes / signature / state`。
狀態機：`pending → confirmed`（你按確認）`→ dismissed`（排除）。索引壞了不影響任何檔案。

審計：`$DSH_HOME/workspace-mgr/audit.jsonl`，每次 recycle / restore / purge 一行。

## 安裝

```bash
# 1) 放進 profile
cp -r dsh-workspace-mgr <profile>/node_modules/   # 或用 junction / symlink
# 2) profile 的 package.json：dependencies 加 file: 路徑，dsh.profile.bundles 加包名
# 3) 重啟或 touch 一次 profile 的 cordis.patch.yml
```

或用 DSH 的 `plugin_manager install_bundle`（指向本目錄）。

> ⚠️ 若 profile 裡已經有 git 依賴且 pnpm 11 要求 `allowBuilds`，`install_bundle` 可能在
> 重解析整個依賴圖時失敗。此時改用上面的手動方式最快，不動任何既有依賴。

## English

**dsh-workspace-mgr — a Workspace Guard for DeepSeek Harness.**

Your workspace lives on `E:`, yet every task still creates its own artifact folder on `C:`
(`C:\w1`, `C:\hs`, apktool's `dec/in/out/pack`) — 1–4 GB each, 27 GB over 12 apps, and nobody
remembers to clean up. This plugin makes it stop happening instead of sweeping afterwards.

- **Gate** (`tools/pre-execute`): denies *new* paths on a protected drive; existing paths stay readable.
  The denial message hands the agent its exact per-session scratch directory.
- **Scratch**: `$DSH_HOME/scratch/<sessionId>/` with a `.dsh-owner.json` that proves ownership.
- **Prompt**: a `systemPrompt` section states the rule and injects the **real** per-session path.
- **Ledger**: scans one level of each drive root plus `%TEMP%\dsh-*`; marks, never auto-deletes.
- **Observation**: after every shell/write call it diffs the scan roots, so even directories created
  *inside a script* are attributed to a session, a tool call, and a timestamp.
- **Trash**: `recycle` renames into `<drive>:\_dsh-trash\<ts>-<name>\` (same volume, instant),
  restorable, audited, with a two-step confirm before permanent purge.

Panel: sidebar entry + folder browser, read-only until you confirm. `%TEMP%` is redirected to
`$DSH_HOME\cache\tmp` at load time.

Known trade-off: a shell command that merely *mentions* a non-existent absolute path on a protected
drive is denied. There is no reliable way to tell "mentions" from "writes" in a command string,
so it errs on the safe side; write the script to a file and run it instead.

## License

MIT

