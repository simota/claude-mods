import { ICONS } from './icons';

export function renderShowcase(): string {
  return `
  <section class="section showcase-section" id="showcase" aria-labelledby="showcase-heading">
    <div class="container">
      <div class="section-header section-header--split reveal">
        <div>
          <span class="section-kicker section-kicker--verified">実物サウンド試聴 · kachi プラグイン</span>
          <h2 id="showcase-heading" class="section-title">
            テスト削除のズルでは鳴らない。<br class="br-desktop" /><span class="earned-green-em">本当に直せた瞬間だけ鳴る「勝ち音」。</span>
          </h2>
        </div>
        <p class="section-desc">
          落ちていたテストや型チェックが<strong>本体コードの修正によって緑に変わった瞬間だけ</strong>、入力欄の上をエメラルドの光が走り、気持ちいいクリック音が鳴ります。右のボタンで実際の同梱音源を試聴できます。
        </p>
      </div>

      <div class="showcase-split reveal">
        <div class="kachi-story-card">
          <img
            src="./assets/images/kachi-refraction.webp"
            alt="黒曜石とガラスプリズムを貫く1本のエメラルドの走査光"
            width="1280"
            height="714"
            loading="lazy"
            decoding="async"
            class="kachi-story-img"
          />
          <div class="kachi-story-body">
            <h3>「見せかけの緑」を弾く3つの判定ルール</h3>
            <ul class="kachi-rules-list">
              <li>
                <strong>無編集の再実行では鳴らない</strong> — 何も直さずもう一度テストを回しただけでは反応しません。
              </li>
              <li>
                <strong>テスト改ざんでは鳴らない</strong> — テストファイルだけを書き換えて緑にしても、本体コードの編集がなければ沈黙します。
              </li>
              <li>
                <strong>部分実行のごまかしも除外</strong> — 赤だったときより狭い対象ファイルだけを指定して通しても鳴りません。
              </li>
            </ul>
          </div>
        </div>

        <div class="kachi-bench" aria-labelledby="kachi-bench-title">
          <div class="kachi-bench-content">
            <div class="kachi-head-row">
              <div>
                <span class="kachi-badge">クリックで実音が鳴ります（mods/kachi/fx/*.wav）</span>
                <h3 id="kachi-bench-title">苦労の深さで変わる4段階の「勝ち音」</h3>
              </div>
              <div class="kachi-sound-toggle" role="group" aria-label="kachi 音量モード">
                <span class="sound-icon">${ICONS.volume}</span>
                <button type="button" class="sound-mode-btn is-active" data-kachi-volume="on" aria-pressed="true">on</button>
                <button type="button" class="sound-mode-btn" data-kachi-volume="quiet" aria-pressed="false">quiet</button>
                <button type="button" class="sound-mode-btn" data-kachi-volume="off" aria-pressed="false">off</button>
              </div>
            </div>

            <div class="kachi-stage-terminal" aria-live="polite">
              <div class="kachi-result-line" id="kachi-result-line">
                <span class="kachi-cmd" id="kachi-cmd-text">$ pnpm test</span>
                <span class="kachi-pass" id="kachi-pass-stat">48 passed (1.42s)</span>
              </div>
              <div class="kachi-receipt-line" id="kachi-receipt-line">
                ✔ 赤→緑  4 回目で · 6m18s 赤だった · 3 → 0 failing
              </div>
              <div class="kachi-sweep-band" id="kachi-sweep-band" data-tier="3">
                <div class="kachi-sweep-beam" id="kachi-sweep-beam" aria-hidden="true"></div>
                <span class="kachi-stamp-text" id="kachi-stamp-text">✔ pnpm test  緑</span>
                <span class="kachi-tier-indicator" id="kachi-tier-indicator">Tier 3 · chime (380ms)</span>
              </div>
            </div>

            <div class="kachi-tier-buttons" role="group" aria-label="kachi 4段階の再生トリガー">
              <button type="button" class="kachi-tier-btn" data-kachi-tier="1" aria-pressed="false">
                <span class="tier-top">
                  <strong>Tier 1 · tick</strong>
                  <code>60 ms</code>
                </span>
                <span class="tier-cond">1発でスッと通ったとき（静かなカチッ）</span>
              </button>

              <button type="button" class="kachi-tier-btn" data-kachi-tier="2" aria-pressed="false">
                <span class="tier-top">
                  <strong>Tier 2 · click</strong>
                  <code>140 ms</code>
                </span>
                <span class="tier-cond">1〜2回失敗したあとに直せたとき</span>
              </button>

              <button type="button" class="kachi-tier-btn is-selected" data-kachi-tier="3" aria-pressed="true">
                <span class="tier-top">
                  <strong>Tier 3 · chime</strong>
                  <code>380 ms</code>
                </span>
                <span class="tier-cond">3回以上失敗 or 5分以上ハマって突破！</span>
              </button>

              <button type="button" class="kachi-tier-btn" data-kachi-tier="4" aria-pressed="false">
                <span class="tier-top">
                  <strong>Tier 4 · bell</strong>
                  <code>700 ms</code>
                </span>
                <span class="tier-cond">20分以上の大ハマり・難バグを一掃！</span>
              </button>
            </div>

            <p class="kachi-guardrail-note">
              音量はセッション中いつでも <code>/plugin configure kachi@simota-mods</code> で <code>on</code> / <code>quiet</code> / <code>off</code> に切り替えられます。
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}
