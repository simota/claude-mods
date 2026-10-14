# claude-mods

[English](README.md) | 日本語

個人用の Claude Code mod（function hook の plugin）集です。1 つの marketplace として公開しています。

| Mod | できること |
| --- | --- |
| `agent-pane` | セッションのサブエージェントをペインで表示。実行中は経過時間、完了したものは結果と所要時間 |
| `done-gate` | 未検証の変更を指摘し、同じ失敗の繰り返しを止め、`git --no-verify` を拒否 |
| `sandbox-lens` | Bash 出力に現れた sandbox の拒否を集計し、`/sandbox-report` で報告 |
| `battle-report` | ターンごとに RPG 風の戦果報告（トークン、編集数、増減行数、ツールエラー）をトースト・通知・効果音で |
| `skill-hint` | 入力したプロンプトに合う skill を最大 3 件、入力欄の上に提案（自動では起動しない） |
| `todo-agent` | Claude の返答にある `#TODO(agent)` をプロジェクトごとに集め、`/todos` ペインで管理 |
| `context-meter` | 入力欄の上に、ターンごとのコンテキスト使用率のスパークライン（Gruvbox 配色）とトークン数・コスト |
| `tool-row` | 完了したツール呼び出しの行を、Nerd Font のアイコンと Gruvbox 配色の 1 行に描き直す |
| `image-preview` | セッションが書き出し・読み込み・生成した画像のサムネイルを、ツール行の下と `/images` ペインに表示 |
| `quick-actions` | ターン終了後、入力欄の上にホットキー付きボタン（チェック実行、差分レビュー、コミットの下書き、続けて） |
| `self-audit` | ターンごとに会話の fork（キャッシュ利用）で Claude 自身の返答を CLAUDE.md の報告ルールに照らし、違反を入力欄の上に表示 |
| `context-diet` | skill 一覧をプロジェクトの種類に必要なものだけに絞る（既定オフ）。`/context-diet` で省いた skill と削減トークン数を表示 |
| `browser-cam` | Claude が操作中のブラウザをペインで表示。Claude in Chrome の最新スクリーンショット、ページの URL、直近の操作 |
| `prompt-coach` | 曖昧に見えるプロンプト（完了条件がない、対象が不明確）の送信を止め、そのまま送るか補足するかを選ばせる（既定オフ） |

## インストール

ターミナルのセッションのプロンプトで:

```
/plugin install <mod> --marketplace simota/claude-mods
```

シェルから:

```
claude plugin install <mod> --marketplace simota/claude-mods
```

このリポジトリは private です。インストールには、GitHub での読み取り権限と、そのマシンにある github.com 用の git 認証情報（SSH 鍵、または `gh auth login` のあと `gh auth setup-git`）が必要です。

## 使い方

設定は、セッション内では `/plugin configure <mod>@simota-mods`、シェルからは次のコマンドで変えられます。

```
echo '{"enabled":"true"}' | claude plugin configure <mod>@simota-mods --values-stdin
```

設定の変更は再起動後に反映されます。入力欄の上の帯は積み重なります。各 mod は、他の mod が描いた内容の上に自分の行を描きます。

### agent-pane

- `/agents` でペインを開きます。実行中のサブエージェントが経過時間付きで先に並び、その後に完了したものが ✓/✗ と所要時間付きで並びます。
- フルスクリーンのターミナルでは、セッションで最初に Agent を呼んだときに自動で開きます。
- 実行中のものがある間は、ステータス行に `agents: N running` と出ます。

### done-gate

コマンドはなく、自動で働きます。

- ファイルを編集したあとにテスト・lint・型チェック・ビルドを実行せずにターンが終わると、「未検証の変更があります」の帯が出ます。その後チェックを実行するか、「閉じる」を押すと消えます。
- 同じ Bash コマンドが同じエラーで 2 回失敗すると、再試行をやめて根本原因を調べるよう Claude に伝えます（コマンドごとに 1 回）。
- `git commit|push|merge … --no-verify`（と `git commit -n`）を拒否します。

### sandbox-lens

- `/sandbox-report` で、Bash の出力に現れた sandbox の拒否を、このセッション分と全期間分の両方について一覧表示します。拒否されたホストやパス、回数、最終発生時刻、コマンド例、許可する場合の設定を出します。
- `/sandbox-report reset` で記録を消去します。
- ヒントを出すだけで、sandbox の設定は変更しません。loopback やプライベートアドレスはポート付きでヒントに出します（例: `127.0.0.1:3000`）。ポートなしで登録すると全ポートが開くためです。

### battle-report

ターンが終わるたびに、そのターンのトークン数、編集数、増減行数（`git diff --shortstat HEAD`）、ツールエラー数を、トースト・OS 通知・効果音で知らせます。

| 設定 | 既定値 | |
| --- | --- | --- |
| `sound` | `true` | エラーなしなら Glass、ツールエラーがあれば Basso（afplay、macOS） |
| `notify` | `true` | トーストに加えて OS 通知も出す |

### skill-hint

プロンプトを入力すると、合いそうな skill を最大 3 件、入力欄の上に出します（`💡 skill候補: /coding-debug …`）。出すのはセッションに実在する skill だけです。自動で起動はしません。「閉じる」か次のプロンプトで消えます。slash コマンドや、すでに skill 名を含むプロンプトには出しません。

### todo-agent

- Claude の返答にある `#TODO(agent): <action>` の行を、プロジェクト（リポジトリのルートか cwd）ごとに集めます。
- `/todos` で、このプロジェクトの未完了項目をペインに出します。各項目に「完了」ボタンがあります。
- `/todos all` で、全プロジェクトの項目をテキストで一覧表示します。
- 未完了の項目がある間は、ステータス行に `TODO(agent): N` と出ます。

### context-meter

ターンごとのコンテキスト使用率のスパークラインと、`ctx 63% ▲4 · in 120k / out 8k · $1.23` を帯に出します。使用率は 50% から黄色、80% から赤になります。

| 設定 | 既定値 | |
| --- | --- | --- |
| `band` | `true` | 帯を描く（オフでも記録は続ける） |

### tool-row

完了したツール呼び出しを、Nerd Font のアイコン付きの 1 行に描き直します。Edit/Write は ` path +A −D`、Read は行数付き、Bash は所要時間付き（エラーなら赤）で、Agent、Web、MCP の呼び出しにも対応します。結果はこれまでどおり Claude Code が下に描きます。ターミナルのみです。

| 設定 | 既定値 | |
| --- | --- | --- |
| `compact` | `true` | オフにすると、すべての行を Claude Code の元の表示のままにする |

### image-preview

- セッションが書き出した画像、読み込んだ画像、Bash コマンドが生成した画像（png、jpg、jpeg、webp、gif）について、ターミナルではそのツール行の下にサムネイルを出します（kitty graphics 対応の Ghostty、kitty）。
- `/images` でペインを開きます。新しい順に並び、`h`/`l` で切り替えます。
- PNG 以外は macOS の `sips` で変換します。

| 設定 | 既定値 | |
| --- | --- | --- |
| `inline` | `true` | ツール行の下にサムネイルを出す |
| `maxRows` | `12` | サムネイルが使える行数（1〜60） |

### quick-actions

ターンが終わるたびに、入力欄の上にホットキー付きのボタンを並べます。

- 編集があったとき: `1: テスト実行`、`2: 差分レビュー`（`/code-review`）、`3: コミット`（入力欄に下書きするだけで、自分ではコミットしない）
- 常に: `c: 続けて`、`x: 閉じる`

数字キーは入力欄が空なら押せます。文字キーは帯にフォーカスがあるとき（ctrl+x tab かクリック）に押せます。

| 設定 | 既定値 | |
| --- | --- | --- |
| `actions` | 上記の既定 | 既定を置き換える `{key,label,prompt,mode:'submit'\|'fill',when:'edits'\|'always'}` の JSON 配列。JSON が不正なら既定に戻し、トーストで知らせる |

### self-audit

`minChars` 文字以上の返答ごとに、会話の fork（道具なし、ほぼプロンプトキャッシュから読まれる）で CLAUDE.md のルールに照らしてチェックします。対象は、根拠なしの完了宣言、1 行目が結果になっていない、未検証の断定、チェックの回避、範囲の膨張です。違反は入力欄の上に赤字で出ます。「詳細」か `/self-audit` で、引用と fork の消費トークンを含むペインを開きます。

| 設定 | 既定値 | |
| --- | --- | --- |
| `enabled` | `true` | |
| `minChars` | `200` | これより短い返答はチェックしない |

コスト: ターンごとに、セッションのモデルで追加リクエストが 1 回走ります。キャッシュが冷えていると（5 分以上空いた後やモデルの切り替え後）、会話全体を送り直します。

### context-diet

既定はオフです。オンにすると、skill 一覧をプロジェクトの種類に必要なものだけに絞ります。種類（Swift、Android、Rust、Web、Python、Go）は、リポジトリのルートとその 1 階層下から判定します。coding、quality、planning、research 系の skill は常に残し、red-team、persona、operation 系は省きます。image と design 系は Rust、Python、Go のときに省きます。省いた skill でも、プロンプトで名前を出せば、そのプロンプトには説明を添えます。

- `/context-diet` で、プロジェクトの種類、残した skill と省いた skill、削減トークン数（推定）を表示します。
- `/context-diet on|off|reset` で、このセッションだけ設定を上書きします。切り替えると一覧を組み直すので、プロンプトキャッシュが 1 回効かなくなります。

| 設定 | 既定値 | |
| --- | --- | --- |
| `enabled` | `false` | |
| `keep` | | 常に残す名前か `prefix*` のカンマ区切り。`drop` より優先 |
| `drop` | | 常に省く名前か `prefix*` のカンマ区切り |

### browser-cam

- Claude が Chrome を操作している間（Claude in Chrome のツール）、ペインに最新のスクリーンショット、ページのタイトルと URL、直近 8 件の操作（✓/✗）を出します。
- `/cam` でペインを開閉します。フルスクリーンのターミナルでは、最初のブラウザ操作のときに自動で開きます。
- デスクトップアプリでは、キャプションと操作一覧だけを出します。

| 設定 | 既定値 | |
| --- | --- | --- |
| `autoOpen` | `true` | 最初のブラウザ操作で開く（フルスクリーンのターミナル） |

### prompt-coach

既定はオフです。オンにすると、曖昧に見えるプロンプトの送信を止めます。曖昧とは、完了条件がなく対象も不明確な場合や、「いい感じ」のような評価語しかない場合です。帯には足りない点と書き直し案が出ます。

- `1: このまま送る` で、そのまま送ります
- `2: 補足して送る` で、`完了条件: ` を付けて入力欄に戻します
- `x` で、元の文を入力欄に戻します

slash コマンド、短いプロンプト、ターンの実行中に打ったプロンプトは判定しません。タイムアウトやエラーのときはそのまま送ります。同じ文を 2 回止めることはありません。送信は最大 `timeoutMs` 待つことがあります。

| 設定 | 既定値 | |
| --- | --- | --- |
| `enabled` | `false` | |
| `model` | `claude-haiku-5-5` | 判定に使うモデル |
| `timeoutMs` | `3000` | 500〜3000 |

## 開発

```
claude plugin validate mods/<mod>
claude plugin test mods/<mod>
claude --plugin-dir mods/<mod>
```
