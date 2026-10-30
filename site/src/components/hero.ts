import { COCKPIT_SCENARIOS } from '../data/cockpit';
import { escapeHtml, ICONS, renderCmdTokens, toolIconSvg } from './icons';

export function renderHero(): string {
  const initial = COCKPIT_SCENARIOS[0]!;
  const scenariosJson = escapeHtml(JSON.stringify(COCKPIT_SCENARIOS));

  return `
  <section class="hero-section" aria-labelledby="hero-heading">
    <div class="hero-backdrop" aria-hidden="true">
      <img
        src="./assets/images/obsidian-instrument.webp"
        alt=""
        width="1280"
        height="714"
        decoding="async"
        fetchpriority="high"
        class="hero-backdrop-img"
      />
      <div class="hero-backdrop-vignette"></div>
    </div>

    <div class="container hero-grid">
      <div class="hero-copy">
        <div class="eyebrow-row">
          <span class="eyebrow-badge">
            <span class="eyebrow-pulse" aria-hidden="true"></span>
            <span>Claude Code 専用プラグイン集</span>
          </span>
          <span class="eyebrow-meta">全29種・1個から後付けOK · MIT</span>
        </div>

        <h1 id="hero-heading" class="hero-title">
          Claude Code の<span class="nowrap-phrase">「手抜き完了」と</span><br class="br-desktop" /><span class="hero-title-em"><span class="hang-open">「</span>見落とし」を、自動で止める。</span>
        </h1>

        <p class="hero-lead">
          毎回「テスト回した？」と聞き直す見張り役はもう不要。いつもの Claude Code に1コマンドで後付けできます。
        </p>

        <ul class="hero-pillars" aria-label="主な3つの効果">
          <li>
            <span class="pillar-icon pillar-icon--guard" aria-hidden="true">${ICONS.shield}</span>
            <div><strong>サボりを即ブロック</strong> — 未テスト完了・テスト削除・<code>--no-verify</code> を自動制止</div>
          </li>
          <li>
            <span class="pillar-icon pillar-icon--consensus" aria-hidden="true">${ICONS.layers}</span>
            <div><strong>3大AIで同時レビュー</strong> — 1クリックで <code>claude</code>・<code>codex</code>・<code>agy</code> に同時監査</div>
          </li>
          <li>
            <span class="pillar-icon pillar-icon--sight" aria-hidden="true">${ICONS.terminal}</span>
            <div><strong>画面をスッキリ1行化</strong> — 大量ログを1行に畳み、PR状況と達成音を手元に集約</div>
          </li>
        </ul>

        <div class="hero-command-panel" role="region" aria-label="クイックインストールコマンド">
          <div class="hero-command-top">
            <span class="hero-preset-hint">まずは一番人気の「未テスト完了ストッパー」を1行で試す：</span>
            <div class="mode-switch" role="group" aria-label="実行環境の切り替え">
              <button
                type="button"
                aria-pressed="true"
                class="mode-tab is-active"
                data-hero-mode="shell"
              >
                シェルで実行
              </button>
              <button
                type="button"
                aria-pressed="false"
                class="mode-tab"
                data-hero-mode="session"
              >
                Claude Code 内
              </button>
            </div>
          </div>

          <div class="command-box command-box--hero">
            <span class="command-prompt" aria-hidden="true">$</span>
            <code class="command-code" id="hero-command-text">${renderCmdTokens('claude plugin install done-gate --marketplace simota/claude-mods')}</code>
            <button
              type="button"
              class="copy-btn copy-btn--primary"
              id="hero-copy-btn"
              data-copy-target="hero-command-text"
              data-orig-label="コピー"
              aria-label="インストールコマンドをクリップボードにコピー"
            >
              <span class="copy-icon-default">${ICONS.copy}</span>
              <span class="copy-icon-done" hidden>${ICONS.check}</span>
              <span class="copy-label">コピー</span>
            </button>
          </div>
          <p class="hero-auth-note">
            OSS公開（MIT） · 設定ファイル汚染なし · 合わなければ1コマンドでいつでも削除できます
          </p>
        </div>

        <div class="hero-cta-row">
          <a href="#install" class="btn btn-secondary btn-lg">
            <span>おすすめセット・全29種から選ぶ</span>
            ${ICONS.arrowRight}
          </a>
          <a href="#showcase" class="btn btn-ghost btn-lg">
            ${ICONS.play}
            <span>38秒のデモ動画を見る</span>
          </a>
        </div>
      </div>

      <div class="hero-stage" id="cockpit" data-scenarios="${scenariosJson}">
        <div class="cockpit-header-bar">
          <div class="cockpit-label-group">
            <span class="live-dot" aria-hidden="true"></span>
            <span class="cockpit-overline">クリックして体験：入れた瞬間にこう変わる</span>
          </div>
          <span class="cockpit-active-mod" id="cockpit-mod-badge">${escapeHtml(initial.modBadge)}</span>
        </div>

        <div class="cockpit-tabs" role="tablist" aria-label="実機UIシナリオの切り替え">
          ${COCKPIT_SCENARIOS.map(
            (s, idx) => `
          <button
            type="button"
            role="tab"
            id="cockpit-tab-${s.id}"
            aria-selected="${idx === 0 ? 'true' : 'false'}"
            tabindex="${idx === 0 ? '0' : '-1'}"
            aria-controls="cockpit-viewport"
            class="cockpit-tab ${idx === 0 ? 'is-active' : ''}"
            data-scenario-id="${s.id}"
            style="--tab-accent: ${s.accentColor}"
          >
            <span class="cockpit-tab-num">${s.tabIndex}</span>
            <span class="cockpit-tab-text">${escapeHtml(s.tabLabel)}</span>
          </button>`,
          ).join('')}
        </div>

        <div class="cockpit-story-cue" id="cockpit-story-cue">
          <div class="cue-row cue-row--problem">
            <span class="cue-tag cue-tag--bad" id="cockpit-problem-tag">AIのやらかし</span>
            <span class="cue-text" id="cockpit-problem-text">${escapeHtml(initial.problem)}</span>
          </div>
          <div class="cue-row cue-row--outcome">
            <span class="cue-tag cue-tag--good" id="cockpit-outcome-tag">入れた瞬間</span>
            <span class="cue-text cue-text--outcome" id="cockpit-outcome-text">${escapeHtml(initial.outcome)}</span>
          </div>
        </div>

        <div
          class="terminal-window"
          id="cockpit-viewport"
          role="tabpanel"
          aria-labelledby="cockpit-tab-${initial.id}"
        >
          <div class="terminal-chrome">
            <div class="window-dots" aria-hidden="true">
              <span></span><span></span><span></span>
            </div>
            <div class="terminal-title">Claude Code ターミナル画面</div>
            <div class="terminal-surface-tag">勝手に送信はしません</div>
          </div>

          <div class="terminal-body" id="cockpit-body">
            <div class="tool-rows-list" id="cockpit-tool-rows">
              ${initial.toolRows
                .map(
                  (row) => `
              <div class="t-row-group">
                <div class="t-row">
                  <span class="t-icon" style="color:${row.iconColor}">${toolIconSvg(row.icon)}</span>
                  <span class="t-path">${escapeHtml(row.path)}</span>
                  <span class="t-stats">
                    ${row.stats.map((st) => `<span style="color:${st.color}">${escapeHtml(st.text)}</span>`).join(' ')}
                  </span>
                </div>
                ${row.subnote ? `<div class="t-subnote" style="color:${row.subnote.color}">${escapeHtml(row.subnote.text)}</div>` : ''}
              </div>`,
                )
                .join('')}
            </div>

            <div class="terminal-pane" id="cockpit-pane" hidden></div>
          </div>

          <div class="terminal-band-dismissed" id="cockpit-band-dismissed" hidden>
            <span>警告バーを閉じました（次の編集でまた自動チェックされます）</span>
            <button type="button" class="band-restore-btn" id="cockpit-band-restore">バーを再表示</button>
          </div>

          <div class="terminal-band" id="cockpit-band" style="--band-color: ${initial.band.color}">
            <div class="band-sweep-layer" id="cockpit-band-sweep" aria-hidden="true"></div>
            <div class="band-main-col">
              <span class="surface-micro-label">▼ 入力欄のすぐ上に自動で出るバー（ボタンを押してみてください）</span>
              <span class="band-text" id="cockpit-band-text">${escapeHtml(initial.band.text)}</span>
            </div>
            <div class="band-actions" id="cockpit-band-actions">
              ${
                initial.band.primaryBtn
                  ? `<button type="button" class="band-btn band-btn--primary" id="cockpit-action-btn">${escapeHtml(initial.band.primaryBtn.label)}</button>`
                  : ''
              }
              ${
                initial.band.secondaryBtn
                  ? `<button type="button" class="band-btn band-btn--ghost" id="cockpit-secondary-btn" data-secondary-action="${initial.band.secondaryBtn.action}">${escapeHtml(initial.band.secondaryBtn.label)}</button>`
                  : ''
              }
            </div>
          </div>

          <div class="terminal-prompt-box" id="cockpit-prompt-box">
            <span class="prompt-chevron" aria-hidden="true">❯</span>
            <div class="prompt-col">
              <div class="prompt-input-preview" id="cockpit-prompt-input" data-placeholder="上のボタンを押すと、ここに修正依頼の下書きが入ります（確認して Enter で送信）"></div>
            </div>
          </div>

          <div class="terminal-statusline" id="cockpit-statusline">
            <span>${escapeHtml(initial.statusLine)}</span>
            <span class="statusline-right">常時ステータス表示</span>
          </div>
        </div>

        <p class="cockpit-caption" id="cockpit-caption">
          ${escapeHtml(initial.caption)}
        </p>
      </div>
    </div>
  </section>`;
}
