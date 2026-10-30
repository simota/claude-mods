import { CATEGORIES, MODS, STARTER_PRESETS } from '../data/mods';
import { escapeHtml, ICONS } from './icons';

export function renderCatalog(): string {
  const presetsJson = escapeHtml(JSON.stringify(STARTER_PRESETS));
  const categoriesJson = escapeHtml(JSON.stringify(CATEGORIES));
  const configsJson = escapeHtml(
    JSON.stringify(
      Object.fromEntries(
        MODS.map((m) => [
          m.name,
          {
            defaultOff: m.defaultState === '既定オフ',
            configSample: m.configSample ?? null,
          },
        ]),
      ),
    ),
  );
  const defaultSelected = new Set(STARTER_PRESETS[0]!.mods);
  const extraCount = MODS.filter((m) => !m.featured).length;

  return `
  <section
    class="section catalog-section"
    id="mods"
    aria-labelledby="catalog-heading"
    data-presets="${presetsJson}"
    data-categories="${categoriesJson}"
    data-mod-configs="${configsJson}"
  >
    <div class="container">
      <div class="section-header section-header--split reveal">
        <div>
          <span class="section-kicker section-kicker--sight">1個から自由に組み合わせ（全29プラグイン）</span>
          <h2 id="catalog-heading" class="section-title">
            迷ったら「基本の3選」から。<br class="br-desktop" />欲しい機能だけ選んで1行コピー。
          </h2>
        </div>
        <p class="section-desc">
          全部まとめて入れる必要はありません。まずは一番人気の3個（未テスト防止・ログ1行化・達成音）から始めるか、気になるカードをクリックして専用コマンドを作れます。
        </p>
      </div>

      <div class="install-builder reveal" id="install" role="region" aria-labelledby="install-heading">
        <div class="install-builder-head">
          <div>
            <span class="section-kicker section-kicker--verified">目的別おすすめパック &amp; コマンド作成</span>
            <h3 id="install-heading">パックを選ぶか下のカードをクリックすると、導入コマンドが自動で作られます</h3>
          </div>
          <div class="selected-counter-wrap">
            <span class="selected-counter" id="builder-selected-count">3 個選択中</span>
            <button type="button" class="text-link-btn" id="builder-clear-btn">選択をクリア</button>
          </div>
        </div>

        <div class="preset-row" role="group" aria-label="おすすめプリセット選択">
          ${STARTER_PRESETS.map(
            (p, idx) => `
          <button
            type="button"
            aria-pressed="${idx === 0 ? 'true' : 'false'}"
            class="preset-chip ${idx === 0 ? 'is-active' : ''}"
            data-preset-id="${p.id}"
          >
            <strong>${escapeHtml(p.label)}</strong>
            <span>${escapeHtml(p.subtitle)}</span>
          </button>`,
          ).join('')}
        </div>

        <div class="builder-mode-bar">
          <div class="mode-switch" role="group" aria-label="生成コマンドの形式">
            <button type="button" aria-pressed="true" class="mode-tab is-active" data-builder-mode="shell">
              シェルでまとめて導入 (claude plugin install)
            </button>
            <button type="button" aria-pressed="false" class="mode-tab" data-builder-mode="session">
              Claude Code 内で導入 (/plugin install)
            </button>
            <button type="button" aria-pressed="false" class="mode-tab" data-builder-mode="configure">
              設定変更の例 (/plugin configure)
            </button>
          </div>
        </div>

        <div class="builder-code-wrap">
          <pre class="builder-pre" tabindex="0" role="region" aria-label="生成されたインストールコマンド"><code id="builder-command-output">claude plugin install done-gate --marketplace simota/claude-mods &amp;&amp; \\
claude plugin install tool-row --marketplace simota/claude-mods &amp;&amp; \\
claude plugin install kachi --marketplace simota/claude-mods</code></pre>
          <button
            type="button"
            id="builder-copy-btn"
            class="btn btn-primary copy-builder-btn"
            data-copy-target="builder-command-output"
            data-orig-label="コマンド一式をコピー"
            aria-label="生成されたコマンド一式をコピー"
          >
            <span class="copy-icon-default">${ICONS.copy}</span>
            <span class="copy-icon-done" hidden>${ICONS.check}</span>
            <span class="copy-label">コマンド一式をコピー</span>
          </button>
        </div>
      </div>

      <div class="catalog-controls reveal">
        <div class="category-pills" role="group" aria-label="カテゴリ絞り込み">
          <button
            type="button"
            aria-pressed="true"
            class="cat-pill is-active"
            data-cat-filter="all"
          >
            <span>すべて</span>
            <span class="cat-count">${MODS.length}</span>
          </button>
          ${CATEGORIES.map((cat) => {
            const count = MODS.filter((m) => m.category === cat.id).length;
            return `
          <button
            type="button"
            aria-pressed="false"
            class="cat-pill"
            data-cat-filter="${cat.id}"
            style="--pill-accent: ${cat.accentVar}"
          >
            <span>${escapeHtml(cat.labelJa)}</span>
            <span class="cat-count">${count}</span>
          </button>`;
          }).join('')}
        </div>

        <div class="catalog-filter-row">
          <div class="search-field-wrap">
            <label for="mod-search-input" class="sr-only">プラグイン名・コマンド・機能で検索</label>
            <span class="search-icon">${ICONS.search}</span>
            <input
              type="search"
              id="mod-search-input"
              class="mod-search-input"
              placeholder="キーワードで探す（例: テスト, PR, codex, 画像, Docker）"
              autocomplete="off"
            />
            <span class="search-hit-count" id="mod-hit-count" aria-live="polite">${MODS.length} / ${MODS.length} 件</span>
          </div>
          <p class="cat-summary-bar" id="cat-active-summary">
            カードをクリックすると選択の ON / OFF を切り替えられます（基本の3選が初期選択されています）。
          </p>
        </div>
      </div>

      <div class="mods-grid" id="mods-grid">
        ${MODS.map((mod) => {
          const catMeta = CATEGORIES.find((c) => c.id === mod.category)!;
          const isChecked = defaultSelected.has(mod.name);
          const isDefaultOff = mod.defaultState === '既定オフ';
          const searchBlob = `${mod.name} ${mod.tagline} ${mod.detail} ${mod.command ?? ''} ${mod.surface} ${mod.defaultState} ${catMeta.labelJa} ${catMeta.labelEn}`.toLowerCase();
          return `
        <article
          class="mod-card ${isChecked ? 'is-selected' : ''} ${mod.featured ? 'mod-card--featured' : 'mod-card--extra'}"
          data-mod-card="${mod.name}"
          data-mod-cat="${mod.category}"
          data-mod-extra="${mod.featured ? 'false' : 'true'}"
          data-mod-search="${escapeHtml(searchBlob)}"
          style="--mod-accent: ${catMeta.accentVar}"
        >
          <div class="mod-card-top">
            <div class="mod-title-row">
              <h3 class="mod-name"><code>${escapeHtml(mod.name)}</code></h3>
              ${mod.starter ? `<span class="mod-tier-badge mod-tier-badge--starter">基本3選</span>` : mod.featured ? `<span class="mod-tier-badge mod-tier-badge--featured">人気</span>` : ''}
              ${mod.command ? `<span class="mod-cmd-badge">${escapeHtml(mod.command)}</span>` : `<span class="mod-auto-badge">${escapeHtml(mod.defaultState)}</span>`}
              ${isDefaultOff ? `<span class="mod-off-badge">既定オフ</span>` : ''}
            </div>
            <label class="mod-select-toggle">
              <input
                type="checkbox"
                class="mod-checkbox"
                value="${escapeHtml(mod.name)}"
                ${isChecked ? 'checked' : ''}
                aria-label="${escapeHtml(mod.name)} を導入コマンドに追加"
              />
              <span class="mod-check-visual" aria-hidden="true">${ICONS.check}</span>
              <span class="mod-check-text">${isChecked ? '選択中' : '追加'}</span>
            </label>
          </div>

          <p class="mod-tagline">${escapeHtml(mod.tagline)}</p>
          <p class="mod-detail">${escapeHtml(mod.detail)}</p>

          <footer class="mod-card-foot">
            <span class="mod-cat-label">${escapeHtml(catMeta.labelJa)}</span>
            <span class="mod-surface-label">${escapeHtml(mod.surface)}</span>
          </footer>
        </article>`;
        }).join('')}
      </div>

      <div class="mobile-expand-wrap" id="mods-mobile-expand-wrap">
        <button
          type="button"
          class="btn btn-secondary btn-block mods-expand-btn"
          id="mods-expand-btn"
          aria-expanded="false"
        >
          <span>残り ${extraCount} 個のプラグインもすべて見る（全 ${MODS.length} 個）</span>
        </button>
      </div>

      <div class="empty-search-state" id="mod-empty-state" hidden>
        <p>一致するプラグインが見つかりませんでした。別の言葉で探すか、フィルタをリセットしてください。</p>
        <button type="button" class="btn btn-secondary btn-sm" id="mod-reset-filter">フィルタをリセット</button>
      </div>
    </div>

    <div class="floating-selection-bar" id="floating-selection-bar" hidden aria-label="選択中プラグインのクイック操作バー">
      <div class="container floating-selection-inner">
        <div class="floating-selection-info">
          <span class="floating-count-pill" id="floating-selected-count">3 個選択中</span>
          <span class="floating-mod-names" id="floating-mod-names">done-gate, tool-row, kachi</span>
        </div>
        <div class="floating-selection-actions">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            id="floating-copy-btn"
            data-copy-target="builder-command-output"
            data-orig-label="導入コマンドをコピー"
          >
            <span class="copy-icon-default">${ICONS.copy}</span>
            <span class="copy-icon-done" hidden>${ICONS.check}</span>
            <span class="copy-label">導入コマンドをコピー</span>
          </button>
          <a href="#install" class="btn btn-secondary btn-sm">
            <span>コマンドを見る</span>
            ${ICONS.arrowRight}
          </a>
        </div>
      </div>
    </div>
  </section>`;
}
