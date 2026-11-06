/**
 * dsh-workspace-mgr — 工作區守衛（host 半）
 *
 * 解決的問題：工作區放在 E 盤，但每個任務還是會在 C 盤自己開產物目錄
 * （例：C:\w1、C:\hs、C:\tw…逆向 APK 的 dec/in/out/pack），一次 1–4 GB，
 * 12 個 App 累積 27 GB，而且沒有人會記得清。
 *
 * 四層，本檔負責前三層：
 *   ① 閘門   tools/pre-execute：C 盤上「不存在的新路徑」一律拒絕，
 *             並在 reason 裡直接給出本會話的 scratch 路徑（模型下一輪照著改）。
 *   ② 收納   每個會話一個 $DSH_HOME/scratch/<sessionId>/，閘門拒絕時順手建好。
 *   ③ 提示   systemPrompt 區段，明說產物只能落在 scratch。
 *   ④ 帳本   掃描 C 盤根目錄一層 + DSH 自己的臨時目錄家族，建索引。
 *             只記錄、只標記，**永不自動刪除**（autoCleanScratch 預設 false，
 *             且即使開啟也只動自己 manifest 內、realpath 校驗過的 scratch）。
 *
 * 設計約束：
 *   - 零第三方依賴，只用 node 內建
 *   - 任何一步失敗都只記日誌，不影響 DSH 其他功能
 *   - 閘門只 deny / 放行，不改寫任何參數，不搬任何檔案
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'workspace-mgr'
export const inject = ['tools']

const LOG = '[workspace-mgr]'

/** 預設值；profile 的 cordis.patch.yml 可覆寫。 */
const DEFAULTS = {
  gate: true,
  protectDrives: ['C'],
  scratchRoot: '',
  autoCleanScratch: false,
  scratchTtlHours: 168,
  scanRoots: [],
  scanDepth: 1,
  scanMaxEntries: 120000,
  allowRoots: [],
  indexFile: '',
  planOnly: true,
  redirectTemp: true,
  tempRedirectDir: '',
}

/** 這些目錄在掃描時直接跳過（系統、回收站、雲端佔位）。 */
const SCAN_SKIP = new Set(
  [
    'windows',
    'program files',
    'program files (x86)',
    'programdata',
    '$recycle.bin',
    'system volume information',
    'recovery',
    'perflogs',
    'config.msi',
    'documents and settings',
    '$windows.~bt',
    '$windows.~ws',
    'msocache',
    'intel',
    'amd',
    'nvidia',
    'users',
    // 系統 / 開機 / IIS / VS Build Tools / 本插件自己的回收站
    'boot',
    'efi',
    'minint',
    'inetpub',
    'program',
    '_dsh-trash',
  ].map((s) => s.toLowerCase()),
)

/** 判定「這是 agent 中途產物目錄」的特徵子項名。 */
const ARTIFACT_MARKERS = new Set(
  ['dec', 'in', 'out', 'pack', 'decompiled', 'unpacked', 'splits', 'extracted', 'work', 'tmp', 'temp'].map((s) =>
    s.toLowerCase(),
  ),
)

const ARTIFACT_FILES = new Set(['apktool.yml', 'apktool.json', '.dsh-owner.json', 'classes.dex'])

// ────────────────────────────────────────────────────────────────────────────
// 路徑工具
// ────────────────────────────────────────────────────────────────────────────

function expandPath(p, base) {
  let s = String(p ?? '').trim()
  if (!s) return ''
  if (s === '~') s = homedir()
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = join(homedir(), s.slice(2))
  s = s.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`)
  return isAbsolute(s) ? resolve(s) : resolve(base, s)
}

function dshHome() {
  const env = process.env.DSH_HOME?.trim()
  return env ? resolve(env) : join(homedir(), '.dsh')
}

/** 取真實路徑；不存在或無權限就原樣返回。用來消除 8.3 短名（ADMINI~1）造成的誤判。 */
function canonical(p) {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** Windows 大小寫不敏感的大小比較。 */
function within(child, parent) {
  if (!child || !parent) return false
  const a = resolve(child).toLowerCase().replace(/[\\/]+$/, '')
  const b = resolve(parent).toLowerCase().replace(/[\\/]+$/, '')
  if (!b) return false
  return a === b || a.startsWith(b + sep) || a.startsWith(b + '/')
}

function withinAny(child, parents) {
  return parents.some((p) => within(child, p))
}

/** 取磁碟代號（大寫），不是絕對路徑就回 undefined。 */
function driveOf(p) {
  const m = /^([A-Za-z]):[\\/]/.exec(String(p ?? ''))
  return m ? m[1].toUpperCase() : undefined
}

function isProtected(p, drives) {
  const d = driveOf(p)
  return d !== undefined && drives.includes(d)
}

/**
 * 從 shell 命令字串裡抽出 Windows 絕對路徑。
 * 只取「像路徑」的片段；不做語義解析（寧可少抓，也不要誤殺）。
 */
function extractPaths(command) {
  const out = new Set()
  const re = /(?:^|[\s"'`=<>|&(;,])("?)([A-Za-z]:[\\/][^\s"'`|&<>;)]*)\1/g
  let m
  while ((m = re.exec(command)) !== null) {
    const p = m[2].replace(/[.,;]+$/, '')
    if (p.length >= 3) out.add(p)
  }
  return [...out]
}

// ────────────────────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────────────────────

function resolveConfig(config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const home = dshHome()
  const scratchRoot = expandPath(cfg.scratchRoot || join(home, 'scratch'), home)
  const indexFile = expandPath(cfg.indexFile || join(home, 'workspace-mgr', 'index.json'), home)
  const scanRoots = (Array.isArray(cfg.scanRoots) && cfg.scanRoots.length ? cfg.scanRoots : ['C:\\']).map((p) =>
    expandPath(p, home),
  )
  const tempDir = process.env.TEMP || process.env.TMP || ''
  const tempRedirectDir = expandPath(cfg.tempRedirectDir || join(home, 'cache', 'tmp'), home)
  // 重定向之後，%TEMP% 已不是原本那個；舊位置仍要掃，否則歷史殘留會變成盲區
  const legacyTempDirs = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : '',
    'C:\\Windows\\Temp',
  ].filter(Boolean)
  const osTemp = (() => {
    try {
      return tmpdir()
    } catch {
      return ''
    }
  })()
  const builtinAllow = [
    home,
    scratchRoot,
    tempDir,
    osTemp,
    tempRedirectDir,
    // 有些 shell（MSYS）會把 TEMP 改寫成 /tmp，這時仍要認得真正的 Windows 臨時目錄
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : '',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean)
  const extraAllow = (Array.isArray(cfg.allowRoots) ? cfg.allowRoots : []).map((p) => expandPath(p, home))
  return {
    gate: cfg.gate !== false,
    protectDrives: (Array.isArray(cfg.protectDrives) && cfg.protectDrives.length ? cfg.protectDrives : ['C']).map(
      (d) => String(d).replace(':', '').toUpperCase(),
    ),
    scratchRoot,
    autoCleanScratch: cfg.autoCleanScratch === true,
    scratchTtlHours: Number(cfg.scratchTtlHours) > 0 ? Number(cfg.scratchTtlHours) : 168,
    scanRoots,
    scanDepth: Number(cfg.scanDepth) >= 0 ? Math.floor(Number(cfg.scanDepth)) : 1,
    scanMaxEntries: Number(cfg.scanMaxEntries) > 0 ? Math.floor(Number(cfg.scanMaxEntries)) : 120000,
    allowRoots: [...builtinAllow, ...extraAllow].filter(Boolean).map(canonical),
    indexFile,
    home,
    tempDir,
    redirectTemp: cfg.redirectTemp !== false,
    tempRedirectDir,
    legacyTempDirs,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 會話上下文
// ────────────────────────────────────────────────────────────────────────────

function sessionIdOf(agent) {
  try {
    return agent?.id ?? agent?.session?.id ?? undefined
  } catch {
    return undefined
  }
}

function sessionCwd(ctx, agent) {
  try {
    const id = sessionIdOf(agent)
    if (!id) return undefined
    const sessions = ctx.get?.('sessions')
    const session = sessions?.get?.(id)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd) return cwd
    const wd = ctx.get?.('workingDirectory')
    return typeof wd?.defaultDirectory === 'string' ? wd.defaultDirectory : undefined
  } catch {
    return undefined
  }
}

function scratchFor(cfg, sessionId) {
  const safe = String(sessionId ?? 'shared').replace(/[^A-Za-z0-9._-]/g, '')
  return join(cfg.scratchRoot, safe || 'shared')
}

async function ensureScratch(cfg, sessionId) {
  const dir = scratchFor(cfg, sessionId)
  try {
    await mkdir(dir, { recursive: true })
    const marker = join(dir, '.dsh-owner.json')
    if (!existsSync(marker)) {
      await writeFile(
        marker,
        `${JSON.stringify(
          {
            owner: 'dsh-workspace-mgr',
            sessionId: sessionId ?? null,
            createdAt: new Date().toISOString(),
            note: '此目錄由 dsh-workspace-mgr 建立；預設不自動刪除，請由面板確認回收。',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    }
  } catch (e) {
    // 建立失敗不影響閘門決策
  }
  return dir
}

// ────────────────────────────────────────────────────────────────────────────
// 閘門
// ────────────────────────────────────────────────────────────────────────────

const SHELL_TOOLS = new Set(['ops_bash', 'bash', 'pwsh', 'terminal_open'])
const WRITE_TOOLS = new Set(['write', 'edit'])

/**
 * 檢查一次工具呼叫是否會踩到 C 盤。回傳命中資訊或 undefined。
 * 規則（刻意極簡，避免誤殺）：
 *   - 寫檔工具（write/edit）：目標在受保護碟且不在白名單 → 攔
 *   - shell：命令裡出現的受保護碟絕對路徑，**不存在** → 攔（= 想新建）
 *             已存在 → 放行（讀取既有檔案是合法的）
 */
function inspectCall(cfg, exec, allow) {
  const tool = String(exec?.name ?? '')
  const args = exec?.arguments ?? {}
  const candidates = []

  if (WRITE_TOOLS.has(tool)) {
    const p = args.file_path ?? args.path
    if (typeof p === 'string' && p) candidates.push({ p, kind: 'write' })
  } else if (SHELL_TOOLS.has(tool)) {
    if (typeof args.workdir === 'string' && args.workdir) candidates.push({ p: args.workdir, kind: 'workdir' })
    const cmd = typeof args.command === 'string' ? args.command : ''
    for (const p of extractPaths(cmd)) candidates.push({ p, kind: 'create' })
  } else {
    return undefined
  }

  for (const c of candidates) {
    const abs = isAbsolute(c.p) ? resolve(c.p) : undefined
    if (!abs) continue
    if (!isProtected(abs, cfg.protectDrives)) continue
    if (withinAny(abs, allow)) continue
    if (c.kind === 'create' && existsSync(abs)) continue
    if (c.kind === 'workdir' && existsSync(abs)) continue
    return { path: abs, kind: c.kind }
  }
  return undefined
}

function denialReason(cfg, hit, sessionId, scratch) {
  const verb = hit.kind === 'create' ? '新建' : '寫入'
  return [
    `【工作區守衛】已拒絕：${verb} ${hit.path}`,
    '',
    `原因：受保護磁碟（${cfg.protectDrives.join('/')}:）不允許再${verb}產物或目錄。`,
    '這條規則不是建議，是工具層強制攔截；照下面改路徑重試即可。',
    '',
    `本會話 scratch（已建好，直接可用）：`,
    `  ${scratch}`,
    '',
    '正確寫法示例：',
    `  mkdir -p "${join(scratch, 'w1')}" && apktool d in.apk -o "${join(scratch, 'w1', 'dec')}"`,
    `  robocopy . "${join(scratch, 'out')}" /E`,
    '',
    '若目標是已存在的 C 盤檔案（只是讀取），直接把完整路徑重試即可放行。',
  ].join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 掃描與帳本
// ────────────────────────────────────────────────────────────────────────────

async function measureDir(dir, cfg) {
  const limit = cfg.scanMaxEntries
  let seen = 0
  let bytes = 0
  let files = 0
  let newest = 0
  const markers = new Set()

  async function walk(current, depth) {
    if (depth > 4 || seen > limit) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (seen > limit) return
      const full = join(current, ent.name)
      try {
        if (ent.isSymbolicLink()) continue
        if (ent.isDirectory()) {
          if (depth === 0 && ARTIFACT_MARKERS.has(ent.name.toLowerCase())) markers.add(ent.name)
          await walk(full, depth + 1)
        } else if (ent.isFile()) {
          seen++
          const st = await stat(full)
          files++
          bytes += st.size
          if (st.mtimeMs > newest) newest = st.mtimeMs
          if (depth === 0 && ARTIFACT_FILES.has(ent.name.toLowerCase())) markers.add(ent.name)
        }
      } catch {
        /* 單檔失敗不影響統計 */
      }
    }
  }

  await walk(dir, 0)
  return { bytes, files, newest, markers: [...markers], truncated: seen > limit }
}

/**
 * 分類。刻意保守：只有拿到「證據」才標成疑似 agent 產物，
 * 避免把 C:\Qt、C:\tools 這類正常安裝誤標。
 *   - 有 apktool 特徵（dec/in/out/pack…）→ 疑似
 *   - 目錄名極短（≤4 字元，像 C:\w1、C:\tw）且 14 天內有寫入 → 疑似
 */
function classify(dir, cfg, m) {
  if (within(dir, cfg.scratchRoot)) return 'scratch'
  if (cfg.tempDir && within(dir, cfg.tempDir) && basename(dir).toLowerCase().startsWith('dsh-')) return 'known-dsh'
  const name = basename(dir)
  const shortName = /^[A-Za-z0-9_-]{1,4}$/.test(name)
  const hasMarkers = (m?.markers?.length ?? 0) > 0
  const recent = typeof m?.newest === 'number' && Date.now() - m.newest < 14 * 86400000
  if (hasMarkers || (shortName && recent)) return 'suspected-agent-scratch'
  return 'unclassified'
}

async function readIndex(cfg) {
  try {
    const raw = await readFile(cfg.indexFile, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.items ? parsed : { items: {}, stats: {} }
  } catch {
    return { items: {}, stats: {} }
  }
}

async function writeIndex(cfg, index) {
  try {
    await mkdir(dirname(cfg.indexFile), { recursive: true })
    await writeFile(cfg.indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  } catch (e) {
    console.warn(`${LOG} 索引写入失败：${e?.message ?? e}`)
  }
}

/** 掃描一輪：C 盤根目錄一層 + DSH 臨時目錄家族 + scratch 子目錄。 */
async function runScan(cfg, state) {
  const previous = await readIndex(cfg)
  const items = {}
  const now = new Date().toISOString()

  for (const root of cfg.scanRoots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue
      if (SCAN_SKIP.has(ent.name.toLowerCase())) continue
      const full = join(root, ent.name)
      const m = await measureDir(full, cfg)
      const prev = previous.items[full] ?? {}
      items[full] = {
        path: full,
        bytes: m.bytes,
        files: m.files,
        newest: m.newest ? new Date(m.newest).toISOString() : undefined,
        class: classify(full, cfg, m),
        signature: m.markers,
        truncated: m.truncated,
        firstSeen: prev.firstSeen ?? now,
        lastScan: now,
        state: prev.state ?? 'pending',
        note: prev.note ?? '',
      }
    }
  }

  // DSH 自己的臨時目錄家族（當前 %TEMP% + 重定向前的舊位置）
  const tempCandidates = new Set([cfg.tempDir, ...(cfg.legacyTempDirs ?? [])].filter(Boolean))
  for (const tempDir of tempCandidates) {
    try {
      const entries = await readdir(tempDir, { withFileTypes: true })
      for (const ent of entries) {
        if (!ent.isDirectory() || !ent.name.toLowerCase().startsWith('dsh-')) continue
        const full = join(tempDir, ent.name)
        if (items[full]) continue
        const m = await measureDir(full, cfg)
        const prev = previous.items[full] ?? {}
        items[full] = {
          path: full,
          bytes: m.bytes,
          files: m.files,
          newest: m.newest ? new Date(m.newest).toISOString() : undefined,
          class: 'known-dsh',
          signature: [],
          truncated: m.truncated,
          firstSeen: prev.firstSeen ?? now,
          lastScan: now,
          state: prev.state ?? 'pending',
          note: prev.note ?? '',
        }
      }
    } catch {
      /* 临时目录不可读就跳过 */
    }
  }

  // scratch 子目录
  try {
    const entries = await readdir(cfg.scratchRoot, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const full = join(cfg.scratchRoot, ent.name)
      const m = await measureDir(full, cfg)
      const prev = previous.items[full] ?? {}
      items[full] = {
        path: full,
        bytes: m.bytes,
        files: m.files,
        newest: m.newest ? new Date(m.newest).toISOString() : undefined,
        class: 'scratch',
        signature: [],
        truncated: m.truncated,
        firstSeen: prev.firstSeen ?? now,
        lastScan: now,
        state: prev.state ?? 'pending',
        note: prev.note ?? '',
      }
    }
  } catch {
    /* scratch 尚未建立 */
  }

  const index = {
    version: 1,
    scannedAt: now,
    scanRoots: cfg.scanRoots,
    stats: {
      ...previous.stats,
      totalBytes: Object.values(items).reduce((n, i) => n + (i.bytes ?? 0), 0),
      totalItems: Object.keys(items).length,
    },
    items,
  }

  // 併入「事後觀測」得到的證據
  for (const [p, ev] of Object.entries(state.evidence ?? {})) {
    if (items[p]) {
      items[p].evidence = ev
      if (items[p].state === 'pending') items[p].class = 'observed-agent-scratch'
    } else if (existsSync(p)) {
      items[p] = {
        path: p,
        bytes: 0,
        files: 0,
        class: 'observed-agent-scratch',
        signature: [],
        firstSeen: ev.at,
        lastScan: now,
        state: 'pending',
        note: '',
        evidence: ev,
      }
    }
  }

  await writeIndex(cfg, index)
  return index
}

// ────────────────────────────────────────────────────────────────────────────
// 回收站（同盤、可還原、有審計）
// ────────────────────────────────────────────────────────────────────────────

const TRASH_DIR_NAME = '_dsh-trash'

/** 磁碟根下這些名字一律不碰（即使被誤標為已確認）。 */
const HARD_REFUSE = new Set(
  [
    'windows',
    'program files',
    'program files (x86)',
    'programdata',
    '$recycle.bin',
    'system volume information',
    'recovery',
    'perflogs',
    'users',
    'documents and settings',
  ].map((s) => s.toLowerCase()),
)

function trashRootFor(target) {
  const d = driveOf(target)
  return d ? `${d}:\\${TRASH_DIR_NAME}` : ''
}

function auditFile(cfg) {
  return join(dirname(cfg.indexFile), 'audit.jsonl')
}

async function audit(cfg, record) {
  try {
    await mkdir(dirname(cfg.indexFile), { recursive: true })
    await writeFile(auditFile(cfg), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
      flag: 'a',
    })
  } catch (e) {
    console.warn(`${LOG} 审计写入失败：${e?.message ?? e}`)
  }
}

/** 回收前的硬性校驗；回傳字串代表拒絕理由。 */
function checkRecyclable(cfg, target) {
  const abs = resolve(String(target ?? ''))
  if (!driveOf(abs)) return '不是絕對路徑'
  const parts = abs.split(sep).filter(Boolean)
  if (parts.length < 2) return '不處理磁碟根'
  const rootName = parts[1].toLowerCase()
  if (parts.length === 2 && HARD_REFUSE.has(rootName)) return `受保護的系統目錄：${abs}`
  if (parts.length === 2 && rootName === TRASH_DIR_NAME) return '不處理回收站本身'
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return '路徑不存在'
  }
  if (st.isSymbolicLink()) return '是連結（junction / symlink），不處理'
  if (!st.isDirectory()) return '只處理目錄'
  const low = abs.toLowerCase()
  if (low === cfg.scratchRoot.toLowerCase()) return '不處理 scratch 根'
  if (within(abs, cfg.home)) return '不處理 DSH 主目錄內的內容'
  if (cfg.tempDir && within(abs, cfg.tempDir)) return '不處理系統臨時目錄'
  if (cfg.tempRedirectDir && within(abs, cfg.tempRedirectDir)) return '不處理重定向後的臨時目錄'
  return undefined
}

/** 掃出所有磁碟上存在的回收站項目。 */
async function listTrash() {
  const out = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\${TRASH_DIR_NAME}`
    if (!existsSync(root)) continue
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const dir = join(root, ent.name)
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
        out.push({ ...manifest, id: ent.name, trashDir: dir, payloadExists: existsSync(join(dir, 'payload')) })
      } catch {
        out.push({ id: ent.name, trashDir: dir, broken: true, payloadExists: existsSync(join(dir, 'payload')) })
      }
    }
  }
  return out.sort((a, b) => String(b.recycledAt ?? '').localeCompare(String(a.recycledAt ?? '')))
}

async function findTrashEntry(id) {
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const dir = `${letter}:\\${TRASH_DIR_NAME}\\${id}`
    if (existsSync(dir)) return dir
  }
  return undefined
}

/** 把目錄移進同盤回收站（rename，即時、不複製）。 */
async function recyclePaths(cfg, paths, state, sessionId) {
  const index = await readIndex(cfg)
  const results = []

  for (const raw of paths) {
    const abs = resolve(String(raw ?? ''))
    const why = checkRecyclable(cfg, abs)
    if (why) {
      results.push({ path: abs, ok: false, error: why })
      continue
    }
    // 只允許已確認的項目，避免介面誤觸
    const item = index.items?.[abs]
    if (!item || item.state !== 'confirmed') {
      results.push({ path: abs, ok: false, error: '未在索引中標記為「已確認」，先在面板按確認' })
      continue
    }
    const root = trashRootFor(abs)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const id = `${stamp}-${basename(abs).replace(/[^\w.-]/g, '_')}`
    const entryDir = join(root, id)
    const payload = join(entryDir, 'payload')

    try {
      const measured = await measureDir(abs, cfg)
      await mkdir(entryDir, { recursive: true })
      await rename(abs, payload)
      await writeFile(
        join(entryDir, 'manifest.json'),
        `${JSON.stringify(
          {
            id,
            originalPath: abs,
            bytes: measured.bytes,
            files: measured.files,
            recycledAt: new Date().toISOString(),
            sessionId: sessionId ?? null,
            class: item.class,
            signature: item.signature ?? [],
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      delete index.items[abs]
      await audit(cfg, { action: 'recycle', id, path: abs, bytes: measured.bytes, files: measured.files, sessionId })
      state.recent.push({ action: 'recycle', path: abs, bytes: measured.bytes })
      results.push({ path: abs, ok: true, id, bytes: measured.bytes, files: measured.files })
    } catch (e) {
      const message = String(e?.message ?? e)
      results.push({ path: abs, ok: false, error: message })
      await audit(cfg, { action: 'recycle-failed', path: abs, error: message })
    }
  }

  index.stats = {
    ...index.stats,
    totalItems: Object.keys(index.items ?? {}).length,
    totalBytes: Object.values(index.items ?? {}).reduce((n, i) => n + (i.bytes ?? 0), 0),
  }
  await writeIndex(cfg, index)
  return results
}

async function restoreTrash(cfg, id) {
  const dir = await findTrashEntry(String(id))
  if (!dir) return { ok: false, error: '找不到该回收站条目' }
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  const target = manifest.originalPath
  if (existsSync(target)) return { ok: false, error: `原路径已被占用：${target}` }
  const parent = dirname(target)
  // Windows 上對磁碟根（C:\）呼叫 mkdir recursive 會 EPERM，先判斷再建
  if (!existsSync(parent)) await mkdir(parent, { recursive: true })
  await rename(join(dir, 'payload'), target)
  await rm(dir, { recursive: true, force: true })
  await audit(cfg, { action: 'restore', id, path: target })
  return { ok: true, path: target }
}

async function purgeTrash(cfg, id) {
  const dir = await findTrashEntry(String(id))
  if (!dir) return { ok: false, error: '找不到该回收站条目' }
  let manifest = {}
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  } catch {
    /* 破损条目也允许清掉 */
  }
  await rm(dir, { recursive: true, force: true })
  await audit(cfg, { action: 'purge', id, path: manifest.originalPath ?? null, bytes: manifest.bytes ?? 0 })
  return { ok: true }
}

// ────────────────────────────────────────────────────────────────────────────
// 事後即時觀測：每次 shell 執行完，重讀掃描根一層，比對新增目錄
// 這不是推斷，是觀察——連腳本內部偷偷建立的目錄也抓得到，而且能對上
// 「哪個會話、哪一次工具呼叫、什麼時間」。
// ────────────────────────────────────────────────────────────────────────────

/** 讀取一個根目錄下的目錄名集合，失敗回空集合。 */
async function listRootDirs(root) {
  const names = new Set()
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.isSymbolicLink()) names.add(ent.name)
    }
  } catch {
    /* 不可讀 */
  }
  return names
}

/** 建立/更新基線，並回傳這次新出現的絕對路徑。 */
async function diffRoots(state, roots) {
  const created = []
  for (const root of roots) {
    const before = state.rootCache.get(root)
    const now = await listRootDirs(root)
    if (before) {
      for (const name of now) {
        if (!before.has(name)) created.push(join(root, name))
      }
    }
    state.rootCache.set(root, now)
  }
  return created
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP 路由（面板用）
// ────────────────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        rejectBody(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {})
      } catch (e) {
        rejectBody(e)
      }
    })
    req.on('error', rejectBody)
  })
}

function mountRoutes(ctx, cfg, state) {
  const webServer = ctx.get?.('webServer')
  if (!webServer?.register) {
    console.warn(`${LOG} webServer 不可用，面板路由未挂载`)
    return
  }

  const routes = [
    [
      'exact',
      '/api/workspace-mgr/status',
      async (req, res) => {
        const index = await readIndex(cfg)
        const items = Object.values(index.items ?? {})
        sendJson(res, 200, {
          ok: true,
          config: {
            gate: cfg.gate,
            protectDrives: cfg.protectDrives,
            scratchRoot: cfg.scratchRoot,
            autoCleanScratch: cfg.autoCleanScratch,
            scanRoots: cfg.scanRoots,
            tempDir: cfg.tempDir,
            tempRedirectDir: cfg.tempRedirectDir,
            redirectTemp: cfg.redirectTemp,
            indexFile: cfg.indexFile,
          },
          gate: {
            denials: state.denials,
            lastDenial: state.lastDenial,
            recent: state.recent.slice(-20),
            observeHits: state.hits ?? {},
            evidenceCount: Object.keys(state.evidence ?? {}).length,
          },
          summary: {
            totalItems: items.length,
            totalBytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0),
            confirmed: items.filter((i) => i.state === 'confirmed').length,
            dismissed: items.filter((i) => i.state === 'dismissed').length,
            observed: items.filter((i) => i.evidence).length,
            scratchBytes: items.filter((i) => i.class === 'scratch').reduce((n, i) => n + (i.bytes ?? 0), 0),
          },
          scannedAt: index.scannedAt ?? null,
        })
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/scan',
      async (req, res) => {
        if (state.scanning) {
          sendJson(res, 409, { ok: false, message: '扫描进行中' })
          return
        }
        state.scanning = true
        try {
          const index = await runScan(cfg, state)
          sendJson(res, 200, { ok: true, index })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        } finally {
          state.scanning = false
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/mark',
      async (req, res) => {
        try {
          const body = await readJson(req)
          const target = String(body?.path ?? '')
          const nextState = String(body?.state ?? '')
          if (!target || !['pending', 'confirmed', 'dismissed'].includes(nextState)) {
            sendJson(res, 400, { ok: false, message: 'path / state 不合法' })
            return
          }
          const index = await readIndex(cfg)
          const item = index.items?.[target]
          if (!item) {
            sendJson(res, 404, { ok: false, message: '索引中没有该路径，请先扫描' })
            return
          }
          item.state = nextState
          item.note = String(body?.note ?? item.note ?? '')
          item.markedAt = new Date().toISOString()
          await writeIndex(cfg, index)
          sendJson(res, 200, { ok: true, item })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/dry-run',
      async (req, res) => {
        try {
          const body = await readJson(req)
          const paths = Array.isArray(body?.paths) ? body.paths.map(String) : []
          const index = await readIndex(cfg)
          const picked = paths.length ? paths : Object.values(index.items ?? {}).filter((i) => i.state === 'confirmed').map((i) => i.path)
          const rows = picked
            .map((p) => index.items?.[p])
            .filter(Boolean)
            .map((i) => ({ path: i.path, bytes: i.bytes, class: i.class, state: i.state }))
          sendJson(res, 200, {
            ok: true,
            planOnly: true,
            message: '本版只做預覽，不執行任何刪除。',
            count: rows.length,
            bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
            rows,
          })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/browse',
      async (req, res) => {
        try {
          const body = await readJson(req)
          const target = String(body?.path ?? '')
          if (!target || !driveOf(target)) {
            sendJson(res, 400, { ok: false, message: '需要绝对路径' })
            return
          }
          const abs = resolve(target)
          if (!existsSync(abs)) {
            sendJson(res, 404, { ok: false, message: `路径不存在：${abs}` })
            return
          }
          const entries = await readdir(abs, { withFileTypes: true })
          const rows = []
          for (const ent of entries.slice(0, 500)) {
            const full = join(abs, ent.name)
            let bytes = 0
            let mtime
            try {
              const st = lstatSync(full)
              bytes = st.isDirectory() ? 0 : st.size
              mtime = new Date(st.mtimeMs).toISOString()
            } catch {
              /* 竞争删除 */
            }
            rows.push({ name: ent.name, dir: ent.isDirectory(), link: ent.isSymbolicLink(), bytes, mtime })
          }
          rows.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name))
          sendJson(res, 200, { ok: true, path: abs, entries: rows, truncated: entries.length > 500 })
        } catch (e) {
          sendJson(res, 400, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/trash',
      async (req, res) => {
        try {
          const items = await listTrash()
          sendJson(res, 200, {
            ok: true,
            items,
            bytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0),
          })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/recycle',
      async (req, res) => {
        try {
          const body = await readJson(req)
          if (body?.confirm !== true) {
            sendJson(res, 400, { ok: false, message: '需要 confirm: true（回收進同盤回收站，可還原）' })
            return
          }
          const paths = Array.isArray(body?.paths) ? body.paths.map(String) : []
          if (!paths.length) {
            sendJson(res, 400, { ok: false, message: 'paths 不能為空' })
            return
          }
          const results = await recyclePaths(cfg, paths, state, body?.sessionId ?? null)
          sendJson(res, 200, {
            ok: results.every((r) => r.ok),
            results,
            recycledBytes: results.filter((r) => r.ok).reduce((n, r) => n + (r.bytes ?? 0), 0),
          })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/restore',
      async (req, res) => {
        try {
          const body = await readJson(req)
          const out = await restoreTrash(cfg, body?.id)
          sendJson(res, out.ok ? 200 : 400, { ...out })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
    [
      'exact',
      '/api/workspace-mgr/purge',
      async (req, res) => {
        try {
          const body = await readJson(req)
          if (body?.confirm !== true) {
            sendJson(res, 400, { ok: false, message: '永久刪除需要 confirm: true' })
            return
          }
          const out = await purgeTrash(cfg, body?.id)
          sendJson(res, out.ok ? 200 : 400, { ...out })
        } catch (e) {
          sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
        }
      },
    ],
  ]

  for (const [kind, path, handler] of routes) {
    try {
      ctx.effect(() =>
        webServer.register({
          kind,
          path,
          handler: async (req, res) => {
            try {
              await handler(req, res)
            } catch (e) {
              try {
                sendJson(res, 500, { ok: false, message: String(e?.message ?? e) })
              } catch {
                /* 回应已发出 */
              }
            }
          },
        }),
      )
    } catch (e) {
      console.warn(`${LOG} 路由注册失败 ${path}: ${e?.message ?? e}`)
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 主體
// ────────────────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  let cfg
  try {
    cfg = resolveConfig(config)
  } catch (e) {
    ctx.logger?.warn?.(`${LOG} 配置解析失败，插件跳过：${e?.message ?? e}`)
    return
  }

  const state = { denials: 0, lastDenial: null, recent: [], scanning: false, rootCache: new Map(), evidence: {} }

  try {
    await mkdir(cfg.scratchRoot, { recursive: true })
  } catch (e) {
    ctx.logger?.warn?.(`${LOG} 无法创建 scratch 根 ${cfg.scratchRoot}：${e?.message ?? e}`)
  }

  // ④ 觀測：建立基線，並在每次 shell / write 執行後比對掃描根一層
  //    工具結果事件可能是 scope 分發（按 exec.agent），所以同時掛 tools/result
  //    與 tools/post-execute，再加一個定時兜底；三者共用同一個比對管道並去重。
  try {
    await diffRoots(state, cfg.scanRoots)

    let chain = Promise.resolve()
    const schedule = (exec, source) => {
      chain = chain
        .then(async () => {
          if (Date.now() - (state.lastDiffMs ?? 0) < 150) return
          state.lastDiffMs = Date.now()
          const created = await diffRoots(state, cfg.scanRoots)
          state.hits = state.hits ?? {}
          state.hits[source] = (state.hits[source] ?? 0) + 1
          if (!created.length) return
          const at = new Date().toISOString()
          const sid = sessionIdOf(exec?.agent)
          const tool = String(exec?.name ?? '')
          const callId = String(exec?.callId ?? '')
          for (const p of created) {
            state.evidence[p] = { at, sessionId: sid ?? null, tool, callId, source }
            ctx.logger?.info?.(`${LOG} 观测到新建目录 ${p}（session=${sid ?? '?'} tool=${tool} via ${source}）`)
          }
          const idx = await readIndex(cfg)
          idx.items = idx.items ?? {}
          for (const p of created) {
            const prev = idx.items[p]
            if (prev) prev.evidence = state.evidence[p]
            else
              idx.items[p] = {
                path: p,
                bytes: 0,
                files: 0,
                class: 'observed-agent-scratch',
                signature: [],
                firstSeen: at,
                lastScan: at,
                state: 'pending',
                note: '',
                evidence: state.evidence[p],
              }
          }
          idx.stats = {
            ...idx.stats,
            totalItems: Object.keys(idx.items).length,
            totalBytes: Object.values(idx.items).reduce((n, i) => n + (i.bytes ?? 0), 0),
          }
          await writeIndex(cfg, idx)
        })
        .catch((e) => ctx.logger?.warn?.(`${LOG} 观测失败：${e?.message ?? e}`))
    }

    const onToolDone = (exec) => {
      try {
        const tool = String(exec?.name ?? '')
        if (!SHELL_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) return
        schedule(exec, 'tool-event')
      } catch {
        /* 觀測失敗不得影響工具本身 */
      }
    }

    // tools/post-execute 的簽名是 (exec, result, next)，漏掉 result 會直接拋錯
    ctx.effect(() =>
      ctx.on('tools/post-execute', (exec, result, next) => {
        onToolDone(exec)
        return next()
      }),
    )
    ctx.effect(() => ctx.on('tools/result', (exec) => onToolDone(exec)))

    // 定時兜底：抓「不是透過工具」的變更（外部程式、其他終端）
    const timer = setInterval(() => {
      if (Date.now() - (state.lastDiffMs ?? 0) < 1000) return
      state.lastDiffMs = Date.now()
      void diffRoots(state, cfg.scanRoots).then((created) => {
        if (!created.length) return
        const at = new Date().toISOString()
        for (const p of created) {
          if (state.evidence[p]) continue
          state.evidence[p] = { at, sessionId: null, tool: '(poll)', callId: '', source: 'poll' }
          ctx.logger?.info?.(`${LOG} 轮询观测到新建目录 ${p}`)
        }
      })
    }, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearInterval(timer))

    ctx.logger?.info?.(`${LOG} 事后观测已启用：${cfg.scanRoots.join('、')} 一层`)
  } catch (e) {
    ctx.logger?.warn?.(`${LOG} 观测初始化失败：${e?.message ?? e}`)
  }

  // ⑤ 進程臨時目錄重定向：os.tmpdir() 每次呼叫都讀 TMP/TEMP，
  //    所以在這裡改就能讓之後新建的 dsh-workspace-changes-*、dsh-spill-*、
  //    dsh-subprocess-* 全部落到非 C 盤（不需重啟；系統級 setx 另說）。
  if (cfg.redirectTemp) {
    try {
      await mkdir(cfg.tempRedirectDir, { recursive: true })
      const before = { TEMP: process.env.TEMP, TMP: process.env.TMP }
      process.env.TEMP = cfg.tempRedirectDir
      process.env.TMP = cfg.tempRedirectDir
      ctx.logger?.info?.(
        `${LOG} 進程臨時目錄已重定向：${before.TEMP ?? '(空)'} → ${cfg.tempRedirectDir}`,
      )
    } catch (e) {
      ctx.logger?.warn?.(`${LOG} 临时目录重定向失败（保持原值）：${e?.message ?? e}`)
    }
  }

  // ① 閘門
  if (cfg.gate) {
    ctx.effect(() =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        try {
          const allow = [...cfg.allowRoots]
          const cwd = sessionCwd(ctx, exec?.agent)
          if (cwd) allow.push(cwd)
          const hit = inspectCall(cfg, exec, allow)
          if (!hit) return next()
          const sid = sessionIdOf(exec?.agent)
          const scratch = await ensureScratch(cfg, sid)
          state.denials++
          const entry = {
            at: new Date().toISOString(),
            sessionId: sid ?? null,
            tool: String(exec?.name ?? ''),
            path: hit.path,
            kind: hit.kind,
          }
          state.lastDenial = entry
          state.recent.push(entry)
          if (state.recent.length > 200) state.recent.shift()
          ctx.logger?.info?.(`${LOG} 拦截 ${entry.tool} → ${hit.path}`)
          return { kind: 'deny', reason: denialReason(cfg, hit, sid, scratch) }
        } catch (e) {
          ctx.logger?.warn?.(`${LOG} 闸门检查异常（放行）：${e?.message ?? e}`)
          return next()
        }
      }),
    )
    ctx.logger?.info?.(`${LOG} 闸门已启用：受保护磁碟 ${cfg.protectDrives.join('/')}:`)
  }

  // ③ 提示詞
  try {
    const systemPrompt = ctx.get?.('systemPrompt')
    if (systemPrompt?.section) {
      ctx.effect(() =>
        systemPrompt.section({
          name: 'workspace-mgr/scratch-discipline',
          order: 900,
          text: () => {
            // 組裝 system prompt 時正處在该 agent 的驅動鏈裡，
            // 用 currentInitiator 拿到它自己的 session id，給出真實路徑而不是模板
            let sid
            try {
              sid = ctx.get?.('agents')?.currentInitiator?.()?.id
            } catch {
              sid = undefined
            }
            const scratch = sid ? join(cfg.scratchRoot, String(sid).replace(/[^A-Za-z0-9._-]/g, '')) : undefined
            return [
              '【工作區守衛 · 產物落盤規則】（插件注入，具強制力）',
              '1. 本會話 scratch 目錄（中間產物、解包、編譯、臨時下載一律放這裡）：',
              scratch ? `   ${scratch}` : `   ${cfg.scratchRoot}\\<sessionId>\\（不知 id 時用此根目錄下自建子目錄）`,
              scratch ? `   例：${join(scratch, 'w1', 'dec')}` : '',
              '2. 受保護磁碟（' + cfg.protectDrives.join('/') + ':）：禁止新建任何目錄或寫入任何產物，',
              '   包括 C:\\w1、C:\\tmp、桌面、文件、下載。',
              '3. 工具層會直接拒絕這類呼叫，並回覆可用路徑；不要反覆重試同一個 C 盤路徑。',
              '4. 讀取 C 盤既有的系統檔案不受限制。',
              '5. 需要盤點或清理時，使用側欄的「工作區守衛」面板（只標記、不自動刪）。',
            ]
              .filter((l) => l !== '')
              .join('\n')
          },
        }),
      )
    }
  } catch (e) {
    ctx.logger?.warn?.(`${LOG} 提示词注册失败：${e?.message ?? e}`)
  }

  // ④ 路由 / 帳本
  try {
    mountRoutes(ctx, cfg, state)
  } catch (e) {
    ctx.logger?.warn?.(`${LOG} 路由挂载失败：${e?.message ?? e}`)
  }

  ctx.logger?.info?.(
    `${LOG} 就绪 ── scratch=${cfg.scratchRoot} | 保护碟=${cfg.protectDrives.join('/')}: | 自动清理=${
      cfg.autoCleanScratch ? '开' : '关'
    } | 索引=${cfg.indexFile}`,
  )
}

export default { name, inject, apply }
