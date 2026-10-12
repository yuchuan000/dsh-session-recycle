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
  return {
    emitted,
    workspaces,
    get(name) {
      if (name === 'storageDomain') {
        return {
          get(unit) {
            if (unit === 'session_projcache') return { table: () => ({ get: (id) => sessionsTable.get(id), delete: async (id) => sessionsTable.delete(id) }) }
            if (unit === 'workspace') return {
              table: () => ({
                entries: () => workspaces.entries(),
                get: (id) => workspaces.get(id),
                put: async (id, rec) => workspaces.set(id, rec),
              }),
            }
            return undefined
          },
        }
      }
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'workspaceRegistry') return undefined
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
    // readSettings is not exported; exercise through writeSettings indirectly is not possible,
    // so just confirm DEFAULT_SETTINGS shape.
    assert.deepEqual({ ...mod.DEFAULT_SETTINGS }, {
      confirmSingleDelete: true,
      askRemoveEmptyWorkspace: true,
      useRecycleBin: true,
    })
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
