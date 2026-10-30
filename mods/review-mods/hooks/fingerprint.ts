import type { EngineInterface } from 'claude-code'

// `hash-object --stdin-paths` reads Git's C-style quoting, not NUL-delimited
// paths or JSON escapes such as \u0001. Keep each filename on one input line.
const quotedPath = (path: string) => `"${path.replace(/[\x00-\x1f\x7f"\\]/g, ch =>
  ch === '"' || ch === '\\' ? `\\${ch}` : `\\${ch.charCodeAt(0).toString(8).padStart(3, '0')}`,
)}"`

const failed = () => new Error('未追跡ファイルの内容を取得できず、差分を確認できません')

/**
 * Regular files are hashed together. A link's content is its target name, not
 * the bytes of the file it points to; no-index diff reads that name even for a
 * dangling link. Never replace an unreadable or incomplete snapshot with ''.
 */
export async function untrackedHashes($: EngineInterface, names: readonly string[]): Promise<string> {
  if (names.length === 0) return ''
  const files: string[] = []
  const links: string[] = []
  try {
    // Git lists paths relative to the session cwd; fs paths otherwise resolve
    // against the plugin directory. Keep both reads on the same working tree.
    const cwd = await $.session.cwd()
    const directory = cwd.replace(/\/$/, '')
    // Bound outstanding host calls while retaining one hash process for regular files.
    for (let start = 0; start < names.length; start += 32) {
      const batch = names.slice(start, start + 32)
      const stats = await Promise.all(batch.map(name => $.fs.stat(`${directory}/${name}`)))
      for (const [i, stat] of stats.entries()) {
        if (stat.isLink) links.push(batch[i]!)
        else if (stat.kind === 'file') files.push(batch[i]!)
        else throw failed()
      }
    }

    let blobs: string[] = []
    if (files.length > 0) {
      // A worktree run reads the raw bytes, before clean filters or EOL normalization.
      // --stdin-paths resolves relative names from the repository root, not cwd.
      const paths = files.map(name => quotedPath(`${directory}/${name}`))
      const ran = await $.process.run(['git', 'hash-object', '--no-filters', '--stdin-paths'], { cwd, stdin: `${paths.join('\n')}\n` })
      blobs = ran.stdout.trimEnd().split('\n')
      if (ran.exitCode !== 0 || ran.isStdoutTruncated || blobs.length !== files.length || blobs.some(blob => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blob))) {
        throw failed()
      }
    }
    const entries = files.map((name, i) => [name, 'file', blobs[i]])
    for (const name of links) {
      const ran = await $.process.run(['git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', name], { cwd })
      // A non-empty symlink against /dev/null is a difference (exit 1), not an error.
      if (ran.exitCode !== 1 || ran.isStdoutTruncated || !ran.stdout.includes('new file mode 120000\n')) throw failed()
      entries.push([name, 'link', ran.stdout])
    }
    return JSON.stringify(entries)
  } catch {
    throw failed()
  }
}
