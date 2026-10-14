// Intent rules in priority order: specific scans before generic coding work. Each pattern
// needs the intent, not a word that happens to contain it: "error handling" is not a bug,
// コンテスト is not a テスト, and いい感じです thanks rather than asks.
const RULES: ReadonlyArray<{ pattern: RegExp; skills: readonly string[] }> = [
  {
    pattern:
      /\b(bugs?|debug(ging)?|broken|crash(es|ed|ing)?|fail(s|ed|ing)?|regression|stack ?trace|traceback)\b|\berrors?\b(?!\s+(handling|handler|handlers|messages?|codes?|types?|boundar(y|ies)|pages?))|デバッグ|バグ|エラー(?!処理|ハンドリング|メッセージ|コード)|壊れ|動かない|落ちる|クラッシュ/i,
    skills: ['coding-debug'],
  },
  { pattern: /\b(security|vulnerab\w*)\b|セキュリティ|脆弱性/i, skills: ['security-scan'] },
  { pattern: /\b(performance|perf|slow)\b|パフォーマンス|遅い/i, skills: ['performance-scan'] },
  { pattern: /\breview\b|レビュー/i, skills: ['coding-review', 'quality-review'] },
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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The part a person types for a plugin skill: `anthropic-skills:pdf` is asked for as `pdf`. */
const shortName = (name: string) => name.slice(name.lastIndexOf(':') + 1)

/**
 * Whether `text` already names a skill: `/name` anywhere, or a hyphenated or scoped name
 * (`coding-debug`, `anthropic-skills:pdf`) as a whole token. A one-word name in prose
 * ("can you clarify why…") is an ordinary word, not a choice of skill.
 */
function namesSkill(text: string, names: readonly string[]): boolean {
  return names.some(name => {
    const word = escape(name)
    if (new RegExp(`(^|\\s)/${word}(?![\\w-])`, 'i').test(text)) return true
    return /[-:]/.test(name) && new RegExp(`(?<![\\w/:-])${word}(?![\\w-])`, 'i').test(text)
  })
}

/**
 * Skills worth suggesting for `text`, among the session's command names `available`
 * (a plugin's skill matches by the part after its `plugin:` scope and is suggested in full).
 * Empty when the text already names one of them.
 */
export function suggest(text: string, available: Iterable<string>): string[] {
  const names = [...available]
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
