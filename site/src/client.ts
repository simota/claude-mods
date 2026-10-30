import type { CockpitScenario } from './data/cockpit';
import type { ModCategoryMeta, ModConfigSample, StarterPreset } from './data/mods';
import { toolIconSvg } from './components/icons';

interface ModConfigMeta {
  defaultOff: boolean;
  configSample: ModConfigSample | null;
}

const copyTimers = new WeakMap<HTMLButtonElement, number>();

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function announce(message: string): void {
  const region = document.getElementById('copy-live-region');
  if (region) {
    region.textContent = message;
  }
}

async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  if (button.disabled) return;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }

  const defaultIcon = button.querySelector<HTMLElement>('.copy-icon-default');
  const doneIcon = button.querySelector<HTMLElement>('.copy-icon-done');
  const label = button.querySelector<HTMLElement>('.copy-label');
  const originalLabel = button.dataset.origLabel ?? label?.textContent ?? 'コピー';
  if (!button.dataset.origLabel) {
    button.dataset.origLabel = originalLabel;
  }

  const prevTimer = copyTimers.get(button);
  if (prevTimer !== undefined) {
    window.clearTimeout(prevTimer);
  }

  button.classList.add('is-copied');
  if (defaultIcon) defaultIcon.hidden = true;
  if (doneIcon) doneIcon.hidden = false;
  if (label) label.textContent = 'コピー完了';
  announce('コマンドをクリップボードにコピーしました');

  const timerId = window.setTimeout(() => {
    button.classList.remove('is-copied');
    if (defaultIcon) defaultIcon.hidden = false;
    if (doneIcon) doneIcon.hidden = true;
    if (label) label.textContent = originalLabel;
    copyTimers.delete(button);
  }, 1800);
  copyTimers.set(button, timerId);
}

function initMobileMenu(): void {
  const toggle = document.getElementById('mobile-menu-toggle') as HTMLButtonElement | null;
  const drawer = document.getElementById('mobile-nav-drawer');
  if (!toggle || !drawer) return;

  const openIcon = toggle.querySelector<HTMLElement>('.icon-open');
  const closeIcon = toggle.querySelector<HTMLElement>('.icon-close');

  const setOpen = (open: boolean) => {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'ナビゲーションメニューを閉じる' : 'ナビゲーションメニューを開く');
    drawer.hidden = !open;
    if (openIcon) openIcon.hidden = open;
    if (closeIcon) closeIcon.hidden = !open;
  };

  toggle.addEventListener('click', () => {
    const isExpanded = toggle.getAttribute('aria-expanded') === 'true';
    setOpen(!isExpanded);
  });

  drawer.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  const desktopMq = window.matchMedia('(min-width: 1081px)');
  desktopMq.addEventListener('change', (e) => {
    if (e.matches && !drawer.hidden) {
      setOpen(false);
    }
  });
}

function setCommandTokens(el: HTMLElement, cmd: string): void {
  el.replaceChildren();
  cmd.split(' ').forEach((tok, idx) => {
    if (idx > 0) el.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    span.className = 'cmd-tok';
    span.textContent = tok;
    el.appendChild(span);
  });
}

function initHeroModeSwitch(): void {
  const codeEl = document.getElementById('hero-command-text');
  const promptEl = codeEl?.parentElement?.querySelector<HTMLElement>('.command-prompt');
  const tabs = document.querySelectorAll<HTMLButtonElement>('[data-hero-mode]');
  if (!codeEl || tabs.length === 0) return;

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.heroMode;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      if (promptEl) {
        promptEl.textContent = mode === 'session' ? '❯' : '$';
      }
      setCommandTokens(
        codeEl,
        mode === 'session'
          ? '/plugin install done-gate --marketplace simota/claude-mods'
          : 'claude plugin install done-gate --marketplace simota/claude-mods',
      );
    });
  });
}

function initCockpit(): void {
  const root = document.getElementById('cockpit');
  if (!root) return;

  const raw = root.dataset.scenarios;
  if (!raw) return;

  let scenarios: CockpitScenario[] = [];
  try {
    scenarios = JSON.parse(raw) as CockpitScenario[];
  } catch {
    return;
  }

  const tabs = root.querySelectorAll<HTMLButtonElement>('[data-scenario-id]');
  const viewport = document.getElementById('cockpit-viewport');
  const badge = document.getElementById('cockpit-mod-badge');
  const problemTag = document.getElementById('cockpit-problem-tag');
  const problemText = document.getElementById('cockpit-problem-text');
  const outcomeText = document.getElementById('cockpit-outcome-text');
  const toolRows = document.getElementById('cockpit-tool-rows');
  const pane = document.getElementById('cockpit-pane');
  const band = document.getElementById('cockpit-band');
  const bandDismissed = document.getElementById('cockpit-band-dismissed');
  const bandRestore = document.getElementById('cockpit-band-restore');
  const bandSweep = document.getElementById('cockpit-band-sweep');
  const bandText = document.getElementById('cockpit-band-text');
  const bandActions = document.getElementById('cockpit-band-actions');
  const promptInput = document.getElementById('cockpit-prompt-input');
  const statusline = document.getElementById('cockpit-statusline');
  const caption = document.getElementById('cockpit-caption');

  if (
    !viewport ||
    !badge ||
    !toolRows ||
    !pane ||
    !band ||
    !bandDismissed ||
    !bandRestore ||
    !bandSweep ||
    !bandText ||
    !bandActions ||
    !promptInput ||
    !statusline ||
    !caption
  ) {
    return;
  }

  const showBand = () => {
    band.hidden = false;
    bandDismissed.hidden = true;
  };

  const handlePrimaryClick = (btn: HTMLButtonElement, label: string, fill: string) => {
    if (fill.startsWith('#')) {
      document.querySelector(fill)?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
      return;
    }
    promptInput.textContent = fill;
    promptInput.classList.add('is-filled');
    btn.textContent = '✓ 入力欄にセット済み';
    btn.classList.add('is-triggered');
    announce(`${label}: プロンプト入力欄に依頼文を挿入しました（自動送信はされません）`);
  };

  const handleSecondaryClick = (action: 'dismiss' | 'focus-pane') => {
    if (action === 'dismiss') {
      band.hidden = true;
      bandDismissed.hidden = false;
      announce('帯を閉じました');
    } else if (action === 'focus-pane') {
      pane.classList.remove('is-highlighted');
      void pane.offsetWidth;
      pane.classList.add('is-highlighted');
      pane.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      announce('ペインの詳細行をハイライトしました');
    }
  };

  bandRestore.addEventListener('click', () => {
    showBand();
    announce('帯を再表示しました');
  });

  const renderScenario = (scenario: CockpitScenario) => {
    showBand();
    pane.classList.remove('is-highlighted');
    viewport.setAttribute('aria-labelledby', `cockpit-tab-${scenario.id}`);
    badge.textContent = scenario.modBadge;
    caption.textContent = scenario.caption;
    if (problemText) problemText.textContent = scenario.problem;
    if (outcomeText) outcomeText.textContent = scenario.outcome;
    if (problemTag) {
      const isKachi = scenario.id === 'kachi';
      problemTag.textContent = isKachi ? 'ハマり突破' : 'AIのやらかし';
      problemTag.classList.toggle('cue-tag--neutral', isKachi);
      problemTag.classList.toggle('cue-tag--bad', !isKachi);
    }

    toolRows.replaceChildren();
    scenario.toolRows.forEach((row) => {
      const group = document.createElement('div');
      group.className = 't-row-group';

      const mainRow = document.createElement('div');
      mainRow.className = 't-row';

      const icon = document.createElement('span');
      icon.className = 't-icon';
      icon.style.color = row.iconColor;
      icon.innerHTML = toolIconSvg(row.icon);

      const path = document.createElement('span');
      path.className = 't-path';
      path.textContent = row.path;

      const stats = document.createElement('span');
      stats.className = 't-stats';
      row.stats.forEach((st, idx) => {
        if (idx > 0) stats.appendChild(document.createTextNode(' '));
        const s = document.createElement('span');
        s.style.color = st.color;
        s.textContent = st.text;
        stats.appendChild(s);
      });

      mainRow.append(icon, path, stats);
      group.appendChild(mainRow);

      if (row.subnote) {
        const sub = document.createElement('div');
        sub.className = 't-subnote';
        sub.style.color = row.subnote.color;
        sub.textContent = row.subnote.text;
        group.appendChild(sub);
      }

      toolRows.appendChild(group);
    });

    pane.replaceChildren();
    if (scenario.paneTitle && scenario.paneLines && scenario.paneLines.length > 0) {
      pane.hidden = false;
      const pTitle = document.createElement('div');
      pTitle.className = 'terminal-pane-title';
      pTitle.textContent = scenario.paneTitle;
      pane.appendChild(pTitle);

      scenario.paneLines.forEach((line) => {
        const l = document.createElement('div');
        l.className = 'terminal-pane-line';
        if (line.color) l.style.color = line.color;
        if (line.dim) l.style.opacity = '0.68';
        if (line.bold) l.style.fontWeight = '700';
        l.textContent = line.text;
        pane.appendChild(l);
      });
    } else {
      pane.hidden = true;
    }

    band.style.setProperty('--band-color', scenario.band.color);
    bandText.textContent = scenario.band.text;

    bandSweep.classList.remove('is-sweeping');
    if (scenario.band.sweep) {
      void bandSweep.offsetWidth;
      bandSweep.classList.add('is-sweeping');
    }

    bandActions.replaceChildren();
    if (scenario.band.primaryBtn) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'band-btn band-btn--primary';
      const label = scenario.band.primaryBtn.label;
      const fill = scenario.band.primaryBtn.promptFill;
      btn.textContent = label;
      btn.addEventListener('click', () => handlePrimaryClick(btn, label, fill));
      bandActions.appendChild(btn);
    }

    if (scenario.band.secondaryBtn) {
      const sec = document.createElement('button');
      sec.type = 'button';
      sec.className = 'band-btn band-btn--ghost';
      sec.textContent = scenario.band.secondaryBtn.label;
      const action = scenario.band.secondaryBtn.action;
      sec.addEventListener('click', () => handleSecondaryClick(action));
      bandActions.appendChild(sec);
    }

    promptInput.textContent = scenario.defaultPrompt;
    promptInput.classList.toggle('is-filled', scenario.defaultPrompt.length > 0);

    const firstStatus = statusline.firstElementChild;
    if (firstStatus) {
      firstStatus.textContent = scenario.statusLine;
    }
  };

  // Bind initial SSR buttons
  const initialScenario = scenarios[0];
  const initialPrimary = document.getElementById('cockpit-action-btn') as HTMLButtonElement | null;
  if (initialPrimary && initialScenario?.band.primaryBtn) {
    const { label, promptFill } = initialScenario.band.primaryBtn;
    initialPrimary.addEventListener('click', () => handlePrimaryClick(initialPrimary, label, promptFill));
  }
  const initialSecondary = document.getElementById('cockpit-secondary-btn') as HTMLButtonElement | null;
  if (initialSecondary && initialScenario?.band.secondaryBtn) {
    const { action } = initialScenario.band.secondaryBtn;
    initialSecondary.addEventListener('click', () => handleSecondaryClick(action));
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.scenarioId;
      const found = scenarios.find((s) => s.id === id);
      if (!found) return;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
        t.setAttribute('tabindex', active ? '0' : '-1');
      });
      renderScenario(found);
    });
  });
}

function initKachiBench(): void {
  const tierBtns = document.querySelectorAll<HTMLButtonElement>('[data-kachi-tier]');
  const volBtns = document.querySelectorAll<HTMLButtonElement>('[data-kachi-volume]');
  const cmdEl = document.getElementById('kachi-cmd-text');
  const receiptEl = document.getElementById('kachi-receipt-line');
  const bandEl = document.getElementById('kachi-sweep-band');
  const beamEl = document.getElementById('kachi-sweep-beam');
  const stampEl = document.getElementById('kachi-stamp-text');
  const indicatorEl = document.getElementById('kachi-tier-indicator');
  const passStatEl = document.getElementById('kachi-pass-stat');

  if (tierBtns.length === 0 || !cmdEl || !receiptEl || !bandEl || !beamEl || !stampEl || !indicatorEl || !passStatEl) {
    return;
  }

  let soundMode: 'on' | 'quiet' | 'off' = 'on';
  const gains: Record<number, number> = { 1: 0.25, 2: 0.45, 3: 0.6, 4: 0.75 };

  // Preload bundled WAV clips for zero-latency acoustic response
  const audioPool: Record<number, HTMLAudioElement> = {};
  for (let t = 1; t <= 4; t += 1) {
    const el = new Audio(`./assets/audio/kachi-${t - 1}.wav`);
    el.preload = 'auto';
    audioPool[t] = el;
  }

  const tierMeta: Record<
    number,
    {
      cmd: string;
      label: string;
      receipt: string;
      dimReceipt?: boolean;
      stamp: string;
      pass: string;
      sweepMs: number;
      mode: 'stamp' | 'once' | 'pulse' | 'double';
    }
  > = {
    1: {
      cmd: '$ pnpm test',
      label: 'Tier 1 · tick (60ms)',
      receipt: '（Tier 1 はツール行下のレシートを出さず、帯に静かな1行スタンプだけを残します）',
      dimReceipt: true,
      stamp: '✔ pnpm test  緑 · 編集後はじめて',
      pass: '48 passed (1.18s)',
      sweepMs: 220,
      mode: 'stamp',
    },
    2: {
      cmd: '$ pnpm test',
      label: 'Tier 2 · click (140ms)',
      receipt: '✔ 赤→緑  2 回目で · 1m14s 赤だった · 1 → 0 failing',
      stamp: '✔ pnpm test  緑',
      pass: '48 passed (1.31s)',
      sweepMs: 420,
      mode: 'once',
    },
    3: {
      cmd: '$ pnpm test',
      label: 'Tier 3 · chime (380ms)',
      receipt: '✔ 赤→緑  4 回目で · 6m18s 赤だった · 3 → 0 failing',
      stamp: '✔ pnpm test  緑',
      pass: '48 passed (1.42s)',
      sweepMs: 620,
      mode: 'pulse',
    },
    4: {
      cmd: '$ cargo test',
      label: 'Tier 4 · bell (700ms)',
      receipt: '✔ 赤→緑  9 回目で · 22m05s 赤だった · 12 → 0 failing',
      stamp: '✔ cargo test  緑',
      pass: '124 passed (2.09s)',
      sweepMs: 860,
      mode: 'double',
    },
  };

  volBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.kachiVolume;
      if (v === 'on' || v === 'quiet' || v === 'off') {
        soundMode = v;
      }
      volBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  });

  tierBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tier = Number(btn.dataset.kachiTier ?? '3');
      const meta = tierMeta[tier] ?? tierMeta[3]!;

      tierBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-selected', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });

      cmdEl.textContent = meta.cmd;
      receiptEl.textContent = meta.receipt;
      receiptEl.classList.toggle('is-dim-note', Boolean(meta.dimReceipt));
      stampEl.textContent = meta.stamp;
      indicatorEl.textContent = meta.label;
      passStatEl.textContent = meta.pass;
      bandEl.dataset.tier = String(tier);

      beamEl.style.setProperty('--sweep-ms', `${meta.sweepMs}ms`);
      beamEl.classList.remove('is-running', 'is-double');
      bandEl.classList.remove('is-pulsing-once', 'is-pulsing-strong', 'is-stamp-flash');
      void beamEl.offsetWidth;

      if (meta.mode === 'stamp') {
        bandEl.classList.add('is-stamp-flash');
      } else if (meta.mode === 'once') {
        beamEl.classList.add('is-running');
      } else if (meta.mode === 'pulse') {
        beamEl.classList.add('is-running');
        bandEl.classList.add('is-pulsing-once');
      } else if (meta.mode === 'double') {
        beamEl.classList.add('is-running', 'is-double');
        bandEl.classList.add('is-pulsing-strong');
      }

      if (soundMode !== 'off' && !(soundMode === 'quiet' && tier === 1)) {
        Object.values(audioPool).forEach((a) => {
          a.pause();
          a.currentTime = 0;
        });
        const audio = audioPool[tier];
        if (audio) {
          const baseGain = gains[tier] ?? 0.5;
          audio.volume = Math.min(1, baseGain * (soundMode === 'quiet' ? 0.5 : 1));
          void audio.play().catch(() => {
            // Ignore autoplay / headless audio device errors cleanly
          });
        }
      }
    });
  });

  // Video overlay & chapter synchronization
  const video = document.getElementById('promo-video') as HTMLVideoElement | null;
  const playOverlay = document.getElementById('promo-play-overlay') as HTMLButtonElement | null;
  const chapterBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-seek]'));

  if (video && playOverlay) {
    playOverlay.addEventListener('click', () => {
      playOverlay.hidden = true;
      void video.play().catch(() => {});
    });
    video.addEventListener('play', () => {
      playOverlay.hidden = true;
    });
    video.addEventListener('ended', () => {
      playOverlay.hidden = false;
    });
  }

  const updateActiveChapter = (t: number) => {
    chapterBtns.forEach((btn) => {
      const start = Number(btn.dataset.seek ?? '0');
      const end = Number(btn.dataset.seekEnd ?? '999');
      btn.classList.toggle('is-active', t >= start && t < end);
    });
  };

  video?.addEventListener('timeupdate', () => {
    updateActiveChapter(video.currentTime);
  });

  chapterBtns.forEach((chapter) => {
    chapter.addEventListener('click', () => {
      if (!video) return;
      const sec = Number(chapter.dataset.seek ?? '0');
      updateActiveChapter(sec);
      if (playOverlay) playOverlay.hidden = true;
      video.currentTime = sec;
      void video.play().catch(() => {});
    });
  });
}

function initCatalogAndBuilder(): void {
  const section = document.getElementById('mods');
  if (!section) return;

  let presets: StarterPreset[] = [];
  let categories: ModCategoryMeta[] = [];
  let modConfigs: Record<string, ModConfigMeta> = {};

  try {
    presets = JSON.parse(section.dataset.presets ?? '[]') as StarterPreset[];
    categories = JSON.parse(section.dataset.categories ?? '[]') as ModCategoryMeta[];
    modConfigs = JSON.parse(section.dataset.modConfigs ?? '{}') as Record<string, ModConfigMeta>;
  } catch {
    // Fallback gracefully if dataset parsing fails
  }

  const catPills = section.querySelectorAll<HTMLButtonElement>('[data-cat-filter]');
  const catSummaryEl = document.getElementById('cat-active-summary');
  const defaultSummaryHtml = catSummaryEl?.innerHTML ?? '';
  const searchInput = document.getElementById('mod-search-input') as HTMLInputElement | null;
  const hitCountEl = document.getElementById('mod-hit-count');
  const cards = section.querySelectorAll<HTMLElement>('[data-mod-card]');
  const emptyState = document.getElementById('mod-empty-state');
  const resetFilterBtn = document.getElementById('mod-reset-filter');

  const expandWrap = document.getElementById('mods-mobile-expand-wrap');
  const expandBtn = document.getElementById('mods-expand-btn') as HTMLButtonElement | null;
  const extraCardsCount = Array.from(cards).filter((c) => c.dataset.modExtra === 'true').length;

  const checkboxes = section.querySelectorAll<HTMLInputElement>('.mod-checkbox');
  const selectedCountEl = document.getElementById('builder-selected-count');
  const clearBtn = document.getElementById('builder-clear-btn');
  const presetBtns = section.querySelectorAll<HTMLButtonElement>('[data-preset-id]');
  const modeTabs = section.querySelectorAll<HTMLButtonElement>('[data-builder-mode]');
  const outputEl = document.getElementById('builder-command-output');
  const builderCopyBtn = document.getElementById('builder-copy-btn') as HTMLButtonElement | null;

  const floatingBar = document.getElementById('floating-selection-bar');
  const floatingCountEl = document.getElementById('floating-selected-count');
  const floatingNamesEl = document.getElementById('floating-mod-names');
  const floatingCopyBtn = document.getElementById('floating-copy-btn') as HTMLButtonElement | null;
  const installEl = document.getElementById('install');
  const modsGridEl = document.getElementById('mods-grid');

  let activeCat = 'all';
  let builderMode: 'shell' | 'session' | 'configure' = 'shell';
  let mobileExpanded = false;
  let modsInView = false;
  let installInView = false;
  const selected = new Set<string>();

  checkboxes.forEach((cb) => {
    if (cb.checked) selected.add(cb.value);
  });

  const setMobileExpanded = (exp: boolean) => {
    mobileExpanded = exp;
    document.documentElement.classList.toggle('mods-expanded', exp);
    if (expandBtn) {
      expandBtn.setAttribute('aria-expanded', exp ? 'true' : 'false');
      const span = expandBtn.querySelector('span');
      if (span) {
        span.textContent = exp
          ? '人気 10 個のみに折りたたむ'
          : `残り ${extraCardsCount} 個のプラグインもすべて見る（全 ${cards.length} 個）`;
      }
    }
  };

  expandBtn?.addEventListener('click', () => {
    setMobileExpanded(!mobileExpanded);
  });

  const updateFloatingVisibility = () => {
    if (!floatingBar) return;
    const shouldShow = selected.size > 0 && modsInView && !installInView;
    floatingBar.hidden = !shouldShow;
  };

  if ('IntersectionObserver' in window && floatingBar && installEl) {
    const modsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          modsInView = entry.isIntersecting;
        });
        updateFloatingVisibility();
      },
      { threshold: 0.04 },
    );
    modsObserver.observe(modsGridEl ?? section);

    const installObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          installInView = entry.isIntersecting;
        });
        updateFloatingVisibility();
      },
      { threshold: 0.15 },
    );
    installObserver.observe(installEl);
  }

  const applyFilter = () => {
    const q = (searchInput?.value ?? '').trim().toLowerCase();
    const filtering = activeCat !== 'all' || q !== '';

    if (filtering && !mobileExpanded) {
      setMobileExpanded(true);
    }
    if (expandWrap) {
      expandWrap.hidden = filtering;
    }

    let visible = 0;
    cards.forEach((card) => {
      const cat = card.dataset.modCat ?? '';
      const hay = card.dataset.modSearch ?? '';
      const catMatch = activeCat === 'all' || cat === activeCat;
      const qMatch = q === '' || hay.includes(q);
      const show = catMatch && qMatch;
      card.hidden = !show;
      if (show) visible += 1;
    });

    if (hitCountEl) hitCountEl.textContent = `${visible} / ${cards.length} 件`;
    if (emptyState) emptyState.hidden = visible > 0;

    if (catSummaryEl) {
      if (activeCat === 'all') {
        catSummaryEl.innerHTML = defaultSummaryHtml;
      } else {
        const meta = categories.find((c) => c.id === activeCat);
        if (meta) {
          catSummaryEl.textContent = `${meta.labelJa}: ${meta.summary}`;
        }
      }
    }
  };

  const syncBuilderOutput = () => {
    const list = Array.from(selected);
    const countLabel = `${list.length} 個選択中`;

    if (selectedCountEl) selectedCountEl.textContent = countLabel;
    if (floatingCountEl) floatingCountEl.textContent = countLabel;
    if (floatingNamesEl) {
      floatingNamesEl.textContent =
        list.length <= 4 ? list.join(', ') : `${list.slice(0, 3).join(', ')} ほか ${list.length - 3} 個`;
    }

    if (builderCopyBtn) builderCopyBtn.disabled = list.length === 0;
    if (floatingCopyBtn) floatingCopyBtn.disabled = list.length === 0;
    updateFloatingVisibility();

    cards.forEach((card) => {
      const name = card.dataset.modCard ?? '';
      const isSel = selected.has(name);
      card.classList.toggle('is-selected', isSel);
      const cb = card.querySelector<HTMLInputElement>('.mod-checkbox');
      const labelTxt = card.querySelector<HTMLElement>('.mod-check-text');
      if (cb) cb.checked = isSel;
      if (labelTxt) labelTxt.textContent = isSel ? '選択中' : '追加';
    });

    if (!outputEl) return;
    if (list.length === 0) {
      outputEl.textContent = '# おすすめパックまたは下のカードから導入したいプラグインを1つ以上選んでください';
      return;
    }

    const defaultOffSelected = list.filter((m) => modConfigs[m]?.defaultOff);

    if (builderMode === 'shell') {
      const installBlock = list
        .map((m) => `claude plugin install ${m} --marketplace simota/claude-mods`)
        .join(' && \\\n');
      if (defaultOffSelected.length > 0) {
        const optInLines = defaultOffSelected
          .map((m) => `echo '{"enabled":"true"}' | claude plugin configure ${m}@simota-mods --values-stdin`)
          .join('\n');
        outputEl.textContent = `${installBlock}\n\n# 既定オフのプラグインを有効化する場合（任意）:\n${optInLines}`;
      } else {
        outputEl.textContent = installBlock;
      }
    } else if (builderMode === 'session') {
      const sessionBlock = list
        .map((m) => `/plugin install ${m} --marketplace simota/claude-mods`)
        .join('\n');
      if (defaultOffSelected.length > 0) {
        const optInSession = defaultOffSelected.map((m) => `/plugin configure ${m}@simota-mods`).join('\n');
        outputEl.textContent = `${sessionBlock}\n\n# 既定オフのプラグインをセッション内で有効化する場合:\n${optInSession}`;
      } else {
        outputEl.textContent = sessionBlock;
      }
    } else {
      const configurable = list.filter((m) => modConfigs[m]?.configSample !== null && modConfigs[m]?.configSample !== undefined);
      const zeroConfig = list.filter((m) => !modConfigs[m]?.configSample);
      const lines: string[] = [];

      if (configurable.length > 0) {
        lines.push('# 1) セッション内で対話的に設定変更（再起動なしで即リロード反映）');
        configurable.slice(0, 4).forEach((m) => {
          const sample = modConfigs[m]!.configSample!;
          lines.push(`/plugin configure ${m}@simota-mods  # ${sample.note}`);
        });
        if (configurable.length > 4) {
          lines.push(`# …ほか ${configurable.length - 4} 個の設定可能プラグイン`);
        }
        lines.push('');
        lines.push('# 2) シェルから実在 userConfig キーを JSON で渡す例（再起動後に反映）');
        configurable.slice(0, 3).forEach((m) => {
          const sample = modConfigs[m]!.configSample!;
          lines.push(`echo '${sample.json}' | claude plugin configure ${m}@simota-mods --values-stdin`);
        });
      }

      if (zeroConfig.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push(`# 設定項目なし（入れた瞬間から自動で動きます）: ${zeroConfig.join(', ')}`);
      }

      outputEl.textContent = lines.join('\n');
    }
  };

  catPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      activeCat = pill.dataset.catFilter ?? 'all';
      catPills.forEach((p) => {
        const active = p === pill;
        p.classList.toggle('is-active', active);
        p.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      applyFilter();
    });
  });

  searchInput?.addEventListener('input', applyFilter);

  resetFilterBtn?.addEventListener('click', () => {
    activeCat = 'all';
    if (searchInput) searchInput.value = '';
    catPills.forEach((p, idx) => {
      p.classList.toggle('is-active', idx === 0);
      p.setAttribute('aria-pressed', idx === 0 ? 'true' : 'false');
    });
    applyFilter();
  });

  checkboxes.forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(cb.value);
      else selected.delete(cb.value);
      presetBtns.forEach((b) => {
        b.classList.remove('is-active');
        b.setAttribute('aria-pressed', 'false');
      });
      syncBuilderOutput();
    });
  });

  cards.forEach((card) => {
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.closest('label, input, button, a')) return;
      if ((window.getSelection()?.toString() ?? '').length > 0) return;
      const cb = card.querySelector<HTMLInputElement>('.mod-checkbox');
      if (!cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.presetId;
      const found = presets.find((p) => p.id === id);
      if (!found) return;
      if (id === 'all29' && !mobileExpanded) {
        setMobileExpanded(true);
      }
      selected.clear();
      found.mods.forEach((m) => selected.add(m));
      presetBtns.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      syncBuilderOutput();
    });
  });

  clearBtn?.addEventListener('click', () => {
    selected.clear();
    presetBtns.forEach((b) => {
      b.classList.remove('is-active');
      b.setAttribute('aria-pressed', 'false');
    });
    syncBuilderOutput();
  });

  modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.builderMode;
      if (mode === 'shell' || mode === 'session' || mode === 'configure') {
        builderMode = mode;
      }
      modeTabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      syncBuilderOutput();
    });
  });

  syncBuilderOutput();
}

function initCopyButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copyTarget;
      if (!targetId) return;
      const target = document.getElementById(targetId);
      if (!target) return;
      void copyText(target.textContent ?? '', btn);
    });
  });
}

function initScrollReveal(): void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
  if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const vh = window.innerHeight || 800;
  targets.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < vh * 1.1) {
      el.classList.add('is-visible');
    }
  });

  document.documentElement.classList.add('js-ready');
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting || entry.boundingClientRect.top < window.innerHeight) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px 100px 0px', threshold: 0.01 },
  );

  targets.forEach((el) => {
    if (!el.classList.contains('is-visible')) {
      observer.observe(el);
    }
  });

  window.addEventListener('hashchange', () => {
    targets.forEach((el) => el.classList.add('is-visible'));
  });
}

function initTablistKeyboard(): void {
  document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((tablist) => {
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    if (tabs.length < 2) return;
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
      const current = document.activeElement as HTMLButtonElement | null;
      const idx = current ? tabs.indexOf(current) : -1;
      if (idx === -1) return;
      e.preventDefault();
      let nextIdx = idx;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabs.length - 1;
      const next = tabs[nextIdx];
      if (next) {
        next.click();
        next.focus();
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initMobileMenu();
  initHeroModeSwitch();
  initCockpit();
  initKachiBench();
  initCatalogAndBuilder();
  initCopyButtons();
  initTablistKeyboard();
  initScrollReveal();
});
