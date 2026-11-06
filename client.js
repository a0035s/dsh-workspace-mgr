/**
 * dsh-workspace-mgr — browser 半
 *
 * 側欄入口（sidebar.panellist id=workspace-mgr）＋ 對應主面板（main key=workspace-mgr）。
 * 面板只做三件事：狀態總覽、掃描、標記（＋ dry-run 預覽）。
 * 本版沒有任何刪除動作——回收按鈕要等使用者確認介面之後才接。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-mgr',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-workspace-mgr'
    const API = '/api/workspace-mgr'

    const DICT = {
      zh: {
        title: '工作區守衛',
        subtitle: '攔截 C 盤新產物 · 盤點可疑目錄 · 只標記不自動刪',
        scan: '掃描',
        rescan: '重新掃描',
        dryrun: '預覽回收',
        confirm: '確認',
        dismiss: '排除',
        reset: '還原',
        pending: '待確認',
        confirmed: '已確認',
        dismissed: '已排除',
        total: '索引項目',
        sizeTotal: '合計大小',
        denials: '閘門攔截',
        scratch: 'scratch',
        empty: '尚未掃描。按「掃描」建立索引（只讀，不會刪任何東西）。',
        scanning: '掃描中…',
        path: '路徑',
        size: '大小',
        kind: '分類',
        state: '狀態',
        actions: '操作',
        planOnly: '預覽模式：本版不會刪除任何檔案。',
        cls_suspected: '疑似 agent 產物',
        cls_known: 'DSH 臨時',
        cls_scratch: 'scratch',
        cls_unclassified: '未分類',
        lastScan: '上次掃描',
        never: '從未',
        error: '出錯',
        recycle: '回收',
        recycleAll: '回收全部已確認',
        recycleHint: '回收 = 移到同盤回收站，可還原',
        trash: '回收站',
        trashEmpty: '回收站是空的',
        restore: '還原',
        purge: '永久刪除',
        purgeConfirm: '再點一次確認',
        recycled: '已回收',
        observed: '確證',
        suspected: '疑似',
        evidence: '證據',
        browse: '瀏覽',
        close: '關閉',
        emptyDir: '空目錄',
        loading: '載入中…',
        entries: '項',
        back: '上層',
      },
      en: {
        title: 'Workspace Guard',
        subtitle: 'Blocks new C: artifacts · indexes suspicious dirs · marks only, never auto-deletes',
        scan: 'Scan',
        rescan: 'Rescan',
        dryrun: 'Preview reclaim',
        confirm: 'Confirm',
        dismiss: 'Dismiss',
        reset: 'Reset',
        pending: 'Pending',
        confirmed: 'Confirmed',
        dismissed: 'Dismissed',
        total: 'Indexed',
        sizeTotal: 'Total size',
        denials: 'Gate blocks',
        scratch: 'scratch',
        empty: 'No index yet. Press Scan to build one (read-only, deletes nothing).',
        scanning: 'Scanning…',
        path: 'Path',
        size: 'Size',
        kind: 'Class',
        state: 'State',
        actions: 'Actions',
        planOnly: 'Preview only: nothing is deleted in this version.',
        cls_suspected: 'Suspected agent artifacts',
        cls_known: 'DSH temp',
        cls_scratch: 'scratch',
        cls_unclassified: 'Unclassified',
        lastScan: 'Last scan',
        never: 'never',
        error: 'Error',
        recycle: 'Recycle',
        recycleAll: 'Recycle all confirmed',
        recycleHint: 'Recycle = move to same-volume trash, restorable',
        trash: 'Trash',
        trashEmpty: 'Trash is empty',
        restore: 'Restore',
        purge: 'Delete forever',
        purgeConfirm: 'Click again to confirm',
        recycled: 'Recycled',
        observed: 'Observed',
        suspected: 'Suspected',
        evidence: 'Evidence',
        browse: 'Browse',
        close: 'Close',
        emptyDir: 'Empty directory',
        loading: 'Loading…',
        entries: 'entries',
        back: 'Up',
      },
    }

    let t = (k) => DICT.zh[k] ?? k

    function fmtBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
    }

    function fmtTime(iso) {
      if (!iso) return t('never')
      try {
        return new Date(iso).toLocaleString()
      } catch {
        return iso
      }
    }

    function classLabel(c) {
      if (c === 'suspected-agent-scratch') return t('cls_suspected')
      if (c === 'known-dsh') return t('cls_known')
      if (c === 'scratch') return t('cls_scratch')
      return t('cls_unclassified')
    }

    const S = {
      page: {
        minHeight: '100%',
        overflowY: 'auto',
        padding: '22px 26px 40px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxSizing: 'border-box',
      },
      head: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' },
      h1: { fontSize: 19, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' },
      sub: { margin: '4px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      spacer: { flex: '1 1 auto' },
      btn: {
        font: 'inherit',
        fontSize: 12,
        padding: '6px 12px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        font: 'inherit',
        fontSize: 12,
        padding: '6px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        fontWeight: 600,
      },
      btnSmall: {
        font: 'inherit',
        fontSize: 11,
        padding: '3px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
      stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 18 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '10px 12px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      cardLabel: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', letterSpacing: '0.03em' },
      cardValue: { fontSize: 19, fontWeight: 700, marginTop: 2, fontVariantNumeric: 'tabular-nums' },
      tableWrap: {
        marginTop: 18,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        overflow: 'hidden',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: {
        textAlign: 'left',
        padding: '8px 10px',
        fontSize: 10.5,
        letterSpacing: '0.03em',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        fontWeight: 600,
      },
      td: { padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)', verticalAlign: 'top' },
      path: {
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: 11.5,
        wordBreak: 'break-all',
      },
      chip: {
        display: 'inline-block',
        fontSize: 10,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      num: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      empty: {
        marginTop: 18,
        padding: '26px 18px',
        borderRadius: 10,
        border: '1px dashed var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12.5,
        textAlign: 'center',
        lineHeight: 1.6,
      },
      note: {
        marginTop: 12,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.6,
      },
      err: { marginTop: 12, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
      pathLink: {
        font: 'inherit',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: 11.5,
        textAlign: 'left',
        background: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        wordBreak: 'break-all',
        textDecoration: 'underline',
        textDecorationColor: 'var(--dsw-alias-border-l4)',
        textUnderlineOffset: '2px',
      },
      chipOk: {
        display: 'inline-block',
        fontSize: 10,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
        whiteSpace: 'nowrap',
      },
      meta: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)' },
      modalBg: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
        padding: 24,
      },
      modal: {
        width: 'min(760px, 100%)',
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      },
      modalHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      modalBody: { overflowY: 'auto', padding: '4px 0' },
      fileRow: {
        display: 'grid',
        gridTemplateColumns: '1fr 90px 130px',
        gap: 8,
        padding: '6px 14px',
        fontSize: 11.5,
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      },
    }

    function SidebarIcon(props) {
      const size = props?.size ?? 20
      const active = !!props?.active
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.78 },
        },
        h('path', { d: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z' }),
        h('path', { d: 'M9 12.5h6' }),
        h('path', { d: 'M12 9.5v6' }),
      )
    }

    async function api(path, init) {
      const res = await fetch(API + path, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body?.ok === false) throw new Error(body?.message || `HTTP ${res.status}`)
      return body
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [index, setIndex] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [plan, setPlan] = React.useState(null)
      const [trash, setTrash] = React.useState([])
      const [purgeArm, setPurgeArm] = React.useState('')
      const [browse, setBrowse] = React.useState(null)
      const [browseBusy, setBrowseBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const body = await api('/status')
          setStatus(body)
          const t2 = await api('/trash').catch(() => ({ items: [] }))
          setTrash(t2.items || [])
          setError('')
        } catch (e) {
          setError(String(e?.message || e))
        }
      }, [])

      React.useEffect(() => {
        load()
        const id = setInterval(load, 15000)
        return () => clearInterval(id)
      }, [load])

      const doScan = async () => {
        setBusy('scan')
        setError('')
        try {
          const body = await api('/scan', { method: 'POST', body: '{}' })
          setIndex(body.index)
          setPlan(null)
          await load()
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const doMark = async (path, state) => {
        setBusy(path)
        try {
          const body = await api('/mark', { method: 'POST', body: JSON.stringify({ path, state }) })
          setIndex((cur) => {
            if (!cur?.items) return cur
            const items = { ...cur.items, [path]: body.item }
            return { ...cur, items }
          })
          await load()
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const doDryRun = async () => {
        setBusy('dryrun')
        setError('')
        try {
          const body = await api('/dry-run', { method: 'POST', body: '{}' })
          setPlan(body)
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const doRecycle = async (paths) => {
        if (!paths || !paths.length) return
        setBusy('recycle')
        setError('')
        try {
          const body = await api('/recycle', {
            method: 'POST',
            body: JSON.stringify({ paths, confirm: true }),
          })
          const failed = (body.results || []).filter((r) => !r.ok)
          if (failed.length) setError(failed.map((f) => `${f.path}: ${f.error}`).join('; '))
          await load()
          const res = await api('/scan', { method: 'POST', body: '{}' }).catch(() => null)
          if (res?.index) setIndex(res.index)
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const doRestore = async (id) => {
        setBusy(id)
        try {
          const body = await api('/restore', { method: 'POST', body: JSON.stringify({ id }) })
          if (body?.ok === false) setError(body.error || 'restore failed')
          await load()
          const res = await api('/scan', { method: 'POST', body: '{}' }).catch(() => null)
          if (res?.index) setIndex(res.index)
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const doPurge = async (id) => {
        if (purgeArm !== id) {
          setPurgeArm(id)
          return
        }
        setPurgeArm('')
        const item = trash.find((t) => t.id === id)
        const label = item?.originalPath || id
        // 二次確認：purge 是不可逆的實體刪除
        try {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            const ok = window.confirm(`永久刪除？\n\n${label}\n\n此操作無法還原。`)
            if (!ok) return
          }
        } catch {
          /* 无 confirm 环境 */
        }
        setBusy(id)
        try {
          await api('/purge', { method: 'POST', body: JSON.stringify({ id, confirm: true }) })
          await load()
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setBusy('')
        }
      }

      const doBrowse = async (path) => {
        setBrowseBusy(true)
        setBrowse({ path, entries: null })
        try {
          const body = await api('/browse', { method: 'POST', body: JSON.stringify({ path }) })
          setBrowse({ path: body.path, entries: body.entries || [], truncated: body.truncated })
        } catch (e) {
          setBrowse({ path, entries: [], error: String(e?.message || e) })
        } finally {
          setBrowseBusy(false)
        }
      }

      const items = index?.items
        ? Object.values(index.items).sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
        : []
      const summary = status?.summary
      const cfg = status?.config

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.head },
          h(
            'div',
            null,
            h('h1', { style: S.h1 }, t('title')),
            h('p', { style: S.sub }, t('subtitle')),
          ),
          h('div', { style: S.spacer }),
          (summary?.confirmed ?? 0) > 0
            ? h(
                'button',
                {
                  style: S.btn,
                  title: t('recycleHint'),
                  onClick: () => doRecycle(items.filter((i) => i.state === 'confirmed').map((i) => i.path)),
                  disabled: busy === 'recycle',
                },
                `${t('recycleAll')} (${summary.confirmed})`,
              )
            : null,
          h(
            'button',
            { style: S.btn, onClick: doDryRun, disabled: busy === 'dryrun' },
            t('dryrun'),
          ),
          h(
            'button',
            { style: S.btnPrimary, onClick: doScan, disabled: busy === 'scan' },
            busy === 'scan' ? t('scanning') : items.length ? t('rescan') : t('scan'),
          ),
        ),

        h(
          'div',
          { style: S.stats },
          h(
            'div',
            { style: S.card },
            h('div', { style: S.cardLabel }, t('sizeTotal')),
            h('div', { style: S.cardValue }, fmtBytes(summary?.totalBytes ?? 0)),
          ),
          h(
            'div',
            { style: S.card },
            h('div', { style: S.cardLabel }, t('total')),
            h('div', { style: S.cardValue }, String(summary?.totalItems ?? 0)),
          ),
          h(
            'div',
            { style: S.card },
            h('div', { style: S.cardLabel }, t('confirmed')),
            h('div', { style: S.cardValue }, String(summary?.confirmed ?? 0)),
          ),
          h(
            'div',
            { style: S.card },
            h('div', { style: S.cardLabel }, t('denials')),
            h('div', { style: S.cardValue }, String(status?.gate?.denials ?? 0)),
          ),
        ),

        error ? h('div', { style: S.err }, `${t('error')}: ${error}`) : null,

        items.length === 0
          ? h('div', { style: S.empty }, t('empty'))
          : h(
              'div',
              { style: S.tableWrap },
              h(
                'table',
                { style: S.table },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: S.th }, t('path')),
                    h('th', { style: { ...S.th, width: 96 } }, t('size')),
                    h('th', { style: { ...S.th, width: 128 } }, t('kind')),
                    h('th', { style: { ...S.th, width: 88 } }, t('state')),
                    h('th', { style: { ...S.th, width: 132 } }, t('actions')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  items.map((it, i) =>
                    h(
                      'tr',
                      { key: it.path },
                      h(
                        'td',
                        { style: { ...S.td, borderBottom: i === items.length - 1 ? 'none' : S.td.borderBottom } },
                        h('button', { style: S.pathLink, onClick: () => doBrowse(it.path), title: t('browse') }, it.path),
                        h(
                          'div',
                          { style: { marginTop: 5, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                          it.evidence
                            ? h('span', { style: S.chipOk }, t('observed'))
                            : h('span', { style: S.chip }, t('suspected')),
                          it.evidence
                            ? h(
                                'span',
                                { style: S.meta },
                                `${it.evidence.sessionId || '—'} · ${it.evidence.tool} · ${fmtTime(it.evidence.at)}`,
                              )
                            : null,
                          (it.signature || []).map((s) => h('span', { key: s, style: S.chip }, s)),
                        ),
                      ),
                      h('td', { style: { ...S.td, ...S.num } }, fmtBytes(it.bytes ?? 0)),
                      h('td', { style: S.td }, h('span', { style: S.chip }, classLabel(it.class))),
                      h(
                        'td',
                        { style: S.td },
                        it.state === 'confirmed'
                          ? t('confirmed')
                          : it.state === 'dismissed'
                            ? t('dismissed')
                            : t('pending'),
                      ),
                      h(
                        'td',
                        { style: S.td },
                        h(
                          'div',
                          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                          it.state === 'dismissed'
                            ? h('button', { style: S.btnSmall, onClick: () => doMark(it.path, 'pending'), disabled: busy === it.path }, t('reset'))
                            : h(
                                'button',
                                { style: S.btnSmall, onClick: () => doMark(it.path, 'confirmed'), disabled: busy === it.path },
                                t('confirm'),
                              ),
                          it.state === 'pending' || it.state === 'confirmed'
                            ? h(
                                'button',
                                { style: S.btnSmall, onClick: () => doMark(it.path, 'dismissed'), disabled: busy === it.path },
                                t('dismiss'),
                              )
                            : null,
                          it.state === 'confirmed'
                            ? h(
                                'button',
                                {
                                  style: { ...S.btnSmall, borderColor: 'var(--dsw-alias-border-l4)' },
                                  onClick: () => doRecycle([it.path]),
                                  disabled: busy === 'recycle',
                                },
                                t('recycle'),
                              )
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),

        plan
          ? h(
              'div',
              { style: S.note },
              h('strong', null, `${t('planOnly')} `),
              `${plan.count} 项 · ${fmtBytes(plan.bytes)}`,
              plan.rows?.length
                ? h(
                    'ul',
                    { style: { margin: '8px 0 0', paddingLeft: 18 } },
                    plan.rows.slice(0, 20).map((r) => h('li', { key: r.path, style: S.path }, `${r.path} — ${fmtBytes(r.bytes)}`)),
                  )
                : null,
            )
          : null,

        trash.length
          ? h(
              'div',
              { style: { marginTop: 22 } },
              h('div', { style: { ...S.cardLabel, marginBottom: 8, fontSize: 12, fontWeight: 600 } },
                `${t('trash')} · ${trash.length} 项 · ${fmtBytes(trash.reduce((n, i) => n + (i.bytes ?? 0), 0))}`),
              h(
                'div',
                { style: S.tableWrap },
                h(
                  'table',
                  { style: S.table },
                  h(
                    'tbody',
                    null,
                    trash.map((it, i) =>
                      h(
                        'tr',
                        { key: it.id },
                        h(
                          'td',
                          { style: { ...S.td, borderBottom: i === trash.length - 1 ? 'none' : S.td.borderBottom } },
                          h('div', { style: S.path }, it.originalPath || it.id),
                          h(
                            'div',
                            { style: { ...S.cardLabel, marginTop: 3 } },
                            `${fmtBytes(it.bytes ?? 0)} · ${fmtTime(it.recycledAt)} · ${it.id}`,
                          ),
                        ),
                        h(
                          'td',
                          { style: { ...S.td, width: 180, whiteSpace: 'nowrap' } },
                          h(
                            'button',
                            { style: S.btnSmall, onClick: () => doRestore(it.id), disabled: busy === it.id },
                            t('restore'),
                          ),
                          ' ',
                          h(
                            'button',
                            {
                              style: {
                                ...S.btnSmall,
                                color: purgeArm === it.id ? 'var(--dsw-alias-state-error-primary)' : undefined,
                                borderColor: purgeArm === it.id ? 'var(--dsw-alias-state-error-primary)' : undefined,
                              },
                              onClick: () => doPurge(it.id),
                              disabled: busy === it.id,
                            },
                            purgeArm === it.id ? t('purgeConfirm') : t('purge'),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,

        browse
          ? h(
              'div',
              {
                style: S.modalBg,
                onClick: (e) => {
                  if (e.target === e.currentTarget) setBrowse(null)
                },
              },
              h(
                'div',
                { style: S.modal },
                h(
                  'div',
                  { style: S.modalHead },
                  h('div', { style: { ...S.path, flex: '1 1 auto' } }, browse.path),
                  h('button', { style: S.btnSmall, onClick: () => setBrowse(null) }, t('close')),
                ),
                h(
                  'div',
                  { style: S.modalBody },
                  browse.error
                    ? h('div', { style: { ...S.err, padding: '12px 14px' } }, browse.error)
                    : browse.entries === null || browseBusy
                      ? h('div', { style: { ...S.meta, padding: '12px 14px' } }, t('loading'))
                      : browse.entries.length === 0
                        ? h('div', { style: { ...S.meta, padding: '12px 14px' } }, t('emptyDir'))
                        : browse.entries.map((e2) =>
                            h(
                              'div',
                              { key: e2.name, style: S.fileRow },
                              h('span', { style: S.path }, `${e2.dir ? '▸ ' : '   '}${e2.name}`),
                              h(
                                'span',
                                { style: { ...S.num, color: 'var(--dsw-alias-label-secondary)' } },
                                e2.dir ? '' : fmtBytes(e2.bytes),
                              ),
                              h('span', { style: { ...S.meta, textAlign: 'right' } }, e2.mtime ? fmtTime(e2.mtime) : ''),
                            ),
                          ),
                ),
                h(
                  'div',
                  { style: { ...S.modalHead, borderTop: '1px solid var(--dsw-alias-border-l2)', borderBottom: 0 } },
                  h(
                    'span',
                    { style: S.meta },
                    `${browse.entries?.length ?? 0} ${t('entries')}${browse.truncated ? ' · truncated' : ''}`,
                  ),
                  h('div', { style: S.spacer }),
                  h('button', { style: S.btnSmall, onClick: () => doBrowse(browse.path) }, t('rescan')),
                ),
              ),
            )
          : null,

        h(
          'div',
          { style: S.note },
          `${t('scratch')}: ${cfg?.scratchRoot ?? '—'}　|　${t('lastScan')}: ${fmtTime(status?.scannedAt)}`,
          h('br'),
          `gate=${String(cfg?.gate)} · autoClean=${String(cfg?.autoCleanScratch)} · index=${cfg?.indexFile ?? '—'}`,
          h('br'),
          `tempRedirect=${String(cfg?.redirectTemp)} → ${cfg?.tempRedirectDir ?? '—'}（原 ${cfg?.tempDir ?? '—'}）`,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const locale = ctx.locale
          if (locale && typeof locale.register === 'function') {
            try {
              locale.register(NS, 'zh', DICT.zh)
              locale.register(NS, 'en', DICT.en)
            } catch {
              /* 重复注册无害 */
            }
            const bound = typeof locale.bind === 'function' ? locale.bind(NS) : null
            if (typeof bound === 'function') {
              t = (k) => {
                const v = bound(k)
                return v === k ? (DICT.zh[k] ?? k) : v
              }
            }
          }
        } catch {
          /* 没有 locale 服务就用内置字典 */
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'workspace-mgr' }, Panel),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'workspace-mgr', order: 30, label: () => t('title') },
            SidebarIcon,
          ),
        )
      },
    }
  },
})
