// Intent rules in priority order: specific scans before generic coding work.
const RULES: ReadonlyArray<{ pattern: RegExp; skills: readonly string[] }> = [
  { pattern: /\b(debug|bug|bugs|error|errors|broken|crash)\b|デバッグ|バグ|エラー|壊れ|動かない/i, skills: ['coding-debug'] },
  { pattern: /\b(security|vulnerab\w*)\b|セキュリティ|脆弱性/i, skills: ['security-scan'] },
  { pattern: /\b(performance|perf|slow)\b|パフォーマンス|遅い/i, skills: ['performance-scan'] },
  { pattern: /\breview\b|レビュー/i, skills: ['coding-review', 'quality-review'] },
  { pattern: /\bresearch\b|調査|リサーチ/i, skills: ['research-route'] },
  { pattern: /\bplan(ning)?\b|計画/i, skills: ['planning-router'] },
  { pattern: /\brefactor\w*|リファクタ/i, skills: ['coding-refactor'] },
  { pattern: /\btests?\b|テスト/i, skills: ['coding-test'] },
  { pattern: /\bimplement\w*|実装/i, skills: ['coding-implement'] },
  { pattern: /\b(ui|ux|design)\b|デザイン/i, skills: ['design-ux', 'ux-scan'] },
  { pattern: /\b(image|images)\b|画像/i, skills: ['image-direction'] },
  { pattern: /\bvague\b|曖昧|いい感じ/i, skills: ['clarify'] },
]

export const MAX_HINTS = 3

export const KNOWN_SKILLS: ReadonlySet<string> = new Set(RULES.flatMap(rule => rule.skills))

/**
 * Skills worth suggesting for `text`, limited to the names in `available`.
 * Empty when the text already names one of the known skills.
 */
export function suggest(text: string, available: ReadonlySet<string>): string[] {
  const lower = text.toLowerCase()
  if ([...KNOWN_SKILLS].some(name => lower.includes(name))) return []

  const hints: string[] = []
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue
    for (const skill of rule.skills) {
      if (available.has(skill) && !hints.includes(skill)) hints.push(skill)
    }
  }

  return hints.slice(0, MAX_HINTS)
}
