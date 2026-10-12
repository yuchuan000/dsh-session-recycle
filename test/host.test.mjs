/**
 * In-process harness for the session-recycle HOST half.
 * Drives deleteSession / restoreRecycled / purgeRecycled against a sandbox
 * DSH_HOME with a fake cordis ctx, so bugs are demonstrable without the app.
 *
 * Requires `@deepseek-ai/dsh-tools` to resolve from the repo root (the host
 * half imports `defineTool` from it). On a machine with DSH installed that
 * package lives under ~/.dsh/profiles/node_modules; point a junction or
 * NODE_PATH-style resolution at it, or `pnpm install` the peer dependency.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
let mod
try {
  mod = await import(pathToFileURL(join(here, '..', 'src', 'index.js')).href)
} catch (error) {
  process.stderr.write(`无法加载 src/index.js：${error.message}\n请先让 @deepseek-ai/dsh-tools 可解析（见文件头注释）。\n`)
  process.exit(1)
}

const results = []
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

/** Same as `check`, for a body that has to await a route. */
async function acheck(label, fn) {
  try { await fn(); results.push({ label, ok: true }) } catch (error) { results.push({ label, ok: false, error }) }
}

function zstdFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** Build a session dir under <root>/<slug>/<name> with a header-only log. */
function makeSession(root, slug, id, cwd) {
  const dir = join(root, slug, id)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id, createdAt: 1791600000000, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([zstdFrame(`${header}\n`)]))
  return dir
}

/** A ctx.get surface covering what index.js touches. */
function makeCtx(root) {
  const workspaces = new Map()
  const sessionsTable = new Map()
  const emitted = []
  // The live workspace registry. Off by default, because most sections exercise
  // the storage-table path (which is what the plugin falls back to); the ones
  // that remove a workspace turn it on so `removeWorkspace` has something to
  // call.
  const registry = {
    enabled: false,
    get: (id) => {
      const record = workspaces.get(id) ?? workspaces.get(String(id))
      if (record === undefined || record === null) return undefined
      return { ...record, attachSession: async () => {} }
    },
    list: () => [...workspaces.values()].map(record => ({ id: String(record.id), title: record.title, path: record.path })),
    delete: async (id) => workspaces.delete(id) || workspaces.delete(String(id)),
  }
  return {
    emitted,
    workspaces,
    sessionsTable,
    registry,
    get(name) {
      if (name === 'storageDomain') {
        return {
          get(unit) {
            if (unit === 'session_projcache') return { table: () => ({ get: (id) => sessionsTable.get(id), delete: async (id) => sessionsTable.delete(id) }) }
            if (unit === 'workspace') return {
              table: () => ({
                entries: () => workspaces.entries(),
                get: (id) => workspaces.get(id) ?? workspaces.get(String(id)),
                put: async (id, rec) => workspaces.set(id, rec),
              }),
            }
            return undefined
          },
        }
      }
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'workspaceRegistry') return registry.enabled ? registry : undefined
      return undefined
    },
    emit(event, payload) { emitted.push([event, payload]) },
  }
}

// --- 1. delete moves payload into the plugin store and sweeps indexes ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const slug = '--d-work-proj--'
  const cwd = 'd:/work/proj'
  makeSession(sessionsRoot, slug, 'session-11111111-2222-3333-4444-555555555555', cwd)
  const ctx = makeCtx(root)
  ctx.workspaces.set('ws-1', { id: 'ws-1', title: 'proj', path: cwd, sessionIds: ['session-11111111-2222-3333-4444-555555555555'] })
  const sid = 'session-11111111-2222-3333-4444-555555555555'
  const result = await mod.deleteSession(ctx, sid)
  check('delete 报告 recycled', () => {
    assert.equal(result.dirsRemoved, 1)
    assert.equal(result.recycled[0].how, 'plugin-store')
  })
  check('delete 后会话目录离开 sessions 根', () => {
    assert.equal(existsSync(join(sessionsRoot, slug, sid)), false)
  })
  check('delete 后工作区 sessionIds 清空', () => {
    assert.deepEqual(ctx.workspaces.get('ws-1').sessionIds, [])
  })
  check('delete 发出 session/disposed 通知', () => {
    assert.ok(ctx.emitted.some(([e]) => e === 'session/disposed'))
    assert.ok(ctx.emitted.some(([e]) => e === 'api-session/removed'))
  })
  check('recycle manifest 记录条目', () => {
    const entries = mod.listRecycled()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sessionId, sid)
  })
  // --- restore ---
  const restored = await mod.restoreRecycled(ctx, sid)
  check('restore 放回原 slug 目录', () => {
    assert.ok(existsSync(join(sessionsRoot, slug, sid)), `dest=${restored.restoredTo}`)
  })
  // --- purge ---
  await mod.deleteSession(ctx, sid)
  const purged = await mod.purgeRecycled(sid)
  check('purge 删除 payload 与条目', () => {
    assert.equal(purged.sessionId, sid)
    assert.equal(existsSync(purged.payload), false)
    assert.equal(mod.listRecycled().length, 0)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 2. bare uuid (imported wb- sessions use prefixed ids) ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test2-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const slug = '--d-work-imported--'
  const cwd = 'd:/work/imported'
  const id = 'wb-99999999-8888-7777-6666-555555555555'
  makeSession(sessionsRoot, slug, id, cwd)
  const ctx = makeCtx(root)
  const result = await mod.deleteSession(ctx, id)
  check('wb- 前缀会话可删除', () => {
    assert.equal(result.dirsRemoved, 1)
    assert.equal(existsSync(join(sessionsRoot, slug, id)), false)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 3. purge refuses a payload outside the plugin store ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test3-'))
  process.env.DSH_HOME = root
  // Plant a manifest entry whose payload points at an innocent directory.
  mkdirSync(join(root, 'session-recycle-store'), { recursive: true })
  mkdirSync(join(root, 'precious'), { recursive: true })
  writeFileSync(join(root, 'precious', 'keep.txt'), 'do not delete')
  const evil = {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    at: Date.now(),
    how: 'plugin-store',
    payload: join(root, 'precious'),
    restoreTo: '',
    title: '',
    slug: '',
    cwd: '',
    workspaceId: '',
    workspaceTitle: '',
  }
  writeFileSync(join(root, 'session-recycle-bin.json'), JSON.stringify({ entries: [evil] }, null, 2))
  let threw = null
  try { await mod.purgeRecycled('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') } catch (error) { threw = error }
  check('purge 拒绝回收站之外的 payload', () => {
    assert.ok(threw, '应当抛错')
    assert.equal(existsSync(join(root, 'precious', 'keep.txt')), true, 'payload 必须原样保留')
  })
  let restoreThrew = null
  try { await mod.restoreRecycled(makeCtx(root), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') } catch (error) { restoreThrew = error }
  check('restore 拒绝回收站之外的 payload', () => {
    assert.ok(restoreThrew, '应当抛错')
    assert.equal(existsSync(join(root, 'precious', 'keep.txt')), true, '目录不得被搬进 sessions 根')
  })
  check('listRecycled 不列出回收站之外的条目', () => {
    assert.equal(mod.listRecycled().length, 0)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 4. settings round trip ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test4-'))
  process.env.DSH_HOME = root
  check('默认设置', () => {
    assert.deepEqual({ ...mod.DEFAULT_SETTINGS }, {
      confirmSingleDelete: true,
      autoPruneEmpty: false,
      useRecycleBin: true,
    })
  })
  check('默认不清理空分组/空目录', () => {
    // Off unless the user asks: an emptied group is a project they may still
    // work in, and the default must not remove it for them.
    assert.equal(mod.DEFAULT_SETTINGS.autoPruneEmpty, false)
  })

  const { routes } = mountRoutes(root)
  const write = (body) => callRoute(routes, '/__session-recycle/settings', makeRequest('POST', body))
  const read = async () => (await callRoute(routes, '/__session-recycle/settings', makeRequest('GET'))).json().settings

  await write({ autoPruneEmpty: true })
  const on = await read()
  check('autoPruneEmpty 可写入并读回', () => assert.equal(on.autoPruneEmpty, true))

  await write({ autoPruneEmpty: 'nonsense' })
  const afterJunk = await read()
  check('非布尔值被忽略，保留原值', () => assert.equal(afterJunk.autoPruneEmpty, true))

  // The three-way string, one value at a time. Only `auto` ever asked for a
  // silent sweep; `ask` and `keep` both leave the group alone now that the
  // prompt is gone.
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ emptyWorkspaceAction: 'auto' }))
  check('旧三态 auto 迁移成勾选', async () => {})
  assert.equal((await read()).autoPruneEmpty, true)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ emptyWorkspaceAction: 'ask' }))
  check('旧三态 ask 迁移成不勾选', async () => {})
  assert.equal((await read()).autoPruneEmpty, false)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ emptyWorkspaceAction: 'keep' }))
  assert.equal((await read()).autoPruneEmpty, false)

  // The oldest spelling: a switch about being *asked*. Neither answer asked for
  // a removal, so both land on off.
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ askRemoveEmptyWorkspace: false }))
  check('旧布尔 false 迁移成不勾选', async () => {})
  assert.equal((await read()).autoPruneEmpty, false)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ askRemoveEmptyWorkspace: true }))
  check('旧布尔 true 也迁移成不勾选', async () => {})
  assert.equal((await read()).autoPruneEmpty, false)

  await write({ emptyWorkspaceAction: 'auto' })
  check('旧三态键仍可写入（缓存中的旧客户端）', async () => {})
  assert.equal((await read()).autoPruneEmpty, true)
  await write({ askRemoveEmptyWorkspace: true })
  check('旧布尔键仍可写入（缓存中的旧客户端）', async () => {})
  assert.equal((await read()).autoPruneEmpty, false)

  rmSync(root, { recursive: true, force: true })
}

// --- 5. HTTP routes: /list and /delete-many -------------------------------
//
// These two back the settings page's pick-list. They are exercised through the
// real registration path (`apply` -> webServer.register) rather than by calling
// the handlers directly, so a route that stopped being registered fails here.

/**
 * A request object shaped like the one node hands a route handler: a method,
 * headers, and an async-iterable body.
 */
function makeRequest(method, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers: { host: '127.0.0.1:5173', ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

/** A response object that records what the handler wrote. */
function makeResponse() {
  const res = { status: 0, headers: undefined, body: '' }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (text) => { res.body = typeof text === 'string' ? text : '' }
  res.json = () => JSON.parse(res.body)
  return res
}

/**
 * Run `apply` against a fake ctx and hand back the registered routes.
 *
 * @returns { routes, ctx } — routes is keyed by path.
 */
function mountRoutes(root) {
  const routes = new Map()
  const ctx = makeCtx(root)
  ctx.tools = { register() { return () => {} } }
  ctx.effect = (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} }
  ctx.inject = () => {}
  ctx.get = ((base) => (name) => {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      }
    }
    return base(name)
  })(ctx.get.bind(ctx))
  mod.apply(ctx)
  return { routes, ctx }
}

async function callRoute(routes, path, request) {
  const response = makeResponse()
  await routes.get(path).handler(request, response)
  return response
}

// --- 5a. /list carries the display fields the pick-list renders ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5a-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const slug = '--d-work-proj--'
  const cwd = 'd:/work/proj'
  const sid = 'session-aaaa1111-2222-3333-4444-555555555555'
  makeSession(sessionsRoot, slug, sid, cwd)

  const { routes, ctx } = mountRoutes(root)
  check('/list 已注册', () => assert.ok(routes.has('/__session-recycle/list')))

  // Title comes from the projection cache; without a row it must degrade to ''
  // rather than throwing or inventing one.
  const res = await callRoute(routes, '/__session-recycle/list', makeRequest('GET'))
  const payload = res.json()
  check('/list 返回会话并带上 cwd 与时间', () => {
    assert.equal(res.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.sessions.length, 1)
    assert.equal(payload.sessions[0].sessionId, sid)
    assert.equal(payload.sessions[0].cwd, cwd, 'cwd 来自会话头')
    assert.equal(payload.sessions[0].title, '', '无投影缓存时标题为空串')
    assert.equal(typeof payload.sessions[0].updatedAt, 'number')
  })

  // With a projection-cache row the row leads with its title; the fake ctx's
  // table reads straight out of the Map the harness owns, so seeding it here is
  // the same thing the sidebar would see.
  const seeded = await callRoute(routes, '/__session-recycle/list', makeRequest('GET'))
  ctx.sessionsTable.set(sid, { rows: { title: { val: '调试记录' } } })
  check('/list 在投影缓存缺失时仍可用', () => {
    assert.equal(seeded.json().sessions[0].sessionId, sid)
  })
  const titled = await callRoute(routes, '/__session-recycle/list', makeRequest('GET'))
  check('/list 从投影缓存取标题', () => {
    assert.equal(titled.json().sessions[0].title, '调试记录')
  })

  const bad = await callRoute(routes, '/__session-recycle/list', makeRequest('POST'))
  check('/list 拒绝非 GET', () => assert.equal(bad.status, 405))

  const crossSite = await callRoute(routes, '/__session-recycle/list', makeRequest('GET', undefined, { 'sec-fetch-site': 'cross-site' }))
  check('/list 拒绝跨站请求', () => assert.equal(crossSite.status, 403))

  rmSync(root, { recursive: true, force: true })
}

// --- 5b. /delete-many is registered and validates its body ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5b-'))
  process.env.DSH_HOME = root
  const { routes } = mountRoutes(root)
  check('/delete-many 已注册', () => assert.ok(routes.has('/__session-recycle/delete-many')))

  const notPost = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('GET'))
  check('/delete-many 拒绝非 POST', () => assert.equal(notPost.status, 405))

  const cross = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: ['x'] }, { 'sec-fetch-site': 'cross-site' }))
  check('/delete-many 拒绝跨站', () => assert.equal(cross.status, 403))

  const missing = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', {}))
  check('/delete-many 缺少 sessionIds 报 400', () => {
    assert.equal(missing.status, 400)
    assert.match(missing.json().error, /sessionIds/)
  })

  const empty = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: [] }))
  check('/delete-many 空数组报 400', () => assert.equal(empty.status, 400))

  const notArray = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: 'abc' }))
  check('/delete-many 非数组报 400', () => assert.equal(notArray.status, 400))

  const badPermanent = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: ['a'], permanent: 'yes' }))
  check('/delete-many permanent 非布尔报 400', () => assert.equal(badPermanent.status, 400))

  const huge = await callRoute(routes, '/__session-recycle/delete-many',
    makeRequest('POST', { sessionIds: Array.from({ length: 5001 }, (_, i) => `session-${i}`) }))
  check('/delete-many 超过 5000 条报 400', () => {
    assert.equal(huge.status, 400)
    assert.match(huge.json().error, /too many ids/)
  })

  rmSync(root, { recursive: true, force: true })
}

// --- 5c. /delete-many deletes the set and aggregates the emptied workspaces ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5c-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const slug = '--d-work-many--'
  const cwd = 'd:/work/many'
  const ids = [
    'session-bbbb1111-2222-3333-4444-555555555551',
    'session-bbbb1111-2222-3333-4444-555555555552',
    'session-bbbb1111-2222-3333-4444-555555555553',
  ]
  for (const id of ids) makeSession(sessionsRoot, slug, id, cwd)

  const { routes, ctx } = mountRoutes(root)
  ctx.workspaces.set('ws-many', { id: 'ws-many', title: 'many', path: cwd, sessionIds: [...ids] })

  const res = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: ids }))
  const payload = res.json()
  check('/delete-many 逐条报告删除结果', () => {
    assert.equal(res.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.deleted.length, 3)
    assert.deepEqual(payload.failed, [])
    for (const row of payload.deleted) assert.equal(row.recycled, true)
  })
  check('/delete-many 目录全部离开 sessions 根', () => {
    for (const id of ids) assert.equal(existsSync(join(sessionsRoot, slug, id)), false, id)
  })
  check('/delete-many 回收站条目齐全且去重', () => {
    const listed = mod.listRecycled().map(e => e.sessionId).sort()
    assert.deepEqual(listed, [...ids].sort())
  })
  check('/delete-many 聚合去空工作区，只报一次', () => {
    assert.equal(payload.emptiedWorkspaces.length, 1)
    assert.equal(payload.emptiedWorkspaces[0].workspaceId, 'ws-many')
  })
  check('/delete-many 清空工作区的 sessionIds', () => {
    assert.deepEqual(ctx.workspaces.get('ws-many').sessionIds, [])
  })

  // Restore one to leave the workspace non-empty, then delete again with the
  // duplicate ids the page can produce (a row ticked twice is impossible, but a
  // retried request is not) — de-duplication must hold.
  rmSync(root, { recursive: true, force: true })
}

// --- 5d. /delete-many de-duplicates ids and survives a bad id in the batch ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5d-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const slug = '--d-work-mix--'
  const cwd = 'd:/work/mix'
  const good = 'session-cccc1111-2222-3333-4444-555555555551'
  makeSession(sessionsRoot, slug, good, cwd)

  const { routes } = mountRoutes(root)
  const res = await callRoute(routes, '/__session-recycle/delete-many',
    makeRequest('POST', { sessionIds: [good, good, '  ' + good + '  ', 'not-a-session-id', { nope: 1 }] }))
  const payload = res.json()
  check('/delete-many 去重后只删一次', () => {
    assert.equal(res.status, 200)
    assert.equal(payload.deleted.length, 1)
    assert.equal(payload.deleted[0].sessionId, good)
  })
  check('/delete-many 单个坏 id 不中断整批，进 failed', () => {
    assert.equal(payload.failed.length, 1)
    assert.equal(payload.failed[0].sessionId, 'not-a-session-id')
    assert.equal(payload.failed[0].code, 'INVALID_ID')
  })
  check('/delete-many 整批结束后目标确实删除', () => {
    assert.equal(existsSync(join(sessionsRoot, slug, good)), false)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 5e. /delete-many honours permanent ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5e-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const slug = '--d-work-perm--'
  const cwd = 'd:/work/perm'
  const sid = 'session-dddd1111-2222-3333-4444-555555555551'
  makeSession(sessionsRoot, slug, sid, cwd)

  const { routes } = mountRoutes(root)
  const res = await callRoute(routes, '/__session-recycle/delete-many',
    makeRequest('POST', { sessionIds: [sid], permanent: true }))
  const payload = res.json()
  check('/delete-many permanent 不写回收站', () => {
    assert.equal(res.status, 200)
    assert.equal(payload.deleted[0].permanent, true)
    assert.equal(payload.deleted[0].recycled, false)
    assert.equal(mod.listRecycled().length, 0)
  })
  check('/delete-many permanent 后目录消失', () => {
    assert.equal(existsSync(join(sessionsRoot, slug, sid)), false)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 5f. the empty-sweep switch decides what a delete does afterwards ---
//
// One scenario, two answers: delete the only session of a workspace and see who
// cleans up. With `autoPruneEmpty` on, the host removes the group and its
// now-empty folder; with it off — the default — both survive and the client is
// merely told what went empty.
for (const [auto, expectRemoved] of [[true, true], [false, false]]) {
  const root = mkdtempSync(join(tmpdir(), `sr-test5f-${auto}-`))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const cwd = 'd:/work/policy'
  const slug = mod.sessionFolderName(cwd)
  const sid = 'session-eeee1111-2222-3333-4444-555555555551'
  makeSession(sessionsRoot, slug, sid, cwd)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ autoPruneEmpty: auto }))

  const { routes, ctx } = mountRoutes(root)
  ctx.registry.enabled = true
  ctx.workspaces.set('ws-policy', { id: 'ws-policy', title: 'policy', path: cwd, sessionIds: [sid] })

  const res = await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: [sid] }))
  const payload = res.json()

  check(`autoPruneEmpty=${auto}：${expectRemoved ? '连分组一起清掉' : '只报告、不动分组'}`, () => {
    assert.equal(res.status, 200)
    assert.equal(payload.autoPruneEmpty, auto)
    // Always reported: what the batch emptied is information either way.
    assert.equal(payload.emptiedWorkspaces.length, 1)
    assert.equal(payload.removedWorkspaces.length, expectRemoved ? 1 : 0)
    assert.equal(ctx.workspaces.has('ws-policy'), !expectRemoved)
  })

  check(`autoPruneEmpty=${auto}：磁盘空目录${expectRemoved ? '被清掉' : '保留'}`, () => {
    assert.equal(existsSync(join(sessionsRoot, slug)), !expectRemoved)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 5f2. the single delete answers the same way ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5f2-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const cwd = 'd:/work/single'
  const slug = mod.sessionFolderName(cwd)
  const sid = 'session-eeee1111-2222-3333-4444-555555555552'
  makeSession(sessionsRoot, slug, sid, cwd)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ autoPruneEmpty: true }))

  const { routes, ctx } = mountRoutes(root)
  ctx.registry.enabled = true
  ctx.workspaces.set('ws-single', { id: 'ws-single', title: 'single', path: cwd, sessionIds: [sid] })

  const res = await callRoute(routes, '/__session-recycle/delete', makeRequest('POST', { sessionId: sid }))
  const payload = res.json()
  check('/delete 在开关打开时移除空分组', () => {
    assert.equal(res.status, 200)
    assert.equal(payload.autoPruneEmpty, true)
    assert.equal(payload.removedWorkspaces.length, 1)
    assert.equal(payload.emptiedWorkspaces.length, 1)
    assert.equal(ctx.workspaces.has('ws-single'), false)
  })
  check('/delete 顺带清掉磁盘空目录', () => assert.equal(existsSync(join(sessionsRoot, slug)), false))
  rmSync(root, { recursive: true, force: true })
}

// --- 5f3. the sweep reaches a session's own folder, not just the group's ---
//
// A group is keyed on the project root, but a session can be opened in a
// sub-directory of it, and DSH files it under a folder named after *that* cwd.
// Pruning the workspace's folder alone therefore leaves the sub-directory's
// folder behind — precisely the empty folder the switch promises to clear.
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5f3-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const projectCwd = 'd:/work/mono'
  const subCwd = 'd:/work/mono/apps/web'
  const subSlug = mod.sessionFolderName(subCwd)
  const rootSlug = mod.sessionFolderName(projectCwd)
  const sid = 'session-eeee1111-2222-3333-4444-555555555553'
  makeSession(sessionsRoot, subSlug, sid, subCwd)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ autoPruneEmpty: true }))

  const { routes, ctx } = mountRoutes(root)
  ctx.registry.enabled = true
  ctx.workspaces.set('ws-mono', { id: 'ws-mono', title: 'mono', path: projectCwd, sessionIds: [sid] })

  const res = await callRoute(routes, '/__session-recycle/delete', makeRequest('POST', { sessionId: sid }))
  const payload = res.json()

  check('子目录会话：目录名与分组目录本就不同', () => assert.notEqual(rootSlug, subSlug))
  check('子目录会话：删完清掉的是它自己那个空目录', () => {
    assert.equal(res.status, 200)
    assert.equal(payload.removedWorkspaces.length, 1, '分组空了，仍按开关移除')
    assert.deepEqual(payload.prunedDirs, [join(sessionsRoot, subSlug)],
      `prunedDirs 要报出会话自己的目录：${JSON.stringify(payload.prunedDirs)}`)
    assert.equal(existsSync(join(sessionsRoot, subSlug)), false, '子目录留下的空文件夹应当被清掉')
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 5f4. the folder sweep is still bounded by emptiness, and by the switch ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5f4-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const subCwd = 'd:/work/mono/apps/web'
  const subSlug = mod.sessionFolderName(subCwd)
  const keep = 'session-eeee1111-2222-3333-4444-555555555554'
  const gone = 'session-eeee1111-2222-3333-4444-555555555555'
  const withNeighbour = makeSession(sessionsRoot, subSlug, keep, subCwd)
  makeSession(sessionsRoot, subSlug, gone, subCwd)

  // Switch off: nothing is swept, so the caller is told the group went empty
  // rather than being handed a cleanup it did not ask for.
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ autoPruneEmpty: false }))
  const off = mountRoutes(root)
  off.ctx.registry.enabled = true
  off.ctx.workspaces.set('ws-off', { id: 'ws-off', title: 'off', path: 'd:/work/mono', sessionIds: [gone] })
  const offRes = await callRoute(off.routes, '/__session-recycle/delete', makeRequest('POST', { sessionId: gone }))
  check('开关关闭时一个目录都不清', () => {
    assert.equal(offRes.status, 200)
    assert.deepEqual(offRes.json().prunedDirs, [])
    assert.equal(existsSync(join(sessionsRoot, subSlug)), true)
  })

  // Switch on, but the folder still holds a session: `rmdir` refuses, so the
  // neighbour is safe and nothing is claimed as cleaned. (The first pass moved
  // its session out of the store, so put one back.)
  makeSession(sessionsRoot, subSlug, gone, subCwd)
  writeFileSync(join(root, 'session-recycle.json'), JSON.stringify({ autoPruneEmpty: true }))
  const on = mountRoutes(root)
  on.ctx.registry.enabled = true
  on.ctx.workspaces.set('ws-on', { id: 'ws-on', title: 'on', path: 'd:/work/mono', sessionIds: [gone] })
  const onRes = await callRoute(on.routes, '/__session-recycle/delete', makeRequest('POST', { sessionId: gone }))
  check('目录里还有别的会话时不清，也不谎报', () => {
    assert.equal(onRes.status, 200)
    assert.deepEqual(onRes.json().prunedDirs, [])
    assert.equal(existsSync(withNeighbour), true, '邻居会话必须还在')
  })

  // Now the last one goes: the folder is empty and is swept.
  on.ctx.workspaces.set('ws-on', { id: 'ws-on', title: 'on', path: 'd:/work/mono', sessionIds: [keep] })
  const lastRes = await callRoute(on.routes, '/__session-recycle/delete', makeRequest('POST', { sessionId: keep }))
  check('最后一个会话删掉后目录才清掉', () => {
    assert.equal(lastRes.status, 200)
    assert.deepEqual(lastRes.json().prunedDirs, [join(sessionsRoot, subSlug)])
    assert.equal(existsSync(join(sessionsRoot, subSlug)), false)
  })
  rmSync(root, { recursive: true, force: true })
}

// --- 5g. /empty-dirs and /prune-empty ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5g-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  // One folder emptied by a deletion, one still holding a session: only the
  // first may go.
  const emptySlug = mod.sessionFolderName('d:/work/empty')
  const busySlug = mod.sessionFolderName('d:/work/busy')
  mkdirSync(join(sessionsRoot, emptySlug), { recursive: true })
  makeSession(sessionsRoot, busySlug, 'session-ffff1111-2222-3333-4444-555555555551', 'd:/work/busy')
  // A group the user emptied (no sessions left) and one still in use.
  const liveSlug = mod.sessionFolderName('d:/work/live')
  mkdirSync(join(sessionsRoot, liveSlug), { recursive: true })

  const { routes, ctx } = mountRoutes(root)
  ctx.registry.enabled = true
  ctx.workspaces.set('ws-dead', { id: 'ws-dead', title: 'dead', path: 'd:/work/empty', sessionIds: [] })
  ctx.workspaces.set('ws-live', {
    id: 'ws-live', title: 'live', path: 'd:/work/live',
    sessionIds: ['session-ffff1111-2222-3333-4444-555555555551'],
  })

  check('/empty-dirs 已注册', () => assert.ok(routes.has('/__session-recycle/empty-dirs')))

  const listed = await callRoute(routes, '/__session-recycle/empty-dirs', makeRequest('GET'))
  check('/empty-dirs 只报空目录', () => {
    assert.equal(listed.status, 200)
    // Sorted, and `live` is not in it: it holds nothing either, but a folder
    // that is empty is a folder that is empty — the two are separate counts.
    assert.deepEqual(listed.json().dirs, [emptySlug, liveSlug].sort())
    assert.equal(listed.json().count, 2)
  })

  check('/empty-dirs 只报没有会话的分组', () => {
    const groups = listed.json().workspaces
    assert.equal(groups.length, 1)
    assert.equal(groups[0].workspaceId, 'ws-dead')
    assert.equal(groups[0].title, 'dead')
    assert.equal(listed.json().workspaceCount, 1)
  })

  const notGet = await callRoute(routes, '/__session-recycle/empty-dirs', makeRequest('POST', {}))
  check('/empty-dirs 拒绝非 GET', () => assert.equal(notGet.status, 405))

  const cross = await callRoute(routes, '/__session-recycle/prune-empty', makeRequest('POST', {}, { 'sec-fetch-site': 'cross-site' }))
  check('/prune-empty 拒绝跨站', () => assert.equal(cross.status, 403))

  const notPost = await callRoute(routes, '/__session-recycle/prune-empty', makeRequest('GET'))
  check('/prune-empty 拒绝非 POST', () => assert.equal(notPost.status, 405))

  const pruned = await callRoute(routes, '/__session-recycle/prune-empty', makeRequest('POST', {}))
  check('/prune-empty 删掉空目录', () => {
    assert.equal(pruned.status, 200)
    assert.deepEqual(pruned.json().removed, [emptySlug, liveSlug].sort())
  })
  check('/prune-empty 移除没有会话的分组', () => {
    assert.equal(pruned.json().removedWorkspaces.length, 1)
    assert.equal(pruned.json().workspaceCount, 1)
    assert.equal(pruned.json().failed.length, 0)
    assert.equal(ctx.workspaces.has('ws-dead'), false)
    assert.equal(ctx.workspaces.has('ws-live'), true)
  })
  check('/prune-empty 不碰非空目录', () => {
    assert.equal(existsSync(join(sessionsRoot, emptySlug)), false)
    assert.equal(existsSync(join(sessionsRoot, busySlug, 'session-ffff1111-2222-3333-4444-555555555551')), true)
  })
  check('/prune-empty 连带清掉分组自己留下的空目录', () => {
    // `ws-live`'s folder went with the folder sweep; the point is that removing
    // a group twice over (folder pass + group pass) is idempotent, not an error.
    assert.equal(existsSync(join(sessionsRoot, liveSlug)), false)
  })

  const again = await callRoute(routes, '/__session-recycle/empty-dirs', makeRequest('GET'))
  check('/empty-dirs 清理后归零', () => {
    assert.equal(again.json().count, 0)
    assert.equal(again.json().workspaceCount, 0)
  })

  const second = await callRoute(routes, '/__session-recycle/prune-empty', makeRequest('POST', {}))
  check('/prune-empty 再按一次什么都不做', () => {
    assert.deepEqual(second.json().removed, [])
    assert.deepEqual(second.json().removedWorkspaces, [])
  })

  rmSync(root, { recursive: true, force: true })
}

// --- 5h. the folder name DSH derives from a cwd ---
//
// The samples are copied from a real `~/.dsh/sessions` listing, including the
// drive-letter case difference and the non-ASCII encoding, because getting this
// wrong means pruning silently finds nothing.
{
  const cases = [
    ['D:\\USER\\Desktop\\workSpace\\dsh', '--D-USER-Desktop-workSpace-dsh--'],
    ['d:\\USER\\Desktop\\workSpace\\novel', '--d-USER-Desktop-workSpace-novel--'],
    ['D:\\USER\\Desktop\\workSpace\\dsh\\迁移', '--D-USER-Desktop-workSpace-dsh-~8FC1~79FB--'],
    ['D:\\USER\\Desktop\\workSpace\\小说分析', '--D-USER-Desktop-workSpace-~5C0F~8BF4~5206~6790--'],
    ['D:\\USER\\Desktop\\workSpace\\破甲工作区\\校园跑2', '--D-USER-Desktop-workSpace-~7834~7532~5DE5~4F5C~533A-~6821~56ED~8DD12--'],
    ['', ''],
  ]
  for (const [input, expected] of cases) {
    check(`目录名编码 ${input || '(空)'}`, () => assert.equal(mod.sessionFolderName(input), expected))
  }
}

// --- 5i. removeWorkspace prunes the folder only when it is empty ---
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5i-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const emptyCwd = 'd:/work/gone'
  const busyCwd = 'd:/work/alive'
  const emptySlug = mod.sessionFolderName(emptyCwd)
  const busySlug = mod.sessionFolderName(busyCwd)
  mkdirSync(join(sessionsRoot, emptySlug), { recursive: true })
  makeSession(sessionsRoot, busySlug, 'session-99991111-2222-3333-4444-555555555551', busyCwd)

  const ctx = makeCtx(root)
  ctx.registry.enabled = true
  ctx.workspaces.set('ws-gone', { id: 'ws-gone', title: 'gone', path: emptyCwd, sessionIds: [] })
  ctx.workspaces.set('ws-alive', { id: 'ws-alive', title: 'alive', path: busyCwd, sessionIds: ['session-99991111-2222-3333-4444-555555555551'] })

  const gone = await mod.removeWorkspace(ctx, 'ws-gone')
  check('removeWorkspace 剪掉空目录', () => {
    assert.equal(gone.removed, true)
    assert.equal(gone.prunedDirs.length, 1)
    assert.equal(existsSync(join(sessionsRoot, emptySlug)), false)
  })

  const alive = await mod.removeWorkspace(ctx, 'ws-alive')
  check('removeWorkspace 不碰还有会话的目录', () => {
    assert.equal(alive.prunedDirs.length, 0)
    assert.equal(existsSync(join(sessionsRoot, busySlug)), true)
  })

  let threw = null
  try { await mod.removeWorkspace(ctx, 'ws-does-not-exist') } catch (error) { threw = error }
  check('removeWorkspace 对不存在的 id 报 NOT_FOUND', () => assert.equal(threw?.code, 'NOT_FOUND'))

  const noRegistry = await (async () => {
    const bare = makeCtx(root)
    try { await mod.removeWorkspace(bare, 'ws-gone') } catch (error) { return error?.code }
    return null
  })()
  check('removeWorkspace 在无注册表时报 NO_REGISTRY', () => assert.equal(noRegistry, 'NO_REGISTRY'))

  rmSync(root, { recursive: true, force: true })
}

// --- 5j. /list and /recycled name the group each session shows under -------
//
// The pick-list groups rows by workspace, so both routes must carry a
// `workspaceTitle`. It has to survive the shape differences the two sides
// actually produce: the session header keeps whatever case the folder was first
// opened with, the registry stores the realpath answer, and either may use `\`
// or `/`.
{
  const root = mkdtempSync(join(tmpdir(), 'sr-test5j-'))
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const wsCwd = 'd:/work/proj-a'
  const looseCwd = 'd:/work/loose'
  const slug = mod.sessionFolderName(wsCwd)
  const looseSlug = mod.sessionFolderName(looseCwd)
  const groupedId = 'session-5a001111-2222-3333-4444-555555555551'
  const looseId = 'session-5a001111-2222-3333-4444-555555555552'
  // Deliberately spelled differently from the workspace record: Windows hands
  // back `D:\...` from one side and `d:/...` from the other.
  makeSession(sessionsRoot, slug, groupedId, 'D:\\work\\proj-a\\')
  makeSession(sessionsRoot, looseSlug, looseId, looseCwd)

  const { routes, ctx } = mountRoutes(root)
  ctx.workspaces.set('ws-a', { id: 'ws-a', title: 'proj-a', path: 'D:/work/proj-a', sessionIds: [groupedId] })

  const listed = (await callRoute(routes, '/__session-recycle/list', makeRequest('GET'))).json().sessions
  const byId = new Map(listed.map(row => [row.sessionId, row]))
  check('/list 按路径把会话归到分组名', () => {
    assert.equal(byId.get(groupedId).workspaceTitle, 'proj-a')
    assert.equal(byId.get(groupedId).workspaceId, 'ws-a')
  })
  check('/list 大小写与分隔符不同也算同一分组', () => {
    assert.equal(byId.get(groupedId).cwd, 'D:\\work\\proj-a\\', 'cwd 原样回传')
  })
  check('/list 没有分组的会话给空串', () => {
    assert.equal(byId.get(looseId).workspaceTitle, '')
    assert.equal(byId.get(looseId).workspaceId, '')
  })

  // Renaming the group must show up: the name is read live, not remembered.
  ctx.workspaces.set('ws-a', { id: 'ws-a', title: '改过的名字', path: 'D:/work/proj-a', sessionIds: [groupedId] })
  await acheck('/list 重命名分组后名字跟着变', async () => {
    const rows = (await callRoute(routes, '/__session-recycle/list', makeRequest('GET'))).json().sessions
    assert.equal(rows.find(r => r.sessionId === groupedId).workspaceTitle, '改过的名字')
  })

  // Recycle bin: the manifest records the title at delete time, but that is only
  // a fallback — the live workspace wins, so a rename shows up here too.
  await callRoute(routes, '/__session-recycle/delete-many', makeRequest('POST', { sessionIds: [groupedId, looseId] }))
  const bin = (await callRoute(routes, '/__session-recycle/recycled', makeRequest('GET'))).json().entries
  const binById = new Map(bin.map(row => [row.sessionId, row]))
  check('/recycled 带上当前的分组名', () => {
    assert.equal(binById.get(groupedId).workspaceTitle, '改过的名字')
    assert.equal(binById.get(groupedId).workspaceId, 'ws-a')
  })
  check('/recycled 没有分组的会话给空串', () => {
    assert.equal(binById.get(looseId).workspaceTitle, '')
  })

  // The recorded id may be gone (the group was removed) while the cwd still
  // resolves — the path lookup is the second chance.
  ctx.workspaces.delete('ws-a')
  ctx.workspaces.set('ws-b', { id: 'ws-b', title: '重建的分组', path: 'd:/work/proj-a', sessionIds: [] })
  await acheck('/recycled 记录的 id 失效时按路径认回来', async () => {
    const rows = (await callRoute(routes, '/__session-recycle/recycled', makeRequest('GET'))).json().entries
    const row = rows.find(r => r.sessionId === groupedId)
    assert.equal(row.workspaceTitle, '重建的分组')
    assert.equal(row.workspaceId, 'ws-b')
  })
  ctx.workspaces.clear()
  await acheck('/recycled 分组全没了就退回删除时记下的名字', async () => {
    const rows = (await callRoute(routes, '/__session-recycle/recycled', makeRequest('GET'))).json().entries
    assert.equal(rows.find(r => r.sessionId === groupedId).workspaceTitle, '改过的名字', '不回退成空串')
  })

  rmSync(root, { recursive: true, force: true })
}

for (const r of results) {
  if (r.ok) process.stdout.write(`  ok  ${r.label}\n`)
  else process.stdout.write(`  FAIL ${r.label}\n      ${r.error?.stack ?? r.error}\n`)
}
const failed = results.filter(r => !r.ok).length
process.stdout.write(`\n${results.length - failed}/${results.length} 通过\n`)
process.exit(failed > 0 ? 1 : 0)
