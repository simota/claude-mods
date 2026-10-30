import { renderHeader } from './header';
import { renderHero } from './hero';
import { renderPromo } from './promo';
import { renderContrast } from './contrast';
import { renderArchitecture } from './architecture';
import { renderShowcase } from './showcase';
import { renderCatalog } from './catalog';
import { renderWorkflowAndFooter } from './workflow';

export function renderFullDocument(): string {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: 'claude-mods',
    alternateName: 'simota-mods',
    url: 'https://simota.github.io/claude-mods/',
    description:
      'Claude Code の「テスト未実行での完了」「勝手なテスト削除」「単一AIの見落とし」「大量ログの氾濫」を自動で止める29個の拡張プラグイン集。1個から後付け可能。',
    codeRepository: 'https://github.com/simota/claude-mods',
    license: 'https://opensource.org/licenses/MIT',
    programmingLanguage: ['TypeScript', 'TSX'],
    runtimePlatform: 'Claude Code',
    author: {
      '@type': 'Person',
      name: 'simota',
    },
    subjectOf: {
      '@type': 'VideoObject',
      name: 'claude-mods — 38秒プロダクトウォークスルー',
      description: '未テスト完了の自動ブロック・1行ログ圧縮・3大AI同時レビュー・バグ解決音 kachi の実機デモ映像',
      thumbnailUrl: 'https://simota.github.io/claude-mods/assets/images/promo-poster.webp',
      contentUrl: 'https://simota.github.io/claude-mods/assets/video/final-promo.mp4',
      duration: 'PT38S',
      uploadDate: '2026-10-30',
    },
  });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>claude-mods — Claude Code の「手抜き完了」と「見落とし」を自動で止めるプラグイン集</title>
  <meta
    name="description"
    content="毎回「テスト回した？」と聞き直すのは終わりにしよう。未テスト完了や --no-verify の自動ブロック、Claude・Codex・Antigravity の3大AI同時レビュー、数百行ログの1行圧縮まで、1コマンドで後付けできる Claude Code 拡張集。"
  />
  <meta name="theme-color" content="#080A0E" />
  <link rel="canonical" href="https://simota.github.io/claude-mods/" />

  <meta property="og:type" content="website" />
  <meta property="og:locale" content="ja_JP" />
  <meta property="og:url" content="https://simota.github.io/claude-mods/" />
  <meta property="og:site_name" content="claude-mods (@simota-mods)" />
  <meta property="og:title" content="claude-mods — Claude Code の「手抜き完了」と「見落とし」を自動で止める" />
  <meta
    property="og:description"
    content="未テスト完了・テスト改ざんの自動ブロック、Claude・Codex・Antigravity の3大AI同時レビュー、ログ1行圧縮、バグ解決音 kachi。1個から入れられる全29種の拡張プラグイン。"
  />
  <meta property="og:image" content="https://simota.github.io/claude-mods/assets/images/og-card.jpg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="claude-mods — Claude Code の「手抜き完了」と「見落とし」を自動で止める" />
  <meta
    name="twitter:description"
    content="毎回「テスト回した？」と聞き直す見張り役を卒業。1コマンドで後付けできる Claude Code 専用プラグイン29選。"
  />
  <meta name="twitter:image" content="https://simota.github.io/claude-mods/assets/images/og-card.jpg" />

  <link
    rel="icon"
    type="image/svg+xml"
    href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230E1219' stroke='%23242E40' stroke-width='2'/%3E%3Ccircle cx='11' cy='16' r='3.5' fill='%23FABD2F'/%3E%3Cpath d='M18 10l6 6-6 6' fill='none' stroke='%238FF5AA' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"
  />
  <link rel="preload" href="./assets/fonts/FiraCode-Regular.ttf" as="font" type="font/ttf" crossorigin />
  <link rel="stylesheet" href="./assets/main.css" />
  <script type="application/ld+json">${jsonLd}</script>
</head>
<body>
  ${renderHeader()}
  <main id="main-content">
    ${renderHero()}
    ${renderPromo()}
    ${renderContrast()}
    ${renderArchitecture()}
    ${renderShowcase()}
    ${renderCatalog()}
    ${renderWorkflowAndFooter()}
  </main>
  <script defer src="./assets/client.js"></script>
</body>
</html>`;
}
