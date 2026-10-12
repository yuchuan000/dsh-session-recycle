/**
 * dsh-session-recycle — CLIENT half.
 *
 * Adds "Delete session" to the sidebar session-row menu and a trash button to
 * the conversation header. Both open one confirmation dialog; confirming calls
 * the host's native `session_delete` tool over the ordinary harness connection
 * (no extra HTTP route, no page reload).
 *
 * Bundle format (client-modules protocol): a classic script that registers a
 * factory through window.__ModuleLoader__.load. No JSX — plain
 * React.createElement — and theme tokens only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-recycle',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { IconTrashOutline16, Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives')

    const HEADER_SLOT = 'conversation.session.header.actions'
    const SETTINGS_SLOT = 'settings.section'
    const OVERLAY_SLOT = 'shell.overlay'
    const HEADER_ID = 'session-recycle-header'
    const SETTINGS_ID = 'session-recycle-settings'
    const DIALOG_ID = 'session-recycle-dialog'
    const EMPTY_DIALOG_ID = 'session-recycle-empty-workspace'
    const TOAST_ID = 'session-recycle-toast'
    const EVENT = 'dsh-session-recycle:delete'
    const EMPTY_EVENT = 'dsh-session-recycle:empty-workspace'

    // --- locale -----------------------------------------------------------------

    const NS = 'session-recycle'

    const zh = {
      'menu.delete': '删除会话',
      'button.title': '删除会话',
      'button.titleRunning': '删除会话（运行中，删除会先停止任务）',
      'dialog.title': '删除会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.untitled': '未命名会话',
      'dialog.runningWarn': '⚠ 该会话正在运行',
      'dialog.deleteDesc': '会话日志将移入本插件的回收站（可随时还原），并同时清理其统计缓存与工作区分组记录。',
      'dialog.runningDesc': '该会话正在运行。删除会先停止其任务，再把日志移入本插件的回收站（可随时还原）。未完成的工作会中断。',
      'dialog.cancel': '取消',
      'dialog.close': '确定',
      'dialog.confirm': '删除',
      'dialog.busy': '正在删除…',
      'dialog.doneRecycled': '已删除，日志在插件回收站中，可随时还原。',
      'dialog.donePermanent': '已永久删除。',
      'dialog.notFound': '未能在会话列表中找到该会话，请刷新页面后重试。',
      'dialog.alreadyGone': '该会话已被删除，正在刷新列表…',
      'empty.title': '这个工作区已经空了',
      'empty.descOne': '「{name}」下的会话已全部删除。要把这个空的工作区分组也一起移除吗？',
      'empty.descMany': '有 {n} 个工作区下的会话已全部删除。要把这些空分组也一起移除吗？',
      'empty.keep': '保留分组',
      'empty.remove': '移除分组',
      'empty.note': '只移除分组，项目文件夹和会话日志都会保留。',
      'empty.done': '已移除 {n} 个分组',
      'settings.nav': '会话删除',
      'settings.behaviour': '删除行为',
      'settings.confirmSingleDelete': '删除单个会话时先确认',
      'settings.confirmSingleDeleteHint': '关闭后点删除会直接执行，不再弹确认框。',
      'settings.askEmpty': '删空后询问是否移除工作区',
      'settings.askEmptyHint': '当某个工作区下的最后一个会话被删除时，询问是否一并移除该分组。',
      'settings.useRecycleBin': '删除时移入回收站',
      'settings.useRecycleBinHint': '关闭后删除不可恢复。默认开启。',
      'settings.binOffWarning': '⚠ 回收站已关闭：删除将无法还原。',
      'settings.recycle': '回收站',
      'settings.recycleHint': '由本插件删除、且仍可还原的会话。',
      'settings.loading': '正在读取…',
      'settings.empty': '回收站里没有可还原的会话。',
      'settings.untitled': '未命名会话',
      'settings.restore': '还原',
      'settings.restoring': '还原中…',
      'settings.restored': '已还原，可在会话列表中找到它。',
      'settings.restoredGrouped': '已还原，并已放回「{name}」分组。',
      'batch.selected': '已选 {n} 条',
      'settings.selectAll': '全选',
      'settings.selectOne': '选择这一条',
      'settings.restorePicked': '恢复所选',
      'settings.restoredMany': '已恢复 {n} 条，其中 {g} 条已放回原分组。',
      'settings.restoredManyPartial': '已恢复 {ok} 条，{fail} 条失败。',
      'settings.purge': '彻底删除',
      'settings.purged': '已彻底删除 {n} 条，无法恢复。',
      'settings.purgedPartial': '已彻底删除 {ok} 条，{fail} 条失败。',
    }

    const en = {
      'menu.delete': 'Delete session',
      'button.title': 'Delete session',
      'button.titleRunning': 'Delete session (running — the task stops first)',
      'dialog.title': 'Delete session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.untitled': 'Untitled session',
      'dialog.runningWarn': '⚠ This session is running',
      'dialog.deleteDesc': "The session log moves to this plugin's recycle bin (restorable at any time), and its statistics cache and workspace grouping entry are cleaned up too.",
      'dialog.runningDesc': "This session is running. Deleting stops its task first, then moves the log to this plugin's recycle bin (restorable at any time). Work in progress is interrupted.",
      'dialog.cancel': 'Cancel',
      'dialog.close': 'OK',
      'dialog.confirm': 'Delete',
      'dialog.busy': 'Deleting…',
      'dialog.doneRecycled': "Deleted. The log is in the plugin's recycle bin and can be restored.",
      'dialog.donePermanent': 'Permanently deleted.',
      'dialog.notFound': 'Could not find this session in the session list. Refresh the page and try again.',
      'dialog.alreadyGone': 'This session was already deleted. Refreshing the list…',
      'empty.title': 'This workspace is now empty',
      'empty.descOne': 'Every session in "{name}" has been deleted. Remove the empty workspace group too?',
      'empty.descMany': 'Every session in {n} workspaces has been deleted. Remove those empty groups too?',
      'empty.keep': 'Keep the group',
      'empty.remove': 'Remove the group',
      'empty.note': 'Only the grouping is removed. The project folder and every session log are kept.',
      'empty.done': 'Removed {n} group(s)',
      'settings.nav': 'Session deletion',
      'settings.behaviour': 'Behaviour',
      'settings.confirmSingleDelete': 'Confirm before deleting a session',
      'settings.confirmSingleDeleteHint': 'When off, clicking delete acts immediately with no dialog.',
      'settings.askEmpty': 'Offer to remove an emptied workspace',
      'settings.askEmptyHint': 'After the last session in a workspace is deleted, ask whether to drop the group as well.',
      'settings.useRecycleBin': 'Move deleted sessions to the recycle bin',
      'settings.useRecycleBinHint': 'When off, deletion cannot be undone. On by default.',
      'settings.binOffWarning': '⚠ The recycle bin is off: deletions cannot be restored.',
      'settings.recycle': 'Recycle bin',
      'settings.recycleHint': 'Sessions this plugin deleted that are still restorable.',
      'settings.loading': 'Loading…',
      'settings.empty': 'Nothing restorable in the recycle bin.',
      'settings.untitled': 'Untitled session',
      'settings.restore': 'Restore',
      'settings.restoring': 'Restoring…',
      'settings.restored': 'Restored. It is back in the session list.',
      'settings.restoredGrouped': 'Restored, and put back in "{name}".',
      'batch.selected': '{n} selected',
      'settings.selectAll': 'Select all',
      'settings.selectOne': 'Select this entry',
      'settings.restorePicked': 'Restore selected',
      'settings.restoredMany': 'Restored {n} entry(ies); {g} went back to their group.',
      'settings.restoredManyPartial': 'Restored {ok}, {fail} failed.',
      'settings.purge': 'Delete permanently',
      'settings.purged': 'Permanently deleted {n} entry(ies). This cannot be undone.',
      'settings.purgedPartial': 'Permanently deleted {ok}, {fail} failed.',
    }

    let localeSvc = null
    let sessionsSvc = null
    // The UI session service owns the "which conversation is open" binding.
    let uiSessionSvc = null
    // The UI workspace service owns navigation (openSession/closeSession).
    let uiWorkspaceSvc = null
    // The client workspace *list* store, so grouping updates can be pushed in.
    let workspacesSvc = null
    // Cleanup for DOM-level wiring that cordis does not own (the sidebar menu
    // observer). Run on dispose so a plugin reload leaves nothing behind.
    const sidebarMenuDisposers = []

    // --- settings state -----------------------------------------------------------
    //
    // Mirrored at module scope so any entry point can read the current policy
    // without a round-trip, and fetched once at apply time. The host remains the
    // authority: a failed save reverts this mirror.
    const SETTINGS_DEFAULTS = {
      confirmSingleDelete: true,
      askRemoveEmptyWorkspace: true,
      useRecycleBin: true,
    }
    const settingsState = {
      values: { ...SETTINGS_DEFAULTS },
      loaded: false,
      listeners: new Set(),
    }

    function settingsSubscribe(listener) {
      settingsState.listeners.add(listener)
      return () => { settingsState.listeners.delete(listener) }
    }

    function settingsNotify() {
      for (const listener of [...settingsState.listeners]) {
        try { listener() } catch { /* a broken subscriber never blocks others */ }
      }
    }

    function settingsValue(key) {
      const value = settingsState.values[key]
      return typeof value === 'boolean' ? value : SETTINGS_DEFAULTS[key]
    }

    /** Load once; failures keep the documented defaults. */
    async function loadSettings() {
      try {
        const { settings } = await fetchSettings()
        settingsState.values = { ...SETTINGS_DEFAULTS, ...settings }
      } catch { /* offline or older host: defaults apply */ }
      settingsState.loaded = true
      settingsNotify()
    }

    /** Persist one key, optimistically, reverting if the host refuses. */
    async function updateSetting(key, value) {
      const previous = settingsState.values[key]
      settingsState.values = { ...settingsState.values, [key]: value }
      settingsNotify()
      try {
        const saved = await saveSettings({ [key]: value })
        settingsState.values = { ...SETTINGS_DEFAULTS, ...saved }
        settingsNotify()
        return true
      } catch {
        settingsState.values = { ...settingsState.values, [key]: previous }
        settingsNotify()
        return false
      }
    }

    function fallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /**
     * Translate one key, substituting `{name}` placeholders.
     *
     * The params argument is NOT optional decoration: the locale tables carry
     * templates like `'已选 {n} 条'` and `'有 {n} 个工作区…'`, and every
     * parameterised call site passes the values. Dropping them (an earlier
     * version of this function took only `key`) left the raw `{n}` / `{name}`
     * on screen — the count, the workspace name and the batch summaries all
     * rendered as literal braces.
     *
     * The host locale service interpolates when it is given the params
     * (`translate(ns, key, params)`), so they are forwarded verbatim; the
     * bundled dictionaries are interpolated locally with the same rule
     * (unknown names stay untouched, matching the host's behaviour).
     */
    function t(key, params) {
      if (localeSvc && typeof localeSvc.translate === 'function') {
        const text = localeSvc.translate(NS, key, params)
        if (typeof text === 'string' && text !== key) return text
      }
      const template = (fallbackLang() === 'en' ? en : zh)[key] || key
      if (params === undefined || typeof template !== 'string') return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function useLocaleRevision() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        if (!localeSvc || typeof localeSvc.subscribe !== 'function') return undefined
        return localeSvc.subscribe(() => setRevision(v => v + 1))
      }, [])
      return undefined
    }

    // --- helpers ----------------------------------------------------------------

    function normalizeTitle(value) {
      return String(value || '').trim().replace(/\s+/g, ' ')
    }

    function stripForkSuffix(value) {
      return normalizeTitle(value).replace(/\s*\(\d+\)\s*$/, '')
    }

    /** Look one session up in the client's own list snapshot. */
    function summaryOf(sessionId) {
      try {
        const snapshot = sessionsSvc?.list?.getSnapshot?.()
        return snapshot?.byId?.[String(sessionId)]
      } catch { return undefined }
    }

    /**
     * Resolve the dialog target for one dispatched event.
     *
     * The id is authoritative and arrives from the DOM row, so this is a direct
     * lookup — the title is only ever filled in for display. The title-matching
     * fallback below exists for an id-less dispatch; it is deliberately kept
     * last, because titles are optional and not unique.
     */
    function resolveFromStore(detail) {
      if (detail.sessionId) {
        const summary = summaryOf(detail.sessionId)
        return {
          sessionId: String(detail.sessionId),
          // Prefer the store's title; fall back to the row's own text. Either
          // may be empty for a session that was never named, and the dialog
          // localizes that case rather than treating it as an error.
          title: summary?.title?.trim() || detail.title || null,
          running: summary ? summary.running === true : detail.running === true,
        }
      }
      const want = normalizeTitle(detail.title)
      if (!want) return null
      const snapshot = sessionsSvc?.list?.getSnapshot?.()
      const byId = snapshot?.byId || {}
      const ids = Object.keys(byId)
      const wantBase = stripForkSuffix(want)
      for (const id of ids) {
        const entry = byId[id]
        if (entry && normalizeTitle(entry.title) === want) {
          return { sessionId: id, title: entry.title, running: entry.running === true }
        }
      }
      if (wantBase) {
        for (const id of ids) {
          const entry = byId[id]
          if (entry && stripForkSuffix(entry.title) === wantBase) {
            return { sessionId: id, title: entry.title, running: entry.running === true }
          }
        }
      }
      let best = null
      for (const id of ids) {
        const entry = byId[id]
        if (!entry || !entry.title) continue
        const candidate = normalizeTitle(entry.title)
        if (candidate && (candidate.includes(want) || want.includes(candidate))) {
          best = { sessionId: id, title: entry.title, running: entry.running === true }
        }
      }
      return best
    }

    /**
     * Ask the host to delete a session.
     *
     * There is no `tools` service in the browser: @deepseek-ai/dsh-tools is a
     * host-only package with no client export, so `ctx.get('tools')` is always
     * undefined client-side. The host half therefore exposes a same-origin
     * guarded route and this drives it — the same carrier the community market
     * uses for its own mutating actions.
     */
    async function invokeDelete(sessionId, permanent, translate) {
      const response = await fetch('/__session-recycle/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, permanent: permanent === true }),
      })
      let payload = {}
      try { payload = await response.json() } catch { /* keep {} */ }
      if (!response.ok || payload.ok !== true) {
        // A repeat delete means the row outlived the session — the refresh
        // raced. Say so plainly and treat it as "already gone", because the
        // user's intent is satisfied and a raw "session not found" reads as a
        // plugin failure.
        if (response.status === 404 || payload.code === 'NOT_FOUND') {
          const error = new Error((translate || t)('dialog.alreadyGone'))
          error.alreadyGone = true
          throw error
        }
        throw new Error(payload.error || `delete failed (HTTP ${response.status})`)
      }
      return payload
    }

    /** One JSON round-trip against this plugin's host routes. */
    async function api(path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      let payload = {}
      try { payload = await response.json() } catch { /* keep {} */ }
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || `${path} failed (HTTP ${response.status})`)
      }
      return payload
    }

    /**
     * Raise the empty-workspace prompt when the policy allows it.
     *
     * Deliberately deferred by a tick: the delete dialog is still on screen
     * showing its success state, and two modals racing for the same overlay
     * would replace one another.
     */
    function offerEmptyWorkspaceCleanup(workspaces) {
      if (!Array.isArray(workspaces) || workspaces.length === 0) return
      if (!settingsValue('askRemoveEmptyWorkspace')) return
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(EMPTY_EVENT, { detail: { workspaces } }))
      }, 0)
    }

    /** Settings currently in effect on the host. */
    async function fetchSettings() {
      const payload = await api('/__session-recycle/settings')
      return { settings: payload.settings ?? {}, defaults: payload.defaults ?? {} }
    }

    /** Persist a settings patch and return what is now in effect. */
    async function saveSettings(patch) {
      const payload = await api('/__session-recycle/settings', { method: 'POST', body: patch })
      return payload.settings ?? {}
    }

    /** Sessions sitting in the recycle bin, newest first. */
    async function fetchRecycled() {
      const payload = await api('/__session-recycle/recycled')
      return Array.isArray(payload.entries) ? payload.entries : []
    }

    async function restoreSession(sessionId) {
      return api('/__session-recycle/restore', { method: 'POST', body: { sessionId } })
    }

    /** Permanently delete one recycled entry (and its OS-bin payload). */
    async function purgeRecycled(sessionId) {
      return api('/__session-recycle/purge', { method: 'POST', body: { sessionId } })
    }

    /**
     * Force the sidebar's workspace list to re-read its grouping.
     *
     * `ctx.workspaces` is the controller, and the controller does NOT expose the
     * store methods: its constructor does `this.list = model`, where `model` is
     * the store (`upsertView` / `removeView` / `getSnapshot`). Calling
     * `svc.upsertView(...)` therefore found nothing and this whole resync was a
     * silent no-op — which is why a restart was the only thing that ever
     * refreshed the grouping. The store is reached as `svc.list`.
     *
     * Restoring re-attaches the session on the host, which does emit the domain
     * change the workspace controller follows, but the client list is fed by a
     * long-lived follow stream and that round trip is not reliable enough to
     * depend on. Fetching the grouping and merging it in uses the same store
     * entry point the stream itself would.
     *
     * @returns how many workspaces were refreshed, or 0 when unavailable.
     */
    async function resyncWorkspaces() {
      // The store may hang off the controller (`svc.list`) or be the service
      // itself on a build that exposes it directly; accept either.
      const candidates = [workspacesSvc?.list, workspacesSvc]
      let store = null
      for (const candidate of candidates) {
        if (candidate && typeof candidate.upsertView === 'function') { store = candidate; break }
      }
      if (store === null) return 0
      let payload
      try {
        payload = await api('/__session-recycle/workspaces')
      } catch {
        return 0
      }
      const items = Array.isArray(payload.workspaces) ? payload.workspaces : []
      // Upsert ONLY. Never remove here, however tempting: the store records
      // every removed id in a permanent in-memory `removedIds` set, and
      // `upsert` refuses any workspace in it for the rest of the session. A
      // single transient answer that happened to omit a workspace (an
      // unreadable table, a race) would therefore delete that group from the
      // sidebar until the app restarted. Removals belong to the follow stream,
      // which knows the difference between "gone" and "not reported yet".
      if (items.length === 0) return 0
      let pushed = 0
      for (const item of items) {
        try {
          store.upsertView(item)
          pushed += 1
        } catch { /* one bad row must not abort the rest */ }
      }
      return pushed
    }

    async function removeWorkspace(workspaceId) {
      return api('/__session-recycle/remove-workspace', { method: 'POST', body: { workspaceId } })
    }

    /**
     * The session currently open in the conversation pane.
     *
     * `sessions.list` snapshot carries `ids` / `byId` but NO `current` field, so
     * the open conversation cannot be read from the list store. The UI session
     * service is the one that tracks it: `uiSession.current` is a binding source
     * whose `.value.key` is the open session id (verified against
     * dsh-client-ui-session's own `publishMain`).
     *
     * @returns the open session id, or undefined when nothing is open.
     */
    function currentSessionId() {
      const sources = [uiSessionSvc, sessionsSvc]
      for (const service of sources) {
        if (!service) continue
        try {
          const binding = service.current
          const value = binding && typeof binding === 'object' && 'value' in binding ? binding.value : undefined
          const key = value && typeof value === 'object' ? (value.key ?? value.id ?? value.sessionId) : undefined
          if (typeof key === 'string' && key.length > 0) return key
        } catch { /* try the next source */ }
      }
      // Fallback: whichever visible row the store marks as retained by the main
      // view. This mirrors how the harness itself resolves the main session.
      try {
        const byId = sessionsSvc?.list?.getSnapshot?.()?.byId || {}
        for (const entry of Object.values(byId)) {
          if (entry && (entry.retainedBy?.mainView ?? 0) > 0 && typeof entry.id === 'string') return entry.id
        }
      } catch { /* no open session discoverable */ }
      return undefined
    }

    /**
     * Re-read the session list so a restored session shows up immediately.
     *
     * Restoring writes the log back on disk; the sidebar renders from the
     * client's list, which has to be re-read before the row exists. One refresh
     * is normally enough (`refreshList` merges whatever the server now reports),
     * but the call is single-flight: if a refresh was already in flight this
     * returns that older answer and misses the restore.
     *
     * The window is deliberately generous. A restored log has to be discovered
     * by the host's own directory scan before any refresh can report it, and
     * that is not instantaneous: an earlier 6x30 ms budget (~200 ms) expired
     * first, which is why the row sometimes never appeared. The loop stops the
     * moment the session shows, so a fast host still costs one call.
     *
     * @param expectId - session id that should become visible, when known.
     * @returns whether the session became visible.
     */
    /**
     * Pull the Session baseline from the host, once.
     *
     * The service method is `refresh()` — NOT `refreshList()`. `sessions.list`
     * is a plain snapshot store (`getSnapshot` / `subscribe`), and the pull lives
     * on the controller as `refresh()`, which delegates to
     * `manager.refreshList()`. Calling `sessions.refreshList()` (or
     * `sessions.list.refreshList()`) is therefore undefined and silently does
     * nothing, which is why a restored session only ever appeared after a
     * restart. `refresh()` reuses an in-flight pull, so repeating it is safe.
     *
     * @returns the pull's completion when one could be started.
     */
    function pullSessionList() {
      try {
        const refresh = sessionsSvc?.refresh
        if (typeof refresh === 'function') return refresh.call(sessionsSvc)
      } catch { /* fall through to the list-store probe */ }
      // Alternate shape: the pull may be hung off the store itself.
      try {
        const store = sessionsSvc?.list
        if (store && typeof store.refresh === 'function') return store.refresh()
      } catch { /* nothing else to try */ }
      return undefined
    }

    /** Await whatever `pullSessionList()` returned, when it is thenable. */
    async function pullSessionListAndWait() {
      const pulled = pullSessionList()
      if (pulled && typeof pulled.then === 'function') await pulled
    }

    async function resyncSessionList(expectId) {
      const wanted = typeof expectId === 'string' && expectId.length > 0 ? expectId : undefined
      const visible = () => {
        if (wanted === undefined) return true
        try {
          const snapshot = sessionsSvc?.list?.getSnapshot?.()
          const ids = snapshot?.ids || Object.keys(snapshot?.byId || {})
          return ids.map(String).includes(wanted)
        } catch { return false }
      }
      // ~3 s budget: 30 attempts, backing off, so a slow host still converges
      // and a fast one returns on the first pass.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await pullSessionListAndWait()
        if (visible()) return true
        await new Promise(resolve => setTimeout(resolve, attempt < 8 ? 40 : 120))
      }
      return visible()
    }

    /**
     * Settle the sidebar after a deletion, without blocking the caller.
     *
     * Neither half is awaited. The host already emitted `api-session/removed`
     * for every id spelling, and the client's list store applies that as its own
     * mutation — the row is gone before this runs. The pull below is only a
     * safety net for an event that was somehow missed, and a pull is expensive:
     * the host walks every session directory on disk to answer it. Awaiting that
     * is what left the confirm dialog sitting on screen for a beat after the
     * work was already done, which reads as "deletion is slow".
     *
     * Ordering is preserved where it matters: clearing the pane is started
     * first, so the conversation is off the dead session as early as possible.
     *
     * @param deletedId - session that must disappear.
     * @param wasCurrent - whether the open conversation is the deleted one.
     */
    function refreshSidebar(deletedId, wasCurrent) {
      // Clear the pane first: that is the part the user is looking at.
      if (wasCurrent) void clearOffDeletedSession(deletedId)
      // Safety net only; a failure here is not the delete's problem.
      void pullSessionListAndWait().catch(() => {})
    }

    /**
     * Clear the conversation pane when it still shows a deleted session.
     *
     * `uiWorkspace.clearMain()` clears whatever the main view holds (the
     * harness's own method, no argument). It is retried briefly because the
     * pane id is read from a binding that updates asynchronously, and the loop
     * exits the moment the pane no longer points at the dead session, so the
     * common case costs one call and no waiting.
     */
    async function clearOffDeletedSession(deletedId) {
      const dead = String(deletedId)
      const clear = () => {
        try {
          if (typeof uiWorkspaceSvc?.clearMain === 'function') { uiWorkspaceSvc.clearMain(); return true }
        } catch { /* fall through to the retry */ }
        return false
      }
      if (String(currentSessionId()) !== dead) return
      if (!clear()) return
      // Navigation is async: give it a short, bounded window to take effect, and
      // re-clear if the harness re-pointed the pane at the removed session.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = currentSessionId()
        if (current === undefined || String(current) !== dead) return
        await new Promise(resolve => setTimeout(resolve, 25))
        clear()
      }
    }

    // --- transient banner ---------------------------------------------------------
    //
    // Restore feedback is a top-center banner rather than inline text on the
    // settings page: the settings panel may be scrolled away from the recycle
    // list, and a message the user has to go looking for is not feedback. One
    // host component renders whatever was raised last; a sequence number keys it
    // so re-raising the same text restarts the cycle.
    const toastState = { seq: 0, text: '', tone: undefined, listeners: new Set() }

    function toastSubscribe(listener) {
      toastState.listeners.add(listener)
      return () => { toastState.listeners.delete(listener) }
    }

    /** Raise a transient banner; `tone: 'success'` gets the check glyph. */
    function showToast(text, tone) {
      if (typeof text !== 'string' || text.length === 0) return
      toastState.seq += 1
      toastState.text = text
      toastState.tone = tone
      for (const listener of [...toastState.listeners]) {
        try { listener() } catch { /* a broken subscriber never blocks others */ }
      }
    }

    /** Renders the current banner, if any, and unmounts it when it fades. */
    function ToastHost() {
      const [, forceRender] = useState(0)
      const [shown, setShown] = useState(0)
      useEffect(() => toastSubscribe(() => forceRender(n => n + 1)), [])
      const seq = toastState.seq
      if (seq === 0 || seq === shown) return null
      return React.createElement(Toast, {
        key: seq,
        text: toastState.text,
        tone: toastState.tone,
        holdMs: 2600,
        onDone: () => setShown(seq),
      })
    }

    // --- styles -----------------------------------------------------------------

    const btnStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6,
      background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'pointer', flex: 'none',
    }
    const metaStyle = {
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 13,
      lineHeight: '20px', margin: '0 0 10px', overflow: 'hidden', textOverflow: 'ellipsis',
    }
    const warnStyle = {
      color: 'var(--dsw-alias-state-warn-primary, #f5a524)', fontSize: 13,
      lineHeight: '20px', margin: '0 0 10px',
    }
    const okStyle = {
      color: 'var(--dsw-alias-state-success-primary, #30a46c)', fontSize: 12,
      lineHeight: '16px', marginTop: 8,
    }
    const errStyle = {
      color: 'var(--dsw-alias-state-error-primary, #e5484d)', fontSize: 12,
      lineHeight: '16px', marginTop: 8,
    }
    const cancelBtnStyle = {
      padding: '6px 14px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 13, cursor: 'pointer', marginRight: 8,
    }
    const dangerBtnStyle = {
      padding: '6px 14px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff', fontSize: 13, cursor: 'pointer',
    }
    /** Affirmative close for the success state — neutral, not destructive. */
    const confirmBtnStyle = {
      padding: '6px 14px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      background: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      color: '#fff', fontSize: 13, cursor: 'pointer',
    }

    // --- dialog -----------------------------------------------------------------

    /**
     * Run one deletion and settle the sidebar.
     *
     * Shared by the confirm dialog and the no-confirmation path, so both behave
     * identically: the list is refreshed, the emptied-workspace offer is raised,
     * and an "already gone" answer counts as success rather than a fault.
     *
     * @returns the host's result payload.
     */
    async function runDelete(sessionId, translate) {
      // Read the open conversation BEFORE the delete: once the session is gone
      // the binding has already been dropped, so asking afterwards always
      // answers "not open" and the pane would never be moved off it.
      const wasCurrent = String(currentSessionId() ?? '') === String(sessionId)
      let result
      try {
        result = await invokeDelete(sessionId, false, translate)
      } catch (reason) {
        if (reason && reason.alreadyGone === true) {
          refreshSidebar(sessionId, wasCurrent)
          return { sessionId, permanent: false, alreadyGone: true }
        }
        throw reason
      }
      refreshSidebar(sessionId, wasCurrent)
      offerEmptyWorkspaceCleanup(result.emptiedWorkspaces)
      return result
    }

    function DeleteDialog(props) {
      const __ = (props && props.t) || t
      useLocaleRevision()
      const [target, setTarget] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [done, setDone] = useState(null)

      useEffect(() => {
        const onEvent = (event) => {
          const detail = (event && event.detail) || {}
          const resolved = resolveFromStore(detail)
          setDone(null)
          setError(null)
          setBusy(false)
          if (resolved) setTarget(resolved)
          else if (detail.title) setTarget({ sessionId: null, title: detail.title, running: false, notFound: true })
        }
        window.addEventListener(EVENT, onEvent)
        return () => window.removeEventListener(EVENT, onEvent)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setError(null)
        setDone(null)
      }, [busy])

      const confirm = useCallback(async () => {
        if (busy || !target || !target.sessionId) return
        setBusy(true)
        setError(null)
        try {
          const result = await runDelete(target.sessionId, __)
          setDone(result.permanent === true ? __('dialog.donePermanent') : __('dialog.doneRecycled'))
          setBusy(false)
        } catch (reason) {
          setBusy(false)
          setError(reason && reason.message ? reason.message : String(reason))
        }
      }, [busy, target, __])

      if (!target) return null

      const title = target.title || __('dialog.untitled')
      const description = target.notFound
        ? __('dialog.notFound')
        : target.running ? __('dialog.runningDesc') : __('dialog.deleteDesc')

      // After a successful delete the only action left is to close the dialog.
      // Labelling it "Cancel" reads as "undo the deletion", so the success
      // state gets its own affirmative label.
      const footer = done
        ? [React.createElement('button', {
            key: 'close', type: 'button', onClick: close, style: confirmBtnStyle,
          }, __('dialog.close'))]
        : [
            React.createElement('button', {
              key: 'cancel', type: 'button', disabled: busy, onClick: close,
              style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, __('dialog.cancel')),
            React.createElement('button', {
              key: 'confirm', type: 'button',
              disabled: busy || !target.sessionId,
              onClick: confirm,
              style: { ...dangerBtnStyle, ...(busy || !target.sessionId ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, busy ? __('dialog.busy') : __('dialog.confirm')),
          ]

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: __('dialog.title'),
        closeLabel: __('dialog.cancel'),
        description,
        footer,
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          __('dialog.session'), title,
          target.sessionId
            ? React.createElement(React.Fragment, null,
                React.createElement('br'), __('dialog.sessionId'), target.sessionId)
            : null),
        target.running && !done
          ? React.createElement('div', { key: 'warn', style: warnStyle }, __('dialog.runningWarn'))
          : null,
        done ? React.createElement('div', { key: 'done', style: okStyle }, done) : null,
        error ? React.createElement('div', { key: 'error', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    // --- empty-workspace prompt ---------------------------------------------------

    /**
     * Offer to drop a workspace the last deletion emptied.
     *
     * Always a question, never automatic: an empty workspace is usually a project
     * the user still works in, so removing it silently would lose a grouping they
     * did not ask to lose. Declining keeps it, and the "ask" behaviour itself is
     * a setting.
     */
    function EmptyWorkspaceDialog(props) {
      const __ = (props && props.t) || t
      useLocaleRevision()
      const [targets, setTargets] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [done, setDone] = useState(null)

      useEffect(() => {
        const onEvent = (event) => {
          const detail = (event && event.detail) || {}
          const list = Array.isArray(detail.workspaces) ? detail.workspaces : []
          setTargets(list.length > 0 ? list : null)
          setBusy(false)
          setError(null)
          setDone(null)
        }
        window.addEventListener(EMPTY_EVENT, onEvent)
        return () => window.removeEventListener(EMPTY_EVENT, onEvent)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTargets(null)
        setError(null)
        setDone(null)
      }, [busy])

      const remove = useCallback(async () => {
        if (busy || !targets) return
        setBusy(true)
        setError(null)
        const failures = []
        let removed = 0
        for (const workspace of targets) {
          try {
            await removeWorkspace(workspace.workspaceId)
            removed += 1
          } catch (reason) {
            failures.push(`${workspace.title || workspace.path}: ${reason?.message ?? reason}`)
          }
        }
        setBusy(false)
        setDone(__('empty.done', { n: removed }))
        if (failures.length > 0) setError(failures.slice(0, 5).join('\n'))
      }, [busy, targets, __])

      if (!targets) return null

      const names = targets.map(w => w.title || w.path || w.workspaceId)
      const description = targets.length === 1
        ? __('empty.descOne', { name: names[0] })
        : __('empty.descMany', { n: targets.length })

      const footer = done
        ? [React.createElement('button', {
            key: 'close', type: 'button', onClick: close, style: confirmBtnStyle,
          }, __('dialog.close'))]
        : [
            React.createElement('button', {
              key: 'keep', type: 'button', disabled: busy, onClick: close,
              style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, __('empty.keep')),
            React.createElement('button', {
              key: 'remove', type: 'button', disabled: busy, onClick: remove,
              style: { ...dangerBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
            }, busy ? __('dialog.busy') : __('empty.remove')),
          ]

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: __('empty.title'),
        closeLabel: __('empty.keep'),
        description,
        footer,
      }, [
        React.createElement('div', { key: 'list', style: { ...metaStyle, maxHeight: 180, overflowY: 'auto' } },
          names.map((name, index) => React.createElement('div', {
            key: `w${index}`, style: { paddingLeft: 8, opacity: 0.85 },
          }, `• ${name}`))),
        !done
          ? React.createElement('div', { key: 'note', style: { ...metaStyle, marginTop: 10 } }, __('empty.note'))
          : null,
        done ? React.createElement('div', { key: 'done', style: okStyle }, done) : null,
        error ? React.createElement('div', {
          key: 'error', role: 'alert', style: { ...errStyle, whiteSpace: 'pre-wrap' },
        }, error) : null,
      ])
    }

    // --- recycle panel ------------------------------------------------------------

    /** One settings row: label, explanation, and a checkbox. */
    function SettingRow(props) {
      const { label, hint, checked, disabled, onChange } = props
      return React.createElement('label', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '10px 0', cursor: disabled ? 'default' : 'pointer',
        },
      }, [
        React.createElement('input', {
          key: 'box', type: 'checkbox', checked: checked === true, disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
          style: { marginTop: 2, flex: 'none' },
        }),
        React.createElement('span', { key: 'text', style: { display: 'block' } }, [
          React.createElement('span', {
            key: 'label', style: { display: 'block', fontSize: 13, lineHeight: '20px' },
          }, label),
          React.createElement('span', {
            key: 'hint',
            style: {
              display: 'block', fontSize: 12, lineHeight: '18px', marginTop: 2,
              color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
            },
          }, hint),
        ]),
      ])
    }

    /**
     * The settings section plus the recycle bin.
     *
     * Registered into `settings.section`, so it appears with the harness's own
     * settings pages. The recycle list lives here rather than in its own slot:
     * restore is rare and belongs next to the policy that produced it.
     */
    function SettingsPanel(props) {
      const __ = (props && props.t) || t
      useLocaleRevision()
      const [, forceRender] = useState(0)
      const [entries, setEntries] = useState([])
      const [loading, setLoading] = useState(true)
      const [busyId, setBusyId] = useState(null)
      const [error, setError] = useState(null)
      const [note, setNote] = useState(null)
      // Recycle-bin selection for batch permanent delete.
      const [picked, setPicked] = useState(() => new Set())
      const [purging, setPurging] = useState(false)

      useEffect(() => settingsSubscribe(() => forceRender(n => n + 1)), [])

      /**
       * Re-read the recycle list.
       *
       * @param quiet - skip the loading flag. A restore or purge is followed by
       *   a re-read, and raising `loading` there blanks the whole list (the
       *   panel renders the loading line instead of the rows) so the entries
       *   visibly vanish and come back. Only the first load needs that state.
       */
      const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true)
        try {
          setEntries(await fetchRecycled())
          setError(null)
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        if (!quiet) setLoading(false)
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const onRestore = useCallback(async (sessionId) => {
        setBusyId(sessionId)
        setError(null)
        setNote(null)
        try {
          const restored = await restoreSession(sessionId)
          // The log is back on disk; pull the session list NOW, in parallel with
          // the recycle-panel re-read, since the two are independent and the
          // sidebar is what the user is watching.
          const listed = resyncSessionList(sessionId)
          await refresh(true)
          await resyncWorkspaces()
          await listed
          // Report upward as a banner: the settings panel may be scrolled away
          // from the recycle list, and feedback the user has to hunt for is not
          // feedback.
          showToast(
            restored.regrouped === true
              ? __('settings.restoredGrouped', { name: restored.workspaceTitle || '' })
              : __('settings.restored'),
            'success',
          )
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setBusyId(null)
      }, [refresh, __])

      /**
       * Restore every picked entry.
       *
       * For a restore the order does not matter, so this can run them in
       * sequence and report one banner at the end. The sidebar and grouping are
       * refreshed once afterwards rather than per entry, so the list settles
       * exactly once no matter how many rows were chosen.
       */
      const onRestorePicked = useCallback(async () => {
        const ids = [...picked]
        if (ids.length === 0) return
        setPurging(true)
        setError(null)
        setNote(null)
        let restored = 0
        let grouped = 0
        const failures = []
        for (const sessionId of ids) {
          try {
            const res = await restoreSession(sessionId)
            restored += 1
            if (res.regrouped === true) grouped += 1
          } catch (reason) {
            failures.push(`${sessionId}: ${reason?.message ?? reason}`)
          }
        }
        setPurging(false)
        setPicked(new Set())
        // Settle the lists once, after every entry has been written back, and
        // start the session pull in parallel with the panel re-read.
        if (restored > 0) {
          const listed = resyncSessionList(ids[ids.length - 1])
          await refresh(true)
          await resyncWorkspaces()
          await listed
        } else {
          await refresh(true)
        }
        showToast(
          failures.length === 0
            ? __('settings.restoredMany', { n: restored, g: grouped })
            : __('settings.restoredManyPartial', { ok: restored, fail: failures.length }),
          'success',
        )
        if (failures.length > 0) setError(failures.slice(0, 5).join('\n'))
      }, [picked, refresh, __])

      /**
       * Permanently delete the picked entries.
       *
       * This is the second half of the recycle bin: an entry that is no longer
       * wanted can be dropped for good, which also empties the OS bin payload
       * so the disk space comes back. It is irreversible, so it is always a
       * deliberate, confirmed action and never a side effect of anything else.
       */
      const onPurge = useCallback(async () => {
        const ids = [...picked]
        if (ids.length === 0) return
        setPurging(true)
        setError(null)
        setNote(null)
        let gone = 0
        const failures = []
        for (const sessionId of ids) {
          try {
            await purgeRecycled(sessionId)
            gone += 1
          } catch (reason) {
            // Already absent counts as done: the entry is gone either way.
            if (/nothing recycled|NOT_RECYCLED/i.test(String(reason?.message ?? reason))) gone += 1
            else failures.push(`${sessionId}: ${reason?.message ?? reason}`)
          }
        }
        setPurging(false)
        setPicked(new Set())
        await refresh(true)
        showToast(
          failures.length === 0
            ? __('settings.purged', { n: gone })
            : __('settings.purgedPartial', { ok: gone, fail: failures.length }),
          'success',
        )
        if (failures.length > 0) setError(failures.slice(0, 5).join('\n'))
      }, [picked, refresh, __])

      const togglePick = useCallback((sessionId) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }, [])

      const allPicked = entries.length > 0 && entries.every(e => picked.has(e.sessionId))
      const toggleAll = useCallback(() => {
        setPicked((prev) => (entries.every(e => prev.has(e.sessionId))
          ? new Set()
          : new Set(entries.map(e => e.sessionId))))
      }, [entries])

      const sectionStyle = { padding: '4px 0 8px' }
      const headingStyle = { fontSize: 13, fontWeight: 600, margin: '14px 0 2px' }

      return React.createElement('div', { style: sectionStyle }, [
        React.createElement('div', { key: 'h1', style: headingStyle }, __('settings.behaviour')),
        React.createElement(SettingRow, {
          key: 'confirm',
          label: __('settings.confirmSingleDelete'),
          hint: __('settings.confirmSingleDeleteHint'),
          checked: settingsValue('confirmSingleDelete'),
          onChange: (value) => updateSetting('confirmSingleDelete', value),
        }),
        React.createElement(SettingRow, {
          key: 'empty',
          label: __('settings.askEmpty'),
          hint: __('settings.askEmptyHint'),
          checked: settingsValue('askRemoveEmptyWorkspace'),
          onChange: (value) => updateSetting('askRemoveEmptyWorkspace', value),
        }),
        React.createElement(SettingRow, {
          key: 'bin',
          label: __('settings.useRecycleBin'),
          hint: __('settings.useRecycleBinHint'),
          checked: settingsValue('useRecycleBin'),
          onChange: (value) => updateSetting('useRecycleBin', value),
        }),
        settingsValue('useRecycleBin')
          ? null
          : React.createElement('div', {
              key: 'binwarn',
              style: { ...errStyle, marginTop: 6 },
            }, __('settings.binOffWarning')),

        React.createElement('div', { key: 'h2', style: headingStyle }, __('settings.recycle')),
        React.createElement('div', {
          key: 'hint',
          style: {
            fontSize: 12, lineHeight: '18px', marginBottom: 6,
            color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
          },
        }, __('settings.recycleHint')),

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, fontSize: 12 } }, __('settings.loading'))
          : entries.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, fontSize: 12 } }, __('settings.empty'))
            : React.createElement(React.Fragment, null, [
                // Toolbar: select-all plus the batch permanent delete.
                React.createElement('div', {
                  key: 'bar',
                  style: {
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 0 8px', fontSize: 12,
                    borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
                  },
                }, [
                  React.createElement('label', {
                    key: 'all',
                    style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
                  }, [
                    React.createElement('input', {
                      key: 'box', type: 'checkbox', checked: allPicked,
                      onChange: toggleAll,
                    }),
                    React.createElement('span', { key: 'lbl' }, __('settings.selectAll')),
                  ]),
                  React.createElement('span', {
                    key: 'count', style: { color: 'var(--dsw-alias-label-secondary, #8a8a8e)' },
                  }, __('batch.selected', { n: picked.size })),
                  React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
                  React.createElement('button', {
                    key: 'restore',
                    type: 'button',
                    disabled: picked.size === 0 || purging,
                    onClick: onRestorePicked,
                    style: {
                      padding: '4px 12px', borderRadius: 6, fontSize: 12,
                      cursor: picked.size === 0 || purging ? 'default' : 'pointer',
                      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-primary, inherit)',
                      ...(picked.size === 0 || purging ? { opacity: 0.5 } : {}),
                    },
                  }, purging ? __('dialog.busy') : __('settings.restorePicked')),
                  React.createElement('button', {
                    key: 'purge',
                    type: 'button',
                    disabled: picked.size === 0 || purging,
                    onClick: onPurge,
                    style: {
                      padding: '4px 12px', borderRadius: 6, fontSize: 12,
                      cursor: picked.size === 0 || purging ? 'default' : 'pointer',
                      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-state-error-primary, #e5484d)',
                      ...(picked.size === 0 || purging ? { opacity: 0.5 } : {}),
                    },
                  }, purging ? __('dialog.busy') : __('settings.purge')),
                ]),
                React.createElement('div', {
                  key: 'list', style: { maxHeight: 320, overflowY: 'auto' },
                }, entries.map(entry => React.createElement(RecycleRow, {
                  key: entry.sessionId,
                  entry,
                  busy: busyId === entry.sessionId,
                  onRestore,
                  picked: picked.has(entry.sessionId),
                  onTogglePick: togglePick,
                  __,
                }))),
              ]),

        note ? React.createElement('div', { key: 'note', style: okStyle }, note) : null,
        error ? React.createElement('div', {
          key: 'err', role: 'alert', style: { ...errStyle, whiteSpace: 'pre-wrap' },
        }, error) : null,
      ])
    }

    /**
     * One recycle-bin row.
     *
     * A bare uuid tells the user nothing about whether to restore it, so the
     * row leads with what the session was -- its title, or the project folder
     * when it never had one -- and keeps the id as tertiary detail. The local
     * time and the id are only shown when they add something.
     */
    function RecycleRow(props) {
      const { entry, busy, onRestore, __ } = props

      const label = (entry.label && String(entry.label).trim())
        || (entry.title && String(entry.title).trim())
        || __('settings.untitled')

      // The project folder, shortened to its last two segments: the full path
      // is available on hover, and the tail is what identifies it.
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
      const shortPath = (() => {
        if (cwd.length === 0) return ''
        const parts = cwd.split(/[\\/]+/).filter(Boolean)
        return parts.slice(-2).join('/')
      })()

      const when = (() => {
        const at = typeof entry.at === 'number' ? entry.at : undefined
        if (at === undefined) return ''
        try {
          return new Date(at).toLocaleString()
        } catch { return '' }
      })()

      const rowStyle = {
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 12, padding: '10px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      }
      const titleStyle = {
        fontSize: 13, lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }
      const subStyle = {
        fontSize: 12, lineHeight: '18px', marginTop: 2,
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }
      const idStyle = {
        fontSize: 11, lineHeight: '16px', marginTop: 2,
        color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }

      return React.createElement('div', { style: rowStyle }, [
        React.createElement('input', {
          key: 'pick',
          type: 'checkbox',
          checked: props.picked === true,
          onChange: () => props.onTogglePick?.(entry.sessionId),
          style: { marginTop: 4, flex: 'none' },
          'aria-label': __('settings.selectOne'),
        }),
        React.createElement('div', {
          key: 'meta',
          style: { minWidth: 0, flex: '1 1 auto' },
        }, [
          React.createElement('div', { key: 't', style: titleStyle, title: entry.title || label }, label),
          shortPath.length > 0
            ? React.createElement('div', { key: 'p', style: subStyle, title: cwd }, shortPath)
            : null,
          when.length > 0
            ? React.createElement('div', { key: 'w', style: subStyle }, when)
            : null,
          React.createElement('div', { key: 'i', style: idStyle, title: entry.sessionId }, entry.sessionId),
        ]),
        React.createElement('button', {
          key: 'restore',
          type: 'button',
          disabled: busy === true,
          onClick: () => onRestore(entry.sessionId),
          style: {
            padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: busy ? 'default' : 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
            background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
            flex: 'none', marginTop: 2,
            ...(busy === true ? { opacity: 0.5 } : {}),
          },
        }, busy === true ? __('settings.restoring') : __('settings.restore')),
      ])
    }

    // --- header button ----------------------------------------------------------

    function HeaderButton(props) {
      const { sessionId, useSessions } = props
      const __ = (props && props.t) || t
      useLocaleRevision()
      const sessions = useSessions ? useSessions(state => state) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false

      const open = useCallback(() => {
        window.dispatchEvent(new CustomEvent(EVENT, {
          detail: { sessionId, title: summary?.title ?? null, running },
        }))
      }, [sessionId, summary, running])

      return React.createElement('button', {
        type: 'button',
        title: running ? __('button.titleRunning') : __('button.title'),
        'aria-label': __('button.title'),
        style: btnStyle,
        onClick: open,
      }, React.createElement(IconTrashOutline16, { size: 16 }))
    }

    // --- sidebar menu injection --------------------------------------------------
    // The session-row menu has no extension slot, so the item is injected at the
    // DOM level.
    //
    // The row carries `data-row-key="session:<id>"` (dsh-client-ui-workspace), so
    // the id is read straight off the DOM. An earlier version read the row's
    // *title* and looked the id up in the list store; that broke in two ways:
    // an untitled session renders an empty title, so nothing could be resolved
    // until opening it once minted a title, and duplicated titles could resolve
    // to the wrong session. The id is unique and always present, so it is used
    // directly and the title is only ever a display string.

    /** Extract the session id from a row's `data-row-key`, or null. */
    function sessionIdOfRow(row) {
      if (!row || typeof row.getAttribute !== 'function') return null
      const key = row.getAttribute('data-row-key')
      if (typeof key !== 'string') return null
      // Session rows are `session:<id>`; workspace rows are `workspace:<key>`
      // and the overflow row is `overflow:<key>`, so the prefix is required.
      if (!key.startsWith('session:')) return null
      const id = key.slice('session:'.length).trim()
      return id.length > 0 ? id : null
    }

    const TRASH_PATH = 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z'

    function isSessionRowMenuOpen() {
      const rows = document.querySelectorAll('[class*=sessionRow]')
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').includes('menuOpen')) return rows[i]
      }
      return null
    }

    function installMenu() {
      const menu = document.querySelector('[role=menu]')
      if (!menu || menu.querySelector('[data-session-recycle]')) return
      const row = isSessionRowMenuOpen()
      if (!row) return
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('data-session-recycle', '1')
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        'color:var(--dsw-alias-state-error-primary,#e5484d)',
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
      item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="' + TRASH_PATH + '" fill="currentColor"/></svg><span></span>'
      item.querySelector('span').textContent = t('menu.delete')
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent' })
      item.addEventListener('click', () => {
        const sessionId = sessionIdOfRow(row)
        if (!sessionId) return
        // The title is display-only: read it if present, but never depend on it.
        const titleEl = row.querySelector('[class*=title]')
        const displayTitle = titleEl ? String(titleEl.innerText || '').trim() : ''
        // With confirmation switched off the row deletes immediately; the
        // dialog is then only ever opened for a not-found report.
        if (!settingsValue('confirmSingleDelete')) {
          // Report the outcome instead of swallowing it. With no dialog there is
          // otherwise no feedback at all, so a refused delete (a running agent,
          // a locked directory, a read-only store) would look exactly like a
          // successful one.
          runDelete(sessionId, t).then(
            (result) => {
              showToast(
                result?.permanent === true ? t('dialog.donePermanent') : t('dialog.doneRecycled'),
                'success',
              )
            },
            (reason) => {
              // "Already gone" means the user's intent is satisfied, not a fault.
              if (reason && reason.alreadyGone === true) return
              showToast(reason?.message ?? String(reason), undefined)
            },
          )
          return
        }
        window.dispatchEvent(new CustomEvent(EVENT, {
          detail: { sessionId, title: displayTitle || null },
        }))
      })
      const separator = document.createElement('div')
      separator.style.cssText = 'height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))'
      menu.appendChild(separator)
      menu.appendChild(item)
    }

    function refreshLabel() {
      const items = document.querySelectorAll('[data-session-recycle]')
      for (let i = 0; i < items.length; i++) {
        const span = items[i].querySelector('span')
        if (span) span.textContent = t('menu.delete')
      }
    }

    function installSidebarMenu() {
      if (window.__sessionRecycleInstalled) return
      window.__sessionRecycleInstalled = true
      try { installMenu() } catch { /* never break the UI */ }
      // The menu is portalled, so a body-scoped observer is the reliable hook.
      //
      // Coalesced to one call per frame: the observer fires on every mutation in
      // the body subtree, and a streaming reply mutates the transcript
      // continuously. Without coalescing this would run a full-document
      // `querySelector` on each batch, for a menu that is almost never open.
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        const run = () => {
          scheduled = false
          try { installMenu() } catch { /* never break the UI */ }
        }
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run)
        else window.setTimeout(run, 16)
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      // Registered so a plugin reload/dispose does not leave the observer (and
      // its retained closure over the module) alive.
      sidebarMenuDisposers.push(() => observer.disconnect())
    }

    // --- apply -------------------------------------------------------------------

    function adoptLocale(locale, ctx) {
      if (!locale) return
      localeSvc = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh, en }))
        }
      } catch { /* namespace already registered */ }
    }

    function apply(ctx) {
      sessionsSvc = ctx.get('sessions')
      if (!sessionsSvc) ctx.inject(['sessions'], (sub) => { sessionsSvc = sub.sessions })

      // `uiSession` tracks the open conversation; `sessions.list` does not.
      uiSessionSvc = ctx.get('uiSession')
      if (!uiSessionSvc) ctx.inject(['uiSession'], (sub) => { uiSessionSvc = sub.uiSession })

      // `uiWorkspace` owns navigation; the `sessions` service has no open(id).
      uiWorkspaceSvc = ctx.get('uiWorkspace')
      if (!uiWorkspaceSvc) ctx.inject(['uiWorkspace'], (sub) => { uiWorkspaceSvc = sub.uiWorkspace })

      // The workspace list store: restoring pushes grouping updates into it.
      workspacesSvc = ctx.get('workspaces')
      if (!workspacesSvc) ctx.inject(['workspaces'], (sub) => { workspacesSvc = sub.workspaces })

      adoptLocale(ctx.get('locale'), ctx)
      if (!localeSvc) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
          refreshLabel()
        })
      }
      ctx.on?.('locale/change', refreshLabel)

      // Settings are fetched once; until they arrive the documented defaults
      // apply, so a slow or missing host never blocks the UI.
      loadSettings()

      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: HEADER_ID,
        order: 30,
        ...(localeSvc ? { locale: NS } : {}),
      }, HeaderButton))

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 100,
        ...(localeSvc ? { locale: NS } : {}),
      }, DeleteDialog))

      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: EMPTY_DIALOG_ID,
        order: 102,
        ...(localeSvc ? { locale: NS } : {}),
      }, EmptyWorkspaceDialog))

      // One settings page, holding both the policy and the recycle bin.
      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({
        name: SETTINGS_SLOT,
        id: SETTINGS_ID,
        order: 60,
        label: () => t('settings.nav'),
        ...(localeSvc ? { locale: NS } : {}),
      }, SettingsPanel))

      // Transient banners. Registered on the overlay (a portalled surface), so
      // a restore reported from the settings page still shows top-center over
      // the whole window.
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: TOAST_ID,
        order: 120,
        ...(localeSvc ? { locale: NS } : {}),
      }, ToastHost))

      installSidebarMenu()

      // DOM-level wiring is not owned by cordis, so tear it down explicitly.
      ctx.effect(() => () => {
        for (const dispose of sidebarMenuDisposers.splice(0)) {
          try { dispose() } catch { /* best effort */ }
        }
        // Let a later mount re-install; otherwise the guard keeps the observer
        // from ever being recreated after a reload.
        try { delete window.__sessionRecycleInstalled } catch { /* best effort */ }
        for (const item of document.querySelectorAll('[data-session-recycle]')) {
          try { item.remove() } catch { /* best effort */ }
        }
      }, 'session-recycle:sidebar-menu')
    }

    return { apply, inject: ['slots'] }
  },
})
