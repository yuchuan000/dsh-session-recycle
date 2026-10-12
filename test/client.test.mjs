/**
 * In-process harness for the session-recycle CLIENT half.
 *
 * The browser bundle is a classic script that registers a factory through
 * `window.__ModuleLoader__.load`, so the file itself is importable from node
 * once that global exists. Everything the factory needs — react, the UI
 * primitives, the plugin context — is injected through stubs here.
 *
 * `react` is a purpose-built stand-in rather than the real package: the plugin
 * only ever calls createElement/useState/useEffect/useCallback, and the point of
 * these tests is the components' own logic (which rows appear, what a click
 * does), not React's reconciler. The harness renders a tree, runs the effects,
 * and lets a test click the result — enough to catch a wrong route, a lost
 * session id, or a panel that renders nothing.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')
const HOST_SRC = readFileSync(join(here, '..', 'src', 'index.js'), 'utf8')

const results = []
async function check(label, fn) {
  try { await fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

// --- the module loader -------------------------------------------------------

let registration = null
// Events the plugin dispatches on `window`. The stub records them instead of
// delivering them: the dialogs themselves are rendered directly by the tests, so
// what needs asserting is whether an event was raised at all (the "ask vs auto"
// policy decides that).
const windowEvents = []
globalThis.window = {
  __ModuleLoader__: { load(definition) { registration = definition } },
  setTimeout, clearTimeout,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  dispatchEvent(event) { windowEvents.push(event); return true },
  addEventListener() {},
  removeEventListener() {},
}
/** Every event of one type dispatched since the last drain. */
const drainEvents = (type) => {
  const mine = windowEvents.filter(event => event.type === type)
  for (const event of mine) windowEvents.splice(windowEvents.indexOf(event), 1)
  return mine
}
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail } }
globalThis.MutationObserver = class MutationObserver { observe() {} disconnect() {} }
globalThis.document = {
  body: { appendChild() {}, removeChild() {}, contains: () => false },
  documentElement: { appendChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  addEventListener() {},
  removeEventListener() {},
}
await import(pathToFileURL(join(here, '..', 'src', 'client.js')).href)

// --- the minimal React runtime ----------------------------------------------

const FRAGMENT = Symbol.for('react.fragment')

function createRuntime() {
  const state = {
    current: null,
    instances: new Map(),
    effects: [],
  }

  const sameDeps = (a, b) => {
    if (!a || !b || a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  function createElement(type, props, ...children) {
    const flat = []
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child)
      else flat.push(child)
    }
    return { type, props: props ?? {}, children: flat }
  }

  function useState(initial) {
    const inst = state.current
    const slot = inst.cursor++
    if (inst.hooks.length <= slot) inst.hooks[slot] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      inst.hooks[slot] = typeof next === 'function' ? next(inst.hooks[slot]) : next
    }
    return [inst.hooks[slot], set]
  }

  function useCallback(fn, deps) {
    const inst = state.current
    const slot = inst.cursor++
    const held = inst.hooks[slot]
    if (held && sameDeps(held.deps, deps)) return held.fn
    inst.hooks[slot] = { fn, deps }
    return fn
  }

  function useEffect(fn, deps) {
    const inst = state.current
    const slot = inst.cursor++
    const held = inst.hooks[slot]
    // Standard semantics: an effect re-runs only when its deps change. Running
    // it on every pass would be a harness artifact with visible consequences —
    // the panel's "reload the list" effect resets `error` to null, which would
    // erase a deletion failure before the test could see it.
    if (held && sameDeps(held.deps, deps)) return
    inst.hooks[slot] = { deps, cleanup: held?.cleanup }
    state.effects.push(() => { inst.hooks[slot].cleanup = fn() })
  }

  const React = { createElement, Fragment: FRAGMENT, useState, useEffect, useCallback }

  function renderComponent(fn, props, key) {
    const inst = state.instances.get(key) ?? { hooks: [], cursor: 0 }
    state.instances.set(key, inst)
    const previous = state.current
    state.current = inst
    inst.cursor = 0
    try {
      return fn(props)
    } finally {
      state.current = previous
    }
  }

  function expand(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { tag: '#text', text: String(node) }
    if (Array.isArray(node)) {
      return node.map((child, index) => expand(child, `${path}.${index}`)).filter(Boolean)
    }
    if (typeof node.type === 'function') {
      // React hands a component its children as `props.children`; the stub
      // primitives (Modal) read exactly that, so dropping them here would make
      // every dialog in these tests render as null.
      const props = node.children.length > 0 ? { ...node.props, children: node.children } : node.props
      const rendered = renderComponent(node.type, props, `${path}<${node.type.name || 'anon'}>`)
      return expand(rendered, `${path}<${node.type.name || 'anon'}>`)
    }
    if (node.type === FRAGMENT) {
      return node.children.map((child, index) => expand(child, `${path}.${index}`)).filter(Boolean)
    }
    return {
      tag: node.type,
      props: node.props,
      children: node.children.map((child, index) => expand(child, `${path}.${index}`)).filter(Boolean),
    }
  }

  const runtime = { React, state }

  /**
   * Render `fn` and settle: render, run the queued effects, drain microtasks,
   * repeat. Bounded, so a component that renders-then-loads-forever fails the
   * test instead of hanging it.
   *
   * `key` names the hook slot the instance owns. Two different top-level
   * components (the settings panel and the overlay dialog) must not share one,
   * or their useState slots interleave and each reads the other's values.
   */
  runtime.render = async (fn, props = {}, passes = 4, key = 'root') => {
    let tree = null
    for (let pass = 0; pass < passes; pass += 1) {
      state.effects.length = 0
      tree = expand(renderComponent(fn, props, key), 'root')
      const pending = state.effects.splice(0)
      for (const run of pending) run()
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    }
    return tree
  }

  /** Re-settle after a click, without resetting hook state. */
  runtime.settle = async (fn, props = {}, passes = 3, key = 'root') => runtime.render(fn, props, passes, key)

  return runtime
}

// --- tree helpers ------------------------------------------------------------

function nodes(tree, predicate, out = []) {
  if (!tree) return out
  if (Array.isArray(tree)) { for (const child of tree) nodes(child, predicate, out); return out }
  if (tree.tag === '#text') return out
  if (predicate(tree)) out.push(tree)
  for (const child of tree.children) nodes(child, predicate, out)
  return out
}

function textOf(tree) {
  if (!tree) return ''
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (tree.tag === '#text') return tree.text
  return tree.children.map(textOf).join('')
}

const byTag = (tree, tag) => nodes(tree, (node) => node.tag === tag)
const buttons = (tree) => byTag(tree, 'button')
const buttonExact = (tree, text) => buttons(tree).find((node) => textOf(node).trim() === text)
const buttonByText = (tree, text) => buttonExact(tree, text) ?? buttons(tree).find((node) => textOf(node).includes(text))
/** Why a click may have gone to the wrong place: print what was reachable. */
const reachable = (tree) => buttons(tree).map((node) => textOf(node).trim()).join('|')
/**
 * The confirm bar's own "delete" button.
 *
 * Once the bar is up there are two buttons carrying that label — the toolbar's
 * (which only raises the bar) and the bar's (which acts) — so the tests must
 * name the one they mean rather than take whichever came first in the tree.
 */
const confirmDeleteButton = (tree) => buttons(tree).filter((node) => textOf(node).includes('删除所选')).pop()
const filterInput = (tree) => nodes(tree, (node) => node.tag === 'input' && node.props.type === 'text')[0]
/**
 * The scrollable pick-list box, found by its one distinctive style value.
 *
 * Scoping to it matters because checkboxes are not exclusive to the list: the
 * Configure dialog carries one per preference, so a tree-wide query would count
 * those too.
 */
const listBox = (tree) => nodes(tree, (node) => node.props?.style?.maxHeight === 340)[0]
const boxes = (tree) => {
  const box = listBox(tree)
  if (!box) return []
  return nodes(box, (node) => node.tag === 'input' && node.props.type === 'checkbox')
}
/**
 * The checkbox of the preference row whose text contains `label`.
 *
 * Preferences live in the Configure dialog, so this is called with that tree —
 * matching on the row's own copy is the only way to name the right one, since
 * every row carries an identical input.
 */
const prefBox = (tree, label) => {
  const row = nodes(tree, (node) => node.tag === 'label' && textOf(node).includes(label))[0]
  return row && nodes(row, (node) => node.tag === 'input' && node.props.type === 'checkbox')[0]
}
/**
 * The page-size selector in a list's footer.
 *
 * There is only ever one per page, and it is the only `select` in the tree, so
 * tag alone names it.
 */
const sizeSelect = (tree) => byTag(tree, 'select')[0]
/** The text of whatever banner the overlay currently holds. */
const toastText = async (client) => {
  const host = client.slots.find((entry) => entry.options.id === 'session-recycle-toast')
  if (!host) return ''
  return textOf(await client.runtime.render(host.component))
}

/**
 * The Configure dialog's tree, rendered the way the overlay slot renders it.
 *
 * It is a separate overlay entry driven by module-level state, not part of the
 * page's tree, so a test has to render it on its own — and with its own hook
 * slot, or its useState calls would be answered by the page's slots.
 *
 * @returns the tree, or null while the dialog is closed (it renders nothing).
 */
const configTree = async (client) => {
  const host = client.slots.find((entry) => entry.options.id === 'session-recycle-config')
  if (!host) return null
  return client.runtime.render(host.component, {}, 3, 'config')
}

/** The page tree of the session-list section. */
const pageTree = async (client) => {
  const panel = sectionById(client, 'session-recycle-settings').component
  return client.runtime.render(panel)
}

/**
 * Render the session page, press its Configure button, and return both trees.
 *
 * @returns { page, config } — `config` is null when the button did not open a
 *   dialog, which is exactly what the tests assert against.
 */
const openConfig = async (client) => {
  const panel = sectionById(client, 'session-recycle-settings').component
  const page = await client.runtime.render(panel)
  const button = buttonByText(page, '配置')
  if (!button) return { page, config: null, panel }
  button.props.onClick()
  return { page: await client.runtime.settle(panel), config: await configTree(client), panel }
}

/** `count` sessions with predictable titles, for the pager tests. */
const manySessions = (count) => Array.from({ length: count }, (_, index) => ({
  sessionId: `session-${index + 1}`,
  title: `会话 ${index + 1}`,
  cwd: 'd:/work/proj',
  updatedAt: 1791600000000 + index,
}))

// --- the plugin context ------------------------------------------------------

/**
 * Build a fresh client instance: a new factory call, so the module's own
 * closure state (settings, service handles) starts clean per test.
 */
function makeClient({
  sessions = [],
  recycled = [],
  settings = {},
  shell,
  uiSession,
  uiWorkspace,
  // Empty session folders and empty workspace groups the host reports, and what
  // a sweep removes from them.
  emptyDirs = [],
  emptyGroups = [],
  prunedDirs = null,
  prunedGroups = null,
  // What the host answers a batch delete with. `emptiedWorkspaces` is what the
  // batch left empty; `removedWorkspaces` is the subset the `autoPruneEmpty`
  // switch then removed.
  emptiedWorkspaces = [],
  removedWorkspaces = [],
  workspaceRemovalFailed = [],
} = {}) {
  const runtime = createRuntime()
  const primitives = {
    IconTrashOutline16: function IconTrashOutline16() { return null },
    // Both halves of the real primitive, so a test can click the dialog's own
    // buttons: the body arrives as props.children and the buttons as
    // props.footer. The card around them is not what is under test.
    Modal: function Modal(props) {
      return runtime.React.createElement('div', { 'data-modal': props.title ?? '' }, [
        props.children ?? null,
        props.footer ?? null,
      ])
    },
    // Renders the banner's text so a test can read what was announced; the real
    // primitive draws a floating card around the same string.
    Toast: function Toast(props) { return props.text ?? null },
  }
  const moduleExports = registration.factory((id) => {
    if (id === 'react') return runtime.React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require(${String(id)})`)
  })

  const calls = []
  const slots = []
  const dictionaries = {}
  // The host's settings document, mutated by POSTs exactly as the real one is:
  // answering a save with the values from before the write would make the
  // panel's optimistic update look like a revert.
  const document = { ...settings }
  const locale = {
    translate: () => undefined,
    register(ns, dict) { dictionaries[ns] = dict; return () => {} },
    subscribe() { return () => {} },
    getSnapshot() { return { revision: 0 } },
  }

  const ctx = {
    get(name) {
      if (name === 'locale') return locale
      if (name === 'uiSession') return uiSession
      if (name === 'uiWorkspace') return uiWorkspace
      return undefined
    },
    inject(_deps, fn) { fn({ locale }) },
    on() {},
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    slots: {
      entries(key) {
        if (key !== 'sidebar.settings') return []
        if (shell === undefined) return []
        return [{ options: { id: 'general' }, store: shell }]
      },
      inject(_name, fn) { return fn() },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
  }

  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    const body = options.body === undefined ? undefined : JSON.parse(options.body)
    calls.push({ path, method: options.method ?? 'GET', body })
    const respond = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (path === '/__session-recycle/settings') {
      if ((options.method ?? 'GET') === 'POST') Object.assign(document, body ?? {})
      return respond({ ok: true, settings: { ...document }, defaults: {} })
    }
    if (path === '/__session-recycle/list') return respond({ ok: true, sessions })
    if (path === '/__session-recycle/recycled') return respond({ ok: true, entries: recycled })
    if (path === '/__session-recycle/empty-dirs') {
      return respond({
        ok: true,
        dirs: emptyDirs,
        count: emptyDirs.length,
        workspaces: emptyGroups,
        workspaceCount: emptyGroups.length,
      })
    }
    if (path === '/__session-recycle/prune-empty') {
      const removed = prunedDirs ?? emptyDirs
      const removedGroups = prunedGroups ?? emptyGroups
      emptyDirs = []
      emptyGroups = []
      return respond({
        ok: true,
        removed,
        count: removed.length,
        removedWorkspaces: removedGroups,
        workspaceCount: removedGroups.length,
        failed: [],
      })
    }
    if (path === '/__session-recycle/delete-many') {
      return respond({
        ok: true,
        deleted: (body?.sessionIds ?? []).map((sessionId) => ({ sessionId, recycled: true, permanent: false })),
        failed: [],
        emptiedWorkspaces,
        removedWorkspaces,
        workspaceRemovalFailed,
      })
    }
    if (path === '/__session-recycle/restore') return respond({ ok: true, sessionId: body?.sessionId })
    if (path === '/__session-recycle/purge') return respond({ ok: true, sessionId: body?.sessionId })
    if (path === '/__session-recycle/workspaces') return respond({ ok: true, workspaces: [] })
    return respond({ ok: false, error: `unexpected route ${path}` })
  }

  try { delete window.__sessionRecycleInstalled } catch { /* ignore */ }
  moduleExports.apply(ctx)
  return { runtime, moduleExports, slots, calls, dictionaries }
}

// --- the fixtures ------------------------------------------------------------

const SESSIONS = [
  { sessionId: 'session-1', title: '重构结算模块', cwd: 'd:/work/settle', updatedAt: 1791600000000 },
  { sessionId: 'session-2', title: '', cwd: 'd:/work/scratch', updatedAt: 1791500000000 },
]

const RECYCLED = [
  { sessionId: 'session-9', title: '旧会话', cwd: 'd:/work/gone', at: 1791400000000, label: '旧会话' },
]

const sectionById = (client, id) => client.slots.find((entry) => entry.options.id === id)

// --- 1. registration ---------------------------------------------------------

await check('注册两个设置分区：会话列表 + 回收站', () => {
  const client = makeClient()
  const main = sectionById(client, 'session-recycle-settings')
  const bin = sectionById(client, 'session-recycle-recycled')
  assert.ok(main, '缺少主设置分区')
  assert.ok(bin, '缺少回收站分区')
  assert.equal(typeof main.component, 'function')
  assert.equal(typeof bin.component, 'function')
  assert.notEqual(main.component, bin.component, '两个分区必须是不同组件')
  assert.ok(main.options.order < bin.options.order, '回收站排在主页面之后')
  assert.equal(main.options.name, 'settings.section')
})

await check('注册会话头部按钮、删除弹窗、配置弹窗与 toast（空工作区询问已并入设置页）', () => {
  const client = makeClient()
  const ids = client.slots.map((entry) => entry.options.id)
  assert.ok(ids.includes('session-recycle-header'))
  assert.ok(ids.includes('session-recycle-dialog'))
  assert.ok(ids.includes('session-recycle-config'), '配置弹窗应当注册在 overlay 槽上')
  assert.ok(ids.includes('session-recycle-toast'))
  assert.ok(!ids.includes('session-recycle-empty-workspace'), '询问弹窗应当随三态策略一起删掉')
})

// --- 2. dictionaries ---------------------------------------------------------

await check('字典：zh/en 键集合完全一致', () => {
  const client = makeClient()
  const dict = client.dictionaries['session-recycle']
  assert.ok(dict, '未注册 session-recycle 字典')
  assert.deepEqual(
    Object.keys(dict.zh).sort(),
    Object.keys(dict.en).sort(),
    '中英文键集合不一致',
  )
})

await check('字典：没有重复键（后写的会静默覆盖前一个）', () => {
  for (const lang of ['zh', 'en']) {
    const seen = new Map()
    const re = new RegExp(`'([a-zA-Z0-9._]+)':`, 'g')
    const block = CLIENT_SRC.slice(
      CLIENT_SRC.indexOf(`const ${lang} = {`),
      CLIENT_SRC.indexOf(`\n    }`, CLIENT_SRC.indexOf(`const ${lang} = {`)),
    )
    let match
    while ((match = re.exec(block)) !== null) {
      seen.set(match[1], (seen.get(match[1]) ?? 0) + 1)
    }
    const dupes = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key)
    assert.deepEqual(dupes, [], `${lang} 里重复的键`)
  }
})

await check('字典：源码里用到的每个键都有中英文案', () => {
  const client = makeClient()
  const dict = client.dictionaries['session-recycle']
  const used = new Set()
  const re = /(?:\bt|__)\(\s*'([a-zA-Z0-9._]+)'/g
  let match
  while ((match = re.exec(CLIENT_SRC)) !== null) used.add(match[1])
  // `t(\`settings.mode.${mode}Hint\`)` style keys are built at runtime.
  used.delete('settings.mode.')
  const missing = [...used].filter((key) => dict.zh[key] === undefined || dict.en[key] === undefined)
  assert.deepEqual(missing, [], '缺少文案的键')
  assert.ok(used.size > 30, `只找到 ${used.size} 个键，抽取大概失效了`)
})

await check('字典：写死的回收站分区标签与主分区不同', () => {
  const client = makeClient()
  const dict = client.dictionaries['session-recycle']
  assert.notEqual(dict.zh['settings.nav'], dict.zh['settings.recycleNav'])
  assert.notEqual(dict.en['settings.nav'], dict.en['settings.recycleNav'])
})

// --- 3. the session list -----------------------------------------------------

await check('会话列表渲染每一行的标题与目录', async () => {
  const client = makeClient({ sessions: SESSIONS })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  const text = textOf(tree)
  assert.ok(text.includes('重构结算模块'), '缺少第一行标题')
  assert.ok(text.includes('settle'), '缺少第一行的目录尾段')
  assert.ok(text.includes('scratch'), '缺少第二行的目录尾段')
  assert.ok(text.includes('共 2 个会话'), `缺少计数行：${text}`)
  assert.equal(boxes(tree).length, 2, '每行一个复选框')
})

await check('无标题的会话以 id 兜底，不渲染空行', async () => {
  const client = makeClient({ sessions: SESSIONS })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  const text = textOf(tree)
  assert.ok(text.includes('session-2'), '无标题行应当回落显示 id')
})

await check('筛选框按标题、目录与 id 过滤', async () => {
  const client = makeClient({ sessions: SESSIONS })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  assert.equal(boxes(tree).length, 2)

  filterInput(tree).props.onChange({ target: { value: 'scratch' } })
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).length, 1, '筛选后应只剩一行')

  const input = filterInput(tree)
  input.props.onChange({ target: { value: 'session-1' } })
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).length, 1)
  assert.ok(textOf(tree).includes('重构结算模块'))

  filterInput(tree).props.onChange({ target: { value: '不存在的东西' } })
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).length, 0)
  assert.ok(textOf(tree).includes('没有匹配的会话'), `应当说明是筛选无结果：${textOf(tree)}`)
})

await check('空会话库给出专门的空状态', async () => {
  const client = makeClient({ sessions: [] })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  assert.ok(textOf(tree).includes('没有可删除的会话'))
})

await check('主页面带有会话列表与打开回收站的入口', async () => {
  const client = makeClient({ sessions: SESSIONS, recycled: RECYCLED })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  const text = textOf(tree)
  assert.ok(text.includes('会话列表'), '缺少会话列表标题')
  assert.ok(text.includes('打开回收站'), '缺少回收站入口按钮')
  assert.ok(text.includes('回收站：1 条待处理'), `入口应报出待处理条数：${text}`)
  // The recycle list itself must NOT be on this page any more.
  assert.ok(!text.includes('旧会话'), '回收站条目不该出现在主设置页')
})

await check('主页面只剩列表：设置项收进右上角「配置」按钮', async () => {
  const client = makeClient({ sessions: SESSIONS })
  const { page, config } = await openConfig(client)
  const text = textOf(page)
  // The page is a list. Every preference lives in the dialog.
  assert.ok(!text.includes('删除单个会话时先确认'), `页面上不该再有设置项：${text}`)
  assert.ok(!text.includes('空分组与空目录'), `页面上不该再有清理行：${text}`)
  assert.equal(prefBox(page, '删除'), undefined, '页面上不该有设置行的复选框')
  assert.ok(config, '「配置」按钮应当打开配置弹窗')
  const dialogText = textOf(config)
  assert.ok(dialogText.includes('删除单个会话时先确认'), `弹窗缺少开关：${dialogText}`)
  assert.ok(dialogText.includes('删除后自动清理空分组与空目录'), `弹窗缺少开关：${dialogText}`)
  assert.ok(dialogText.includes('删除时移入回收站'), `弹窗缺少开关：${dialogText}`)
  assert.ok(dialogText.includes('空分组与空目录'), `弹窗缺少清理行：${dialogText}`)
  // The dialog is the overlay entry, so its tree is not the page's.
  assert.ok(!text.includes('删除设置'), '弹窗内容不该落在页面树里')
})

// --- 4. batch delete ---------------------------------------------------------

await check('勾选后删除：先内联确认，再发一次 delete-many', async () => {
  const client = makeClient({ sessions: SESSIONS })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  const confirmBefore = buttonByText(tree, '删除所选')
  assert.ok(confirmBefore.props.disabled, '没勾选时删除按钮应当禁用')

  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  assert.equal(buttonByText(tree, '删除所选').props.disabled, false, '勾选后应当可点')

  // First click only asks.
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.ok(textOf(tree).includes('确定删除这 2 个会话吗'), `缺少确认文案：${textOf(tree)}`)
  assert.equal(client.calls.filter(call => call.path === '/__session-recycle/delete-many').length, 0,
    '确认之前不得发请求')

  // Confirming sends exactly one batch request with both ids.
  buttonExact(tree, '取消').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.ok(!textOf(tree).includes('确定删除这'), `取消应当收起确认条，当前按钮：${reachable(tree)}`)

  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  await confirmDeleteButton(tree).props.onClick()
  tree = await client.runtime.settle(panel)

  const posted = client.calls.filter(call => call.path === '/__session-recycle/delete-many')
  assert.equal(posted.length, 1, `应当只发一次批量删除，实际 ${posted.length}；请求：${client.calls.map(c => c.path).join(', ')}`)
  assert.equal(posted[0].method, 'POST')
  assert.deepEqual(posted[0].body.sessionIds.sort(), ['session-1', 'session-2'])
  assert.equal(posted[0].body.permanent, false, '回收站开启时不是永久删除')
})

await check('取消全选与全选在筛选范围内生效', async () => {
  const client = makeClient({ sessions: SESSIONS })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  filterInput(tree).props.onChange({ target: { value: 'scratch' } })
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '全选').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree)[0].props.checked, true, '筛选后的可见行应当被勾上')

  buttonByText(tree, '取消全选').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree)[0].props.checked, false)
})

await check('回收站关闭时确认文案改为永久删除的警告', async () => {
  const client = makeClient({ sessions: SESSIONS, settings: { useRecycleBin: false } })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.ok(textOf(tree).includes('永久删除'), `缺少永久删除警告：${textOf(tree)}`)
})

// --- 5. the recycle section --------------------------------------------------

await check('回收站页面渲染条目、还原按钮与批量操作', async () => {
  const client = makeClient({ recycled: RECYCLED })
  const panel = sectionById(client, 'session-recycle-recycled').component
  const tree = await client.runtime.render(panel)
  const text = textOf(tree)
  assert.ok(text.includes('旧会话'), '缺少回收站条目标题')
  assert.ok(text.includes('session-9'), '缺少条目 id')
  assert.ok(buttonByText(tree, '还原'), '缺少行内还原按钮')
  assert.ok(buttonByText(tree, '恢复所选'), '缺少批量恢复按钮')
  assert.ok(buttonByText(tree, '彻底删除'), '缺少批量彻底删除按钮')
})

await check('回收站为空时给出空状态', async () => {
  const client = makeClient({ recycled: [] })
  const panel = sectionById(client, 'session-recycle-recycled').component
  const tree = await client.runtime.render(panel)
  assert.ok(textOf(tree).includes('回收站里没有可还原的会话'))
})

await check('点行内还原只还原那一行', async () => {
  const client = makeClient({ recycled: RECYCLED })
  const panel = sectionById(client, 'session-recycle-recycled').component
  let tree = await client.runtime.render(panel)
  await buttonByText(tree, '还原').props.onClick()
  tree = await client.runtime.settle(panel)
  const restored = client.calls.filter(call => call.path === '/__session-recycle/restore')
  assert.equal(restored.length, 1)
  assert.equal(restored[0].body.sessionId, 'session-9')
})

await check('批量彻底删除逐条走 purge', async () => {
  const client = makeClient({ recycled: [{ ...RECYCLED[0] }, { ...RECYCLED[0], sessionId: 'session-10', title: '另一个' }] })
  const panel = sectionById(client, 'session-recycle-recycled').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  await buttonByText(tree, '彻底删除').props.onClick()
  tree = await client.runtime.settle(panel)
  const purged = client.calls.filter(call => call.path === '/__session-recycle/purge')
  assert.equal(purged.length, 2)
  assert.deepEqual(purged.map(call => call.body.sessionId).sort(), ['session-10', 'session-9'])
})

// --- 6. cross-section navigation --------------------------------------------

await check('打开回收站调用外壳的 openSection，指向回收站分区', async () => {
  const opened = []
  const shell = { create: () => ({ actions: { openSection: (id) => opened.push(id) } }) }
  const client = makeClient({ sessions: SESSIONS, shell })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  buttonByText(tree, '打开回收站').props.onClick()
  assert.deepEqual(opened, ['session-recycle-recycled'])
})

await check('外壳没有 openSection 时回落到导航点击而非抛错', async () => {
  const shell = { create: () => ({ actions: {} }) }
  const client = makeClient({ sessions: SESSIONS, shell })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  assert.doesNotThrow(() => buttonByText(tree, '打开回收站').props.onClick())
})

await check('批量删除时，清空的是当前打开的那个会话而不是列表第一条', async () => {
  const cleared = []
  const pane = { key: 'session-3' }
  const uiSession = { current: { get value() { return { key: pane.key } } } }
  const uiWorkspace = { clearMain() { cleared.push(pane.key); pane.key = undefined; return true } }
  const three = [
    { sessionId: 'session-1', title: '一', cwd: 'd:/a', updatedAt: 1 },
    { sessionId: 'session-2', title: '二', cwd: 'd:/b', updatedAt: 2 },
    { sessionId: 'session-3', title: '三', cwd: 'd:/c', updatedAt: 3 },
  ]
  const client = makeClient({ sessions: three, uiSession, uiWorkspace })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  await confirmDeleteButton(tree).props.onClick()
  tree = await client.runtime.settle(panel)
  assert.ok(cleared.length > 0, '打开中的会话被删掉时应当清空右侧面板')
  assert.equal(cleared[0], 'session-3', '要清的是当前打开的那个，不是列表第一条')
})

// --- 6b. the empty-sweep switch ----------------------------------------------

await check('「删除后自动清理」是配置弹窗里的复选框，勾上写回 host', async () => {
  const client = makeClient({})
  const { config } = await openConfig(client)
  assert.ok(config, '配置按钮没有打开弹窗')

  const box = prefBox(config, '删除后自动清理空分组与空目录')
  assert.ok(box, `配置弹窗应当有这一行：${textOf(config).slice(0, 300)}`)
  assert.equal(box.props.checked, false, '默认不勾选：不替用户删分组')

  box.props.onChange({ target: { checked: true } })
  const after = await configTree(client)
  const posted = client.calls.filter(call => call.path === '/__session-recycle/settings' && call.method === 'POST')
  assert.deepEqual(posted.map(call => call.body), [{ autoPruneEmpty: true }])
  assert.equal(prefBox(after, '删除后自动清理空分组与空目录').props.checked, true, '保存后勾选态应当跟着走')
})

await check('host 说勾选时配置弹窗也勾上', async () => {
  const client = makeClient({ settings: { autoPruneEmpty: true } })
  const { config } = await openConfig(client)
  assert.equal(prefBox(config, '删除后自动清理').props.checked, true)
})

await check('host 只返回旧字段时视为不勾选', async () => {
  // An older host never removed a group silently unless told to, so an unknown
  // shape must read as "off" rather than as a licence to delete.
  const client = makeClient({ settings: { emptyWorkspaceAction: 'ask' } })
  const { config } = await openConfig(client)
  assert.equal(prefBox(config, '删除后自动清理').props.checked, false)
})

await check('配置弹窗关掉后不再渲染', async () => {
  const client = makeClient({})
  const { config } = await openConfig(client)
  assert.ok(config, '应当先能打开')
  const close = buttonByText(config, '关闭')
  assert.ok(close, `弹窗应有关闭按钮：${reachable(config)}`)
  close.props.onClick()
  assert.equal(await configTree(client), null, '关闭后弹窗应当渲染为空')
})

await check('开关打开时，删完只报数、不再弹空工作区询问', async () => {
  drainEvents('dsh-session-recycle:empty-workspace')
  const client = makeClient({
    sessions: SESSIONS,
    settings: { autoPruneEmpty: true },
    removedWorkspaces: [{ workspaceId: 'ws-1', title: 'proj', path: 'd:/work/proj', prunedDirs: [] }],
  })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  await confirmDeleteButton(tree).props.onClick()
  tree = await client.runtime.settle(panel)
  // The old prompt was deferred by a tick, so give one before asserting absence.
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(drainEvents('dsh-session-recycle:empty-workspace'), [], '不该再弹询问')
  const banner = await toastText(client)
  assert.ok(banner.includes('已删除 2 个会话'), `应当报出删了几条：${banner}`)
  assert.ok(banner.includes('并移除 1 个空分组'), `同一条横幅里报出分组数：${banner}`)
})

await check('开关关闭时，删除不触碰任何分组', async () => {
  const client = makeClient({
    sessions: SESSIONS,
    settings: { autoPruneEmpty: false },
    emptiedWorkspaces: [{ workspaceId: 'ws-1', title: 'proj', path: 'd:/work/proj' }],
  })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  await confirmDeleteButton(tree).props.onClick()
  tree = await client.runtime.settle(panel)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(drainEvents('dsh-session-recycle:empty-workspace'), [], '不该弹询问')
  const banner = await toastText(client)
  assert.ok(!banner.includes('空分组'), `没有移除分组就不该提分组：${banner}`)
})

await check('工作区移除失败时，提示不会被会话失败的文案顶掉', async () => {
  const client = makeClient({
    sessions: SESSIONS,
    settings: { autoPruneEmpty: true },
    workspaceRemovalFailed: [{ workspaceId: 'ws-1', error: 'no such workspace', code: 'NOT_FOUND' }],
  })
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === '/__session-recycle/delete-many') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          deleted: [],
          failed: [{ sessionId: 'session-1', error: '磁盘只读', code: 'REMOVE_FAILED' }],
          emptiedWorkspaces: [],
          removedWorkspaces: [],
          workspaceRemovalFailed: [{ workspaceId: 'ws-1', error: 'no such workspace', code: 'NOT_FOUND' }],
        }),
      }
    }
    return original(url, options)
  }
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  await confirmDeleteButton(tree).props.onClick()
  tree = await client.runtime.settle(panel)
  globalThis.fetch = original
  const text = textOf(tree)
  assert.ok(text.includes('磁盘只读'), `会话失败原因应当保留：${text.slice(-300)}`)
  assert.ok(text.includes('1 个空工作区移除失败'), `工作区失败原因应当保留：${text.slice(-300)}`)
})

// --- 6c. empty groups and empty folders --------------------------------------

await check('空分组与空目录行在配置弹窗里显示数量并可一键清理', async () => {
  const client = makeClient({
    emptyDirs: ['--d-a--', '--d-b--'],
    emptyGroups: [{ workspaceId: 'ws-1', title: 'proj', path: 'd:/work/proj' }],
  })
  const { config } = await openConfig(client)
  assert.ok(config, '配置按钮没有打开弹窗')

  assert.ok(
    textOf(config).includes('当前有 2 个空目录、1 个空分组'),
    `应当同时显示两个数量：${textOf(config).slice(0, 300)}`,
  )
  const clean = buttonExact(config, '清理')
  assert.ok(clean, `缺少清理按钮：${reachable(config)}`)
  assert.equal(clean.props.disabled, false)

  await clean.props.onClick()
  const after = await configTree(client)
  const posted = client.calls.filter(call => call.path === '/__session-recycle/prune-empty')
  assert.equal(posted.length, 1, '应当只发一次清理请求')
  assert.equal(posted[0].method, 'POST')
  assert.ok(textOf(after).includes('没有空分组或空目录'), `清理后应当归零：${textOf(after).slice(0, 300)}`)
  const banner = await toastText(client)
  assert.ok(banner.includes('2 个空目录'), `应当报出清掉的数量：${banner}`)
  assert.ok(banner.includes('1 个空分组'), `应当报出清掉的分组数：${banner}`)
})

await check('只有空目录时按目录口径报数', async () => {
  const client = makeClient({ emptyDirs: ['--d-a--'] })
  const { config } = await openConfig(client)
  assert.ok(textOf(config).includes('当前有 1 个空目录，没有空分组'), textOf(config).slice(0, 300))
})

await check('只有空分组时按分组口径报数', async () => {
  const client = makeClient({ emptyGroups: [{ workspaceId: 'ws-1', title: 'proj', path: 'd:/work/proj' }] })
  const { config } = await openConfig(client)
  assert.ok(textOf(config).includes('当前有 1 个空分组，没有空目录'), textOf(config).slice(0, 300))
})

await check('都没有时清理按钮禁用', async () => {
  const client = makeClient({})
  const { config } = await openConfig(client)
  assert.ok(textOf(config).includes('没有空分组或空目录'))
  assert.equal(buttonExact(config, '清理').props.disabled, true)
})

// --- 6d. paging ---------------------------------------------------------------

/**
 * The titles of the rows currently on screen, in order.
 *
 * The row title is the only span inside the list carrying this exact style pair
 * (the meta line below it is a size smaller), which is enough to name it
 * without reaching into the component.
 */
const rowTitles = (tree) => {
  const box = listBox(tree)
  if (!box) return []
  return nodes(box, (node) => node.props?.style?.fontSize === 13 && node.props?.style?.whiteSpace === 'nowrap')
    .map(textOf)
}

const countCalls = (client, path) => client.calls.filter(call => call.path === path).length

await check('会话列表分页：默认每页 50 行，翻页换一批', async () => {
  const client = makeClient({ sessions: manySessions(60) })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  assert.equal(boxes(tree).length, 50, '默认每页 50 行')
  assert.equal(rowTitles(tree)[0], '会话 1')
  assert.ok(textOf(tree).includes('共 60 个会话'), textOf(tree).slice(0, 200))
  assert.ok(textOf(tree).includes('第 1/2 页'), `缺少页码位置：${textOf(tree).slice(0, 200)}`)

  await buttonByText(tree, '下一页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).length, 10, '第二页只剩 10 行')
  assert.equal(rowTitles(tree)[0], '会话 51', '第二页应当从第 51 行开始')
  assert.ok(textOf(tree).includes('第 2/2 页'), textOf(tree).slice(0, 200))
})

await check('页码按钮直达对应页，末页按钮按页数收窄', async () => {
  const client = makeClient({ sessions: manySessions(120) })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  assert.ok(textOf(tree).includes('第 1/3 页'), textOf(tree).slice(0, 200))
  /** The page buttons carry exactly the page number as their label. */
  await buttonExact(tree, '3').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(rowTitles(tree)[0], '会话 101', '直接跳末页')
  assert.equal(boxes(tree).length, 20, '120 条 → 末页 20 行')

  await buttonByText(tree, '上一页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(rowTitles(tree)[0], '会话 51')
})

await check('每页条数可切换，并且回到第一页', async () => {
  const client = makeClient({ sessions: manySessions(60) })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  await buttonByText(tree, '下一页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(rowTitles(tree)[0], '会话 51')

  sizeSelect(tree).props.onChange({ target: { value: '20' } })
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).length, 20, '每页 20 行')
  assert.equal(rowTitles(tree)[0], '会话 1', '换页大小后回到第一页')
  assert.ok(textOf(tree).includes('第 1/3 页'), textOf(tree).slice(0, 200))
})

await check('全选只作用于当前页，已勾选跨页保留', async () => {
  const client = makeClient({ sessions: manySessions(60) })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  buttonByText(tree, '全选本页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).filter(box => box.props.checked).length, 50, '整页被勾上')
  assert.ok(textOf(tree).includes('已选 50 条'), `应当报出已选条数：${textOf(tree).slice(0, 300)}`)

  await buttonByText(tree, '下一页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).filter(box => box.props.checked).length, 0, '第二页没被连带勾上')
  assert.ok(textOf(tree).includes('已选 50 条'), '勾选跨页保留，计数不重置')
})

await check('筛选后回到第一页', async () => {
  const client = makeClient({ sessions: manySessions(60) })
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)

  await buttonByText(tree, '下一页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(rowTitles(tree)[0], '会话 51')

  filterInput(tree).props.onChange({ target: { value: '会话 1' } })
  tree = await client.runtime.settle(panel)
  // 会话 1 / 10 … 19 — eleven rows, one page.
  assert.equal(boxes(tree).length, 11, `筛选结果应为 11 行：${textOf(tree).slice(0, 200)}`)
  assert.equal(rowTitles(tree)[0], '会话 1', '筛选后应当从第一页开始')
})

await check('空列表不渲染分页器', async () => {
  const client = makeClient({ sessions: [] })
  const panel = sectionById(client, 'session-recycle-settings').component
  const tree = await client.runtime.render(panel)
  assert.ok(textOf(tree).includes('没有可删除的会话'))
  assert.equal(sizeSelect(tree), undefined, '没有行时不该有分页器')
})

await check('回收站列表用同一套分页', async () => {
  const recycled = Array.from({ length: 55 }, (_, index) => ({
    sessionId: `session-${index + 1}`,
    title: `旧会话 ${index + 1}`,
    cwd: 'd:/work/gone',
    at: 1791400000000 + index,
    label: `旧会话 ${index + 1}`,
  }))
  const client = makeClient({ recycled })
  const panel = sectionById(client, 'session-recycle-recycled').component
  let tree = await client.runtime.render(panel)
  assert.equal(boxes(tree).length, 50)
  assert.ok(textOf(tree).includes('共 55 个会话'), textOf(tree).slice(0, 200))

  await buttonByText(tree, '下一页').props.onClick()
  tree = await client.runtime.settle(panel)
  assert.equal(boxes(tree).length, 5)
})

await check('空分组计数只在打开配置弹窗时才去读', async () => {
  const client = makeClient({})
  await pageTree(client)
  assert.equal(countCalls(client, '/__session-recycle/empty-dirs'), 0, '页面上不再需要这份计数')
  await openConfig(client)
  assert.equal(countCalls(client, '/__session-recycle/empty-dirs'), 1, '打开配置时读一次')
})

// --- 7. client/host contract -------------------------------------------------

await check('客户端请求的每条路由在 host 端都注册了', () => {
  const routes = new Set()
  const re = /['"`](\/__session-recycle\/[a-z-]+)['"`]/g
  let match
  while ((match = re.exec(CLIENT_SRC)) !== null) routes.add(match[1])
  assert.ok(routes.size >= 8, `只抽出 ${routes.size} 条路由，抽取大概失效了`)
  for (const route of routes) {
    assert.ok(HOST_SRC.includes(`path: '${route}'`), `host 端没有注册 ${route}`)
  }
})

await check('删除失败时把前五条错误摆在页面上', async () => {
  const client = makeClient({ sessions: SESSIONS })
  // Make delete-many answer with a failure.
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === '/__session-recycle/delete-many') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted: [], failed: [{ sessionId: 'session-1', error: '磁盘只读', code: 'REMOVE_FAILED' }], emptiedWorkspaces: [] }),
      }
    }
    return original(url, options)
  }
  const panel = sectionById(client, 'session-recycle-settings').component
  let tree = await client.runtime.render(panel)
  for (const box of boxes(tree)) box.props.onChange()
  tree = await client.runtime.settle(panel)
  buttonByText(tree, '删除所选').props.onClick()
  tree = await client.runtime.settle(panel)
  await confirmDeleteButton(tree).props.onClick()
  tree = await client.runtime.settle(panel)
  globalThis.fetch = original
  assert.ok(textOf(tree).includes('磁盘只读'), `失败原因应当显示；请求：${client.calls.map(c => c.path).join(', ')}；文案：${textOf(tree)}`)
})

for (const result of results) {
  if (result.ok) process.stdout.write(`  ok  ${result.label}\n`)
  else process.stdout.write(`  FAIL ${result.label}\n      ${result.error?.stack ?? result.error}\n`)
}
const failed = results.filter((result) => !result.ok).length
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`)
process.exit(failed > 0 ? 1 : 0)
