// Intent rules in priority order: specific scans before generic coding work. Each pattern
// needs the intent, not a word that happens to contain it: "error handling" is not a bug,
// コンテスト is not a テスト, and いい感じです thanks rather than asks.
const RULES: ReadonlyArray<{ pattern: RegExp; skills: readonly string[] }> = [
  {
    // A failure of the software, not of the person: "I failed to understand" and "fail fast"
    // are no bug, nor is 気分が落ちる.
    pattern:
      /\b(bugs?|debug(ging|ger)?|broken|crash(es|ed|ing)?|regression|stack ?trace|traceback)\b|\bfail(s|ed)? to (build|compile|run|start|load|launch)\b|\bfailing (tests?|builds?|ci|checks?)\b|\b(tests?|builds?|ci|checks?) (is |are )?(failing|fails|failed)\b|\berrors?\b(?!\s+(handling|handler|handlers|messages?|codes?|types?|boundar(y|ies)|pages?))|デバッグ|バグ|不具合|エラー(?!処理|ハンドリング|メッセージ|コード)|壊れ|動かない|(アプリ|サーバー?|プロセス|ビルド|テスト|CI|画面|ページ)が?落ちる|クラッシュ/i,
    skills: ['coding-debug'],
  },
  { pattern: /\b(security|vulnerab\w*)\b|セキュリティ|脆弱性/i, skills: ['security-scan'] },
  {
    // Slowness of the product: "the test is slow" is the test's own matter, not a performance scan.
    pattern:
      /\b(performance|perf|latency)\b|\bslow(ness)?\s+(pages?|quer(y|ies)|endpoints?|apis?|apps?|load(ing)?|responses?|render(ing)?|startup)\b|\b(pages?|quer(y|ies)|endpoints?|apis?|apps?|load(ing)?|responses?|render(ing)?|startup)\s+(is\s+|are\s+)?(too\s+|very\s+)?slow\b|パフォーマンス|遅い|重い|高速化/i,
    skills: ['performance-scan'],
  },
  // A word of its own, never a path segment: src/review/foo.ts asks for no review.
  { pattern: /(?<![\w/.-])review(s|ed|ing)?(?![\w/.-])|レビュー/i, skills: ['coding-review', 'quality-review'] },
  { pattern: /\bresearch\b|調査|リサーチ/i, skills: ['research-route'] },
  { pattern: /\bplan(ning)?\b|計画/i, skills: ['planning-router'] },
  { pattern: /\brefactor\w*|リファクタ/i, skills: ['coding-refactor'] },
  { pattern: /\b(tests?|testing)\b|(?<!コン|プロ)テスト/i, skills: ['coding-test'] },
  { pattern: /\bimplement\w*|実装/i, skills: ['coding-implement'] },
  { pattern: /\b(ui|ux)\b|\bdesign\b(?!\s+patterns?)|デザイン(?!パターン)/i, skills: ['design-ux', 'ux-scan'] },
  { pattern: /\b(image|images)\b|画像/i, skills: ['image-direction'] },
  {
    pattern:
      /\bvague\b|\b(make it (nice|nicer|better|good|pretty)|clean (this|it) up)\b|(いい感じ|良い感じ|きれい|綺麗|ちゃんと|よしなに)に?(して|直して|整えて|やって|お願い)|曖昧な(依頼|指示|要件)/i,
    skills: ['clarify'],
  },
]

export const MAX_HINTS = 3

/** Claude Code's own commands: naming one (`/clear`, `/init`) is no choice of skill. */
const BUILTINS = new Set([
  'agents', 'bug', 'clear', 'compact', 'config', 'cost', 'doctor', 'export', 'help', 'hooks', 'init', 'login',
  'logout', 'mcp', 'memory', 'model', 'permissions', 'plugin', 'resume', 'review', 'rewind', 'status',
  'terminal-setup', 'vim',
])

/** A command as `$.command.list()` gives it, or a bare name. */
export type Available = string | { name: string; source?: string }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The part a person types for a plugin skill: `anthropic-skills:pdf` is asked for as `pdf`. */
const shortName = (name: string) => name.slice(name.lastIndexOf(':') + 1)

/**
 * Whether `text` already names a skill: `/name` after anything but a word character or a
 * path (start, space, punctuation, a CJK character, a quote, a backtick, a paren), and not
 * itself the start of a path (`/review/foo.ts`); or a hyphenated or scoped name
 * (`coding-debug`, `anthropic-skills:pdf`) as a whole token. A plugin's skill counts as
 * `/short` too. A one-word name in prose ("can you clarify why…") is an ordinary word.
 */
function namesSkill(text: string, names: readonly string[]): boolean {
  const slashed = (word: string) => new RegExp(`(?<![\\w/.~-])/${word}(?![\\w/-])`, 'i').test(text)
  return names.some(name => {
    if (slashed(escape(name))) return true
    if (name.includes(':') && slashed(escape(shortName(name)))) return true
    return /[-:]/.test(name) && new RegExp(`(?<![\\w/:-])${escape(name)}(?![\\w-])`, 'i').test(text)
  })
}

/**
 * Skills worth suggesting for `text`, among the session's commands `available`
 * (a plugin's skill matches by the part after its `plugin:` scope and is suggested in full).
 * Empty when the text already names a skill; Claude Code's own commands name none.
 */
export function suggest(text: string, available: Iterable<Available>): string[] {
  const commands = [...available].map(one => (typeof one === 'string' ? { name: one } : one))
  const names = commands.filter(one => one.source !== 'builtin' && !BUILTINS.has(one.name)).map(one => one.name)
  if (namesSkill(text, names)) return []

  const byShort = new Map<string, string>()
  for (const name of names) {
    const short = shortName(name)
    // A bare name wins over a plugin's skill of the same short name.
    if (!byShort.has(short) || !name.includes(':')) byShort.set(short, name)
  }

  const hints: string[] = []
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue
    for (const skill of rule.skills) {
      const full = byShort.get(skill)
      if (full !== undefined && !hints.includes(full)) hints.push(full)
    }
  }

  return hints.slice(0, MAX_HINTS)
}
