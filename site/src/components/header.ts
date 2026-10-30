import { ICONS } from './icons';

export function renderHeader(): string {
  return `
  <a href="#main-content" class="skip-link">メインコンテンツへ移動</a>
  <header class="site-header" id="top">
    <div class="container header-inner">
      <a href="#top" class="brand-mark" aria-label="claude-mods トップへ戻る">
        <span class="brand-glyph" aria-hidden="true">
          <span class="brand-dot brand-dot--amber"></span>
          <span class="brand-dot brand-dot--emerald"></span>
        </span>
        <span class="brand-name">claude-mods</span>
        <span class="brand-tag">@simota-mods</span>
      </a>

      <nav class="desktop-nav" aria-label="主要セクション">
        <a href="#shift" class="nav-link">解決できること</a>
        <a href="#architecture" class="nav-link">3大AI同時レビュー</a>
        <a href="#showcase" class="nav-link">38秒動画 &amp; 音</a>
        <a href="#mods" class="nav-link">全29種一覧</a>
        <a href="#setup" class="nav-link">入れ方</a>
        <a href="#faq" class="nav-link">よくある質問</a>
      </nav>

      <div class="header-actions">
        <a
          href="https://github.com/simota/claude-mods"
          target="_blank"
          rel="noopener noreferrer"
          class="btn btn-ghost btn-sm header-github"
          aria-label="GitHub で simota/claude-mods リポジトリを開く（新しいタブ）"
        >
          ${ICONS.github}
          <span>GitHub</span>
        </a>
        <a href="#install" class="btn btn-primary btn-sm header-cta-btn">
          <span class="header-cta-full">1行で導入する</span>
          <span class="header-cta-short">導入する</span>
          ${ICONS.arrowRight}
        </a>
        <button
          type="button"
          class="mobile-menu-btn"
          id="mobile-menu-toggle"
          aria-expanded="false"
          aria-controls="mobile-nav-drawer"
          aria-label="ナビゲーションメニューを開く"
        >
          <span class="icon-open">${ICONS.menu}</span>
          <span class="icon-close" hidden>${ICONS.close}</span>
        </button>
      </div>
    </div>

    <div class="mobile-drawer" id="mobile-nav-drawer" hidden>
      <nav class="container mobile-drawer-inner" aria-label="モバイルナビゲーション">
        <a href="#shift" class="mobile-nav-link">
          <span class="mobile-nav-num">01</span>
          <span>よくある4大ストレスと解決策</span>
        </a>
        <a href="#architecture" class="mobile-nav-link">
          <span class="mobile-nav-num">02</span>
          <span>3大AI同時レビュー &amp; 4つの安心設計</span>
        </a>
        <a href="#showcase" class="mobile-nav-link">
          <span class="mobile-nav-num">03</span>
          <span>38秒デモ動画 &amp; バグ解決音試聴</span>
        </a>
        <a href="#mods" class="mobile-nav-link">
          <span class="mobile-nav-num">04</span>
          <span>全29プラグイン一覧・コマンド作成</span>
        </a>
        <a href="#setup" class="mobile-nav-link">
          <span class="mobile-nav-num">05</span>
          <span>1分で終わる導入手順</span>
        </a>
        <a href="#faq" class="mobile-nav-link">
          <span class="mobile-nav-num">06</span>
          <span>よくある質問（安全性・動作環境）</span>
        </a>
        <div class="mobile-drawer-cta">
          <a href="#install" class="btn btn-primary btn-block">
            <span>欲しい機能を選んで1行導入</span>
            ${ICONS.arrowRight}
          </a>
          <a
            href="https://github.com/simota/claude-mods"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-secondary btn-block"
          >
            ${ICONS.github}
            <span>simota/claude-mods (GitHub)</span>
          </a>
        </div>
      </nav>
    </div>
  </header>`;
}
