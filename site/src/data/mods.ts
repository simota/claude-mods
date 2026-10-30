export type CategoryId = 'guard' | 'sight' | 'consensus' | 'loop' | 'ops';

export interface ModCategoryMeta {
  id: CategoryId;
  labelJa: string;
  labelEn: string;
  accentVar: string;
  summary: string;
}

export interface ModConfigSample {
  json: string;
  note: string;
}

export interface ModEntry {
  name: string;
  category: CategoryId;
  tagline: string;
  detail: string;
  surface: string;
  command: string | null;
  defaultState: '既定オン' | '既定オフ' | '常時自動' | 'コマンド起動';
  configSample?: ModConfigSample;
  starter?: boolean;
  featured?: boolean;
}

export const CATEGORIES: readonly ModCategoryMeta[] = [
  {
    id: 'guard',
    labelJa: '手抜き・バグ防止',
    labelEn: 'ANTI-SLACKING',
    accentVar: 'var(--color-signal-guard)',
    summary: 'テスト未実行の「完了しました」、勝手なテスト削除、--no-verify での逃げを自動でブロックします。',
  },
  {
    id: 'sight',
    labelJa: '画面整理・影響マップ',
    labelEn: 'CLEAN VIEW',
    accentVar: 'var(--color-signal-sight)',
    summary: '何百行ものツール出力を1行に畳み、まだ読んでいない影響ファイルやブラウザ操作を見える化します。',
  },
  {
    id: 'consensus',
    labelJa: '3大AI同時レビュー',
    labelEn: '3-AI REVIEW',
    accentVar: 'var(--color-signal-consensus)',
    summary: 'ボタン1つで Claude・Codex・Antigravity の3つに同時コードレビューや設計コンペをさせます。',
  },
  {
    id: 'loop',
    labelJa: 'エラー記憶・達成音',
    labelEn: 'MEMORY & SOUND',
    accentVar: 'var(--color-signal-verified)',
    summary: '過去のエラー解決法を覚えて再発時に教え、本物のコード修正で緑になった瞬間だけ快音で祝います。',
  },
  {
    id: 'ops',
    labelJa: 'PR・ローカルCI・環境',
    labelEn: 'PR & LOCAL CI',
    accentVar: 'var(--color-signal-ops)',
    summary: 'PRのマージ残り条件、push前のGitHub Actions実行、開発サーバの死活を1画面に集めます。',
  },
] as const;

export const MODS: readonly ModEntry[] = [
  {
    name: 'done-gate',
    category: 'guard',
    tagline: 'テスト未実行の「完了」を自動で止め、同じ失敗の連打や git --no-verify もブロック',
    detail: '編集後にテスト・lint・型チェック・ビルドが通らないまま終わると警告バーを表示。ボタンを押すだけで修正依頼が入り、HUSKY=0 等の抜け道も防ぎます。',
    surface: '入力欄上の警告バー + Bashガード',
    command: null,
    defaultState: '常時自動',
    starter: true,
    featured: true,
  },
  {
    name: 'assertion-guard',
    category: 'guard',
    tagline: 'テストを通すために expect を消す・期待値を緩める「ズル編集」を自動検知',
    detail: 'toEqual→toBeDefined の緩和、it.skip、catch {} によるエラー握りつぶしを差分から拾い、Claudeに理由の説明か元に戻すよう求めます。',
    surface: '入力欄上の警告バー + `/assertion-guard`',
    command: '/assertion-guard',
    defaultState: '常時自動',
    featured: true,
  },
  {
    name: 'self-audit',
    category: 'guard',
    tagline: 'メイン履歴を汚さない分岐判定（会話 fork）で返答を CLAUDE.md の報告ルールと照合',
    detail: '根拠なき完了宣言、1行目が結論でない返答、未検証の断定、チェック回避、スコープ膨張を実在引用付きで監査します。',
    surface: '入力欄上の帯 + `/self-audit`',
    command: '/self-audit',
    defaultState: '既定オン',
    configSample: { json: '{"minChars":120}', note: '監査する最小返答文字数を変更（既定200）' },
  },
  {
    name: 'prompt-coach',
    category: 'guard',
    tagline: '完了条件や対象が曖昧なプロンプトの送信を一旦止め、具体化候補を提示',
    detail: 'a/b/d で推定候補を入力、s でそのまま送信、e で完了条件を追記。保留した下書きは /clear や終了をまたいでも失われません。',
    surface: 'プロンプト送信前帯',
    command: null,
    defaultState: '既定オン',
    configSample: { json: '{"timeoutMs":2000}', note: '送信前判定のタイムアウト上限を変更（既定3000ms）' },
  },
  {
    name: 'negative-space',
    category: 'guard',
    tagline: '認可・入力検証・エラー処理の追加時に、未カバーの拒否ケース・境界値テストを提案',
    detail: '変更箇所の関数や条件に対し、セッション内で触れたテストがまだ試していない 403・不正入力・N-1/N/N+1 境界値を抽出します。',
    surface: '入力欄上の帯 + `/negative-space`',
    command: '/negative-space',
    defaultState: '常時自動',
  },
  {
    name: 'mutation-tap',
    category: 'guard',
    tagline: 'HEAD からの変更行だけにミューテーションテストを実行し、見逃された改変を一覧化',
    detail: 'APFS の cp -c 等の CoW 複製上で比較反転や定数+1を実行するため、作業ツリーや稼働中の開発サーバを一切汚しません。',
    surface: 'ペイン `/mutate`',
    command: '/mutate',
    defaultState: 'コマンド起動',
    configSample: { json: '{"maxMutants":10}', note: '1回の /mutate で試す上限数を変更（既定20）' },
  },
  {
    name: 'tool-row',
    category: 'sight',
    tagline: '何百行も流れる Read / Edit / Bash の出力を、色分けされたスッキリ1行に自動圧縮',
    detail: '編集の +A −D 行数、Read した行数、コマンドの成否だけを1行に残し、エラー時以外の長大なログを自動で畳みます（ターミナル専用）。',
    surface: 'ターミナル 1行表示',
    command: null,
    defaultState: '既定オン',
    configSample: { json: '{"compact":false}', note: '1行圧縮を一時オフにして標準表示へ戻す' },
    starter: true,
    featured: true,
  },
  {
    name: 'fog-map',
    category: 'sight',
    tagline: '編集したファイルを import しているのに、まだ一度も読んでいない関連ファイルを警告',
    detail: 'リポジトリの探索率を地図表示し、変更の影響で壊れるかもしれない未読の JS/TS・Python ファイルを先回りして教えます。',
    surface: 'ステータス行 + ペイン `/map`',
    command: '/map',
    defaultState: '常時自動',
    featured: true,
  },
  {
    name: 'agent-pane',
    category: 'sight',
    tagline: '実行中・完了済みのサブエージェントを経過時間と結果（✓/✗/停止）付きで一覧表示',
    detail: 'フルスクリーンターミナルでは最初の Agent 呼び出し時に1回だけ自動で開き、ステータス行に実行中件数を出します。',
    surface: 'ステータス行 + ペイン `/agent-pane`',
    command: '/agent-pane',
    defaultState: '常時自動',
  },
  {
    name: 'browser-cam',
    category: 'sight',
    tagline: 'Claude が操作中のブラウザの最新スクリーンショット・URL・直近8操作をペイン表示',
    detail: 'URL中のトークンは伏せ字化し、フォーム入力文字列はパスワード保護のため文字数のみ（type ‹7文字›）を記録します。',
    surface: 'ペイン `/cam`',
    command: '/cam',
    defaultState: '既定オン',
    configSample: { json: '{"autoOpen":false}', note: '初回ブラウザ操作時の自動ペイン展開をオフにする' },
  },
  {
    name: 'image-preview',
    category: 'sight',
    tagline: '読み書き・生成した画像のサムネイルをツール行直下と `/images` ペインに表示',
    detail: 'Ghostty / kitty の kitty graphics に対応。非PNG画像はツール応答後に macOS sips で非同期変換し、処理を待たせません。',
    surface: 'ツール行直下 + ペイン `/images`',
    command: '/images',
    defaultState: '既定オン',
    configSample: { json: '{"maxRows":16}', note: 'インラインサムネイルの最大行数を変更（既定12）' },
  },
  {
    name: 'visual-diff',
    category: 'sight',
    tagline: '編集前後の同一URL・同一サイズ画面を32列セルで比較し、変化領域と編集ファイルを対比',
    detail: 'ブラウザ操作後のタブURLを追跡し、ピクセル座標での変化領域と間に編集されたソースファイルを並べて確認できます。',
    surface: 'ペイン `/vdiff`',
    command: '/vdiff',
    defaultState: 'コマンド起動',
  },
  {
    name: 'token-lens',
    category: 'sight',
    tagline: 'ページ要素の実測スタイルを CSS 変数・SCSS・tokens JSON と照合し独自値を検出',
    detail: '色・余白・角丸・タイポグラフィを登録済みデザイントークンと突き合わせ、トークン外の値には最寄り候補を提示します。',
    surface: 'コマンド `/token-lens`',
    command: '/token-lens',
    defaultState: 'コマンド起動',
  },
  {
    name: 'review-mods',
    category: 'consensus',
    tagline: 'ボタン1つで Claude・Codex・Antigravity の3大AIに同時コードレビューを依頼',
    detail: '3つのCLIが書き換え不可で差分を同時チェック。同じ箇所の指摘は1件にまとめ、複数AIが一致した危険バグを最上位に出します。',
    surface: '入力欄上のバー + `/review-mods`',
    command: '/review-diff',
    defaultState: '常時自動',
    configSample: { json: '{"reviewers":"claude,codex","timeoutMin":10}', note: '使用するCLIと制限分数を指定' },
    featured: true,
  },
  {
    name: 'design-duel',
    category: 'consensus',
    tagline: '実装前に Claude・Codex・Antigravity が別々に設計案を出し、名前を伏せて相互採点',
    detail: '案A・B・Cとして匿名で20点満点採点＋最大の弱点を指摘し合い、一番筋の良い設計案を選んで Claude に作らせられます。',
    surface: '入力欄上のバー + `/design-duel`',
    command: '/design-duel',
    defaultState: 'コマンド起動',
    configSample: { json: '{"revise":true}', note: '反論への回答と修正案の再採点ラウンドを有効化' },
    featured: true,
  },
  {
    name: 'kachi',
    category: 'loop',
    tagline: '落ちていたテストが「本物のコード修正」で通った瞬間だけ、緑の光と快音で祝福',
    detail: '無編集の再実行やテスト削除では一切鳴りません。苦労した回数と時間に応じて tick〜bell の4段階の音が鳴り、戦績を残します。',
    surface: '入力欄上の光スイープ + 効果音',
    command: null,
    defaultState: '既定オン',
    configSample: { json: '{"sound":"quiet","minTier":"tick"}', note: '控えめ音量＋初回グリーンも通知対象にする' },
    starter: true,
    featured: true,
  },
  {
    name: 'loopback',
    category: 'loop',
    tagline: 'self-audit・done-gate・sandbox-lens の発見を次のプロンプトに自動添付して返送',
    detail: '人が毎回手で指摘を打ち直す手間を削減（既定オフ・要有効化）。未導入の検出mod分は空として安全に扱い、hit-rate の低精度ルールを自動除外します。',
    surface: 'プロンプト自動添付 + `/loopback`',
    command: '/loopback',
    defaultState: '既定オフ',
    configSample: { json: '{"enabled":true}', note: '既定オフの次プロンプト自動添付を有効化' },
  },
  {
    name: 'hit-rate',
    category: 'loop',
    tagline: '各検出modの発見をその後のセッション結果から当たり/外れ判定し、ルール別的中率を記録',
    detail: '追加のLLM呼び出しゼロで TP/FP を計測（既定オフ・要有効化）。判定20件以上で的中率 0.5 未満のルールを loopback から自動ミュートします。',
    surface: 'コマンド `/hit-rate`',
    command: '/hit-rate',
    defaultState: '既定オフ',
    configSample: { json: '{"enabled":true,"minN":20,"threshold":0.5}', note: '既定オフの的中率計測を有効化' },
  },
  {
    name: 'zukan',
    category: 'loop',
    tagline: 'リポジトリ横断のエラー図鑑。Bashエラーと突破したコマンドを記憶し再会時に提示',
    detail: '続く10回以内に成功した同系コマンドを解決策として記録。認証情報は自動マスクし、最大300種を保持します。',
    surface: 'ツール結果横 + ペイン `/zukan`',
    command: '/zukan',
    defaultState: '常時自動',
    featured: true,
  },
  {
    name: 'todo-agent',
    category: 'loop',
    tagline: 'Claudeの返答行頭にある `#TODO(agent):` をプロジェクト別に収集しペインで完了管理',
    detail: '文中の言及やサブエージェント出力は誤検出せず、未完了件数をステータスラインに常時表示します。',
    surface: 'ステータス行 + ペイン `/todos`',
    command: '/todos',
    defaultState: '常時自動',
  },
  {
    name: 'pr-lamp',
    category: 'ops',
    tagline: '現在ブランチのPRを信号灯表示。CI・レビュー・マージ残件を追い、赤チェックをClaudeへ伝達',
    detail: 'マージまでの残り条件が0になると `🟢 マージ可能` に変化。失敗ジョブのログ末尾40行や新規レビューコメントを次ターンへ渡せます。',
    surface: 'ステータス行 + ペイン `/pr`',
    command: '/pr',
    defaultState: '常時自動',
    configSample: { json: '{"feed":true}', note: '赤チェックや新着レビューコメントの次ターン添付' },
    featured: true,
  },
  {
    name: 'ci-rehearsal',
    category: 'ops',
    tagline: 'push前にボタン1つで GitHub Actions ワークフローを runthrough でローカル実行',
    detail: '要 runthrough CLI（Docker またはホスト実行）。失敗ジョブとログ末尾40行をデータ引用して入力欄へ挿入し、機密値は自動マスクします。',
    surface: '入力欄上の帯 + ペイン `/ci`',
    command: '/ci-run',
    defaultState: '常時自動',
    configSample: { json: '{"mode":"container","scope":"worktree"}', note: 'Docker上で未コミット変更を含めて実行' },
    featured: true,
  },
  {
    name: 'stack-dock',
    category: 'ops',
    tagline: 'devrouter のローカル開発スタックを1ボタンで起動し、各サービスのURLと死活を監視',
    detail: '要 devrouter + Docker。コンテナ状態と HTTP 応答を定期確認し、障害時は devrouter doctor とログ末尾を入力欄へ挿入できます。',
    surface: '入力欄上の帯 + ステータス行 + `/stack`',
    command: '/stack',
    defaultState: '常時自動',
    configSample: { json: '{"auto":"session-start","pollSec":10}', note: 'セッション開始時に停止中スタックを自動起動' },
  },
  {
    name: 'side-effect-ledger',
    category: 'ops',
    tagline: 'push・公開・デプロイ・PR・外部API更新など Git 差分に出ない操作と取消方法を台帳化',
    detail: 'git push の戻しコマンド等を出力から自動生成。取消が容易でない未確認操作は14日間セッションをまたいで繰り越し警告します。',
    surface: 'ステータス行 + ペイン `/ledger`',
    command: '/ledger',
    defaultState: '常時自動',
  },
  {
    name: 'port-lantern',
    category: 'ops',
    tagline: '起動した開発サーバのURL・ポート・lsof生存状態・直近ログをステータス行とペインに表示',
    detail: 'pnpm dev や vite、uvicorn 等の出力からポートを自動検出し、起動・停止をトーストと `🏮 ● :5173` で通知します。',
    surface: 'ステータス行 + ペイン `/ports`',
    command: '/ports',
    defaultState: '常時自動',
  },
  {
    name: 'artifact-shelf',
    category: 'ops',
    tagline: 'セッションが生成した CSV・PDF・HTML・動画・パッチを依頼プロンプトと紐付けて棚に整理',
    detail: 'ファイル更新を実確認してからリポジトリ別に最大300件保存。種類・拡張子・時刻・語句から即座に検索できます。',
    surface: 'ペイン `/shelf`',
    command: '/shelf',
    defaultState: '常時自動',
  },
  {
    name: 'perf-delta',
    category: 'ops',
    tagline: 'ベンチマークの前後や任意 git ref を一時 worktree で比較し、実行時間・メモリ・有意差を算出',
    detail: '中央値・標準偏差・変動係数（CV）を計測し、差が2SDかつ1%を超える場合のみ統計的に有意と判定します。',
    surface: 'コマンド `/perf`',
    command: '/perf',
    defaultState: 'コマンド起動',
    configSample: { json: '{"runs":7}', note: 'ウォームアップ後の計測反復回数を変更（既定5）' },
  },
  {
    name: 'journey-trace',
    category: 'ops',
    tagline: 'Claudeのブラウザ操作手順と期待状態を記録し、Markdownバグ報告やPlaywright下書きに変換',
    detail: 'パスワードやトークン入力は自動で伏せ字化し、E2Eテスト出力では環境変数参照（process.env.JOURNEY_SECRET_n）に置き換えます。',
    surface: 'コマンド `/journey`',
    command: '/journey',
    defaultState: 'コマンド起動',
  },
  {
    name: 'sandbox-lens',
    category: 'ops',
    tagline: 'Bash出力に現れた sandbox 拒否を集計し、ホスト・パス・許可設定のヒントを一覧報告',
    detail: '設定ファイル自体は勝手に書き換えず、loopbackアドレスには全ポート開放を防ぐポート付き設定例を提示します。',
    surface: 'コマンド `/sandbox-report`',
    command: '/sandbox-report',
    defaultState: '常時自動',
  },
] as const;

export interface StarterPreset {
  id: string;
  label: string;
  subtitle: string;
  mods: readonly string[];
}

export const STARTER_PRESETS: readonly StarterPreset[] = [
  {
    id: 'core3',
    label: '迷ったらこれ！基本の3選',
    subtitle: '未テスト完了防止・ログ1行化・バグ解決音の定番セット',
    mods: ['done-gate', 'tool-row', 'kachi'],
  },
  {
    id: 'guard-pack',
    label: 'AIの手抜き完全ブロック 5選',
    subtitle: '未テスト完了・テスト改ざん・確認漏れを自動で止める',
    mods: ['done-gate', 'assertion-guard', 'self-audit', 'fog-map', 'negative-space'],
  },
  {
    id: 'consensus-pack',
    label: '3大AI同時レビュー & PR 4選',
    subtitle: 'Claude・Codex・Antigravity 同時監査と push 前ローカルCI',
    mods: ['review-mods', 'design-duel', 'ci-rehearsal', 'pr-lamp'],
  },
  {
    id: 'all29',
    label: '全 29 プラグイン一括導入',
    subtitle: '全29プラグインをまとめて一括導入',
    mods: MODS.map((m) => m.name),
  },
] as const;
