import { ICONS } from './icons';

export function renderPromo(): string {
  return `
  <section class="section promo-section" id="promo" aria-labelledby="promo-heading">
    <div class="container">
      <div class="section-header section-header--centered reveal">
        <span class="section-kicker section-kicker--verified">38秒 プロモーション映像（1080p · 60fps）</span>
        <h2 id="promo-heading" class="section-title">
          まずは38秒で、実際の動きを見る。
        </h2>
        <p class="section-desc">
          手抜き完了の自動ブロックから、1行ログ整理、3大AI同時レビュー、バグ解決音 <code>kachi</code> まで、<span class="nowrap-phrase">導入後の体験を38秒に凝縮しました。</span>
        </p>
      </div>

      <div class="promo-cinema-shell reveal">
        <div class="promo-cinema-bar">
          <div class="promo-cinema-meta">
            <span class="live-dot" aria-hidden="true"></span>
            <span class="promo-cinema-title">claude-mods Official Product Walkthrough · 0:38</span>
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm promo-unmute-btn"
            id="promo-unmute-btn"
            aria-pressed="false"
          >
            ${ICONS.volume}
            <span id="promo-unmute-label">音声ONで最初から再生</span>
          </button>
        </div>

        <div class="video-frame video-frame--cinema" id="promo-video-wrap">
          <video
            id="promo-video"
            class="promo-video-el"
            autoplay
            muted
            loop
            playsinline
            controls
            preload="metadata"
            poster="./assets/images/promo-poster.webp"
            aria-label="claude-mods 38秒プロモーション映像"
          >
            <source src="./assets/video/final-promo.mp4" type="video/mp4" />
            お使いのブラウザは動画再生に対応していません。
          </video>
        </div>

        <div class="film-chapters film-chapters--cinema" role="group" aria-label="見たいシーンへジャンプ">
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
            <span>全29種まとめ・導入</span>
          </button>
        </div>
      </div>
    </div>
  </section>`;
}
