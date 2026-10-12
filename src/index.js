/**
 * dsh-session-recycle — HOST half.
 *
 * Adds session deletion to DeepSeek Harness, with a recycle-bin safety net.
 *
 * Design differences from the existing community plugin:
 *   - registers a NATIVE DSH tool (`session_delete`) instead of injecting an
 *     unauthenticated HTTP route, so deletion is only reachable through the
 *     harness's own tool surface;
 *   - never `rm -rf`s outright: the session directory is renamed into this
 *     plugin's own recycle store, so a mistake is recoverable and the delete is
 *     instant (a same-volume rename, no child process on any platform);
 *   - verifies containment before every destructive call: a target directory
 *     must resolve to a direct child of `$DSH_HOME/sessions`.
 *
 * Deletion is end-to-end: live agent stopped -> log dir recycled -> projection
 * cache row dropped -> workspace accounting detached. Removing only the log
 * directory leaves a ghost row in the projection cache and a stale id in
 * `workspaces[].sessionIds`, which is what makes deleted sessions reappear as
 * "Ungrouped" after the next flush.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'session-recycle'
const inject = ['tools']

// --- settings -----------------------------------------------------------------
//
// Kept in a tiny JSON document under $DSH_HOME rather than in the storage-domain
// stack: the domain API is version-sensitive across DSH releases, and a settings
// file that fails to load must never take the plugin (and therefore deletion)
// down with it. Reads are tolerant, writes are atomic-ish (temp + rename), and
// every failure falls back to the documented default.

/** Documented defaults; also the fallback for any unreadable or partial file. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Ask before deleting a session, or delete immediately on confirm. */
  confirmSingleDelete: true,
  /**
   * Sweep whatever a deletion left empty: a workspace whose last session just
   * went, and the session folder that workspace was stored under.
   *
   * Off by default, and one switch rather than a policy: either the user wants
   * this cleaned up for them or they do not, and a checkbox is the honest shape
   * for that. Nothing is ever removed on a guess.
   */
  autoPruneEmpty: false,
  /** Move to the OS recycle bin instead of deleting outright. */
  useRecycleBin: true,
})

const SETTINGS_FILE = 'session-recycle.json'

function settingsPath() {
  return path.join(dshHome(), SETTINGS_FILE)
}

/** Coerce one stored value to a boolean, falling back to the default. */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * The empty-sweep switch, including both of its older spellings.
 *
 * The setting has been through two shapes: a three-way string
 * (`emptyWorkspaceAction`: ask / auto / keep) and, before that, a plain switch
 * asking whether the user wanted to be *asked* (`askRemoveEmptyWorkspace`).
 * Exactly one historical value ever meant "remove it without asking" — the
 * string `'auto'` — so that, and only that, migrates to `true`. Every other
 * value lands on `false`: "stop asking me" is not the same instruction as
 * "delete it silently", and guessing wrong there would drop groupings the user
 * only ever asked to stop being interrupted about.
 */
function readAutoPrune(parsed) {
  if (typeof parsed.autoPruneEmpty === 'boolean') return parsed.autoPruneEmpty
  if (typeof parsed.emptyWorkspaceAction === 'string') return parsed.emptyWorkspaceAction === 'auto'
  return DEFAULT_SETTINGS.autoPruneEmpty
}

/** Read settings; any failure yields the defaults rather than throwing. */
function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS }
    return {
      confirmSingleDelete: boolOr(parsed.confirmSingleDelete, DEFAULT_SETTINGS.confirmSingleDelete),
      autoPruneEmpty: readAutoPrune(parsed),
      useRecycleBin: boolOr(parsed.useRecycleBin, DEFAULT_SETTINGS.useRecycleBin),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * Persist one settings patch; returns the settings now in effect.
 *
 * The temp name carries a per-write counter as well as the pid, so two writes
 * cannot share one temp path and publish each other's bytes.
 *
 * @returns the settings in effect; `written` is false when the file could not
 *   be replaced, which the caller reports rather than silently forgetting.
 */
let settingsWriteSeq = 0

function writeSettings(patch) {
  const next = { ...readSettings() }
  const given = (key) => patch !== null && typeof patch === 'object' && patch[key] !== undefined
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!given(key)) continue
    if (typeof patch[key] === 'boolean') next[key] = patch[key]
  }
  // Cached client bundles may still send the older keys, and a rename must not
  // leave a switch that writes a field nothing reads. `'auto'` is the one
  // historical value that asked for a silent sweep; the oldest switch only ever
  // controlled the prompt that no longer exists, so it maps to off.
  if (given('emptyWorkspaceAction') && typeof patch.emptyWorkspaceAction === 'string') {
    next.autoPruneEmpty = patch.emptyWorkspaceAction === 'auto'
  }
  if (given('askRemoveEmptyWorkspace') && typeof patch.askRemoveEmptyWorkspace === 'boolean') {
    next.autoPruneEmpty = false
  }
  let written = false
  try {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    settingsWriteSeq += 1
    const tmp = `${file}.${process.pid}.${settingsWriteSeq}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    written = true
  } catch {
    // The previous document stays in place and the defaults still apply, so a
    // failed write degrades to "this change did not stick" rather than a crash.
    // `written: false` is what lets the route tell the user that.
  }
  return { settings: next, written }
}

/**
 * Session ids are not always bare uuids. Three shapes occur in a real store:
 *
 *   session-<uuid>   native sessions created by this harness
 *   wb-<uuid>        imported (also codex-/claude-/pi-/oc- from other importers)
 *   <uuid>           bare — subagent transcripts and older records
 *
 * The bare form is easy to overlook, and it does occur in practice, so the
 * prefix is optional here. The uuid body stays mandatory, which is what keeps
 * separators and traversal out: no id containing `/`, `\` or `..` can match.
 */
const SESSION_ID_RE = /^(?:[a-z0-9]+-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class SessionRecycleError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SessionRecycleError'
    this.code = code
  }
}

// --- paths -------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.resolve(path.join(dshHome(), 'sessions'))
}

/**
 * Every on-disk spelling a session id can take. The JSONL backend encodes the
 * exact id, but older rows in the projection cache and workspace stores may use
 * either the raw uuid or the `session-`-prefixed form.
 */
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  const bare = sessionId.replace(/^[a-z0-9]+-/, '')
  if (bare !== sessionId) variants.add(bare)
  variants.add(`session-${bare}`)
  return [...variants]
}

/**
 * Directories under the sessions root that belong to this session.
 *
 * The candidates are always `<root>/<existing-slug-dir>/<variant>` — the slug
 * segment comes from a `readdir` of the real root, never from the caller — and
 * each resolved candidate is re-checked to be a strict child of that root
 * before it is returned. That double check is what makes an escape impossible
 * even if the id rule were ever loosened.
 */
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const variants = sessionIdVariants(sessionId)
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.resolve(path.join(root, entry.name, variant))
      if (candidate === root || !candidate.startsWith(root + path.sep)) continue
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* absent variant: keep scanning */ }
    }
  }
  return found
}

/** Session directories currently present in the store, newest-modified first. */
export function listStoredSessions() {
  const root = sessionsRoot()
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const slugDir = path.join(root, entry.name)
    let children
    try {
      children = fs.readdirSync(slugDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const dir = path.join(slugDir, child.name)
      if (path.resolve(dir) === root) continue
      let stat
      try { stat = fs.statSync(dir) } catch { continue }
      out.push({ sessionId: child.name, dir, cwd: entry.name, modifiedAt: stat.mtimeMs })
    }
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return out
}

// --- empty session folders ----------------------------------------------------
//
// Deleting a session moves its *payload* out of the store, but the folder the
// backend made for its working directory stays: `sessions/--d-work-proj--/`
// survives with nothing in it. DSH never notices, because the name is derived
// from the cwd and is recreated on demand — but the user browsing `~/.dsh` (or
// cleaning up after deleting every session of a project) is left with a row of
// empty folders, one per project they ever opened. They carry no data, so they
// are safe to remove; they are only ever removed when they are actually empty.

/**
 * The folder name DSH derives from a working directory.
 *
 * Measured against a real store rather than documented anywhere: every
 * separator run collapses to a single `-`, the whole thing is wrapped in `--`,
 * and each character outside ASCII becomes `~` plus its UTF-16 code unit in
 * upper-case hex (exactly four digits, no terminator) — so
 * `D:\USER\Desktop\workSpace\dsh` becomes `--D-USER-Desktop-workSpace-dsh--`,
 * `小说分析` becomes `~5C0F~8BF4~5206~6790`, and the trailing `2` of `校园跑2`
 * simply follows the `~8DD1` that encodes `跑`. The drive letter keeps whatever
 * case the path was registered with, which is why callers must try more than
 * one spelling (see `candidateSessionFolders`).
 */
export function sessionFolderName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const flattened = cwd.replace(/[:\\/]+/g, '-')
  const encoded = flattened.replace(
    /[^\x20-\x7E]/g,
    (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
  return `--${encoded}--`
}

/**
 * Every folder name a cwd could have produced.
 *
 * The encoding does not normalise case, and the same project shows up in the
 * registry as both `D:\...` and `d:\...` depending on how it was first opened,
 * so the drive letter is tried in both cases. A miss is harmless: pruning only
 * ever removes a folder that is already empty.
 */
function candidateSessionFolders(cwd) {
  const exact = sessionFolderName(cwd)
  if (exact.length === 0) return []
  const names = new Set([exact])
  const swapped = exact.replace(/^--([a-z])/i, (_all, letter) => `--${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}`)
  if (swapped !== exact) names.add(swapped)
  return [...names]
}

/**
 * Remove the session folder a workspace's cwd is stored under, if it is empty.
 *
 * @returns the absolute paths that were removed (normally one, often none).
 */
export function pruneEmptySessionFolder(cwd) {
  const root = sessionsRoot()
  const removed = []
  for (const name of candidateSessionFolders(cwd)) {
    const full = path.resolve(path.join(root, name))
    if (full === root || !full.startsWith(root + path.sep)) continue
    try {
      if (!fs.lstatSync(full).isDirectory()) continue
      // Non-recursive on purpose: `rmdir` refuses a folder with anything in it,
      // so a session that was not part of this deletion can never be caught.
      if (fs.readdirSync(full).length > 0) continue
      fs.rmdirSync(full)
      removed.push(full)
    } catch { /* absent, already gone, or locked: nothing to report */ }
  }
  return removed
}

/** Session folders in the store that hold nothing, by name, sorted. */
export function listEmptySessionFolders() {
  const root = sessionsRoot()
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.resolve(path.join(root, entry.name))
    if (full === root || !full.startsWith(root + path.sep)) continue
    try {
      if (fs.readdirSync(full).length === 0) out.push(entry.name)
    } catch { /* unreadable: leave it alone */ }
  }
  return out.sort()
}

/** Sweep every empty session folder. @returns the names removed. */
export function pruneEmptySessionFolders() {
  const root = sessionsRoot()
  const removed = []
  for (const name of listEmptySessionFolders()) {
    const full = path.resolve(path.join(root, name))
    if (full === root || !full.startsWith(root + path.sep)) continue
    try {
      fs.rmdirSync(full)
      removed.push(name)
    } catch { /* raced with a new session, or locked: keep it */ }
  }
  return removed
}

// --- recycle bin -------------------------------------------------------------

/**
 * Record of what this plugin recycled, so it can be listed and restored.
 *
 * The payloads themselves live in `session-recycle-store/` next to this file;
 * this is the ledger of where each came from and what it was. A restore that
 * finds its payload missing simply drops the entry, so a payload removed by hand
 * cannot corrupt anything, and `recoverOrphanedPayloads` rebuilds rows for
 * payloads that lost theirs.
 */
const RECYCLE_FILE = 'session-recycle-bin.json'

function recyclePath() {
  return path.join(dshHome(), RECYCLE_FILE)
}

function readRecycleManifest() {
  try {
    const parsed = JSON.parse(fs.readFileSync(recyclePath(), 'utf8'))
    return Array.isArray(parsed?.entries) ? parsed.entries.filter(e => e && typeof e.sessionId === 'string') : []
  } catch {
    return []
  }
}

/**
 * Serialize every manifest update through one promise chain.
 *
 * Each update is a read-modify-write of a shared file, so two overlapping calls
 * could otherwise lose one of the changes: both read the same list, and the
 * second write drops the first's entry. The read happens INSIDE the chain, not
 * before it, which is what makes the pair atomic.
 *
 * The temp name carries a per-write counter as well as the pid, so two writes
 * can never share one temp path and publish each other's bytes.
 *
 * @param mutate - maps the current entries to the next entries.
 * @returns whether the file was replaced.
 */
let manifestWriteChain = Promise.resolve()
let manifestWriteSeq = 0

function updateRecycleManifest(mutate) {
  const job = manifestWriteChain.then(() => {
    try {
      const next = mutate(readRecycleManifest())
      const file = recyclePath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      manifestWriteSeq += 1
      const tmp = `${file}.${process.pid}.${manifestWriteSeq}.tmp`
      fs.writeFileSync(tmp, `${JSON.stringify({ entries: next }, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch {
      // A failed write must not stall every later one on the chain.
      return false
    }
  })
  manifestWriteChain = job.catch(() => {})
  return job
}

/** Add one recycled session to the manifest, newest first, capped. */
function rememberRecycled(entry) {
  return updateRecycleManifest(
    entries => [entry, ...entries.filter(e => e.sessionId !== entry.sessionId)].slice(0, 200),
  )
}

function forgetRecycled(sessionId) {
  return updateRecycleManifest(entries => entries.filter(e => e.sessionId !== sessionId))
}

/**
 * The recycle entries whose payload is still present on disk.
 *
 * Each entry is verified, so an entry the user purged from the system bin (or
 * one a failed move left behind) never shows up as restorable.
 *
 * Entries recorded before this plugin stored titles are enriched on read: the
 * project folder is recovered by decoding the session header inside the payload,
 * which is what makes an older row identifiable instead of a bare uuid.
 */
export function listRecycled() {
  const store = recycleStoreRoot()
  const inStore = (payload) => {
    if (typeof payload !== 'string' || payload.length === 0) return false
    const resolved = path.resolve(payload)
    return resolved !== store && resolved.startsWith(store + path.sep)
  }
  return readRecycleManifest()
    .filter(entry => {
      // A payload outside the plugin's store is not ours to offer: the
      // manifest is an unauthenticated JSON file, so a foreign path can appear
      // in it (hand edit, restored backup, copied from another machine).
      if (!inStore(entry.payload)) return false
      try { return fs.existsSync(entry.payload) } catch { return false }
    })
    .map(entry => {
      const enriched = { ...entry }
      if (typeof enriched.cwd !== 'string' || enriched.cwd.length === 0) {
        const cwd = cwdFromArtifact(entry.payload)
        if (cwd !== undefined) enriched.cwd = cwd
      }
      // A stable human label for the row: the title if the session had one,
      // else the project folder, else nothing (the client localizes the rest).
      enriched.label = enriched.title && enriched.title.length > 0
        ? enriched.title
        : (typeof enriched.cwd === 'string' && enriched.cwd.length > 0
            ? path.basename(enriched.cwd)
            : '')
      return enriched
    })
}

/**
 * The store's own directory key for a session cwd.
 *
 * Mirrors `projectKey` in @deepseek-ai/dsh-session-persistence-jsonl: separators
 * collapse to a single `-`, and anything outside `[A-Za-z0-9._-]` becomes a
 * `~XXXX` escape. The persistence backend validates a stored session by
 * recomputing this from the header's `cwd`, so a restored file must sit in the
 * directory this function produces or the backend rejects it as corrupt and the
 * session never appears in the list.
 *
 * @param cwd - the session header's cwd.
 * @returns the project directory name, e.g. `--D-USER-proj--`.
 */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Permanently discard one recycled entry.
 *
 * The recycle bin's second half: an entry that is no longer wanted is dropped
 * for good, and its payload is deleted from this plugin's store so the space
 * comes back.
 *
 * Irreversible by design, so it is only ever reached from an explicit,
 * confirmed client action. A payload that is already gone is not an error: the
 * user's intent is satisfied, so the ledger entry is dropped either way.
 *
 * The payload path is re-verified to live inside this plugin's own recycle
 * store before anything is removed. The manifest is a plain JSON file under
 * $DSH_HOME — it can be hand-edited, restored from a backup, or carried over
 * from another machine — and `rm -rf` on whatever it names would otherwise be
 * an arbitrary delete. A row pointing outside the store is refused.
 *
 * @returns { sessionId, payloadRemoved: boolean }.
 */
export async function purgeRecycled(sessionId) {
  const entry = readRecycleManifest().find(e => e.sessionId === sessionId)
  if (entry === undefined) throw new SessionRecycleError(`nothing recycled for session ${sessionId}`, 'NOT_RECYCLED')
  let payloadRemoved = false
  const payload = typeof entry.payload === 'string' ? entry.payload : ''
  if (payload.length > 0) {
    // The payload must be a directory this plugin owns, inside its own store.
    const store = recycleStoreRoot()
    const resolved = path.resolve(payload)
    if (resolved === store || !resolved.startsWith(store + path.sep)) {
      throw new SessionRecycleError(`refusing to purge a payload outside the recycle store: ${resolved}`, 'OUT_OF_STORE')
    }
    try {
      if (fs.existsSync(payload)) {
        // The payload is a directory this plugin owns, so removing it is the
        // whole operation — nothing else would ever collect it.
        fs.rmSync(payload, { recursive: true, force: true })
      }
      payloadRemoved = !fs.existsSync(payload)
    } catch (error) {
      throw new SessionRecycleError(`could not remove the recycled payload: ${error.message}`, 'PURGE_FAILED')
    }
  }
  await forgetRecycled(sessionId)
  return { sessionId, payloadRemoved }
}

/**
 * Move one recycled session back to its original location.
 *
 * Also re-attaches the session to the workspace it came from, when that
 * workspace still exists. The delete removed its id from `sessionIds` and only
 * the recycle entry remembers where it was, so without this step a restored
 * session reappears under Ungrouped.
 *
 * The payload lives in this plugin's own recycle store, so restoring is the
 * reverse rename — no copy, no child process, and nothing to wait for.
 */
export async function restoreRecycled(ctx, sessionId) {
  const entry = listRecycled().find(e => e.sessionId === sessionId)
  if (entry === undefined) throw new SessionRecycleError(`nothing recycled for session ${sessionId}`, 'NOT_RECYCLED')

  const root = sessionsRoot()
  // Recompute the destination from the session's own cwd whenever possible.
  //
  // `restoreTo` records the path the delete moved away, but two cases make it
  // unusable on its own: a row recovered from an orphaned payload has none, and
  // on Windows the recorded path came from a directory scan, so its drive-letter
  // case can differ from the header's cwd. The persistence backend recomputes
  // the directory from the cwd and rejects a mismatch as a corrupt log — present
  // on disk, absent from every list, nothing reported — so the cwd wins.
  const cwd = typeof entry.cwd === 'string' && entry.cwd.length > 0
    ? entry.cwd
    : cwdFromArtifact(entry.payload)
  const key = projectKey(cwd)
  const recorded = typeof entry.restoreTo === 'string' && entry.restoreTo.length > 0
    ? path.resolve(entry.restoreTo)
    : undefined
  if (recorded !== undefined && (recorded === root || !recorded.startsWith(root + path.sep))) {
    throw new SessionRecycleError(`refusing to restore outside the sessions root: ${recorded}`, 'OUT_OF_ROOT')
  }
  // The directory name is the session id; only the project folder has to be
  // derived, and `key` supplies it.
  const leaf = recorded === undefined ? sessionId : path.basename(recorded)
  const dest = key === undefined
    ? recorded
    : path.join(root, key, leaf)
  if (dest === undefined) {
    throw new SessionRecycleError(
      `cannot tell where session ${sessionId} belongs: neither the entry nor its log records a project folder`,
      'NO_DESTINATION',
    )
  }
  if (dest === root || !dest.startsWith(root + path.sep)) {
    throw new SessionRecycleError(`refusing to restore outside the sessions root: ${dest}`, 'OUT_OF_ROOT')
  }
  if (fs.existsSync(dest)) throw new SessionRecycleError(`restore target already exists: ${dest}`, 'ALREADY_EXISTS')

  // The payload must also live inside this plugin's own recycle store. The
  // manifest is an unauthenticated JSON file under $DSH_HOME, so a row naming
  // a foreign directory would otherwise move that directory into the session
  // store — the same containment rule `purgeRecycled` applies to deletion.
  const store = recycleStoreRoot()
  const source = path.resolve(entry.payload)
  if (source === store || !source.startsWith(store + path.sep)) {
    throw new SessionRecycleError(`refusing to restore from outside the recycle store: ${source}`, 'OUT_OF_STORE')
  }

  // The payload is on the same volume (both live under DSH_HOME), so putting it
  // back is a rename — no copy, and no second pass to clean up the source.
  // A cross-volume rename is impossible here, but if the store was relocated to
  // another drive the copy fallback still restores correctly, just slower.
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.renameSync(entry.payload, dest)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      fs.cpSync(entry.payload, dest, { recursive: true })
      fs.rmSync(entry.payload, { recursive: true, force: true })
    }
  } catch (error) {
    throw new SessionRecycleError(`could not restore the session: ${error.message}`, 'RESTORE_FAILED')
  }
  if (!fs.existsSync(dest)) throw new SessionRecycleError('restore did not produce the session directory', 'RESTORE_FAILED')

  // Put it back in its group. Done before the entry is forgotten, and never
  // fatal: a workspace the user removed in the meantime is simply gone, and the
  // session then shows under Ungrouped as it would for any ungrouped session.
  const regrouped = await reattachWorkspace(ctx, entry)

  // The payload has already left the store (the rename moved it), so only the
  // ledger row remains. Awaited so the entry is gone by the time the response
  // lands: the client re-reads the recycle list immediately afterwards and would
  // otherwise still see the row it just restored.
  await forgetRecycled(sessionId)
  return { sessionId, restoredTo: dest, ...regrouped }
}

/**
 * Re-add a restored session to the workspace recorded on its recycle entry.
 *
 * Goes through `workspaceRegistry` rather than writing the domain table
 * directly. A raw `table.put()` does persist the new `sessionIds`, but it
 * bypasses the registry's own change notification, so the client's workspace
 * list never hears about it and the sidebar keeps showing the old grouping
 * until a reload. The registry's `WorkspaceEntity.attachSession` performs the
 * same write plus the notification.
 *
 * The registry validates that the session header's cwd resolves to the
 * workspace path, which the restored log satisfies (it is the same log that was
 * removed). A workspace the user deleted in the meantime simply has no record,
 * and the session then shows under Ungrouped — not an error.
 *
 * @returns { regrouped: boolean, workspaceTitle?: string }.
 */
async function reattachWorkspace(ctx, entry) {
  const workspaceId = typeof entry.workspaceId === 'string' ? entry.workspaceId : ''
  if (workspaceId.length === 0) return { regrouped: false }
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.get !== 'function') {
    // No registry (older host): fall back to the direct write, which at least
    // persists the grouping even though the live list will not update.
    return { regrouped: await reattachDirect(ctx, entry, workspaceId) }
  }
  try {
    const workspace = registry.get(workspaceId)
    if (workspace === undefined || workspace === null) return { regrouped: false }
    let title = ''
    try {
      const view = registry.list().find(w => String(w.id) === workspaceId)
      if (view && typeof view.title === 'string') title = view.title
    } catch { /* title is cosmetic */ }
    await workspace.attachSession(entry.sessionId)
    return { regrouped: true, workspaceTitle: title }
  } catch {
    // Attach is validated (cwd must resolve to the workspace path). If that
    // fails the log is still restored, so report it as ungrouped rather than
    // failing the whole restore.
    return { regrouped: false }
  }
}

/** Direct-to-table fallback used only when no workspace registry is available. */
async function reattachDirect(ctx, entry, workspaceId) {
  const sd = ctx.get('storageDomain')
  const ws = sd && typeof sd.get === 'function' ? sd.get('workspace') : undefined
  if (!ws || typeof ws.table !== 'function') return false
  try {
    const workspaces = ws.table('workspaces')
    const record = workspaces.get(workspaceId)
    if (record === undefined || record === null) return false
    const sessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : []
    if (sessionIds.includes(entry.sessionId)) return true
    await workspaces.put(workspaceId, { ...record, sessionIds: [entry.sessionId, ...sessionIds] })
    return true
  } catch {
    return false
  }
}

/**
 * Where this plugin keeps deleted payloads.
 *
 * Inside DSH_HOME, on the same volume as the sessions root, so moving a session
 * here is a rename: measured at ~10 ms, against ~1.7 s to hand the same folder
 * to the OS recycle bin (which starts a PowerShell process and drives the Shell
 * COM API twice on Windows, and shells out to Finder or writes XDG metadata
 * elsewhere).
 *
 * The trade is deliberate: the payload no longer appears in the desktop's own
 * recycle bin, so recovery happens through this plugin's panel rather than
 * Explorer. What it buys is that delete, restore and purge are all a single
 * rename — no child process on any platform, no background work to resume, and
 * one code path instead of three.
 */
function recycleStoreRoot() {
  return path.join(dshHome(), 'session-recycle-store')
}

/**
 * Move one session directory into this plugin's recycle store.
 *
 * The destination keeps the session id so a payload can be identified from the
 * filesystem alone, which is what lets a lost manifest be rebuilt. A numeric
 * suffix disambiguates the rare case of the same id being deleted twice.
 *
 * @returns the payload's new absolute path.
 */
function storePayload(dir) {
  const root = recycleStoreRoot()
  fs.mkdirSync(root, { recursive: true })
  const base = path.basename(dir)
  let target = path.join(root, base)
  let n = 2
  while (fs.existsSync(target)) target = path.join(root, `${base}.${n++}`)
  fs.renameSync(dir, target)
  return target
}

/**
 * Rebuild manifest rows for payloads that have no entry.
 *
 * A payload can outlive its manifest row if the process died between the rename
 * and the write, or if the manifest file was lost. The payload's own header
 * carries the session id and cwd, so the row is recoverable rather than the
 * directory becoming an orphan that only `rm -rf` can clear.
 *
 * @returns how many rows were recovered.
 */
function recoverOrphanedPayloads() {
  const root = recycleStoreRoot()
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const known = new Set(readRecycleManifest().map(entry => entry.payload))
  let recovered = 0
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue
    const payload = path.join(root, dirent.name)
    if (known.has(payload)) continue
    // The stored directory is `<sessionId>` or `<sessionId>.<n>`.
    const sessionId = dirent.name.replace(/\.\d+$/, '')
    if (!SESSION_ID_RE.test(sessionId)) continue
    let header
    try {
      header = cwdFromArtifact(payload)
    } catch { /* a payload we cannot read is left alone */ }
    rememberRecycled({
      sessionId,
      at: Date.now(),
      how: 'plugin-store',
      payload,
      // Without a manifest row the original path is unknown; the cwd is enough
      // to recompute it, which is what restore does when restoreTo is absent.
      restoreTo: '',
      title: '',
      slug: '',
      cwd: typeof header === 'string' ? header : '',
      workspaceId: '',
      workspaceTitle: '',
    })
    recovered += 1
  }
  return recovered
}

// --- live session teardown ---------------------------------------------------

/** Cancel a running agent and wait (time-boxed) for it to quiesce. */
async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  try { agent.cancel?.({ kind: 'user' }) } catch { /* already settling */ }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([agent.whenIdle(), new Promise(resolve => setTimeout(resolve, 15000))])
    } catch { /* time-boxed: proceed with deletion */ }
  }
  return true
}

/**
 * Flush a live session so its pending writes land before the log is recycled.
 * Without this, dispose-time teardown could re-create the directory we just
 * moved away.
 */
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') {
      try { await sessions.flush(session); flushed = true } catch { /* deletion proceeds */ }
    }
  }
  return flushed
}

/** Detach the session from the in-memory store so no later flush recreates it. */
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (entry.session && typeof sessions.attachments?.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    }
  } catch { /* best effort */ }
  return detached
}

/**
 * Descriptive facts about a session, read before it is deleted.
 *
 * The recycle list is only useful if a row says what it is: a bare uuid tells
 * the user nothing about whether to restore it. Every field here has to be
 * captured BEFORE `stripStorageDomains` runs, because that is what removes the
 * projection-cache row holding the title.
 *
 * All fields are best-effort. A missing title is normal (a session that was
 * never named renders as "untitled" in the harness too), and the caller still
 * gets a usable entry with its id and date.
 *
 * @returns { title, slug, messageCount, createdAt } — any may be undefined.
 */
function describeSession(ctx, sessionId) {
  const variants = sessionIdVariants(sessionId)
  const out = { title: undefined, slug: undefined, messageCount: undefined, createdAt: undefined }

  // The projection cache is the authority for the sidebar title.
  try {
    const sd = ctx.get('storageDomain')
    const projcache = sd && typeof sd.get === 'function' ? sd.get('session_projcache') : undefined
    if (projcache && typeof projcache.table === 'function') {
      const table = projcache.table('sessions')
      for (const variant of variants) {
        const record = table.get(variant)
        if (record === undefined || record === null) continue
        const rows = record.rows && typeof record.rows === 'object' ? record.rows : {}
        const title = rows.title && typeof rows.title.val === 'string' ? rows.title.val.trim() : ''
        if (title.length > 0) { out.title = title; break }
      }
    }
  } catch { /* unit closed or table absent */ }

  // The session header line carries the cwd, which becomes the group name.
  const dirs = findSessionDirs(sessionId)
  const dir = dirs[0]
  if (dir !== undefined) {
    try {
      out.slug = path.basename(path.dirname(dir))
      const artifact = path.join(dir, 'session.v4.jsonl.zstd')
      if (fs.existsSync(artifact)) {
        const stat = fs.statSync(artifact)
        // The directory's own mtime is when it was last written, which is the
        // closest thing to "last active" available without decoding the log.
        out.createdAt = stat.mtimeMs
      }
    } catch { /* unreadable artifact: id and date are enough */ }
  }
  return out
}

/**
 * Decode a session header to recover its cwd, for the recycle list's label.
 *
 * Kept separate from `describeSession` because it touches the recycled payload,
 * not the live store, and is only needed at list time.
 *
 * @returns the cwd string, or undefined when the header cannot be read.
 */
/**
 * Decode the session header line (the first zstd frame) to recover the cwd.
 *
 * Kept separate from `describeSession` because it touches the recycled payload,
 * not the live store, and is only needed at list time.
 *
 * `budget` caps how much of the file is read. The header frame is one line, so
 * a listing only ever needs the first few kilobytes; reading whole artifacts to
 * answer "which project is this" cost ~700 MB of I/O across a 60-session store
 * on this machine. Callers that need certainty (restore) pass the default and
 * read everything.
 *
 * @returns the parsed header object, or undefined when it cannot be read.
 */
function readSessionHeader(dir, budget = Infinity) {
  try {
    const artifact = path.join(dir, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(artifact)) return undefined
    const want = budget === Infinity
      ? fs.statSync(artifact).size
      : Math.min(fs.statSync(artifact).size, budget)
    if (want <= 0) return undefined
    const buf = Buffer.alloc(want)
    const handle = fs.openSync(artifact, 'r')
    try {
      fs.readSync(handle, buf, 0, want, 0)
    } finally {
      try { fs.closeSync(handle) } catch { /* best effort */ }
    }
    const first = zlib.zstdDecompressSync(buf.subarray(0, firstFrameEnd(buf)))
    const line = first.toString('utf8').split('\n')[0]
    return JSON.parse(line)
  } catch { return undefined }
}

function cwdFromArtifact(dir) {
  const header = readSessionHeader(dir)
  return typeof header?.cwd === 'string' ? header.cwd : undefined
}

/**
 * How much of an artifact the session listing reads to find its header.
 *
 * One line of JSON, generously padded: a session whose first frame is larger
 * than this simply falls back to its project slug, which still identifies it.
 */
const HEADER_PREFIX_BYTES = 256 * 1024

/** Byte offset just past the first zstd frame, or the buffer end. */
function firstFrameEnd(buf) {
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  for (let i = 4; i < buf.length - 3; i++) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) return i
  }
  return buf.length
}

/**
 * Drop the session's rows from the storage domains that index it.
 *
 * These are separate durable stores, not derived state: the projection cache
 * holds the sidebar title, and the workspace registry owns which group a
 * session appears under. Leaving either behind produces a ghost entry.
 */
async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = ctx.get('storageDomain')
  if (!sd || typeof sd.get !== 'function') return { projectRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projectRemoved = false
  let workspaceRemoved = false

  const projcache = sd.get('session_projcache')
  if (projcache && typeof projcache.table === 'function') {
    try {
      const sessions = projcache.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projectRemoved = true
        }
      }
    } catch { /* unit closed or table absent */ }
  }

  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [workspaceId, record] of workspaces.entries()) {
          if (record && Array.isArray(record.sessionIds) && variants.some(v => record.sessionIds.includes(v))) {
            await workspaces.put(workspaceId, {
              ...record,
              sessionIds: record.sessionIds.filter(id => !variants.includes(id)),
            })
            workspaceRemoved = true
          }
        }
      } catch { /* unit closed or table absent */ }
      try {
        const global = ws.global
        if (global && typeof global.get === 'function' && typeof global.set === 'function') {
          const state = global.get()
          if (state && Array.isArray(state.archivedSessionIds) && variants.some(v => state.archivedSessionIds.includes(v))) {
            await global.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter(id => !variants.includes(id)) })
            workspaceRemoved = true
          }
        }
      } catch { /* no global slot */ }
    }
  }

  return { projectRemoved, workspaceRemoved }
}

/**
 * Workspaces that held one of these sessions, captured BEFORE the sweep.
 *
 * The emptiness check cannot run afterwards: `stripStorageDomains` removes the
 * id from `sessionIds` first, so a post-hoc scan can no longer tell which
 * workspace the session belonged to. Taking the membership now and the count
 * later keeps the two facts separate.
 *
 * @param touchedIds - session ids about to be removed.
 * @returns a Map of workspaceId -> { title, path } for workspaces holding any.
 */
function workspacesHolding(ctx, touchedIds) {
  const sd = ctx.get('storageDomain')
  if (!sd || typeof sd.get !== 'function') return new Map()
  const ws = sd.get('workspace')
  if (!ws || typeof ws.table !== 'function') return new Map()
  const touched = new Set(touchedIds.map(String))
  const holders = new Map()
  try {
    const workspaces = ws.table('workspaces')
    for (const [workspaceId, record] of workspaces.entries()) {
      if (!record || !Array.isArray(record.sessionIds)) continue
      if (!record.sessionIds.some(id => touched.has(String(id)))) continue
      holders.set(String(workspaceId), {
        workspaceId: String(workspaceId),
        title: typeof record.title === 'string' ? record.title : '',
        path: typeof record.path === 'string' ? record.path : '',
      })
    }
  } catch { /* unit closed or table absent */ }
  return holders
}

/**
 * The subset of `holders` whose `sessionIds` is now empty.
 *
 * "Empty" means the array has no entries left — deliberately narrow: the
 * registry is the only accounting that decides whether a group still has rows
 * to show, so anything else (archived ids, subagent transcripts) would be
 * guessing at what the sidebar renders.
 *
 * The workspaces are NOT removed here. An empty workspace is usually a project
 * the user still works in, so the decision stays with them.
 *
 * @param holders - result of {@link workspacesHolding}, taken before the sweep.
 * @returns [{ workspaceId, title, path }] for each workspace now empty.
 */
function emptiedFromHolders(ctx, holders) {
  if (holders.size === 0) return []
  const sd = ctx.get('storageDomain')
  if (!sd || typeof sd.get !== 'function') return []
  const ws = sd.get('workspace')
  if (!ws || typeof ws.table !== 'function') return []
  const out = []
  try {
    const workspaces = ws.table('workspaces')
    for (const [workspaceId, record] of workspaces.entries()) {
      const holder = holders.get(String(workspaceId))
      if (holder === undefined) continue
      if (!record || !Array.isArray(record.sessionIds)) continue
      if (record.sessionIds.length > 0) continue
      out.push(holder)
    }
  } catch { /* unit closed or table absent */ }
  return out
}

/**
 * The project folder behind a workspace id.
 *
 * The registry handle and the storage table disagree about nothing except
 * availability, so both are tried: the handle is the live object (and carries
 * `path`), the table is what survives when no registry is wired up. An empty
 * answer just means "nothing to prune", never an error.
 */
function workspacePath(ctx, workspaceId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.get === 'function') {
      const handle = registry.get(workspaceId)
      const fromHandle = handle && typeof handle.path === 'string' ? handle.path : ''
      if (fromHandle.length > 0) return fromHandle
    }
  } catch { /* fall through to the table */ }
  try {
    const sd = ctx.get('storageDomain')
    const ws = sd && typeof sd.get === 'function' ? sd.get('workspace') : undefined
    const table = ws && typeof ws.table === 'function' ? ws.table('workspaces') : undefined
    const record = table && typeof table.get === 'function' ? table.get(workspaceId) : undefined
    if (record && typeof record.path === 'string') return record.path
  } catch { /* no table: nothing to prune */ }
  return ''
}

/**
 * Remove one workspace registration.
 *
 * The registry entry goes, plus the session folder its cwd is stored under —
 * but only when that folder is empty, which after the workspace's last session
 * was deleted it is. The project directory itself and every session log are
 * untouched, exactly like the harness's own "delete workspace": the folder
 * pruned here is DSH's own derived index of that path, not the path. Sessions
 * that somehow still reference it simply render under Ungrouped.
 *
 * @returns { workspaceId, removed, prunedDirs } — the pruned paths are reported
 *   so a caller can say what was cleaned rather than implying it.
 */
export async function removeWorkspace(ctx, workspaceId) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.delete !== 'function') {
    throw new SessionRecycleError('workspace registry unavailable', 'NO_REGISTRY')
  }
  // Read the path BEFORE the delete: the record is what carries it.
  const target = workspacePath(ctx, workspaceId)
  const removed = await registry.delete(workspaceId)
  if (removed !== true) {
    throw new SessionRecycleError(`no such workspace: ${workspaceId}`, 'NOT_FOUND')
  }
  const prunedDirs = target.length > 0 ? pruneEmptySessionFolder(target) : []
  return { workspaceId, removed: true, prunedDirs }
}

/**
 * Every workspace in the registry that holds no sessions.
 *
 * The grouping record outlives its sessions: deleting a session detaches its id
 * from the record and the record stays, which is the right default (a project
 * the user still works in keeps its place) and the reason a sidebar can end up
 * with a row of groups holding nothing. Read from the domain table, which is
 * what the store actually contains.
 */
function emptyWorkspaces(ctx) {
  return currentWorkspaces(ctx).filter(workspace => workspace.sessionIds.length === 0)
}

/**
 * Drop every workspace with no sessions left, and the empty folder each left on
 * disk.
 *
 * The manual counterpart to `autoPruneEmpty`, covering what the switch cannot:
 * groups emptied while it was off, and groups emptied before it existed. Only
 * session-free groups are touched — a group with even one session is left
 * exactly as it was — and a group that fails is reported rather than aborting
 * the sweep.
 *
 * @returns { removed: [{ workspaceId, title, path, prunedDirs }], failed }
 */
export async function pruneEmptyWorkspaces(ctx) {
  const removed = []
  const failed = []
  for (const workspace of emptyWorkspaces(ctx)) {
    try {
      const result = await removeWorkspace(ctx, workspace.workspaceId)
      removed.push({
        workspaceId: result.workspaceId,
        title: workspace.title ?? '',
        path: workspace.path ?? '',
        prunedDirs: result.prunedDirs ?? [],
      })
    } catch (error) {
      failed.push({
        workspaceId: workspace.workspaceId,
        error: error?.message ?? String(error),
        code: error?.code ?? null,
      })
    }
  }
  return { removed, failed }
}

/**
 * Apply the empty-sweep switch to what a delete just emptied.
 *
 * Only the `autoPruneEmpty` setting reaches here, and only when it is on: the
 * user turned on "clean up what I emptied", so a bulk delete does not end with
 * the sidebar full of empty shells to sweep by hand, and each removal takes the
 * empty session folder with it. With the switch off nothing is removed and the
 * caller reports the emptied groups as information rather than an offer — a
 * grouping the user did not ask to lose stays where it is.
 *
 * One workspace failing must not cost the others: the reason lands in `failed`
 * and the loop continues.
 *
 * @returns { auto, removed: [{ workspaceId, title, path, prunedDirs }], failed }
 *   `removed` is empty unless the switch is on.
 */
async function settleEmptyWorkspaces(ctx, emptied, settings) {
  const auto = settings?.autoPruneEmpty === true
  if (!auto || !Array.isArray(emptied) || emptied.length === 0) {
    return { auto, removed: [], failed: [] }
  }
  const removed = []
  const failed = []
  for (const workspace of emptied) {
    try {
      const result = await removeWorkspace(ctx, workspace.workspaceId)
      removed.push({
        workspaceId: result.workspaceId,
        title: workspace.title ?? '',
        path: workspace.path ?? '',
        prunedDirs: result.prunedDirs ?? [],
      })
    } catch (error) {
      failed.push({
        workspaceId: workspace.workspaceId,
        error: error?.message ?? String(error),
        code: error?.code ?? null,
      })
    }
  }
  return { auto, removed, failed }
}

/**
 * Tell the client session list that this session is gone.
 *
 * This is the load-bearing call for the sidebar. dsh-api-session-controller
 * already relays removals: it listens for `session/disposed` and re-emits
 * `api-session/removed`, which the client store turns into a `remove` mutation
 * plus `handleRemoved()` on the session instance (dropping it from the list).
 *
 * Deleting only the files never disposes a session, so nothing was ever
 * emitted and the row stayed on screen even though the session was gone —
 * a second click then answered "not found". Emitting the same event the
 * harness emits on dispose puts the two halves back in agreement.
 *
 * Both id spellings are emitted because the store keys by whatever id the
 * summary carried; a store that never held one of them ignores it.
 */
function notifySessionRemoved(ctx, sessionId) {
  const emitted = []
  for (const variant of sessionIdVariants(sessionId)) {
    try {
      ctx.emit('session/disposed', { id: variant })
      emitted.push(variant)
    } catch { /* a listener that throws must not fail the deletion */ }
    try {
      ctx.emit('api-session/removed', variant)
      emitted.push(variant)
    } catch { /* tolerated for the same reason */ }
  }
  return emitted.length > 0
}

// --- core --------------------------------------------------------------------

/**
 * Delete one session end to end.
 *
 * @param options.permanent - skip the recycle bin and unlink outright.
 * @param options.settings - settings in effect; defaults to the stored document.
 * @returns a structured result summarising every store that was updated, plus
 *   the workspaces this deletion left empty.
 */
export async function deleteSession(ctx, sessionId, { permanent = false, settings } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new SessionRecycleError(`invalid session id: ${sessionId}`, 'INVALID_ID')
  }
  const effective = settings ?? readSettings()
  // The user's recycle-bin preference decides the default; an explicit
  // permanent request always wins, because that is the caller being deliberate.
  const useBin = permanent !== true && effective.useRecycleBin !== false
  const touchedVariants = sessionIdVariants(sessionId)
  // Which workspaces hold this session, read BEFORE the sweep removes it.
  const holders = workspacesHolding(ctx, touchedVariants)
  // Title and shape, also read before the sweep drops the projection row.
  const described = describeSession(ctx, sessionId)

  const dirs = findSessionDirs(sessionId)
  if (dirs.length === 0) {
    // No log on disk: still sweep the index stores so a half-deleted session
    // cannot linger as a ghost row.
    const swept = await stripStorageDomains(ctx, sessionId, { workspace: true })
    if (!swept.projectRemoved && !swept.workspaceRemoved) {
      throw new SessionRecycleError(`session not found: ${sessionId}`, 'NOT_FOUND')
    }
    const notified = notifySessionRemoved(ctx, sessionId)
    return {
      sessionId,
      recycled: [],
      dirsRemoved: 0,
      permanent: false,
      ...swept,
      stopped: false,
      detached: false,
      notified,
      emptiedWorkspaces: emptiedFromHolders(ctx, holders),
    }
  }

  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  const root = sessionsRoot()
  const recycled = []

  // Move each payload out of the store, with a rename.
  //
  // This is the whole deletion as far as the filesystem is concerned: the
  // payload lands in this plugin's own recycle store, and the session is out of
  // the sessions root immediately, so `findSessionDirs` no longer sees it. Being
  // a same-volume rename it costs ~10 ms, which is why the delete is instant —
  // handing the same folder to the OS recycle bin measured ~1.7 s on Windows
  // (a PowerShell process plus two Shell COM calls).
  for (const dir of dirs) {
    // Re-verify containment immediately before the destructive call.
    const resolved = path.resolve(dir)
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
      throw new SessionRecycleError(`refusing to remove a path outside the sessions root: ${resolved}`, 'OUT_OF_ROOT')
    }
    if (!fs.existsSync(resolved)) continue
    if (!useBin) {
      fs.rmSync(resolved, { recursive: true, force: true })
      recycled.push({ dir: resolved, how: 'permanent', payload: '' })
      continue
    }
    try {
      recycled.push({ dir: resolved, how: 'plugin-store', payload: storePayload(resolved) })
    } catch (error) {
      throw new SessionRecycleError(`could not move the session aside: ${error.message}`, 'REMOVE_FAILED')
    }
  }

  if (findSessionDirs(sessionId).length > 0) {
    throw new SessionRecycleError(`session files could not be fully removed: ${sessionId}`, 'REMOVE_FAILED')
  }

  const swept = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const emptiedWorkspaces = emptiedFromHolders(ctx, holders)
  // Every index now agrees the session is gone, so the list can hear about it.
  const notified = notifySessionRemoved(ctx, sessionId)

  // Remember what went to the store so the recycle panel can list and restore
  // it. Entries whose payload could not be located are still recorded: restore
  // reports them as unavailable rather than silently losing the row.
  //
  // Written before the response because the client re-reads the recycle list as
  // soon as it lands. The payload is already in place — it was moved there by
  // `storePayload` above — so there is no follow-up work to wait for.
  if (useBin) {
    // The workspace this session belonged to, captured before the sweep. It is
    // recorded so a restore can put the session back in its group instead of
    // dropping it into Ungrouped (the sweep removes the id from sessionIds, and
    // nothing else remembers where it was).
    const holder = [...holders.values()][0]
    for (const entry of recycled) {
      await rememberRecycled({
        sessionId,
        at: Date.now(),
        how: 'plugin-store',
        payload: entry.payload,
        restoreTo: entry.dir,
        // Captured before the sweep, so the recycle row can say what it is.
        title: described.title ?? '',
        slug: described.slug ?? '',
        lastActiveAt: described.createdAt ?? undefined,
        workspaceId: holder?.workspaceId ?? '',
        workspaceTitle: holder?.title ?? '',
      })
    }
  }

  return {
    sessionId,
    recycled,
    dirsRemoved: recycled.length,
    permanent: !useBin,
    ...swept,
    stopped,
    detached,
    notified,
    emptiedWorkspaces,
  }
}

/**
 * One spelling for a path, for comparing two of them.
 *
 * The same directory reaches this plugin under several spellings — the session
 * header keeps whatever case the cwd was first opened with, the workspace
 * registry stores the `fs.realpath` answer, and either may use `\` or `/`.
 * Comparing raw strings misses matches that are obvious on screen, so both sides
 * go through this first.
 */
function normalizePathKey(value) {
  return String(value ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * The live workspace grouping, read from the authoritative storage table.
 *
 * `workspaceRegistry.list()` is deliberately NOT used: the registry caches a
 * `record` per workspace and does not observe writes made straight through the
 * domain table, which is how this plugin detaches a session from its group. Its
 * view therefore goes stale (it kept reporting a deleted session as grouped),
 * and anything built on it would keep showing the old grouping. The table is
 * what the `domain/changed` frames carry, so it is the truth the client needs.
 *
 * @returns [{ workspaceId, path, title, sessionIds }] in durable order.
 */
function currentWorkspaces(ctx) {
  const sd = ctx.get('storageDomain')
  const ws = sd && typeof sd.get === 'function' ? sd.get('workspace') : undefined
  if (!ws || typeof ws.table !== 'function') return []
  const out = []
  try {
    const workspaces = ws.table('workspaces')
    // Durable order comes from the global slot; fall back to table order.
    let order = []
    try {
      const state = typeof ws.global?.get === 'function' ? ws.global.get() : undefined
      if (state && Array.isArray(state.workspaceIds)) order = state.workspaceIds.map(String)
    } catch { /* table order is an acceptable fallback */ }
    const seen = new Set()
    const emit = (id, record) => {
      if (seen.has(id)) return
      seen.add(id)
      if (record === undefined || record === null) return
      out.push({
        workspaceId: id,
        path: typeof record.path === 'string' ? record.path : '',
        title: typeof record.title === 'string' ? record.title : '',
        sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.map(String) : [],
      })
    }
    for (const id of order) emit(id, workspaces.get(id))
    for (const [id, record] of workspaces.entries()) emit(String(id), record)
  } catch { /* unit closed or table absent */ }
  return out
}

// --- client bridge -----------------------------------------------------------
//
// The client half runs in the browser and cannot reach the `tools` service:
// @deepseek-ai/dsh-tools is a HOST-only package with no `./client` export, so
// `ctx.get('tools')` is always undefined in the client runtime. A client button
// therefore needs an explicit carrier to the host. This plugin registers two
// `exact` routes on the web server instead of mounting a typert Remote
// namespace, matching what the community market itself does for every one of
// its own mutating actions.
//
// Because an `exact` registration wins over the harness's own /api fence, the
// route has to defend itself. The guards below are the market's, deliberately:
//
//   - Host must name a loopback authority (or a host the deployment declared
//     through `dsh web --trusted-host`). `Host` is the one header a
//     DNS-rebinding page cannot forge, so this is the real defence — an
//     `Origin === Host` equality alone is satisfied by the attacker's own pair.
//   - `sec-fetch-site: cross-site` is refused outright.
//   - A PRESENT Origin must match Host; an absent one is allowed, because the
//     Desktop build's proxy strips it before forwarding, and a non-browser
//     client can forge any value anyway.
//   - `Origin: null` (sandboxed iframe / data: document) is present but
//     unparseable, so it is refused rather than treated as absent.
//   - Bodies are capped, and only the two documented fields are read.

/** Parse a bare `host[:port]` authority; null when the value is not one. */
function parseAuthority(value) {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === String(value).toLowerCase() ? url : null
  } catch {
    return null
  }
}

/** Whether a `Host` header names a loopback authority. */
function loopbackAuthority(host) {
  if (host === undefined) return false
  const lower = String(host).toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/** Authorities this deployment serves besides loopback, as the host declared them. */
function trustedHosts(ctx) {
  try {
    const connection = ctx.get('connection')
    const list = connection?.trustedHosts
    if (Array.isArray(list)) return list
    if (typeof list?.getSnapshot === 'function') return list.getSnapshot() ?? []
  } catch { /* older host: loopback-only, which is the stricter rule */ }
  return []
}

function trustedAuthority(host, list) {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  return list.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/** Whether this request may mutate plugin state. */
function sameOrigin(ctx, request) {
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHosts(ctx))) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Cap on a batch body.
 *
 * A session id is 36 bytes of uuid plus JSON quoting, so 400 of them fit in
 * ~18 KB. 256 KB is the same ceiling the import plugin uses and leaves room for
 * the `permanent` flag and future fields; it exists to stop a hostile page from
 * making the host buffer megabytes before the fence even runs.
 */
const MAX_BATCH_BODY_BYTES = 256 * 1024

/**
 * Cap on ids per batch.
 *
 * A store with more live sessions than this is not a store a settings page can
 * render anyway, and the ceiling keeps one request from making the host do an
 * unbounded amount of synchronous work in a single tick.
 */
const MAX_BATCH_IDS = 5000

/** Normalize a body id list: strings only, trimmed, de-duplicated, capped. */
function normalizeSessionIds(value) {
  if (!Array.isArray(value)) return undefined
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id.length > 0) seen.add(id)
    if (seen.size > MAX_BATCH_IDS) throw new Error(`too many ids (max ${MAX_BATCH_IDS})`)
  }
  return [...seen]
}

/** Read a size-capped JSON body. */
async function readJsonBody(request, maxBytes = 4096) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Register the client-facing routes; returns a disposer. */
function registerRoutes(host, ctx) {
  const disposers = []

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/list',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      try {
        // Title comes from the projection cache (the same source the sidebar
        // uses) and the cwd from the artifact header; the project slug is the
        // fallback for either. Without them the settings page could only offer
        // bare uuids, which is not a list anyone can pick from.
        //
        // The workspace title is what names the group the session shows under in
        // the sidebar — and the registry is the authority on that, so a renamed
        // group comes back renamed. Matching is by path, not by the registry's
        // own `sessionIds`: that list is the raw table row, which can name
        // sessions whose cwd no longer resolves to the group path (the entity's
        // getter filters those out, and the sidebar follows the getter).
        const workspaceByPath = new Map()
        for (const workspace of currentWorkspaces(ctx)) {
          if (workspace.path.length === 0) continue
          workspaceByPath.set(normalizePathKey(workspace.path), workspace)
        }
        sendJson(response, 200, {
          ok: true,
          sessions: listStoredSessions().map((entry) => {
            const described = describeSession(ctx, entry.sessionId)
            const header = readSessionHeader(entry.dir, HEADER_PREFIX_BYTES)
            const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0
              ? header.cwd
              : (described.slug ?? entry.cwd ?? '')
            const workspace = workspaceByPath.get(normalizePathKey(cwd))
            return {
              sessionId: entry.sessionId,
              title: described.title ?? '',
              cwd,
              // 空串而不是 null：客户端只关心「有没有一个分组名」。
              workspaceId: workspace?.workspaceId ?? '',
              workspaceTitle: workspace?.title ?? '',
              updatedAt: entry.modifiedAt ?? null,
            }
          }),
        })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/delete',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // Mutating route: the fence runs before the body is even read.
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId.length === 0) {
        sendJson(response, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      if (body?.permanent !== undefined && typeof body.permanent !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'permanent must be a boolean' })
        return
      }
      try {
        // Read the policy once and hand it in, so the delete and the cleanup
        // that follows it cannot disagree about what the user asked for.
        const settings = readSettings()
        const result = await deleteSession(ctx, sessionId, { permanent: body?.permanent === true, settings })
        const emptied = result.emptiedWorkspaces ?? []
        const settled = await settleEmptyWorkspaces(ctx, emptied, settings)
        sendJson(response, 200, {
          ok: true,
          sessionId: result.sessionId,
          permanent: result.permanent,
          dirsRemoved: result.dirsRemoved,
          projectRemoved: result.projectRemoved,
          workspaceRemoved: result.workspaceRemoved,
          notified: result.notified === true,
          // Informational: these groupings are empty now. Whether they were
          // also removed is the `autoPruneEmpty` switch's business, reported
          // separately so the client never has to guess which happened.
          emptiedWorkspaces: emptied,
          autoPruneEmpty: settled.auto,
          removedWorkspaces: settled.removed,
          workspaceRemovalFailed: settled.failed,
        })
      } catch (error) {
        const status = error?.code === 'INVALID_ID' ? 400 : error?.code === 'NOT_FOUND' ? 404 : 500
        sendJson(response, status, { ok: false, error: error.message, code: error?.code })
      }
    },
  }))

  // Batch delete for the settings page's session list.
  //
  // The single delete is deliberately per-session — it stops an agent, flushes
  // a live log and notifies before touching disk — and doing that 20 times over
  // 20 round-trips is both slow and racy: each call re-reads settings and the
  // workspace registry, so a workspace emptied by call 3 is already gone by the
  // time call 7 looks. One route keeps the fence, reads settings once and
  // aggregates the "this workspace is now empty" offer instead of firing it
  // twenty times.
  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/delete-many',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // Mutating route: the fence runs before the body is even read.
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request, MAX_BATCH_BODY_BYTES)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      let sessionIds
      try {
        sessionIds = normalizeSessionIds(body?.sessionIds)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message })
        return
      }
      if (sessionIds === undefined || sessionIds.length === 0) {
        sendJson(response, 400, { ok: false, error: 'sessionIds is required' })
        return
      }
      if (body?.permanent !== undefined && typeof body.permanent !== 'boolean') {
        sendJson(response, 400, { ok: false, error: 'permanent must be a boolean' })
        return
      }
      const permanent = body?.permanent === true
      // Read once and hand it to every call: the policy must not change
      // mid-batch just because a write landed between two deletions.
      const settings = readSettings()
      const deleted = []
      const failed = []
      const emptiedById = new Map()
      for (const sessionId of sessionIds) {
        try {
          const result = await deleteSession(ctx, sessionId, { permanent, settings })
          deleted.push({
            sessionId,
            // `result.recycled` is the store-loop log and it records permanent
            // removals too (`how: 'permanent'`), so "went to the bin" has to be
            // read off the entry, not off the list being non-empty.
            recycled: result.recycled.some(entry => entry.how === 'plugin-store'),
            permanent: result.permanent === true,
            dirsRemoved: result.dirsRemoved,
            notified: result.notified === true,
          })
          for (const holder of result.emptiedWorkspaces ?? []) {
            const key = holder?.workspaceId ?? JSON.stringify(holder)
            if (key !== undefined && key !== '' && !emptiedById.has(key)) {
              emptiedById.set(key, holder)
            }
          }
        } catch (error) {
          // One failure must not abort the batch: the user asked for a set, and
          // reporting which of them survived is more useful than stopping at
          // the first problem.
          failed.push({ sessionId, error: error?.message ?? String(error), code: error?.code ?? null })
        }
      }
      const settled = await settleEmptyWorkspaces(ctx, [...emptiedById.values()], settings)
      sendJson(response, 200, {
        ok: true,
        deleted,
        failed,
        // Same split as the single delete: what went empty, and what the switch
        // then did about it. Under `autoPruneEmpty` the host has already
        // removed them, so `removedWorkspaces` is what the client reports.
        emptiedWorkspaces: [...emptiedById.values()],
        autoPruneEmpty: settled.auto,
        removedWorkspaces: settled.removed,
        workspaceRemovalFailed: settled.failed,
      })
    },
  }))

  // --- settings ---------------------------------------------------------------

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/settings',
    handler: async (request, response) => {
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      if (request.method === 'GET') {
        sendJson(response, 200, { ok: true, settings: readSettings(), defaults: DEFAULT_SETTINGS })
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(response, 400, { ok: false, error: 'body must be an object' })
        return
      }
      // `emptyWorkspaceAction` and `askRemoveEmptyWorkspace` are accepted on
      // purpose rather than treated as typos: they are the older spellings of
      // `autoPruneEmpty`, and a client bundle cached from before the rename can
      // still send either. `writeSettings` translates both, so the switch keeps
      // working either way.
      const writable = [...Object.keys(DEFAULT_SETTINGS), 'emptyWorkspaceAction', 'askRemoveEmptyWorkspace']
      const unknown = Object.keys(body).filter(key => !writable.includes(key))
      if (unknown.length > 0) {
        sendJson(response, 400, { ok: false, error: `unknown setting: ${unknown.join(', ')}` })
        return
      }
      const { settings, written } = writeSettings(body)
      // Report a failed write instead of answering 200 with settings that were
      // never persisted: the client would then show a value the next read
      // contradicts.
      sendJson(response, written ? 200 : 500, written
        ? { ok: true, settings }
        : { ok: false, error: 'could not persist settings', settings })
    },
  }))

  // --- workspaces -------------------------------------------------------------

  /**
   * The current workspace grouping, shaped for the client's own list store.
   *
   * Read from the storage domain TABLE rather than `workspaceRegistry.list()`.
   * The registry keeps its own in-memory `record` per workspace and does not
   * observe writes made through the domain table directly (which is how a
   * session is detached from its group here), so its view goes stale — it kept
   * reporting a deleted session as still grouped. The table is the authority
   * the `domain/changed` frames carry, so it is what the client must be given.
   *
   * The response matches what the client's `upsertView` expects: workspaceId
   * plus the fields the sidebar renders.
   */
  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/workspaces',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      try {
        sendJson(response, 200, { ok: true, workspaces: currentWorkspaces(ctx) })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message })
      }
    },
  }))

  // --- recycle panel ----------------------------------------------------------

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/recycled',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      try {
        // 回收站里的行也要有分组名，才能和会话列表按同一套名字分块。清单里记着
        // 删除那一刻的 workspaceTitle，但分组可能改名、也可能当时就查不到，所以
        // 用当前的注册表补一次：先按 id 认，认不到再按路径认。
        const byId = new Map()
        const byPath = new Map()
        for (const workspace of currentWorkspaces(ctx)) {
          byId.set(workspace.workspaceId, workspace)
          if (workspace.path.length > 0) byPath.set(normalizePathKey(workspace.path), workspace)
        }
        const entries = listRecycled().map((entry) => {
          const known = byId.get(entry.workspaceId) ?? byPath.get(normalizePathKey(entry.cwd))
          return {
            ...entry,
            workspaceId: known?.workspaceId ?? entry.workspaceId ?? '',
            workspaceTitle: known?.title ?? entry.workspaceTitle ?? '',
          }
        })
        sendJson(response, 200, { ok: true, entries })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/restore',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId.length === 0) {
        sendJson(response, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      if (!SESSION_ID_RE.test(sessionId)) {
        sendJson(response, 400, { ok: false, error: `invalid session id: ${sessionId}` })
        return
      }
      try {
        const result = await restoreRecycled(ctx, sessionId)
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        const status = error?.code === 'NOT_RECYCLED' ? 404 : error?.code === 'INVALID_ID' ? 400 : error?.code === 'OUT_OF_STORE' ? 400 : 500
        sendJson(response, status, { ok: false, error: error.message, code: error?.code })
      }
    },
  }))

  // Irreversible: dropping a recycle entry and its parked payload for good.
  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/purge',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId.length === 0) {
        sendJson(response, 400, { ok: false, error: 'sessionId is required' })
        return
      }
      if (!SESSION_ID_RE.test(sessionId)) {
        sendJson(response, 400, { ok: false, error: `invalid session id: ${sessionId}` })
        return
      }
      try {
        const result = await purgeRecycled(sessionId)
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        const status = error?.code === 'NOT_RECYCLED' ? 404 : error?.code === 'OUT_OF_STORE' ? 400 : 500
        sendJson(response, status, { ok: false, error: error.message, code: error?.code })
      }
    },
  }))

  // --- empty session folders and empty groups ---------------------------------
  //
  // Two things a deletion can leave behind with nothing in them: the folder the
  // store keeps per working directory, and the workspace grouping record. The
  // store folder carries no data (DSH recreates the name on demand) and a group
  // with no sessions has nothing to show, but both clutter what the user sees,
  // so these two routes let the settings page count them and sweep them in one
  // click — which is also the only way to clear what earlier versions left.

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/empty-dirs',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      const dirs = listEmptySessionFolders()
      const workspaces = emptyWorkspaces(ctx)
      sendJson(response, 200, {
        ok: true,
        dirs,
        count: dirs.length,
        workspaces: workspaces.map(workspace => ({
          workspaceId: workspace.workspaceId,
          title: workspace.title,
          path: workspace.path,
        })),
        workspaceCount: workspaces.length,
      })
    },
  }))

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/prune-empty',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // Mutating route: the fence runs before anything is touched.
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      const removed = pruneEmptySessionFolders()
      // Folders first, then the groups that would have pruned them anyway, so a
      // folder is never reported twice and the group sweep finds it already
      // gone.
      const pruned = await pruneEmptyWorkspaces(ctx)
      sendJson(response, 200, {
        ok: true,
        removed,
        count: removed.length,
        removedWorkspaces: pruned.removed,
        workspaceCount: pruned.removed.length,
        failed: pruned.failed,
      })
    },
  }))

  // --- workspace cleanup ------------------------------------------------------

  disposers.push(host.register({
    kind: 'exact',
    path: '/__session-recycle/remove-workspace',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(ctx, request)) {
        sendJson(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `bad request body: ${error.message}` })
        return
      }
      const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : ''
      if (workspaceId.length === 0) {
        sendJson(response, 400, { ok: false, error: 'workspaceId is required' })
        return
      }
      try {
        const result = await removeWorkspace(ctx, workspaceId)
        sendJson(response, 200, { ok: true, ...result })
      } catch (error) {
        const status = error?.code === 'NOT_FOUND' ? 404 : 500
        sendJson(response, status, { ok: false, error: error.message, code: error?.code })
      }
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}

// --- plugin ------------------------------------------------------------------

function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'session_delete',
    description:
      'Delete one session of this harness. Stops the session if it is running, moves its persisted log to the OS recycle bin (or deletes it permanently when permanent=true), and removes its projection-cache row and workspace grouping entry. Use list_sessions first to confirm the exact sessionId.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to delete, exactly as reported by list_sessions or the session list.',
      },
      permanent: {
        type: 'boolean',
        description: 'Delete outright instead of moving to the recycle bin. Defaults to false, which is recoverable.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args?.sessionId ?? '').trim()
      try {
        // Honor the same switch the settings page does, so a delete driven from
        // the agent leaves the store in the state the user configured instead
        // of only the UI doing it.
        const settings = readSettings()
        const result = await deleteSession(ctx, sessionId, { permanent: args?.permanent === true, settings })
        const emptied = result.emptiedWorkspaces ?? []
        const settled = await settleEmptyWorkspaces(ctx, emptied, settings)
        const lines = [
          `deleted ${result.sessionId}`,
          `directories removed: ${result.dirsRemoved}`,
        ]
        for (const entry of result.recycled) lines.push(`  ${entry.how}: ${entry.dir}`)
        lines.push(`agent stopped: ${result.stopped}`)
        lines.push(`projection cache row removed: ${result.projectRemoved}`)
        lines.push(`workspace grouping removed: ${result.workspaceRemoved}`)
        if (!result.permanent && result.dirsRemoved > 0) {
          lines.push('recoverable: the log was moved to the system recycle bin')
        }
        for (const workspace of settled.removed) {
          lines.push(`removed the emptied workspace "${workspace.title || workspace.path}" and the folder it left on disk`)
        }
        for (const workspace of settled.failed) {
          lines.push(`could not remove the emptied workspace "${workspace.workspaceId}": ${workspace.error}`)
        }
        for (const workspace of settled.auto ? [] : emptied) {
          lines.push(`note: workspace "${workspace.title || workspace.path}" is now empty; use workspace_remove to drop the group, or turn on the "auto-prune emptied workspaces" setting to have it done on every delete`)
        }
        return lines.join('\n')
      } catch (error) {
        return `delete failed: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_sessions',
    description:
      'List every session stored on disk with its id and workspace slug, newest-modified first. Use this to find the exact sessionId to pass to session_delete.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute() {
      const sessions = listStoredSessions()
      if (sessions.length === 0) return 'no sessions found on disk'
      return sessions
        .map(entry => `${entry.sessionId}  [${entry.cwd}]`)
        .join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_recycled',
    description:
      'List sessions this plugin moved to the system recycle bin that can still be restored, newest first. Use session_restore with the reported sessionId to put one back.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute() {
      const entries = listRecycled()
      if (entries.length === 0) return 'nothing in the recycle bin'
      return entries
        .map(entry => `${entry.sessionId}  recycled=${new Date(entry.at).toISOString()}  ${entry.how}`)
        .join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_restore',
    description:
      'Restore one session this plugin moved to the system recycle bin, back to its original location in the session store. Use list_recycled to find the sessionId.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The recycled session id to restore.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args?.sessionId ?? '').trim()
      try {
        const result = await restoreRecycled(ctx, sessionId)
        const group = result.regrouped
          ? `  back in workspace: ${result.workspaceTitle || result.workspaceId}`
          : '  no workspace to restore it into; it will show under Ungrouped'
        return `restored ${result.sessionId}\n  -> ${result.restoredTo}\n${group}\nrefresh the harness to see it again`
      } catch (error) {
        return `restore failed: ${error.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workspace_remove',
    description:
      'Remove one workspace (session group) from the list. The grouping entry and the now-empty session folder DSH kept for its working directory are removed; the project folder itself and every session log are kept. Use this after deleting the last session in a workspace, when the empty group should go too.',
    parameters: {
      workspaceId: {
        type: 'string',
        required: true,
        description: 'The workspace id to remove, as reported by session_delete.',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const workspaceId = String(args?.workspaceId ?? '').trim()
      try {
        const result = await removeWorkspace(ctx, workspaceId)
        const pruned = (result.prunedDirs ?? []).length
        return `removed workspace ${result.workspaceId}\n  the project folder and its session logs are untouched\n  pruned ${pruned} empty session folder(s)`
      } catch (error) {
        return `workspace removal failed: ${error.message}`
      }
    },
  }))

  // The client bridge. `webServer` is optional — a terminal-only profile has no
  // web surface — so the routes register when the service exists or appears
  // later, while the tools above register unconditionally. The plugin must never
  // hang waiting on a service a profile will never provide.
  const register = (webServer, targetCtx) => {
    targetCtx.effect(() => registerRoutes(webServer, ctx), 'session-recycle: client bridge')
  }
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) register(webServer, ctx)
  else ctx.inject(['webServer'], (sub) => register(sub.webServer, sub))

  // Rebuild manifest rows for payloads that lost theirs — a crash between the
  // rename and the write, or a deleted manifest file. Without this the payload
  // would sit in the store as an orphan that only `rm -rf` could clear. It is
  // synchronous and reads one directory, so it costs nothing at startup.
  try { recoverOrphanedPayloads() } catch { /* recovery is best effort */ }
}

export { apply, inject, name }
