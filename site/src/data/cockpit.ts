export type ToolIconKind = 'read' | 'edit' | 'bash' | 'search';

export interface CockpitScenario {
  id: string;
  tabIndex: string;
  tabLabel: string;
  modBadge: string;
  accentColor: string;
  problem: string;
  outcome: string;
  caption: string;
  toolRows: readonly {
    icon: ToolIconKind;
    iconColor: string;
    path: string;
    stats: readonly { text: string; color: string }[];
    subnote?: { text: string; color: string };
  }[];
  paneTitle?: string;
  paneLines?: readonly { text: string; color?: string; dim?: boolean; bold?: boolean }[];
  band: {
    color: string;
    sweep?: boolean;
    text: string;
    primaryBtn?: {
      label: string;
      promptFill: string;
    };
    secondaryBtn?: {
      label: string;
      action: 'dismiss' | 'focus-pane';
    };
  };
  statusLine: string;
  defaultPrompt: string;
}

// 100% source-faithful strings derived from mods/{done-gate,tool-row,fog-map,assertion-guard,review-mods,kachi}/hooks/
export const COCKPIT_SCENARIOS: readonly CockpitScenario[] = [
  {
    id: 'guard',
    tabIndex: '①',
    tabLabel: '未テスト完了阻止',
    modBadge: 'done-gate + pr-lamp',
    accentColor: '#FABD2F',
    problem: 'ファイルを書き換えたのに、テストを1回も回さず終わろうとした（--no-verify も試みた）',
    outcome: '自動で警告バーが出現。「検証させる」を押すだけで修正依頼が入力欄に入ります',
    caption: '自動送信はされません。入力欄に入った依頼文を見て、人間が Enter を押すだけです。',
    toolRows: [
      {
        icon: 'read',
        iconColor: '#83A598',
        path: 'src/auth/session.ts',
        stats: [{ text: '148 lines', color: '#A89984' }],
      },
      {
        icon: 'edit',
        iconColor: '#FE8019',
        path: 'src/auth/session.ts',
        stats: [
          { text: '+24', color: '#B8BB26' },
          { text: '−6', color: '#FB4934' },
        ],
      },
      {
        icon: 'bash',
        iconColor: '#FB4934',
        path: 'git commit --no-verify -m "fix: session expiry"',
        stats: [{ text: '✗ ブロック (done-gate)', color: '#FF7A68' }],
        subnote: {
          text: 'done-gate: --no-verify などフックを止める実行はこの環境では禁止です。根本原因を直してください。',
          color: '#FF7A68',
        },
      },
    ],
    band: {
      color: '#FABD2F',
      text: '🧪 未検証の変更があります（テスト/lint/型チェック未実行）',
      primaryBtn: {
        label: '検証させる',
        promptFill:
          '編集した変更がまだ検証されていません。このリポジトリのテスト・lint・型チェック・ビルドのうち、変更に関わるものを実行してください。失敗したら原因を直し、通るまで繰り返してください。',
      },
      secondaryBtn: {
        label: '閉じる',
        action: 'dismiss',
      },
    },
    statusLine: '🟡 PR #42 · ✓4 ✗1 · マージまであと2  │  TODO(agent): 1',
    defaultPrompt: '',
  },
  {
    id: 'sight',
    tabIndex: '②',
    tabLabel: 'テスト改ざん検知',
    modBadge: 'assertion-guard + fog-map + tool-row',
    accentColor: '#8FBCB0',
    problem: 'テストを通すために expect(...).toEqual を勝手に toBeDefined に緩めてごまかした',
    outcome: 'テスト弱体化を差分から即検知。まだ読んでいない import 元ファイルも地図で警告します',
    caption: '数百行のツール出力も自動で1行に圧縮（tool-row）。どこを触ってどこが未確認か一目でわかります。',
    toolRows: [
      {
        icon: 'edit',
        iconColor: '#FE8019',
        path: 'mods/pr-lamp/hooks/lamp.ts',
        stats: [
          { text: '+43', color: '#B8BB26' },
          { text: '−2', color: '#FB4934' },
        ],
      },
      {
        icon: 'edit',
        iconColor: '#FE8019',
        path: 'mods/pr-lamp/tests/lamp.test.ts',
        stats: [
          { text: '+2', color: '#B8BB26' },
          { text: '−2', color: '#FB4934' },
        ],
      },
    ],
    paneTitle: '影響ファイルマップ (/map ペイン)',
    paneLines: [
      { text: '🗺 探索率 38%  ████████░░░░░░░░░░░░  読 27 · 編 4 · ✗ 0 / 82', bold: true },
      { text: '  ▾ mods/pr-lamp/hooks/   ● lamp.ts  +43 −2 ★', color: '#FABD2F' },
      { text: '⚠ lamp.ts を import しているが未読: mods/pr-lamp/hooks/register.tsx', color: '#FABD2F', bold: true },
    ],
    band: {
      color: '#FABD2F',
      text: '🛡 テストを弱めた可能性 1件 (lamp.test.ts) — toEqual → toBeDefined に緩和',
      primaryBtn: {
        label: '理由を尋ねる',
        promptFill:
          'テストを弱めた可能性がある変更について、それぞれの理由を説明してください（/assertion-guard で一覧）:\n- mods/pr-lamp/tests/lamp.test.ts: toEqual を toBeDefined に緩和',
      },
      secondaryBtn: {
        label: '確認済み',
        action: 'dismiss',
      },
    },
    statusLine: '🗺 探索 38% · ●4 · ⚠1  │  🏮 ● :5173',
    defaultPrompt: '',
  },
  {
    id: 'consensus',
    tabIndex: '③',
    tabLabel: '3大AI同時レビュー',
    modBadge: 'review-mods + design-duel',
    accentColor: '#FE9036',
    problem: '書いた本人に「バグない？」と聞いても、自分の思い込みによるゼロ除算バグを見逃す',
    outcome: 'ボタン1つで Claude・Codex・Antigravity が同時チェック。全員一致の危険箇所が最上位に出ます',
    caption: 'わざわざ別ターミナルで Codex に差分をコピペする必要はありません。すべて読み取り専用で安全に走ります。',
    toolRows: [
      {
        icon: 'edit',
        iconColor: '#FE8019',
        path: 'src/billing/prorate.ts',
        stats: [
          { text: '+68', color: '#B8BB26' },
          { text: '−14', color: '#FB4934' },
        ],
      },
    ],
    paneTitle: '3大AI 同時レビュー結果 (/review-mods ペイン)',
    paneLines: [
      { text: 'origin/main との差分 · 2件  （claude ✓ · codex ✓ · agy ✓）', bold: true },
      { text: 'high src/billing/prorate.ts:42 日割り境界0秒でゼロ除算（3者全員が指摘）', color: '#FF7A68', bold: true },
      { text: 'medium src/billing/prorate.ts:87 タイムゾーン跨ぎの端数不一致（codex・agy）', color: '#FABD2F' },
      { text: '★ /design-duel 設計コンペ勝者: codex（案B 17.5/20点）', color: '#8EC07C' },
    ],
    band: {
      color: '#FF7A68',
      text: '🔍 high · prorate.ts:42 日割り境界0秒でゼロ除算（claude・codex・agy） · ほか1件',
      primaryBtn: {
        label: 'Claude に直させる',
        promptFill:
          '[review-mods 指摘データ] src/billing/prorate.ts:42 (claude・codex・agy): 日割り期間の秒数が 0 のときゼロ除算が発生します。境界条件を確認して修正し、回帰テストを追加してください。',
      },
      secondaryBtn: {
        label: '詳細',
        action: 'focus-pane',
      },
    },
    statusLine: '🔍 review 2件  │  🧪 CI ✓ 3/3 1:12',
    defaultPrompt: '',
  },
  {
    id: 'kachi',
    tabIndex: '④',
    tabLabel: '本物の修正で快音',
    modBadge: 'kachi',
    accentColor: '#8FF5AA',
    problem: '6分間ハマっていた3件のテスト失敗を、テスト削除ではなく本体コード修正で突破！',
    outcome: '「本物の修正」と判定された瞬間だけ、緑の光が走って気持ちいいクリック音が鳴ります',
    caption: '無編集の再実行やテストファイルだけの編集では一切鳴りません。本当に直せたときだけ鳴るご褒美です。',
    toolRows: [
      {
        icon: 'bash',
        iconColor: '#FB4934',
        path: 'pnpm test',
        stats: [{ text: '3 failed', color: '#FF7A68' }],
        subnote: {
          text: '◌ kachi: pnpm test が赤。本当の修正で鳴ります',
          color: '#82CA96',
        },
      },
      {
        icon: 'edit',
        iconColor: '#FE8019',
        path: 'src/billing/prorate.ts',
        stats: [
          { text: '+9', color: '#B8BB26' },
          { text: '−3', color: '#FB4934' },
        ],
      },
      {
        icon: 'bash',
        iconColor: '#8EC07C',
        path: 'pnpm test',
        stats: [{ text: '48 passed', color: '#B8BB26' }],
        subnote: {
          text: '✔ 赤→緑  4 回目で · 6m18s 赤だった · 3 → 0 failing',
          color: '#82CA96',
        },
      },
    ],
    band: {
      color: '#A8EFB6',
      sweep: true,
      text: '✔ pnpm test  緑',
      primaryBtn: {
        label: '下の試聴パッドで実際の音を聴く ↓',
        promptFill: '#showcase',
      },
    },
    statusLine: '🟢 PR #42 マージ可能  │  📦 app 2/2',
    defaultPrompt: 'git commit -m "fix(billing): guard zero-duration proration window"',
  },
] as const;
