import { ICONS } from './icons';

export function renderShowcase(): string {
  return `
  <section class="section showcase-section" id="showcase" aria-labelledby="showcase-heading">
    <div class="container">
      <div class="section-header section-header--centered reveal">
        <span class="section-kicker section-kicker--verified">実際の画面とサウンドを体験</span>
        <h2 id="showcase-heading" class="section-title">
          38秒でわかる実機デモ映像と、<br class="br-desktop" /><span class="earned-green-em">バグが直った瞬間だけ鳴る「達成音」。</span>
        </h2>
        <p class="section-desc">
          ターミナル上でどう動くのかを凝縮した38秒の映像と、テスト削除のごまかしでは決して鳴らず<strong>「本当にコードを直して緑になった瞬間」だけ光って鳴る <code>kachi</code></strong> の実物サウンドをその場で試せます。
        </p>
      </div>

      <div class="showcase-split reveal">
        <div class="promo-film-card">
          <div class="promo-film-header">
            <div>
              <span class="kachi-badge kachi-badge--neutral">38秒 プロダクトデモ映像</span>
              <h3>一連の動きを38秒で見る</h3>
            </div>
            <span class="film-spec-tag">1080p · 音声あり</span>
          </div>

          <div class="video-frame" id="promo-video-wrap">
            <video
              id="promo-video"
              class="promo-video-el"
              controls
              preload="metadata"
              playsinline
              poster="./assets/images/promo-poster.webp"
              aria-label="claude-mods 38秒プロモーション映像"
            >
              <source src="./assets/video/final-promo.mp4" type="video/mp4" />
              お使いのブラウザは動画再生に対応していません。
            </video>
            <button
              type="button"
              class="video-play-overlay"
              id="promo-play-overlay"
              aria-label="38秒のプロモーション映像を再生"
            >
              <span class="video-play-circle">${ICONS.play}</span>
              <span class="video-play-label">再生して動きを見る（38秒・音声あり）</span>
            </button>
          </div>

          <div class="film-chapters" role="group" aria-label="見たいシーンへジャンプ">
            <button type="button" class="chapter-btn is-active" data-seek="0" data-seek-end="4.5">
              <code>0:00</code>
              <span>手抜き完了を阻止</span>
            </button>
            <button type="button" class="chapter-btn" data-seek="4.5" data-seek-end="11.5">
              <code>0:04</code>
              <span>ログ1行化・影響マップ</span>
            </button>
            <button type="button" class="chapter-btn" data-seek="11.5" data-seek-end="19.5">
              <code>0:11</code>
              <span>3大AI同時レビュー</span>
            </button>
            <button type="button" class="chapter-btn" data-seek="19.5" data-seek-end="27.5">
              <code>0:19</code>
              <span>バグ解決音 kachi</span>
            </button>
            <button type="button" class="chapter-btn" data-seek="27.5" data-seek-end="99">
              <code>0:27</code>
              <span>全29種まとめ</span>
            </button>
          </div>
        </div>

        <div class="kachi-bench" aria-labelledby="kachi-bench-title">
          <div class="kachi-bench-bg" aria-hidden="true">
            <img
              src="./assets/images/kachi-refraction.webp"
              alt=""
              width="1280"
              height="714"
              loading="lazy"
              decoding="async"
            />
          </div>

          <div class="kachi-bench-content">
            <div class="kachi-head-row">
              <div>
                <span class="kachi-badge">実物サウンド試聴 · kachi プラグイン</span>
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
              <strong>ズルでは鳴りません：</strong>無編集の再実行・テストファイルだけの編集・一部ファイルだけの部分実行では一切鳴りません。
            </p>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}
