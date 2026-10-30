import { ICONS } from './icons';

export function renderArchitecture(): string {
  return `
  <section class="section architecture-section" id="architecture" aria-labelledby="arch-heading">
    <div class="container">
      <div class="section-header reveal">
        <span class="section-kicker section-kicker--consensus">目玉機能：マルチAI セカンドオピニオン</span>
        <h2 id="arch-heading" class="section-title">
          書いた本人に聞き直しても、同じバグを見逃す。<br class="br-desktop" />だからボタン1つで「3つのAI」に同時に聞く。
        </h2>
        <p class="section-desc">
          別ウィンドウを開いて Codex 等へ手動で差分をコピペする手間をゼロに。Claude Code の画面のまま、3つのAIにコードレビューや設計コンペを同時依頼できます。
        </p>
      </div>

      <div class="consensus-feature reveal">
        <div class="consensus-visual">
          <img
            src="./assets/images/tri-engine-prism.webp"
            alt="3本の光線（Claude・Codex・Antigravity）がプリズムを通過し、中央で1本のエメラルド光線に収束するビジュアル"
            width="1280"
            height="714"
            loading="lazy"
            decoding="async"
            class="consensus-img"
          />
          <div class="consensus-legend" aria-label="同時チェックする3つのCLI">
            <span class="engine-chip engine-chip--claude"><strong>Claude</strong><span>読み取り専用で監査</span></span>
            <span class="engine-chip engine-chip--codex"><strong>Codex</strong><span>sandbox 読み取り専用</span></span>
            <span class="engine-chip engine-chip--agy"><strong>Antigravity (agy)</strong><span>読み取り専用で監査</span></span>
          </div>
        </div>

        <div class="consensus-body">
          <div class="consensus-tag">review-mods &amp; design-duel</div>
          <h3>ファイル書き換え不可の安全圏で、3つのAIを競わせる。</h3>
          <p>
            3つのCLIすべてが「コードを読むだけ（編集不可）」の安全なモードで並列稼働。どれか1〜2個のCLIしか入っていない環境でも、使えるものだけで自動で動きます。
          </p>
          <dl class="consensus-specs">
            <div>
              <dt>① 3大AI 同時コードレビュー (<code>/review-diff</code> または帯のボタン)</dt>
              <dd>今のブランチの差分を3者同時にチェック。同じ箇所の指摘は1件にまとめ、「誰が見つけたか」を明示。ボタン1つで修正依頼を入力欄にセットできます。</dd>
            </div>
            <div>
              <dt>② 名前を伏せた匿名設計コンペ (<code>/design-duel &lt;お題&gt;</code>)</dt>
              <dd>実装前に3者が別々に設計案を作成し、名前を隠した「案A・B・C」として互いに20点満点で採点＆最大の弱点を指摘。一番筋の良い設計を選んで実装に進めます。</dd>
            </div>
          </dl>
        </div>
      </div>

      <div class="invariants-grid reveal" role="list" aria-label="安心して導入できる4つの約束">
        <article class="invariant-item" role="listitem">
          <div class="invariant-top">
            <span class="invariant-icon invariant-icon--guard">${ICONS.terminal}</span>
            <span class="invariant-num">安心設計 01</span>
          </div>
          <h3>勝手にプロンプトを送信しない</h3>
          <p>
            どのボタンを押しても、プロンプト入力欄に下書きが入るだけです。勝手にトークンを消費したり暴走したりせず、最後に Enter を押すのは常にあなたです。
          </p>
        </article>

        <article class="invariant-item" role="listitem">
          <div class="invariant-top">
            <span class="invariant-icon invariant-icon--ops">${ICONS.lock}</span>
            <span class="invariant-num">安心設計 02</span>
          </div>
          <h3>APIキーや秘密情報を自動でマスク</h3>
          <p>
            エラー履歴や操作ログを記録するプラグインは、保存前にトークン・パスワード・<code>Authorization</code> ヘッダ・環境変数の鍵を自動でマスクします。
          </p>
        </article>

        <article class="invariant-item" role="listitem">
          <div class="invariant-top">
            <span class="invariant-icon invariant-icon--sight">${ICONS.layers}</span>
            <span class="invariant-num">安心設計 03</span>
          </div>
          <h3>1個だけ入れて、いつでも外せる</h3>
          <p>
            29個すべてが独立しており、まとめて入れる必要はありません。気になった1個だけを試し、設定変更もセッション内 <code>/plugin configure</code> で即反映されます。
          </p>
        </article>

        <article class="invariant-item" role="listitem">
          <div class="invariant-top">
            <span class="invariant-icon invariant-icon--consensus">${ICONS.gauge}</span>
            <span class="invariant-num">安心設計 04</span>
          </div>
          <h3>設定や作業コードを勝手に汚さない</h3>
          <p>
            Git設定や sandbox 設定を裏で書き換えることはありません。ベンチ比較やミューテーションテストも一時コピー上で動くため作業中のコードは安全です。
          </p>
        </article>
      </div>
    </div>
  </section>`;
}
