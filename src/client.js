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
    const TOAST_ID = 'session-recycle-toast'
    // The deletion preferences, moved off the page and behind a button. They
    // render from the overlay slot like the confirm dialog, so the panel itself
    // stays a plain list.
    const CONFIG_ID = 'session-recycle-config'
    // The page's two lists, as tabs on one settings section. They were briefly
    // two sections — two nav entries inside Settings — which put two nearly
    // identical toolbars one click apart and made "undo a delete" look like a
    // different feature from "delete". Same page, one tab strip.
    const TAB_SESSIONS = 'sessions'
    const TAB_RECYCLE = 'recycle'
    const EVENT = 'dsh-session-recycle:delete'

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
      'settings.nav': '会话删除',
      'settings.config': '配置',
      'settings.configTitle': '删除设置',
      'settings.configDesc': '这里的勾选改完立即生效，关掉即生效完毕。每项标题右侧的 ? 是它的说明，悬浮即显。',
      'settings.close': '关闭',
      'settings.behaviour': '删除行为',
      // What each switch actually does, behind the "?" next to its title: the
      // rows carry a name and a box, the explanation waits for a hover. Written
      // as bullet points, one idea each — a paragraph this long pushed the row
      // it belonged to out of shape.
      'settings.tip': '说明',
      'settings.useRecycleBin': '删除时移入回收站',
      'settings.useRecycleBinTip1': '开启（默认）：删除的会话进回收站，可随时还原。',
      'settings.useRecycleBinTip2': '关闭：删除立即生效且无法还原，每次删除前仍会先确认。',
      'settings.binOffWarning': '⚠ 回收站已关闭：删除将无法还原。',
      'settings.confirmSingleDelete': '删除会话前先确认',
      'settings.confirmSingleDeleteTip1': '开启（默认）：点「删除」先问一次，确认后才真的删。',
      'settings.confirmSingleDeleteTip2': '关闭：点「删除」（单个或所选）直接执行，不再询问。',
      'settings.confirmForcedHint': '回收站已关闭：删除不可还原，所以始终会先确认。',
      'settings.confirmForcedTip': '这一项暂时不管用：回收站关着，删掉就找不回来了，所以每次都会先确认一次。',
      'settings.autoPrune': '删除后自动清理空分组与空目录',
      // Kept to two lines each at the bubble's 260px: the dialog clips its
      // overflow, and the tallest bubble still has to fit above its own row.
      'settings.autoPruneTip1': '每删完一个会话，检查它所属的分组是不是已经空了。',
      'settings.autoPruneTip2': '空了就连同该分组一起移除。',
      'settings.autoPruneTip3': '同时清掉留下的空文件夹：分组目录与会话自己的目录（子目录里的会话另算）。',
      'settings.autoPruneTip4': '非空目录和有会话的分组不动，项目文件夹与会话日志不受影响。',
      'settings.autoPruneTip5': '默认关闭：空分组往往是你还在用的项目。',
      'settings.emptyAutoRemoved': '已一并移除 {n} 个空工作区',
      'settings.emptyAutoDirs': '已一并清理 {n} 个空目录',
      'settings.emptyAutoBoth': '已一并移除 {m} 个空工作区、清理 {d} 个空目录',
      'settings.emptyAutoFailed': '有 {n} 个空工作区移除失败',
      'settings.cleanup': '空分组与空目录',
      // The relation to the switch above, spelled out behind the "?" — it used
      // to sit on the row as a paragraph, where it made the row four lines tall
      // and pushed the button beside it into wrapping. The switch fires only on
      // this plugin's own deletes, so anything left by another route — or by a
      // delete that ran while the switch was off — is collected here. Without
      // that point the row reads like a duplicate of the switch.
      'settings.cleanupTip1': '清理没有会话的分组，以及确实空着的会话目录。',
      'settings.cleanupTip2': '上面的开关只在「本插件删除会话」时触发；用别的方式删掉的会话留下的空壳，要在这里收。',
      'settings.cleanupTip3': '非空目录和有会话的分组不会动；连按两次和按一次一样。',
      'settings.cleanupCount': '当前有 {dirs} 个空目录、{workspaces} 个空分组',
      'settings.cleanupCountDirs': '当前有 {n} 个空目录，没有空分组',
      'settings.cleanupCountWorkspaces': '当前有 {n} 个空分组，没有空目录',
      'settings.cleanupNone': '没有空分组或空目录',
      'settings.cleanupUnknown': '没能读到数量',
      'settings.cleanupRun': '清理',
      'settings.cleanupRunning': '清理中…',
      'settings.cleaned': '已清理 {dirs} 个空目录、{workspaces} 个空分组',
      'settings.cleanedPartial': '已清理 {ok} 个，{fail} 个失败',
      'settings.cleanupNothing': '没有需要清理的空分组或空目录',
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
      'settings.groupUngrouped': '未分组',
      'settings.selectOne': '选择这一条',
      'settings.restorePicked': '恢复所选',
      'settings.restoredMany': '已恢复 {n} 条，其中 {g} 条已放回原分组。',
      'settings.restoredManyPartial': '已恢复 {ok} 条，{fail} 条失败。',
      'settings.purge': '彻底删除',
      'settings.purged': '已彻底删除 {n} 条，无法恢复。',
      'settings.purgedPartial': '已彻底删除 {ok} 条，{fail} 条失败。',

      // 会话列表（本页主体）：直接挑选并删除现存会话，不必先打开某个会话。
      'settings.sessions': '会话列表',
      'settings.sessionsHint': '勾选后一次删除多个会话。删除后可在回收站还原（回收站关闭时不可还原）。',
      'settings.filter': '筛选（标题 / 目录 / 序列号）',
      'settings.refresh': '刷新',
      'settings.emptySessions': '没有可删除的会话。',
      'settings.filterEmpty': '没有匹配的会话。',
      'settings.count': '共 {n} 个会话',
      'settings.deletePicked': '删除所选',
      'settings.deleting': '正在删除…',
      'settings.confirmDeleteMany': '确定删除这 {n} 个会话吗？日志会移入回收站，可随时还原。',
      'settings.confirmDeleteManyPermanent': '⚠ 回收站已关闭：这 {n} 个会话将被永久删除，无法还原。确定继续吗？',
      'settings.cancel': '取消',
      // The batch result is one sentence assembled from a main clause and an
      // optional "and the sweep also cleared…" tail, rather than a string per
      // combination: the tail has three shapes and the clause two, and a table
      // of all six would be six chances to let them drift apart.
      'settings.deletedMany': '已删除 {n} 个会话{extra}。',
      'settings.deletedManyPartial': '已删除 {ok} 个，{fail} 个失败{extra}。',
      'settings.sweptGroups': '，并移除 {m} 个空分组',
      'settings.sweptDirs': '，并清理 {d} 个空目录',
      'settings.sweptBoth': '，移除 {m} 个空分组并清理 {d} 个空目录',

      // 两个列表是同一页上的两个标签页：标题取列表名，徽标是各自的条数。
      'settings.tabsLabel': '会话删除页签',
      'settings.tabCount': '共 {n} 条',

      // 分页器（两个列表共用）。
      'settings.pagerPrev': '上一页',
      'settings.pagerNext': '下一页',
      'settings.pageSize': '每页',
      'settings.pagePosition': '第 {page}/{pages} 页',
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
      'settings.nav': 'Session deletion',
      'settings.config': 'Settings',
      'settings.configTitle': 'Deletion settings',
      'settings.configDesc': 'Every tick here applies immediately — just close this when you are done. The "?" beside each title holds that setting\'s explanation: hover it.',
      'settings.close': 'Close',
      'settings.behaviour': 'Behaviour',
      'settings.tip': 'Explanation',
      'settings.useRecycleBin': 'Move deleted sessions to the recycle bin',
      'settings.useRecycleBinTip1': 'On (default): a deleted session goes to the bin first, restorable at any time.',
      'settings.useRecycleBinTip2': 'Off: deletion is immediate and cannot be undone.',
      'settings.binOffWarning': '⚠ The recycle bin is off: deletions cannot be restored.',
      'settings.confirmSingleDelete': 'Confirm before deleting sessions',
      'settings.confirmSingleDeleteTip1': 'On (default): clicking delete asks once, then acts on your confirmation.',
      'settings.confirmSingleDeleteTip2': 'Off: clicking delete — one session or a selection — acts immediately with no confirmation.',
      'settings.confirmForcedHint': 'The recycle bin is off, so a delete cannot be undone and is always confirmed.',
      'settings.confirmForcedTip': 'This switch is inactive for now: with the bin off a deletion cannot be recovered, so every one of them asks first.',
      'settings.autoPrune': 'Clean up emptied groups and folders after a delete',
      'settings.autoPruneTip1': 'After a delete, is its group now empty?',
      'settings.autoPruneTip2': 'If it is, the group goes too.',
      'settings.autoPruneTip3': 'The folders it emptied go with it: the group\'s and the session\'s own.',
      'settings.autoPruneTip4': 'Groups with sessions left and non-empty folders are left alone.',
      'settings.autoPruneTip5': 'Off by default: an empty group is often a project still in use.',
      'settings.emptyAutoRemoved': 'Also removed {n} empty workspace(s)',
      'settings.emptyAutoDirs': 'Also cleaned {n} empty folder(s)',
      'settings.emptyAutoBoth': 'Also removed {m} empty workspace(s) and cleaned {d} empty folder(s)',
      'settings.emptyAutoFailed': '{n} empty workspace(s) could not be removed',
      'settings.cleanup': 'Empty groups and folders',
      'settings.cleanupTip1': 'Sweeps groups with no session left, and genuinely empty session folders.',
      'settings.cleanupTip2': 'The switch above only fires on a delete this plugin performs; shells left by any other route are collected here.',
      'settings.cleanupTip3': 'Non-empty folders and groups with sessions left are untouched, and pressing this twice equals pressing it once.',
      'settings.cleanupCount': '{dirs} empty folder(s) and {workspaces} empty group(s)',
      'settings.cleanupCountDirs': '{n} empty folder(s), no empty group',
      'settings.cleanupCountWorkspaces': '{n} empty group(s), no empty folder',
      'settings.cleanupNone': 'Nothing empty',
      'settings.cleanupUnknown': 'Count unavailable',
      'settings.cleanupRun': 'Clean up',
      'settings.cleanupRunning': 'Cleaning…',
      'settings.cleaned': 'Removed {dirs} empty folder(s) and {workspaces} empty group(s)',
      'settings.cleanedPartial': 'Removed {ok}, {fail} failed',
      'settings.cleanupNothing': 'No empty group or folder to clean',
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
      'settings.groupUngrouped': 'Ungrouped',
      'settings.selectOne': 'Select this entry',
      'settings.restorePicked': 'Restore selected',
      'settings.restoredMany': 'Restored {n} entry(ies); {g} went back to their group.',
      'settings.restoredManyPartial': 'Restored {ok}, {fail} failed.',
      'settings.purge': 'Delete permanently',
      'settings.purged': 'Permanently deleted {n} entry(ies). This cannot be undone.',
      'settings.purgedPartial': 'Permanently deleted {ok}, {fail} failed.',

      // Session list (the page's main body): pick live sessions and delete them
      // without opening each one first.
      'settings.sessions': 'Sessions',
      'settings.sessionsHint': 'Tick several entries to delete them in one go. A deletion lands in the recycle bin and can be restored (unless the bin is off).',
      'settings.filter': 'Filter (title / folder / id)',
      'settings.refresh': 'Refresh',
      'settings.emptySessions': 'No sessions to delete.',
      'settings.filterEmpty': 'No session matches the filter.',
      'settings.count': '{n} session(s)',
      'settings.deletePicked': 'Delete selected',
      'settings.deleting': 'Deleting…',
      'settings.confirmDeleteMany': 'Delete these {n} session(s)? Their logs move to the recycle bin and can be restored.',
      'settings.confirmDeleteManyPermanent': '⚠ The recycle bin is off: these {n} session(s) are deleted permanently and cannot be restored. Continue?',
      'settings.cancel': 'Cancel',
      'settings.deletedMany': 'Deleted {n} session(s){extra}.',
      'settings.deletedManyPartial': 'Deleted {ok}, {fail} failed{extra}.',
      'settings.sweptGroups': ', and removed {m} empty group(s)',
      'settings.sweptDirs': ', and cleaned {d} empty folder(s)',
      'settings.sweptBoth': ', and removed {m} empty group(s) plus cleaned {d} empty folder(s)',

      // Two lists, two tabs on one page: the title is the list's own name and
      // the badge is how much each one is holding.
      'settings.tabsLabel': 'Deletion page tabs',
      'settings.tabCount': '{n} entries',

      // The pager, shared by both pick-lists.
      'settings.pagerPrev': 'Previous',
      'settings.pagerNext': 'Next',
      'settings.pageSize': 'Per page',
      'settings.pagePosition': 'Page {page} of {pages}',
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
      autoPruneEmpty: false,
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

    /**
     * Whether a delete has to be asked about first.
     *
     * The Configure switch answers for the reversible case, and it is a single
     * answer for both entry points — the sidebar row's own delete and the
     * batch on this page's list. A delete with the recycle bin off is the one
     * case the switch cannot cover: it cannot be undone, so it is confirmed
     * regardless. The switch is about not being nagged, not about agreeing to
     * lose data, and the hint next to it says so.
     */
    function needsConfirm() {
      return settingsValue('confirmSingleDelete') || settingsValue('useRecycleBin') === false
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

    // --- config dialog -------------------------------------------------------------
    //
    // The three preferences used to sit at the top of the session list, so every
    // visit opened on a form the user had already answered — pushing the list,
    // the reason the page exists, below the fold. They live behind the header's
    // Configure button now, and the page is a list and nothing else.
    //
    // The state is module-level and the dialog renders from the overlay slot,
    // like the confirm dialog. The button that opens it sits deep inside the
    // settings modal, so an overlay entry is the one place guaranteed to paint
    // above it.
    const configDialogState = { open: false, listeners: new Set() }

    function configDialogSubscribe(listener) {
      configDialogState.listeners.add(listener)
      return () => { configDialogState.listeners.delete(listener) }
    }

    function setConfigDialogOpen(open) {
      if (configDialogState.open === open) return
      configDialogState.open = open
      for (const listener of [...configDialogState.listeners]) {
        try { listener() } catch { /* a broken subscriber never blocks others */ }
      }
    }

    function openConfigDialog() { setConfigDialogOpen(true) }
    function closeConfigDialog() { setConfigDialogOpen(false) }

    // --- tab counts ----------------------------------------------------------------
    //
    // How many rows each tab is holding, shared by the tab strip and the panes.
    //
    // The bin's number cannot be reported by its own pane: the badge is on
    // screen from the moment the page opens, and that pane is not mounted until
    // someone crosses to it — which is exactly the moment the badge stops being
    // needed as an invitation. It is also changed from outside the pane, since
    // deleting with the bin on feeds it. A module-level cell covers both: the
    // strip reads it, whoever changes the list writes it, and a null ("not read
    // yet") renders as no badge rather than as a claim of zero.
    const tabCounts = { [TAB_SESSIONS]: null, [TAB_RECYCLE]: null, listeners: new Set() }

    function tabCountSubscribe(listener) {
      tabCounts.listeners.add(listener)
      return () => { tabCounts.listeners.delete(listener) }
    }

    function setTabCount(id, n) {
      const next = typeof n === 'number' && Number.isFinite(n) ? n : null
      if (tabCounts[id] === next) return
      tabCounts[id] = next
      for (const listener of [...tabCounts.listeners]) {
        try { listener() } catch { /* a broken subscriber never blocks others */ }
      }
    }

    /**
     * Re-read the recycle bin's length.
     *
     * Called when the page opens — so the badge is right before the pane has
     * ever mounted — and after a deletion that fed the bin. A failed read keeps
     * the last known number: stale beats blank on a count that is only ever an
     * invitation.
     */
    async function refreshRecycleCount() {
      try {
        const rows = await fetchRecycled()
        if (Array.isArray(rows)) setTabCount(TAB_RECYCLE, rows.length)
      } catch { /* the badge keeps whatever it last knew */ }
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

    /**
     * Live sessions in the store, newest first, with display fields.
     *
     * The host fills `title` from the projection cache and `cwd` from the
     * session header, so the row can show what the session *is* rather than a
     * uuid the user has to decode elsewhere first.
     */
    async function fetchSessions() {
      const payload = await api('/__session-recycle/list')
      return Array.isArray(payload.sessions) ? payload.sessions : []
    }

    /**
     * Delete a set of sessions in one round trip.
     *
     * One request rather than N: each single delete re-reads settings and the
     * workspace registry on the host, so a batch of 20 would both be slow and
     * race itself — a workspace emptied by the third call is already gone by
     * the time the seventh looks for it.
     *
     * @returns { deleted, failed, emptiedWorkspaces, removedWorkspaces,
     *   prunedDirs } from the host. `emptiedWorkspaces` is what the batch left
     *   empty; `removedWorkspaces` is the subset the `autoPruneEmpty` switch
     *   then removed, and `prunedDirs` every folder that sweep also cleared
     *   (the group's folder and the session's own are not always the same one).
     */
    async function deleteSessions(sessionIds, permanent) {
      const payload = await api('/__session-recycle/delete-many', {
        method: 'POST',
        body: { sessionIds, permanent: permanent === true },
      })
      return {
        deleted: Array.isArray(payload.deleted) ? payload.deleted : [],
        failed: Array.isArray(payload.failed) ? payload.failed : [],
        emptiedWorkspaces: Array.isArray(payload.emptiedWorkspaces) ? payload.emptiedWorkspaces : [],
        removedWorkspaces: Array.isArray(payload.removedWorkspaces) ? payload.removedWorkspaces : [],
        prunedDirs: Array.isArray(payload.prunedDirs) ? payload.prunedDirs : [],
        workspaceRemovalFailed: Array.isArray(payload.workspaceRemovalFailed) ? payload.workspaceRemovalFailed : [],
      }
    }

    /**
     * The "…and the sweep also cleared X" tail of a batch result.
     *
     * Assembled here rather than picked from one key per combination, and
     * reported even when it is empty so the caller can always hand `{extra}`
     * to the template — an unfilled placeholder would render as literal braces.
     *
     * @returns a string starting with a separator, or '' when nothing was swept.
     */
    function sweptSuffix(translate, removedWorkspaces, prunedDirs) {
      const groups = Array.isArray(removedWorkspaces) ? removedWorkspaces.length : 0
      const dirs = Array.isArray(prunedDirs) ? prunedDirs.length : 0
      if (groups > 0 && dirs > 0) return translate('settings.sweptBoth', { m: groups, d: dirs })
      if (groups > 0) return translate('settings.sweptGroups', { m: groups })
      if (dirs > 0) return translate('settings.sweptDirs', { d: dirs })
      return ''
    }

    /**
     * What a sweep would clear: the store folders that hold nothing, and the
     * workspaces that no longer hold a single session.
     *
     * Deleting a session takes its payload out of the store and leaves behind
     * the folder DSH made for its working directory; deleting the last session
     * of a project leaves the workspace group with nothing in it. Sweeping both
     * is the difference between "everything is deleted" and "everything is
     * deleted but the sidebar and the store still show a row per project".
     */
    async function fetchCleanup() {
      const payload = await api('/__session-recycle/empty-dirs')
      return {
        dirs: Array.isArray(payload.dirs) ? payload.dirs : [],
        workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
      }
    }

    /**
     * Sweep both, host-side and idempotent.
     *
     * @returns { dirs, workspaces, failed } — the names/paths actually removed.
     */
    async function pruneEmpty() {
      const payload = await api('/__session-recycle/prune-empty', { method: 'POST' })
      return {
        dirs: Array.isArray(payload.removed) ? payload.removed : [],
        workspaces: Array.isArray(payload.removedWorkspaces) ? payload.removedWorkspaces : [],
        failed: Array.isArray(payload.failed) ? payload.failed : [],
      }
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

    // --- tab strip --------------------------------------------------------------
    //
    // One page, two lists, one strip. The selected tab is marked with a rule on
    // the shared baseline rather than a filled pill: the page below it is dense
    // already, and a second filled surface would compete with the list itself.

    const tabStripStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      paddingBottom: 0,
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    const tabListStyle = {
      display: 'flex', alignItems: 'center', gap: 2,
      flex: '1 1 auto', minWidth: 0,
    }
    const tabBaseStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 10px', marginBottom: -1, borderRadius: '6px 6px 0 0',
      border: 'none', borderBottom: '2px solid transparent',
      background: 'transparent', cursor: 'pointer',
      fontSize: 13, lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }
    /** The open tab: same shape as the idle one, marked rather than disabled. */
    const tabOnStyle = {
      ...tabBaseStyle, fontWeight: 600,
      color: 'var(--dsw-alias-label-primary, inherit)',
      borderBottomColor: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    /** How much a list is holding — quiet, so it does not outrank the label. */
    const tabBadgeStyle = {
      display: 'inline-block', padding: '0 6px', borderRadius: 8,
      fontSize: 11, lineHeight: '16px',
      background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }

    // --- pick-list styles -------------------------------------------------------
    //
    // Shared by the session list and the recycle list: both are "tick rows,
    // then act on the ticks", so they are deliberately the same object to look
    // at. The boxed border is what tells the user the list is a scrollable
    // area rather than more page text.

    const listBoxStyle = {
      marginTop: 8, maxHeight: 340, overflowY: 'auto',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
      borderRadius: 8,
    }
    const rowBaseStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px',
    }
    const rowBorderStyle = {
      ...rowBaseStyle,
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    const rowTitleStyle = {
      display: 'block', fontSize: 13, lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, inherit)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }
    const rowMetaStyle = {
      display: 'block', fontSize: 12, lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }
    /**
     * The toolbar, in two rows.
     *
     * The filter is a box the user types into; the buttons are things they
     * press. On one wrapped row the filter shared its line with four buttons and
     * ended up a 140px slot in the middle of them. It gets its own row now, and
     * the row under it holds the controls — which is also what lets the
     * select-all box sit flush left, exactly where each row's own box is.
     *
     * Both lists on this page use it, so the two tabs read as one pattern.
     */
    const filterRowStyle = { padding: '6px 0 0' }
    const actionRowStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
      padding: '8px 0',
    }
    const filterInputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '5px 10px',
      fontSize: 12, borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    }
    /** The select-all box: shaped like a list row's own, so the parallel reads. */
    const selectAllStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      flex: 'none', cursor: 'pointer', fontSize: 12, lineHeight: '18px',
    }
    /**
     * A group heading inside the pick-list.
     *
     * The list is one flat scroll box, so groups need something to be *seen* as
     * groups: rows are sorted by group and each run is opened by this bar. It is
     * repeated at the top of every page on purpose — a page that starts in the
     * middle of a group still has to say which group that is.
     *
     * A heading bar was chosen over a per-row group badge: the badge repeats the
     * same folder on every line, which is exactly the noise a list this long
     * cannot afford, and it leaves the eye with nothing to scan. The bar draws
     * the boundary once and names it.
     */
    const groupHeadingStyle = {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px',
      fontSize: 12, lineHeight: '18px', fontWeight: 600,
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
      background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.12))',
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    /** The first heading has the box's own top edge; a line there would double it. */
    const groupHeadingFirstStyle = { ...groupHeadingStyle, borderTop: 'none' }
    const ghostBtnStyle = {
      padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const ghostBtnOffStyle = { ...ghostBtnStyle, opacity: 0.5, cursor: 'default' }
    const settingLabelStyle = { display: 'block', fontSize: 13, lineHeight: '20px' }
    /**
     * A title and its "?" on one line — the explanation moved into the tip.
     *
     * It is also the bubble's positioning context, and that is deliberate: the
     * dialog is 380px wide with `overflow: hidden`, so a bubble hung off the
     * right of a long title would be clipped. Anchored to the line instead, the
     * bubble starts at the column's left edge and its `max-width: 100%` keeps it
     * inside the column by construction.
     */
    const settingLabelRowStyle = {
      position: 'relative',
      display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
    }
    const settingHintStyle = {
      display: 'block', fontSize: 12, lineHeight: '18px', marginTop: 2,
      color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
    }
    const settingRowStyle = {
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0',
    }
    // The sweep row: a title and count on the left, one button on the right.
    // The button keeps its own width and never wraps — it used to be squeezed
    // by the long explanation next to it until "清理" broke onto two lines.
    const cleanupRowStyle = { display: 'flex', alignItems: 'center', gap: 10 }
    const cleanupTextStyle = { flex: '1 1 auto', display: 'block', minWidth: 0 }
    const cleanupGoStyle = { ...ghostBtnStyle, flex: 'none', whiteSpace: 'nowrap' }
    // --- the "?" tip -------------------------------------------------------------
    //
    // Long explanations used to sit under their title as a paragraph. In this
    // dialog they made every row three lines tall and squeezed the buttons next
    // to them into wrapping, so the text moved behind a hover: the row keeps its
    // name, and whoever wants the reasoning asks for it.
    //
    // The bubble is the platform's own tooltip surface (`--dsw-alias-tooltip-bg`
    // is a dark chip in both themes, so the text is white in both), lifted off
    // the dialog with a border and a shadow instead of floating over it.
    // The bubble hangs off the row's title line, not off the "?" itself (see
    // `settingLabelRowStyle`), so the anchor only has to sit still on that line.
    const tipAnchorStyle = { display: 'inline-flex', flex: 'none' }
    const tipChipStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 14, height: 14, borderRadius: '50%', flex: 'none',
      fontSize: 10, lineHeight: '14px', fontWeight: 600,
      border: '1px solid var(--dsw-alias-border-l4, rgba(128,128,128,.5))',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'help', userSelect: 'none',
    }
    const tipChipOnStyle = {
      ...tipChipStyle,
      borderColor: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      color: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    // The bubble always opens *upward*. The dialog clips its overflow (380px
    // wide, `overflow: hidden`), so the only thing that matters is whether a
    // bubble clears the card's top edge. Measured in the card's own layout —
    // 380x422 with the description on two lines — every bubble does, with this
    // much spare air above it: 82px from the first row, 122 from the second,
    // 66 from the third (the tallest bubble at 192px), 153 from the last. Below
    // the last row there is only ~79px, so a bubble opening downward would be
    // cut at the card's bottom edge.
    const tipBoxStyle = {
      position: 'absolute', left: 0, bottom: '100%', zIndex: 30,
      // A fixed 260px, not a percentage: the percentage resolved against the
      // title line, so a long title squeezed the bubble into a narrow column and
      // the text grew tall enough to run past the dialog's top edge. At 260px
      // the widest bubble ends 66px short of the dialog's right edge, and the
      // viewport cap only matters when the window is too narrow for the dialog
      // itself (it is `min(380px, 100%)`).
      width: 260, maxWidth: 'calc(100vw - 140px)',
      padding: '8px 10px', borderRadius: 8,
      background: 'var(--dsw-alias-tooltip-bg, #2c2c2e)',
      // The surface is dark in light and dark themes alike, so the platform's
      // own tooltip colour is the only readable one — it is `#fff`, spelled as
      // the token so the bubble keeps tracking it.
      color: 'var(--dsw-static-neutral-bluish-00, #fff)',
      border: '1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.18))',
      boxShadow: '0 8px 24px rgba(0,0,0,.28), 0 2px 6px rgba(0,0,0,.18)',
      fontSize: 12, lineHeight: '18px', fontWeight: 400,
      textAlign: 'left', whiteSpace: 'normal',
      cursor: 'default',
    }
    const tipListStyle = {
      margin: 0, padding: '0 0 0 16px', listStyle: 'disc',
    }
    const tipItemStyle = { margin: '2px 0' }
    const dangerOutlineBtnStyle = {
      padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #e5484d)',
    }
    const dangerOutlineBtnOffStyle = { ...dangerOutlineBtnStyle, opacity: 0.5, cursor: 'default' }
    const pagerStyle = {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      marginTop: 8, paddingTop: 8,
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }
    /** The current page's button: same shape, marked rather than disabled. */
    const pagerPageOnStyle = {
      ...ghostBtnStyle, fontWeight: 600,
      borderColor: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
      color: 'var(--dsw-alias-interactive-bg-primary, #3b82f6)',
    }
    const pageSizeSelectStyle = {
      padding: '3px 6px', fontSize: 12, borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
      background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const separatorStyle = {
      height: 1, margin: '12px 0 4px',
      background: 'var(--dsw-alias-border-l1, rgba(128,128,128,.18))',
    }

    /**
     * Format a millisecond timestamp for a row's meta line.
     *
     * @returns the local string, or '' when there is nothing to show.
     */
    function formatWhen(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      try { return new Date(value).toLocaleString() } catch { return '' }
    }

    /**
     * Shorten a project path to its last two segments.
     *
     * The full path is kept in the `title` attribute: the tail identifies the
     * project, the head only tells the user which drive it is on.
     */
    function shortPath(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      const parts = value.split(/[\\/]+/).filter(Boolean)
      return parts.slice(-2).join('/')
    }

    /** The last segment of a path — the folder's own name. */
    function lastSegment(value) {
      if (typeof value !== 'string') return ''
      const parts = value.split(/[\\/]+/).filter(part => part.length > 0)
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    // --- grouping ----------------------------------------------------------------
    //
    // 两个列表都是「一个分组里的一堆会话」，行与行之间却没有结构：删掉一个项目
    // 的十几个会话时，得自己记住哪些行属于同一个项目。分组把这件事变成看得见的
    // 东西——同名分组相邻，块与块之间有一条小标题。
    //
    // 分组不是从路径猜的：会话在侧栏里挂在哪个分组下，由 workspace 注册表说了算
    // （见 host 侧的 /list），所以这里直接读它给的那两个字段。读不到就归到「未分
    // 组」——那正是这一行在侧栏里的处境。

    /** The group a row belongs to: the workspace's id, or '' for none. */
    function groupKeyOf(row) {
      const id = typeof row?.workspaceId === 'string' ? row.workspaceId.trim() : ''
      return id.length > 0 ? id : ''
    }

    /**
     * What to print for a row's group: the workspace's name, else its folder name.
     *
     * The title is preferred over the path because that is the string the sidebar
     * shows; renaming a group has to be visible here too. The folder is only the
     * fallback for a row the registry answered about by path and never titled.
     */
    function groupLabelOf(row, key) {
      if (key.length === 0) return ''
      const title = typeof row?.workspaceTitle === 'string' ? row.workspaceTitle.trim() : ''
      return title.length > 0 ? title : lastSegment(row?.cwd)
    }

    /**
     * Rows in group order: same group adjacent, groups by name, no-group last.
     *
     * Sorting is what makes the headings meaningful — a heading over an
     * unsorted run would just be a label that happens to be true once. Order
     * inside a group is left as the host sent it (newest first).
     *
     * @returns {{ row, key, label }[]}
     */
    function groupRows(rows) {
      return rows
        .map(row => {
          const key = groupKeyOf(row)
          return { row, key, label: groupLabelOf(row, key) }
        })
        .sort((a, b) => {
          // Sessions with no group cannot be placed; they go last rather than
          // first, so the named groups stay at the top where they are read.
          if (a.label.length === 0 && b.label.length > 0) return 1
          if (b.label.length === 0 && a.label.length > 0) return -1
          const byName = a.label.localeCompare(b.label)
          if (byName !== 0) return byName
          // Two groups can share a folder name (a `src` on two drives). The id
          // breaks the tie so the two blocks stay separate and each keeps its
          // own heading, instead of merging into one bar that is true of half
          // the rows under it.
          return a.key.localeCompare(b.key)
        })
    }

    /**
     * How many rows each group holds, over the rows currently visible.
     *
     * Counted over the filtered list, not the page: the heading is a statement
     * about the group, and "3" that means "3 on this page" would be a different
     * statement that changes as you page.
     */
    function groupCounts(entries) {
      const counts = new Map()
      for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1)
      return counts
    }

    /**
     * One group's heading inside the pick-list.
     *
     * `title` carries the full group name so the shortening never hides the only
     * thing that distinguishes two projects with the same folder name.
     */
    function GroupHeading(props) {
      const { label, groupKey, count, first, __ } = props
      return React.createElement('div', {
        style: first ? groupHeadingFirstStyle : groupHeadingStyle,
        'data-group': groupKey,
      }, [
        React.createElement('span', {
          key: 'name',
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: label,
        }, label.length > 0 ? label : __('settings.groupUngrouped')),
        React.createElement('span', { key: 'n', style: tabBadgeStyle }, String(count)),
      ])
    }

    /**
     * The select-all box, at the head of the toolbar's second row.
     *
     * A checkbox rather than a button, because it is the same gesture as ticking
     * a row — and it selects the whole filtered list, not the page: the button
     * it replaces said "this page", which meant a select-all that silently
     * stopped at row 50. The filter is what narrows a selection now, and the
     * count next to it is always the honest number.
     */
    function SelectAllBox(props) {
      const { label, checked, disabled, onToggle } = props
      return React.createElement('label', {
        style: {
          ...selectAllStyle,
          ...(disabled ? { opacity: 0.5, cursor: 'default' } : {}),
        },
      }, [
        React.createElement('input', {
          key: 'box',
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: () => onToggle(),
          style: { flex: 'none' },
        }),
        React.createElement('span', { key: 'l' }, label),
      ])
    }

    // --- pager -------------------------------------------------------------------
    //
    // Both pick-lists grow with the store, so they are paged rather than left to
    // run off the bottom of the modal. Paging keeps the list scannable; it no
    // longer limits a selection — select-all means the whole filtered list, and
    // the pager is only how much of it is on screen at once.
    //
    // The page size is a local preference (localStorage), not a host setting:
    // how many rows fit on a screen is a property of the screen, and nothing
    // outside this client has any use for the number.

    const PAGE_SIZE_KEY = 'session-recycle:pageSize'
    const PAGE_SIZES = [20, 50, 100, 200]
    const DEFAULT_PAGE_SIZE = 50

    function readPageSize() {
      try {
        const value = Number(window.localStorage?.getItem(PAGE_SIZE_KEY))
        if (PAGE_SIZES.includes(value)) return value
      } catch { /* no storage (private mode) — the default stands */ }
      return DEFAULT_PAGE_SIZE
    }

    function writePageSize(value) {
      try { window.localStorage?.setItem(PAGE_SIZE_KEY, String(value)) } catch { /* preference only */ }
    }

    /**
     * The page numbers to render, with '…' where the run is broken.
     *
     * The first and last pages and the current one (plus its neighbours) are
     * always reachable: a pager that only ever shows 1 2 3 cannot tell you that
     * you are on page 40 of 60.
     *
     * @param page - zero-based current page.
     * @param pageCount - total pages, at least 1.
     * @returns 1-based page numbers with the string '…' between runs.
     */
    function pageWindow(page, pageCount) {
      const last = pageCount - 1
      const wanted = new Set([0, 1, last - 1, last, page - 1, page, page + 1])
      const indexes = [...wanted]
        .filter(index => index >= 0 && index <= last)
        .sort((a, b) => a - b)
      const out = []
      let previous = -1
      for (const index of indexes) {
        if (previous >= 0 && index - previous > 1) out.push('…')
        out.push(index + 1)
        previous = index
      }
      return out
    }

    /** The list footer: how many rows, which page, and how many per page. */
    function Pager(props) {
      const __ = props.__ || t
      const { page, pageCount, total, pageSize, onPage, onPageSize } = props
      const children = [
        React.createElement('span', {
          key: 'count', style: { ...metaStyle, margin: 0 },
        }, __('settings.count', { n: total })),
      ]
      // With one page there is nothing to navigate; the count and the size
      // selector still belong to the footer, so only the buttons drop out.
      if (pageCount > 1) {
        children.push(React.createElement('span', {
          key: 'pos', style: { ...metaStyle, margin: 0 },
        }, __('settings.pagePosition', { page: page + 1, pages: pageCount })))
        children.push(React.createElement('button', {
          key: 'prev', type: 'button',
          style: page <= 0 ? ghostBtnOffStyle : ghostBtnStyle,
          disabled: page <= 0,
          onClick: () => onPage(page - 1),
        }, __('settings.pagerPrev')))
        pageWindow(page, pageCount).forEach((token, index) => {
          if (token === '…') {
            children.push(React.createElement('span', {
              key: `gap${index}`, style: { ...metaStyle, margin: 0, padding: '0 2px' },
            }, '…'))
            return
          }
          const target = token - 1
          children.push(React.createElement('button', {
            key: `p${token}`, type: 'button',
            'aria-current': target === page ? 'page' : undefined,
            style: target === page ? pagerPageOnStyle : ghostBtnStyle,
            onClick: () => onPage(target),
          }, String(token)))
        })
        children.push(React.createElement('button', {
          key: 'next', type: 'button',
          style: page >= pageCount - 1 ? ghostBtnOffStyle : ghostBtnStyle,
          disabled: page >= pageCount - 1,
          onClick: () => onPage(page + 1),
        }, __('settings.pagerNext')))
      }
      if (total > 0) {
        children.push(React.createElement('span', {
          key: 'sizeLabel', style: { ...metaStyle, margin: 0, marginLeft: 'auto' },
        }, __('settings.pageSize')))
        children.push(React.createElement('select', {
          key: 'size',
          value: String(pageSize),
          style: pageSizeSelectStyle,
          'aria-label': __('settings.pageSize'),
          onChange: (event) => onPageSize(Number(event.target.value)),
        }, PAGE_SIZES.map(size => React.createElement('option', {
          key: size, value: String(size),
        }, String(size)))))
      }
      return React.createElement('div', { style: pagerStyle }, children)
    }

    /**
     * The slice of `rows` the current page shows, clamping a page that the
     * current filter or a deletion has left past the end.
     *
     * @returns { rows, page, pageCount } — `page` is zero-based and always in
     *   range, so callers can feed it straight back to the pager.
     */
    function paginate(rows, page, pageSize) {
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
      const safe = Math.min(Math.max(page, 0), pageCount - 1)
      const start = safe * pageSize
      return { rows: rows.slice(start, start + pageSize), page: safe, pageCount }
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
      reportAutoRemoval(result, translate)
      // A deletion with the bin on feeds the settings page's tab badge, which
      // usually is not even open. Silent: the badge is an invitation, not a
      // report the user is waiting on.
      if (result?.permanent !== true) refreshRecycleCount()
      return result
    }

    /**
     * Say what the sweep did, since it did it without asking.
     *
     * A group vanishing from the sidebar is otherwise unexplained, and the point
     * of the switch is that the user asked for exactly this — so the banner is
     * confirmation, not a warning.
     */
    function reportAutoRemoval(result, translate) {
      const __ = translate || t
      const removed = Array.isArray(result?.removedWorkspaces) ? result.removedWorkspaces : []
      const dirs = Array.isArray(result?.prunedDirs) ? result.prunedDirs : []
      if (removed.length === 0 && dirs.length === 0) return
      // Two facts, one banner. The group is the visible one — a sidebar row
      // disappears. The folder is the one the user only notices later, when
      // the store has collected a shell per project, so it is said too: a
      // silent sweep is indistinguishable from a sweep that did not happen.
      showToast(
        removed.length > 0 && dirs.length > 0
          ? __('settings.emptyAutoBoth', { m: removed.length, d: dirs.length })
          : removed.length > 0
            ? __('settings.emptyAutoRemoved', { n: removed.length })
            : __('settings.emptyAutoDirs', { n: dirs.length }),
        'success',
      )
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

    // --- recycle panel ------------------------------------------------------------

    /**
     * The "?" that sits next to a setting's title, holding its explanation.
     *
     * Hover, not click: reading a row's reasoning is a glance, not a task. The
     * chip lives inside a `<label>`, where a click is forwarded to the checkbox,
     * so it stops the event rather than letting a look at the text flip a switch.
     * Focus does the same as a hover, for the keyboard.
     */
    function InfoTip(props) {
      const __ = props.t || t
      const [open, setOpen] = useState(false)
      const points = Array.isArray(props.items)
        ? props.items.filter((item) => typeof item === 'string' && item.length > 0)
        : []
      if (points.length === 0) return null
      return React.createElement('span', {
        style: tipAnchorStyle,
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
      }, [
        React.createElement('span', {
          key: 'chip',
          tabIndex: 0,
          role: 'button',
          style: open ? tipChipOnStyle : tipChipStyle,
          'aria-label': __('settings.tip'),
          'aria-expanded': open,
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            setOpen((value) => !value)
          },
          onMouseDown: (event) => event.preventDefault(),
        }, '?'),
        open
          ? React.createElement('span', {
              key: 'tip',
              role: 'tooltip',
              style: tipBoxStyle,
              // Selecting text in the bubble must not reach the <label> around
              // the row, or a copy would flip the switch it explains.
              onClick: (event) => { event.preventDefault(); event.stopPropagation() },
            }, React.createElement('ul', { key: 'points', style: tipListStyle },
              points.map((point, index) => React.createElement('li', {
                key: `point:${index}`, style: tipItemStyle,
              }, point))))
          : null,
      ])
    }

    /**
     * One settings row: a title with its "?" on the same line, an optional short
     * note under it, and a checkbox.
     *
     * `tip` carries the long explanation and `hint` only what has to be read
     * without asking — a live count, a warning the row cannot be honoured
     * without.
     */
    function SettingRow(props) {
      const __ = props.t || t
      const { label, hint, tip, checked, disabled, onChange } = props
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
        React.createElement('span', { key: 'text', style: { display: 'block', minWidth: 0 } }, [
          React.createElement('span', { key: 'title', style: settingLabelRowStyle }, [
            React.createElement('span', { key: 'label', style: settingLabelStyle }, label),
            React.createElement(InfoTip, { key: 'tip', items: tip, t: __ }),
          ]),
          hint
            ? React.createElement('span', { key: 'hint', style: settingHintStyle }, hint)
            : null,
        ]),
      ])
    }

    /**
     * The deletion preferences, behind the session list's Configure button.
     *
     * Everything that is a *policy* lives here and nothing that is a *row* does:
     * the switches, the standing warning when the recycle bin is off, and the
     * sweep for whatever the switch did not cover. The empty-group counts are
     * fetched when the dialog opens rather than handed in, so the dialog owns
     * the data it shows and the list behind it does not carry a second,
     * unrelated load on every refresh.
     */
    function SettingsConfigDialog(props) {
      const __ = (props && props.t) || t
      useLocaleRevision()
      const [, forceRender] = useState(0)
      const [cleanup, setCleanup] = useState(null)
      const [pruning, setPruning] = useState(false)
      const [error, setError] = useState(null)
      const open = configDialogState.open

      useEffect(() => configDialogSubscribe(() => forceRender(n => n + 1)), [])
      useEffect(() => settingsSubscribe(() => forceRender(n => n + 1)), [])

      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        setError(null)
        // null means "unknown" (a failed read), so the button stays disabled
        // rather than claiming there is nothing to sweep.
        fetchCleanup()
          .then((counts) => { if (!cancelled) setCleanup(counts) })
          .catch(() => { if (!cancelled) setCleanup(null) })
        return () => { cancelled = true }
      }, [open])

      /**
       * Sweep the groups and the store folders a cleanup left empty.
       *
       * Host-side and idempotent: a folder goes only when it is actually empty
       * and a group only when it has no session left, so pressing it twice is
       * the same as pressing it once.
       */
      const onCleanup = useCallback(async () => {
        if (pruning) return
        setPruning(true)
        setError(null)
        try {
          const removed = await pruneEmpty()
          setCleanup(await fetchCleanup())
          const total = removed.dirs.length + removed.workspaces.length
          showToast(
            total > 0
              ? __('settings.cleaned', { dirs: removed.dirs.length, workspaces: removed.workspaces.length })
              : __('settings.cleanupNothing'),
            'success',
          )
          if (removed.failed.length > 0) {
            setError(__('settings.cleanedPartial', { ok: total, fail: removed.failed.length }))
          }
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setPruning(false)
      }, [pruning, __])

      if (!open) return null

      const binOff = !settingsValue('useRecycleBin')
      // "Unknown" (a failed count) reads as the explanation alone; a known zero
      // says so in words rather than as "0 of 0".
      const cleanupDirs = cleanup === null ? 0 : cleanup.dirs.length
      const cleanupGroups = cleanup === null ? 0 : cleanup.workspaces.length
      const cleanupSummary = cleanup === null
        ? ''
        : cleanupGroups === 0
          ? (cleanupDirs === 0 ? __('settings.cleanupNone') : __('settings.cleanupCountDirs', { n: cleanupDirs }))
          : (cleanupDirs === 0
              ? __('settings.cleanupCountWorkspaces', { n: cleanupGroups })
              : __('settings.cleanupCount', { dirs: cleanupDirs, workspaces: cleanupGroups }))
      const cleanupOff = cleanup === null || (cleanupDirs === 0 && cleanupGroups === 0)

      return React.createElement(Modal, {
        open: true,
        onClose: closeConfigDialog,
        title: __('settings.configTitle'),
        closeLabel: __('settings.close'),
        description: __('settings.configDesc'),
        footer: [React.createElement('button', {
          key: 'close', type: 'button', style: confirmBtnStyle, onClick: closeConfigDialog,
        }, __('settings.close'))],
      }, [
        React.createElement('div', {
          key: 'h', style: { ...settingLabelStyle, fontWeight: 600, marginBottom: 2 },
        }, __('settings.behaviour')),
        // Ordered by how much each one costs to get wrong: whether a deletion
        // can be undone at all, then whether a stray click gets a second look,
        // then the housekeeping that only tidies what the first two left.
        React.createElement(SettingRow, {
          key: 'bin',
          label: __('settings.useRecycleBin'),
          tip: [__('settings.useRecycleBinTip1'), __('settings.useRecycleBinTip2')],
          t: __,
          checked: settingsValue('useRecycleBin'),
          onChange: (value) => updateSetting('useRecycleBin', value),
        }),
        binOff
          ? React.createElement('div', { key: 'binwarn', style: { ...errStyle, marginTop: 0 } },
              __('settings.binOffWarning'))
          : null,
        React.createElement(SettingRow, {
          key: 'confirm',
          label: __('settings.confirmSingleDelete'),
          // With the bin off the switch cannot be honoured — an irreversible
          // delete is always asked about — so the row says why in place, where
          // it cannot be missed, instead of letting the user turn it off and
          // wonder why they were still asked.
          hint: binOff ? __('settings.confirmForcedHint') : undefined,
          tip: binOff
            ? [__('settings.confirmForcedTip')]
            : [__('settings.confirmSingleDeleteTip1'), __('settings.confirmSingleDeleteTip2')],
          t: __,
          checked: settingsValue('confirmSingleDelete'),
          onChange: (value) => updateSetting('confirmSingleDelete', value),
        }),
        React.createElement(SettingRow, {
          key: 'prune',
          label: __('settings.autoPrune'),
          tip: [
            __('settings.autoPruneTip1'),
            __('settings.autoPruneTip2'),
            __('settings.autoPruneTip3'),
            __('settings.autoPruneTip4'),
            __('settings.autoPruneTip5'),
          ],
          t: __,
          checked: settingsValue('autoPruneEmpty'),
          onChange: (value) => updateSetting('autoPruneEmpty', value),
        }),

        // Anything the switch did not cover — groups emptied while it was off,
        // or before it existed — is swept here. The counts stay on the row: the
        // user cannot otherwise tell whether a sweep is worth pressing, and a
        // disabled button with "nothing empty" next to it says exactly that.
        // The reasoning is behind the "?" like every other row's.
        React.createElement('div', { key: 'sep', style: separatorStyle }),
        React.createElement('div', { key: 'cleanup', style: cleanupRowStyle }, [
          React.createElement('span', { key: 'text', style: cleanupTextStyle }, [
            React.createElement('span', { key: 'title', style: settingLabelRowStyle }, [
              React.createElement('span', { key: 'label', style: settingLabelStyle }, __('settings.cleanup')),
              // Above the row: this is the last thing in the dialog, so a bubble
              // hanging below it would open past the dialog's own edge.
              React.createElement(InfoTip, {
                key: 'tip',
                t: __,
                items: [
                  __('settings.cleanupTip1'),
                  __('settings.cleanupTip2'),
                  __('settings.cleanupTip3'),
                ],
              }),
            ]),
            React.createElement('span', { key: 'hint', style: settingHintStyle },
              cleanupSummary.length === 0 ? __('settings.cleanupUnknown') : cleanupSummary),
          ]),
          React.createElement('button', {
            key: 'go',
            type: 'button',
            disabled: pruning || cleanupOff,
            style: pruning || cleanupOff ? ghostBtnOffStyle : cleanupGoStyle,
            onClick: onCleanup,
          }, pruning ? __('settings.cleanupRunning') : __('settings.cleanupRun')),
        ]),

        error ? React.createElement('div', {
          key: 'err', role: 'alert', style: { ...errStyle, whiteSpace: 'pre-wrap' },
        }, error) : null,
      ])
    }

    /**
     * The settings section: one page, two tabs — the session list and the
     * recycle bin.
     *
     * Registered into `settings.section`. The session list is the reason this
     * page exists: before it the only way to delete a session was to find its
     * row in the sidebar and open its menu, once per session. Here the whole
     * store is on screen at once — paged — so a cleanup is
     * tick-tick-tick-delete instead of a hunt.
     *
     * The two lists were briefly two separate settings sections. That gave each
     * one its own nav entry, which read as two features, cost a click to cross,
     * and hid how much was waiting in the bin from the list you delete from. A
     * tab strip is the right size for the distinction: same page, same toolbar
     * vocabulary, one click to cross.
     *
     * Both panes, once visited, stay mounted and the inactive one is hidden with
     * `display: none` rather than unmounted. Two reasons: ticks survive a peek
     * into the bin and back (the whole point of ticking across pages), and the
     * second list is not re-fetched every time the user flicks between tabs. A
     * tab that has never been opened is not mounted at all, so opening the page
     * still costs one request.
     *
     * Everything that is a *policy* — the deletion prefs, the recycle-bin
     * switch, the empty-group sweep — lives behind the Configure button in this
     * strip, not in either pane: those settings govern both lists, and a control
     * that comes and goes with the tab is a control the user has to hunt for.
     */
    function SettingsPanel(props) {
      const __ = (props && props.t) || t
      useLocaleRevision()
      const [tab, setTab] = useState(TAB_SESSIONS)
      // Which panes have been opened at least once. `Set` because it is only
      // ever added to: going back to a tab must not unload the other one.
      const [mounted, setMounted] = useState(() => new Set([TAB_SESSIONS]))
      // Re-render when either list changes length. The numbers themselves live
      // in the module cell, not here: the bin's is needed before its pane is
      // mounted, and is changed by deletions taken in the other pane.
      const [, forceRender] = useState(0)
      const counts = { [TAB_SESSIONS]: tabCounts[TAB_SESSIONS], [TAB_RECYCLE]: tabCounts[TAB_RECYCLE] }

      useEffect(() => {
        const sync = () => forceRender(n => n + 1)
        const off = tabCountSubscribe(sync)
        // Seed the bin's badge without mounting its pane: this is the whole
        // point of the badge, and the pane is not coming until someone clicks.
        refreshRecycleCount()
        return off
      }, [])

      const onTab = useCallback((id) => {
        setTab(id)
        setMounted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
      }, [])

      const onOpenConfig = useCallback(() => { openConfigDialog() }, [])

      const panes = [
        { id: TAB_SESSIONS, pane: SessionsPane },
        { id: TAB_RECYCLE, pane: RecyclePane },
      ]

      return React.createElement('div', { style: { padding: '4px 0 8px' } }, [
        React.createElement(SettingsTabs, {
          key: 'tabs',
          tab,
          counts,
          onTab,
          onOpenConfig,
          __,
        }),
        // Inactive panes stay in the tree, hidden: see the note above. State is
        // kept by `display: none` rather than by lifting it, so a pane that has
        // never been visited still costs nothing.
        ...panes
          .filter(entry => mounted.has(entry.id))
          .map(entry => React.createElement('div', {
            key: entry.id,
            'data-pane': entry.id,
            style: { display: tab === entry.id ? undefined : 'none' },
          }, React.createElement(entry.pane, { __ }))),
      ])
    }

    /**
     * The page's tab strip: one tab per list, plus the Configure button.
     *
     * The badge says how much each list is holding — the one number that
     * decides whether crossing over is worth a click.
     */
    function SettingsTabs(props) {
      const __ = props.__ || t
      const tabs = [
        { id: TAB_SESSIONS, label: __('settings.sessions') },
        { id: TAB_RECYCLE, label: __('settings.recycle') },
      ]
      return React.createElement('div', { style: tabStripStyle }, [
        React.createElement('div', {
          key: 'list',
          role: 'tablist',
          'aria-label': __('settings.tabsLabel'),
          style: tabListStyle,
        }, tabs.map(tab => {
          const count = props.counts?.[tab.id]
          const on = props.tab === tab.id
          return React.createElement('button', {
            key: tab.id,
            type: 'button',
            role: 'tab',
            'data-tab': tab.id,
            'aria-selected': on,
            style: on ? tabOnStyle : tabBaseStyle,
            onClick: () => props.onTab?.(tab.id),
          }, [
            React.createElement('span', { key: 'l' }, tab.label),
            // Missing until the pane has a number to give: a badge reading "0"
            // during the first load would be a claim the client cannot make yet.
            typeof count === 'number'
              ? React.createElement('span', {
                  key: 'n', style: tabBadgeStyle, title: __('settings.tabCount', { n: count }),
                }, String(count))
              : null,
          ])
        })),
        React.createElement('button', {
          key: 'config',
          type: 'button',
          style: { ...ghostBtnStyle, flex: 'none' },
          onClick: () => props.onOpenConfig?.(),
        }, __('settings.config')),
      ])
    }

    /**
     * The session list: tick rows, delete them in one batch.
     *
     * A pane of `SettingsPanel`, not a page of its own — it publishes its row
     * count for the tab strip and owns nothing else about the page.
     */
    function SessionsPane(props) {
      const __ = props.__ || t
      useLocaleRevision()
      const [, forceRender] = useState(0)
      const [sessions, setSessions] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [filter, setFilter] = useState('')
      const [picked, setPicked] = useState(() => new Set())
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      // Paging. `page` is zero-based and the slice is derived (`paginate`), so a
      // filter or a deletion that shortens the list can never strand the panel
      // on an empty page it has no way back from.
      const [page, setPage] = useState(0)
      const [pageSize, setPageSize] = useState(() => readPageSize())

      useEffect(() => settingsSubscribe(() => forceRender(n => n + 1)), [])

      // The tab badge. Published from an effect keyed on the number, not during
      // render: the tab strip is another component's state, and writing it
      // mid-render would be a render-time update. Nothing is published until
      // the first read lands, so the badge cannot flash a "0" it is about to
      // contradict; a later refresh leaves the last known number up while it
      // runs.
      useEffect(() => {
        if (loading) return
        setTabCount(TAB_SESSIONS, sessions.length)
      }, [loading, sessions.length])

      /**
       * Re-read the store's session list.
       *
       * @param quiet - skip the loading flag. A delete is followed by a re-read
       *   and raising `loading` there blanks the list, so the rows visibly
       *   vanish and come back. Only the first load needs that state.
       */
      const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true)
        try {
          const rows = await fetchSessions()
          setSessions(rows)
          // Drop ticks for sessions that are gone. Keeping them would let the
          // delete button act on ids the list no longer shows, and the "n
          // selected" count would stop matching what is on screen.
          const alive = new Set(rows.map(row => row.sessionId))
          setPicked((prev) => {
            const next = new Set([...prev].filter(id => alive.has(id)))
            return next.size === prev.size ? prev : next
          })
          setError(null)
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        // The empty-group/empty-folder counts are NOT read here: they belong to
        // the Configure dialog, which fetches them when it opens. Carrying them
        // on this page meant a second unrelated request on every refresh, for a
        // number the page no longer shows.
        if (!quiet) setLoading(false)
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const needle = filter.trim().toLowerCase()
      const visible = needle.length === 0
        ? sessions
        : sessions.filter(row => (
            String(row.title || '').toLowerCase().includes(needle)
            || String(row.cwd || '').toLowerCase().includes(needle)
            || String(row.sessionId || '').toLowerCase().includes(needle)
          ))

      // Rows go into the list grouped, so the page slices groups rather than the
      // flat list; the heading is re-emitted at the top of every page so a page
      // that lands mid-group still names the group it is in.
      const entries = groupRows(visible)
      const counts = groupCounts(entries)
      const { rows: pageEntries, page: safePage, pageCount } = paginate(entries, page, pageSize)

      // Select acts on the filtered list, not on the page: ticking the box is a
      // statement about "everything here", and a filter is how the user says
      // what "here" means. Narrowing with the filter is the way to select a
      // subset; paging is only how much of it is on screen.
      const allVisiblePicked = visible.length > 0 && visible.every(row => picked.has(row.sessionId))
      const toggleAllVisible = useCallback(() => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (visible.every(row => next.has(row.sessionId))) {
            for (const row of visible) next.delete(row.sessionId)
          } else {
            for (const row of visible) next.add(row.sessionId)
          }
          return next
        })
        setConfirming(false)
      }, [visible])

      const onPageSize = useCallback((size) => {
        setPageSize(size)
        writePageSize(size)
        // Row 51 is not row 51 any more: start over rather than land somewhere
        // arbitrary in the re-sliced list.
        setPage(0)
      }, [])

      const togglePick = useCallback((sessionId) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
        setConfirming(false)
      }, [])

      /**
       * Delete every ticked session.
       *
       * One host round trip for the whole set (see `deleteSessions`), then the
       * three surfaces that showed the dead sessions are told to settle: this
       * list, the sidebar, and the conversation pane when it held one of them.
       * The emptied-workspace offer is raised afterwards, by a tick, so it
       * cannot race the settings modal for the overlay.
       */
      const onDelete = useCallback(async () => {
        const ids = [...picked]
        if (ids.length === 0) return
        setBusy(true)
        setError(null)
        // Which of the batch, if any, is the open conversation. The pane has to
        // be cleared off *that* id — handing `refreshSidebar` the first id in
        // the set would leave the pane showing a session that no longer exists
        // whenever the user was reading the third one.
        const current = currentSessionId()
        const deadCurrent = current !== undefined && ids.some(id => String(id) === String(current))
        try {
          const result = await deleteSessions(ids, !settingsValue('useRecycleBin'))
          setConfirming(false)
          setPicked(new Set())
          await refresh(true)
          refreshSidebar(deadCurrent ? String(current) : ids[0], deadCurrent)
          // Part of this batch may have landed in the bin, which the badge above
          // is counting. The host says per entry where each one went, so the
          // re-read happens only when at least one of them went there.
          if (result.deleted.some(entry => entry.recycled === true)) refreshRecycleCount()
          // One banner, not two: the sweep's own "removed 3 groups" toast would
          // be replaced by the delete count a line later, so the numbers that
          // explain why a sidebar group and a store folder vanished have to
          // ride along with it.
          const extra = sweptSuffix(__, result.removedWorkspaces, result.prunedDirs)
          showToast(
            result.failed.length === 0
              ? __('settings.deletedMany', { n: result.deleted.length, extra })
              : __('settings.deletedManyPartial', { ok: result.deleted.length, fail: result.failed.length, extra }),
            'success',
          )
          // One message block: a session that refused to delete and a workspace
          // that refused to go are both "what survived", and the second must not
          // overwrite the first.
          const problems = result.failed.slice(0, 5).map(f => `${f.sessionId}: ${f.error}`)
          if (result.workspaceRemovalFailed.length > 0) {
            problems.push(__('settings.emptyAutoFailed', { n: result.workspaceRemovalFailed.length }))
          }
          if (problems.length > 0) setError(problems.join('\n'))
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        }
        setBusy(false)
      }, [picked, refresh, __])

      // The Configure button that opens the preferences dialog lives in the tab
      // strip (`SettingsTabs`), not in this pane: the bin switch it holds
      // governs the other tab too.

      const hintStyle = { ...metaStyle, margin: '0 0 8px' }
      const binOff = !settingsValue('useRecycleBin')
      const deleteIds = [...picked]

      return React.createElement('div', null, [
        // No heading: the tab right above this line carries the name, and a
        // title that repeats the tab it sits under is just one more line of
        // furniture between the user and the first row.
        React.createElement('div', { key: 'h', style: { ...hintStyle, paddingTop: 8 } },
          __('settings.sessionsHint')),

        // Toolbar in two rows: the filter gets the whole first line, and the row
        // under it starts with the select-all box — flush left, in the same
        // column as every row's own checkbox.
        React.createElement('div', { key: 'filterRow', style: filterRowStyle },
          React.createElement('input', {
            type: 'text',
            value: filter,
            placeholder: __('settings.filter'),
            // A filter is a new list: page 1 is where the user expects to be,
            // not page 4 of the previous one.
            onChange: (event) => { setFilter(event.target.value); setPage(0) },
            style: filterInputStyle,
            'aria-label': __('settings.filter'),
          })),

        React.createElement('div', { key: 'bar', style: actionRowStyle }, [
          React.createElement(SelectAllBox, {
            key: 'all',
            label: __('settings.selectAll'),
            checked: allVisiblePicked,
            disabled: visible.length === 0 || loading || busy,
            onToggle: toggleAllVisible,
          }),
          React.createElement('button', {
            key: 'refresh',
            type: 'button',
            style: loading || busy ? ghostBtnOffStyle : ghostBtnStyle,
            disabled: loading || busy,
            onClick: () => refresh(),
          }, __('settings.refresh')),
          React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          // Ticks survive a page turn, so the count is the only thing that says
          // how much the delete button is about to remove.
          deleteIds.length > 0
            ? React.createElement('span', {
                key: 'picked', style: { ...metaStyle, margin: 0 },
              }, __('batch.selected', { n: deleteIds.length }))
            : null,
          React.createElement('button', {
            key: 'delete',
            type: 'button',
            style: deleteIds.length === 0 || busy ? dangerOutlineBtnOffStyle : dangerOutlineBtnStyle,
            disabled: deleteIds.length === 0 || busy,
            // Asking is the Configure switch's call, not this button's. With it
            // off the batch goes straight through — the click was the decision.
            onClick: () => { if (needsConfirm()) setConfirming(true); else onDelete() },
          }, busy ? __('settings.deleting') : __('settings.deletePicked')),
        ]),

        // Inline confirmation rather than a second modal: the user is already
        // inside one, and a modal on a modal is what makes a settings page feel
        // like a maze. It renders next to the button that raised it, so the
        // answer stays with the question.
        confirming && deleteIds.length > 0
          ? React.createElement('div', {
              key: 'confirm',
              style: {
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                marginTop: 8, padding: '8px 10px', borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
              },
            }, [
              React.createElement('span', {
                key: 'text',
                style: {
                  flex: '1 1 220px', fontSize: 12, lineHeight: '18px',
                  color: binOff
                    ? 'var(--dsw-alias-state-error-primary, #e5484d)'
                    : 'var(--dsw-alias-label-primary, inherit)',
                },
              }, binOff
                ? __('settings.confirmDeleteManyPermanent', { n: deleteIds.length })
                : __('settings.confirmDeleteMany', { n: deleteIds.length })),
              React.createElement('button', {
                key: 'cancel', type: 'button', style: ghostBtnStyle,
                disabled: busy, onClick: () => setConfirming(false),
              }, __('settings.cancel')),
              React.createElement('button', {
                key: 'go', type: 'button',
                style: busy ? dangerOutlineBtnOffStyle : dangerOutlineBtnStyle,
                disabled: busy, onClick: onDelete,
              }, busy ? __('settings.deleting') : __('settings.deletePicked')),
            ])
          : null,

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, marginTop: 10 } },
              __('settings.loading'))
          : visible.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, marginTop: 10 } },
                sessions.length === 0 ? __('settings.emptySessions') : __('settings.filterEmpty'))
            : React.createElement('div', { key: 'list', style: listBoxStyle },
                pageEntries.flatMap((entry, index) => {
                  const session = entry.row
                  // A heading opens each group, and page 1 of a group is only
                  // "the first row of the page": a page that starts mid-group
                  // still has to say which group these rows belong to.
                  const opensGroup = index === 0 || pageEntries[index - 1].key !== entry.key
                  const nodes = []
                  if (opensGroup) {
                    nodes.push(React.createElement(GroupHeading, {
                      key: `group:${entry.key}:${index}`,
                      groupKey: entry.key,
                      label: entry.label,
                      count: counts.get(entry.key) ?? 0,
                      first: index === 0,
                      __,
                    }))
                  }
                  nodes.push(React.createElement(SessionRow, {
                    key: session.sessionId,
                    session,
                    // The heading already draws the line above the group's first
                    // row; a border there too would draw it twice.
                    border: !opensGroup,
                    busy,
                    picked: picked.has(session.sessionId),
                    onTogglePick: togglePick,
                  }))
                  return nodes
                })),

        // Not rendered while empty: a footer under "nothing to delete" is one
        // more line of furniture.
        loading || visible.length === 0
          ? null
          : React.createElement(Pager, {
              key: 'pager',
              page: safePage,
              pageCount,
              total: visible.length,
              pageSize,
              onPage: setPage,
              onPageSize,
              __,
            }),

        // No doorway to the bin down here any more: it is one tab away, with
        // its own count on the tab, instead of a button the user had to notice.
        error ? React.createElement('div', {
          key: 'err', role: 'alert', style: { ...errStyle, whiteSpace: 'pre-wrap' },
        }, error) : null,
      ])
    }

    /**
     * One row of the session list.
     *
     * Deliberately the same shape as the import page's rows — checkbox, title,
     * meta line — so the two pick-lists in this app read as one pattern rather
     * than two. The row is a `label`, so the whole row is the hit target and
     * only the checkbox has to be aimed at.
     *
     * The id is the title's fallback, not its companion: a uuid under every row
     * is noise, and the host already resolves the title from the same
     * projection cache the sidebar uses.
     */
    function SessionRow(props) {
      const { session, busy } = props
      const title = (session.title && String(session.title).trim()) || session.sessionId
      const cwd = typeof session.cwd === 'string' ? session.cwd : ''
      const when = formatWhen(session.updatedAt)
      const meta = [shortPath(cwd), when].filter(part => part.length > 0).join(' · ')

      return React.createElement('label', {
        style: props.border === true ? rowBorderStyle : rowBaseStyle,
      }, [
        React.createElement('input', {
          key: 'box',
          type: 'checkbox',
          checked: props.picked === true,
          disabled: busy === true,
          onChange: () => props.onTogglePick?.(session.sessionId),
          style: { marginTop: 3, flex: 'none' },
        }),
        React.createElement('span', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          React.createElement('span', { key: 't', style: rowTitleStyle, title }, title),
          React.createElement('span', { key: 'm', style: rowMetaStyle, title: cwd || meta }, meta),
        ]),
      ])
    }

    /**
     * The recycle bin: the second tab of the same settings page.
     *
     * Same pick-list shape as the session list: tick rows, then restore or purge
     * them. Entries are sessions this plugin deleted and still holds payloads
     * for; an entry whose payload went missing is listed anyway, because a row
     * that cannot be restored is better news than one that silently vanished.
     */
    function RecyclePane(props) {
      const __ = props.__ || t
      useLocaleRevision()
      const [entries, setEntries] = useState([])
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [filter, setFilter] = useState('')
      const [picked, setPicked] = useState(() => new Set())
      const [busy, setBusy] = useState(false)
      // Same paging as the session list, and the same local page size: two
      // pick-lists that page differently would read as two plugins.
      const [page, setPage] = useState(0)
      const [pageSize, setPageSize] = useState(() => readPageSize())

      // The tab badge, same contract as the session list's — except that this
      // pane is not what usually puts the first number there: the strip seeds it
      // when the page opens, so the count is up before anyone clicks over. The
      // pane takes over from the moment it reads its own list.
      useEffect(() => {
        if (loading) return
        setTabCount(TAB_RECYCLE, entries.length)
      }, [loading, entries.length])

      /**
       * Re-read the recycle list.
       *
       * @param quiet - skip the loading flag, for the same reason as the session
       *   list: a restore is followed by a re-read and raising `loading` there
       *   blanks the list the user is watching.
       */
      const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true)
        try {
          const rows = await fetchRecycled()
          setEntries(rows)
          const alive = new Set(rows.map(row => row.sessionId))
          setPicked((prev) => {
            const next = new Set([...prev].filter(id => alive.has(id)))
            return next.size === prev.size ? prev : next
          })
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
        try {
          const restored = await restoreSession(sessionId)
          // The log is back on disk; start the sidebar pull in parallel with the
          // recycle re-read, since the two are independent and the sidebar is
          // what the user is watching.
          const listed = resyncSessionList(sessionId)
          await refresh(true)
          await resyncWorkspaces()
          await listed
          // Reported as a banner: this page can be scrolled away from the row,
          // and feedback the user has to hunt for is not feedback.
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

      const togglePick = useCallback((sessionId) => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }, [])

      /**
       * Restore every ticked entry.
       *
       * Order does not matter for a restore, so they run in sequence and report
       * one banner at the end; the sidebar and the grouping are settled once
       * afterwards rather than per entry, so the list stops moving exactly once
       * no matter how many rows were chosen.
       */
      const onRestorePicked = useCallback(async () => {
        const ids = [...picked]
        if (ids.length === 0) return
        setBusy(true)
        setError(null)
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
        setBusy(false)
        setPicked(new Set())
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
       * Permanently delete the ticked entries.
       *
       * The second half of the bin: an entry nobody wants back can be dropped
       * for good, which also frees the payload on disk. Irreversible, so it is
       * always a deliberate action and never a side effect of anything else.
       */
      const onPurge = useCallback(async () => {
        const ids = [...picked]
        if (ids.length === 0) return
        setBusy(true)
        setError(null)
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
        setBusy(false)
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

      const needle = filter.trim().toLowerCase()
      const visible = needle.length === 0
        ? entries
        : entries.filter(entry => (
            String(entry.title || entry.label || '').toLowerCase().includes(needle)
            || String(entry.cwd || '').toLowerCase().includes(needle)
            || String(entry.sessionId || '').toLowerCase().includes(needle)
          ))

      // Same grouping as the session list: an entry whose session still names a
      // workspace shows it under that group's bar, and everything else lands in
      // one 未分组 block at the end.
      const grouped = groupRows(visible)
      const counts = groupCounts(grouped)
      const { rows: pageEntries, page: safePage, pageCount } = paginate(grouped, page, pageSize)

      // Same contract as the session list's box: the whole filtered list, not
      // the page in front of the user.
      const allVisiblePicked = visible.length > 0 && visible.every(entry => picked.has(entry.sessionId))
      const toggleAllVisible = useCallback(() => {
        setPicked((prev) => {
          const next = new Set(prev)
          if (visible.every(entry => next.has(entry.sessionId))) {
            for (const entry of visible) next.delete(entry.sessionId)
          } else {
            for (const entry of visible) next.add(entry.sessionId)
          }
          return next
        })
      }, [visible])

      const onPageSize = useCallback((size) => {
        setPageSize(size)
        writePageSize(size)
        setPage(0)
      }, [])

      const selected = picked.size

      return React.createElement('div', null, [
        // The bin's own hint sits where the session list's does; the tab above
        // already carries the name, so neither pane repeats its title here.
        React.createElement('div', { key: 'hint', style: { ...metaStyle, margin: '0 0 8px', paddingTop: 8 } },
          __('settings.recycleHint')),

        // Two rows, same as the session list's: filter on its own line, then the
        // select-all box at the far left of the action row.
        React.createElement('div', { key: 'filterRow', style: filterRowStyle },
          React.createElement('input', {
            type: 'text',
            value: filter,
            placeholder: __('settings.filter'),
            onChange: (event) => { setFilter(event.target.value); setPage(0) },
            style: filterInputStyle,
            'aria-label': __('settings.filter'),
          })),

        React.createElement('div', { key: 'bar', style: actionRowStyle }, [
          React.createElement(SelectAllBox, {
            key: 'all',
            label: __('settings.selectAll'),
            checked: allVisiblePicked,
            disabled: visible.length === 0 || loading || busy,
            onToggle: toggleAllVisible,
          }),
          React.createElement('span', {
            key: 'count', style: { ...metaStyle, margin: 0 },
          }, __('batch.selected', { n: selected })),
          React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          React.createElement('button', {
            key: 'refresh',
            type: 'button',
            style: loading || busy ? ghostBtnOffStyle : ghostBtnStyle,
            disabled: loading || busy,
            onClick: () => refresh(),
          }, __('settings.refresh')),
          React.createElement('button', {
            key: 'restore',
            type: 'button',
            style: selected === 0 || busy ? ghostBtnOffStyle : ghostBtnStyle,
            disabled: selected === 0 || busy,
            onClick: onRestorePicked,
          }, busy ? __('dialog.busy') : __('settings.restorePicked')),
          React.createElement('button', {
            key: 'purge',
            type: 'button',
            style: selected === 0 || busy ? dangerOutlineBtnOffStyle : dangerOutlineBtnStyle,
            disabled: selected === 0 || busy,
            onClick: onPurge,
          }, busy ? __('dialog.busy') : __('settings.purge')),
        ]),

        loading
          ? React.createElement('div', { key: 'loading', style: { ...metaStyle, marginTop: 10 } },
              __('settings.loading'))
          : visible.length === 0
            ? React.createElement('div', { key: 'none', style: { ...metaStyle, marginTop: 10 } },
                entries.length === 0 ? __('settings.empty') : __('settings.filterEmpty'))
            : React.createElement('div', { key: 'list', style: listBoxStyle },
                pageEntries.flatMap((item, index) => {
                  const entry = item.row
                  const opensGroup = index === 0 || pageEntries[index - 1].key !== item.key
                  const nodes = []
                  if (opensGroup) {
                    nodes.push(React.createElement(GroupHeading, {
                      key: `group:${item.key}:${index}`,
                      groupKey: item.key,
                      label: item.label,
                      count: counts.get(item.key) ?? 0,
                      first: index === 0,
                      __,
                    }))
                  }
                  nodes.push(React.createElement(RecycleRow, {
                    key: entry.sessionId,
                    entry,
                    border: !opensGroup,
                    busy: busyId === entry.sessionId,
                    onRestore,
                    picked: picked.has(entry.sessionId),
                    onTogglePick: togglePick,
                    __,
                  }))
                  return nodes
                })),

        loading || visible.length === 0
          ? null
          : React.createElement(Pager, {
              key: 'pager',
              page: safePage,
              pageCount,
              total: visible.length,
              pageSize,
              onPage: setPage,
              onPageSize,
              __,
            }),

        error ? React.createElement('div', {
          key: 'err', role: 'alert', style: { ...errStyle, whiteSpace: 'pre-wrap' },
        }, error) : null,
      ])
    }

    /**
     * One recycle-bin row.
     *
     * A bare uuid tells the user nothing about whether to restore it, so the
     * row leads with what the session was — its title, or the project folder
     * when it never had one — and keeps the id as tertiary detail. Same row
     * shape as the session list, so the two lists are scannable the same way.
     */
    function RecycleRow(props) {
      const { entry, busy, onRestore, __ } = props

      const label = (entry.label && String(entry.label).trim())
        || (entry.title && String(entry.title).trim())
        || __('settings.untitled')
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
      const when = formatWhen(entry.at)
      const meta = [shortPath(cwd), when].filter(part => part.length > 0).join(' · ')

      // A `div`, not a `label`: this row contains a button, and a button inside
      // a label also fires the label's own activation, so clicking "Restore"
      // would tick the checkbox on its way past.
      return React.createElement('div', {
        style: props.border === true ? rowBorderStyle : rowBaseStyle,
      }, [
        React.createElement('input', {
          key: 'pick',
          type: 'checkbox',
          checked: props.picked === true,
          disabled: busy === true,
          onChange: () => props.onTogglePick?.(entry.sessionId),
          style: { marginTop: 3, flex: 'none' },
          'aria-label': __('settings.selectOne'),
        }),
        React.createElement('span', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          React.createElement('span', { key: 't', style: rowTitleStyle, title: entry.title || label }, label),
          React.createElement('span', { key: 'm', style: rowMetaStyle, title: cwd || meta }, meta),
          React.createElement('span', {
            key: 'i',
            style: {
              ...rowMetaStyle,
              fontSize: 11, lineHeight: '16px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            },
            title: entry.sessionId,
          }, entry.sessionId),
        ]),
        React.createElement('button', {
          key: 'restore',
          type: 'button',
          disabled: busy === true,
          onClick: () => onRestore(entry.sessionId),
          style: {
            ...ghostBtnStyle,
            flex: 'none', marginTop: 2,
            ...(busy === true ? { opacity: 0.5, cursor: 'default' } : {}),
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

      // The deletion preferences, opened from the session list's header. On the
      // overlay rather than inside the panel so it paints over the settings
      // modal, which is what contains the button that opens it.
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: CONFIG_ID,
        order: 110,
        ...(localeSvc ? { locale: NS } : {}),
      }, SettingsConfigDialog))

      // One settings page for both lists — the session list and the recycle bin
      // are tabs inside it, not two nav entries. `SettingsPanel` is the shell
      // that paints the strip and mounts whichever pane has been opened.
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
