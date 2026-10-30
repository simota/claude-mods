export function renderContrast(): string {
  return `
  <section class="section contrast-section" id="shift" aria-labelledby="shift-heading">
    <div class="container">
      <div class="section-header section-header--split reveal">
        <div>
          <span class="section-kicker section-kicker--guard">Claude Code ユーザーの「4大あるある」を解消</span>
          <h2 id="shift-heading" class="section-title">
            AI が速く書くほど、<br class="br-desktop" />人間の「見張り作業」がしんどくなる。
          </h2>
        </div>
        <p class="section-desc">
          素の Claude Code では、テスト漏れや勝手な手抜きを人間が毎回チェックし続ける羽目になります。<code>claude-mods</code> はプロンプトのお願いではなく、<strong>自動で動く仕組み（フック）</strong>で解決します。
        </p>
      </div>

      <div class="pain-fix-list reveal" role="list" aria-label="よくあるイライラと導入後の変化">
        <article class="pain-fix-row" role="listitem">
          <div class="pain-side">
            <span class="pain-badge">よくあるイライラ 01</span>
            <h3>「修正完了しました！」→ 実はテストを1回も回していない</h3>
            <p>毎回人間が「テスト回した？」「型チェック通した？」と聞き直すのにうんざりする。</p>
          </div>
          <div class="pain-arrow" aria-hidden="true">→</div>
          <div class="fix-side">
            <div class="fix-badges">
              <span class="fix-badge">入れた瞬間こう変わる</span>
              <code class="fix-mod-tag">done-gate</code>
            </div>
            <h3>テスト成功まで自動で「未検証バー」を表示。<code>--no-verify</code> 逃げも拒否</h3>
            <p>編集後にテスト・lint・型チェック・ビルドが通らないまま終わるとその場で捕捉。ボタン1つで「通るまで直して」と依頼でき、フックを飛ばすズルも防ぎます。</p>
          </div>
        </article>

        <article class="pain-fix-row" role="listitem">
          <div class="pain-side">
            <span class="pain-badge">よくあるイライラ 02</span>
            <h3>「テスト通りました！」→ 差分を見たら <code>expect</code> を消して通してた</h3>
            <p>落ちるテストを直す代わりに、期待値を緩めたり <code>catch {}</code> でエラーを握りつぶしたりする。</p>
          </div>
          <div class="pain-arrow" aria-hidden="true">→</div>
          <div class="fix-side">
            <div class="fix-badges">
              <span class="fix-badge">入れた瞬間こう変わる</span>
              <code class="fix-mod-tag">assertion-guard</code>
            </div>
            <h3>テストを弱める編集を差分から即摘出し、理由の説明を要求</h3>
            <p><code>toEqual</code> から <code>toBeDefined</code> への緩和、<code>it.skip</code>、例外の握りつぶしを自動で見つけ、ワンクリックで「なぜ弱めたのか説明して」と問い詰められます。</p>
          </div>
        </article>

        <article class="pain-fix-row" role="listitem">
          <div class="pain-side">
            <span class="pain-badge">よくあるイライラ 03</span>
            <h3>書いた本人に「バグない？」と聞いても「問題ありません」しか返らない</h3>
            <p>同じAIに見直させても同じ思い込みで素通りする。別ツールに手動で diff を貼るのも面倒。</p>
          </div>
          <div class="pain-arrow" aria-hidden="true">→</div>
          <div class="fix-side">
            <div class="fix-badges">
              <span class="fix-badge">入れた瞬間こう変わる</span>
              <code class="fix-mod-tag">review-mods</code>
              <code class="fix-mod-tag">design-duel</code>
            </div>
            <h3>ボタン1つで Claude・Codex・Antigravity の3大AIに同時レビュー</h3>
            <p>3つの異なるAIが同時に差分をチェック（書き換え不可）。重複指摘は自動で1つにまとまり、複数AIが一致した「本当に危ないバグ」が一番上に表示されます。</p>
          </div>
        </article>

        <article class="pain-fix-row" role="listitem">
          <div class="pain-side">
            <span class="pain-badge">よくあるイライラ 04</span>
            <h3>Read や Bash のログが何百行も流れて、今どこを触ってるか追えない</h3>
            <p>画面がログで埋め尽くされ、変更の影響で壊れた別ファイルや PR の CI 失敗に気づけない。</p>
          </div>
          <div class="pain-arrow" aria-hidden="true">→</div>
          <div class="fix-side">
            <div class="fix-badges">
              <span class="fix-badge">入れた瞬間こう変わる</span>
              <code class="fix-mod-tag">tool-row</code>
              <code class="fix-mod-tag">fog-map</code>
              <code class="fix-mod-tag">pr-lamp</code>
            </div>
            <h3>全ログを「1呼び出し＝1行」に圧縮。未読の関連ファイルも先回り警告</h3>
            <p>終わった処理は色付きの短い1行にスッキリ折りたたみ。編集したファイルを import しているのにまだ読んでいない箇所や、PRのマージ残り条件も常時ひと目でわかります。</p>
          </div>
        </article>
      </div>
    </div>
  </section>`;
}
