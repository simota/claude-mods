import { ICONS, renderCmdTokens } from './icons';

export function renderWorkflowAndFooter(): string {
  return `
  <section class="section workflow-section" id="setup" aria-labelledby="setup-heading">
    <div class="container">
      <div class="section-header reveal">
        <span class="section-kicker section-kicker--ops">1分で完了・いつでも着脱自由</span>
        <h2 id="setup-heading" class="section-title">
          入れ方は1コマンド。<br class="br-desktop" />設定変更も削除もその場ですぐ完了。
        </h2>
      </div>

      <ol class="steps-grid reveal">
        <li class="step-card">
          <span class="step-num">STEP 01</span>
          <h3>欲しいプラグインを1行で追加</h3>
          <p>
            シェルから <code>claude plugin install</code>（または Claude Code 内の入力欄から <code>/plugin install</code>）を実行するだけ。1個からすぐ試せます。
          </p>
          <div class="step-snippet-box">
            <code class="step-snippet" id="step-cmd-1">${renderCmdTokens('claude plugin install done-gate --marketplace simota/claude-mods')}</code>
            <button
              type="button"
              class="step-copy-btn"
              data-copy-target="step-cmd-1"
              data-orig-label="コピー"
              aria-label="STEP 01 のインストールコマンドをコピー"
            >
              <span class="copy-icon-default">${ICONS.copy}</span>
              <span class="copy-icon-done" hidden>${ICONS.check}</span>
              <span class="copy-label">コピー</span>
            </button>
          </div>
        </li>

        <li class="step-card">
          <span class="step-num">STEP 02</span>
          <h3>設定変更も再起動なしで即反映</h3>
          <p>
            入れた瞬間から自動でチェックや1行整理が働きます。音量やオプションを変えたいときは <code>/plugin configure</code> で作業を止めずに変更できます。
          </p>
          <div class="step-snippet-box">
            <code class="step-snippet" id="step-cmd-2">${renderCmdTokens('/plugin configure kachi@simota-mods')}</code>
            <button
              type="button"
              class="step-copy-btn"
              data-copy-target="step-cmd-2"
              data-orig-label="コピー"
              aria-label="STEP 02 の設定コマンドをコピー"
            >
              <span class="copy-icon-default">${ICONS.copy}</span>
              <span class="copy-icon-done" hidden>${ICONS.check}</span>
              <span class="copy-label">コピー</span>
            </button>
          </div>
        </li>

        <li class="step-card">
          <span class="step-num">STEP 03</span>
          <h3>合わなければ1コマンドで削除</h3>
          <p>
            Git設定や作業ファイルを汚すことはありません。一時オフ（<code>disable</code>）やアンインストールも1行でクリーンに行えます。
          </p>
          <div class="step-snippet-box">
            <code class="step-snippet" id="step-cmd-3">${renderCmdTokens('claude plugin uninstall done-gate@simota-mods')}</code>
            <button
              type="button"
              class="step-copy-btn"
              data-copy-target="step-cmd-3"
              data-orig-label="コピー"
              aria-label="STEP 03 のアンインストールコマンドをコピー"
            >
              <span class="copy-icon-default">${ICONS.copy}</span>
              <span class="copy-icon-done" hidden>${ICONS.check}</span>
              <span class="copy-label">コピー</span>
            </button>
          </div>
        </li>
      </ol>
    </div>
  </section>

  <section class="section faq-section" id="faq" aria-labelledby="faq-heading">
    <div class="container faq-layout">
      <div class="faq-intro reveal">
        <span class="section-kicker section-kicker--muted">導入前のギモンを解消</span>
        <h2 id="faq-heading" class="section-title">よくある質問</h2>
        <p class="section-desc">
          すべての回答はリポジトリ内の実際のコード（<code>mods/*/hooks/</code>）に基づいています。
        </p>
      </div>

      <div class="faq-list reveal">
        <details class="faq-item" open>
          <summary><span class="faq-q">29個ぜんぶ入れる必要がありますか？重くなりませんか？</span></summary>
          <div class="faq-answer">
            <p>
              いいえ、1個単位で好きなものだけ入れられます。各プラグインは完全に独立しており、画像変換や効果音再生もツールの返答を待たせない非同期処理になっているため、普段のレスポンスを邪魔しません（なお <code>self-audit</code> を入れた場合のみ、200文字以上の返答ごとにキャッシュ利用の軽量ルール照合が1回走ります）。
            </p>
          </div>
        </details>

        <details class="faq-item">
          <summary><span class="faq-q">勝手にプロンプトを送信したり、Git設定やコードを書き換えたりしませんか？</span></summary>
          <div class="faq-answer">
            <p>
              一切しません。「検証させる」「Claude に直させる」などのボタンを押しても、あなたの入力欄に依頼文の下書きが入るだけです。送信するかどうかは必ず人間が決めます。また、設定ファイルを裏で書き換えたり作業ツリーを汚したりすることもありません。
            </p>
          </div>
        </details>

        <details class="faq-item">
          <summary><span class="faq-q"><code>review-mods</code> や <code>design-duel</code> は Codex や Antigravity が無くても動きますか？</span></summary>
          <div class="faq-answer">
            <p>
              はい。<code>claude</code>・<code>codex</code>・<code>agy</code>（Antigravity CLI）のうち、手元のマシンに入っていてログイン済みのものを使って自動で動きます（<code>review-mods</code> は1つ以上、相互採点する <code>design-duel</code> は2つ以上あれば実行可能）。
            </p>
          </div>
        </details>

        <details class="faq-item">
          <summary><span class="faq-q">エラー履歴やログに API キーやパスワードが残ってしまう心配はありませんか？</span></summary>
          <div class="faq-answer">
            <p>
              履歴を残すプラグイン（<code>zukan</code>・<code>sandbox-lens</code>・<code>side-effect-ledger</code>・<code>browser-cam</code> 等）には専用のマスク処理が組み込まれており、<code>Authorization</code> ヘッダや Cookie、URL内の認証情報、環境変数の秘密鍵、パスワード入力値を保存前に自動で伏せ字にします。
            </p>
          </div>
        </details>

        <details class="faq-item">
          <summary><span class="faq-q">ターミナル版だけでなく Claude Desktop アプリでも使えますか？</span></summary>
          <div class="faq-answer">
            <p>
              警告バー・ステータス表示・ペインを使う大半のプラグインはデスクトップアプリでも動作します（<code>tool-row</code> の1行描き直しと、Ghostty / kitty 向けのインライン画像サムネイル表示のみターミナル専用です）。
            </p>
          </div>
        </details>

        <details class="faq-item">
          <summary><span class="faq-q">「既定オフ」と書かれているプラグインがあるのはなぜですか？</span></summary>
          <div class="faq-answer">
            <p>
              <code>loopback</code>（指摘の次プロンプト自動添付）と <code>hit-rate</code>（的中率の計測）は、次のプロンプトへ自動で情報を添える仕組みのため、使いたい人が明示的にオンにしたときだけ動く安全設計になっています。導入後に <code>/plugin configure loopback@simota-mods</code> でいつでもオンにできます。
            </p>
          </div>
        </details>
      </div>
    </div>
  </section>

  <section class="final-cta-section" aria-labelledby="final-cta-heading">
    <div class="container">
      <div class="final-cta-panel reveal">
        <div class="final-cta-copy">
          <span class="section-kicker section-kicker--verified">今すぐ1分で試せます</span>
          <h2 id="final-cta-heading">次のセッションから、<br class="br-desktop" />Claude Code の「見張り役」を卒業しよう。</h2>
          <p>
            まずは一番人気の基本3選（未テスト防止 <code>done-gate</code>・1行整理 <code>tool-row</code>・達成音 <code>kachi</code>）をコピペして導入。合わなければいつでもすぐに外せます。
          </p>
        </div>

        <div class="final-cta-actions">
          <div class="command-box command-box--final">
            <span class="command-prompt" aria-hidden="true">$</span>
            <pre class="final-command-pre"><code id="final-command-text">claude plugin install done-gate --marketplace simota/claude-mods &amp;&amp; \\
claude plugin install tool-row --marketplace simota/claude-mods &amp;&amp; \\
claude plugin install kachi --marketplace simota/claude-mods</code></pre>
            <button
              type="button"
              class="copy-btn copy-btn--primary"
              data-copy-target="final-command-text"
              data-orig-label="基本の3選をコピー"
              aria-label="基本の3選のインストールコマンドをコピー"
            >
              <span class="copy-icon-default">${ICONS.copy}</span>
              <span class="copy-icon-done" hidden>${ICONS.check}</span>
              <span class="copy-label">基本の3選をコピー</span>
            </button>
          </div>

          <div class="final-btn-row">
            <a href="#mods" class="btn btn-secondary btn-lg">
              <span>全29種から自由に選ぶ</span>
              ${ICONS.arrowRight}
            </a>
            <a
              href="https://github.com/simota/claude-mods"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-ghost btn-lg"
            >
              ${ICONS.github}
              <span>GitHub リポジトリを見る</span>
              ${ICONS.external}
            </a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-brand-col">
        <div class="brand-mark">
          <span class="brand-glyph" aria-hidden="true">
            <span class="brand-dot brand-dot--amber"></span>
            <span class="brand-dot brand-dot--emerald"></span>
          </span>
          <span class="brand-name">claude-mods</span>
          <span class="brand-tag">marketplace: simota/claude-mods</span>
        </div>
        <p class="footer-note">
          Claude Code の手抜き完了・見落とし・ログ氾濫を自動で防ぐ 29 個の拡張プラグイン集（MIT License）。
        </p>
      </div>

      <nav class="footer-links" aria-label="フッターナビゲーション">
        <a href="#shift">解決できること</a>
        <a href="#architecture">3大AI同時レビュー</a>
        <a href="#showcase">38秒動画 &amp; 音</a>
        <a href="#mods">全29種一覧</a>
        <a href="#setup">入れ方</a>
        <a href="#faq">よくある質問</a>
        <a href="https://github.com/simota/claude-mods" target="_blank" rel="noopener noreferrer">GitHub</a>
      </nav>
    </div>
    <div class="container footer-bottom">
      <span>MIT License · © simota</span>
      <span>Verified with: <code>claude plugin validate</code> · <code>claude plugin test</code> · <code>scripts/check-copies.sh</code></span>
    </div>
  </footer>

  <div class="sr-only" role="status" aria-live="polite" id="copy-live-region"></div>`;
}
