// 《勿聲》HUSH — UI 與 HUD 控制器（E3）
// 依 docs/architecture.md §6.5 規範實作：管理 DOM 狀態、畫面切換、設定面板與回饋提示。

import { DEFAULT_SETTINGS, SCREENS } from './core/config.js';

export class UI {
  /**
   * @param {Document|HTMLElement} [root=document]
   */
  constructor(root = document) {
    this.root = root;

    // 快取主要 DOM 元素
    this.app = this._el('app');
    this.canvas = this._el('game-canvas');
    this.hud = this._el('hud');

    // HUD 元件
    this.volumeRing = this._el('volume-ring');
    this.volumeValue = this._el('volume-value');
    this.volumeLabel = this._el('volume-label');
    this.breathFill = this._el('breath-fill');
    this.breathValue = this._el('breath-value');
    this.modeBadge = this._el('mode-badge');
    this.chapterName = this._el('chapter-name');
    this.objectiveText = this._el('objective-text');
    this.subtitle = this._el('subtitle');
    this.toastEl = this._el('toast');
    this.dangerVignette = this._el('danger-vignette');
    this.hint = this._el('hint');

    // 畫面
    this.screenStart = this._el('screen-start');
    this.screenCalibration = this._el('screen-calibration');
    this.screenPause = this._el('screen-pause');
    this.screenDeath = this._el('screen-death');
    this.screenChapter = this._el('screen-chapter');
    this.screenEnding = this._el('screen-ending');
    this.settingsPanel = this._el('settings-panel');

    // 按鈕
    this.btnStart = this._el('btn-start');
    this.btnContinue = this._el('btn-continue');
    this.btnSettings = this._el('btn-settings');
    this.btnPauseSettings = this._el('btn-pause-settings');
    this.btnCloseSettings = this._el('btn-close-settings');
    this.btnSettingsDone = this._el('btn-settings-done');
    this.btnResetProgress = this._el('btn-reset-progress');
    this.btnMicRetry = this._el('btn-mic-retry');
    this.btnCalibrate = this._el('btn-calibrate');
    this.btnSkipCalibration = this._el('btn-skip-calibration');
    this.btnResume = this._el('btn-resume');
    this.btnRestart = this._el('btn-restart');
    this.btnQuit = this._el('btn-quit');
    this.btnNextChapter = this._el('btn-next-chapter');
    this.btnReplay = this._el('btn-replay');
    this.btnEndingMenu = this._el('btn-ending-menu');

    // 狀態與說明
    this.micStatus = this._el('mic-status');
    this.calibrationInstruction = this._el('calibration-instruction');
    this.calibrationMeterFill = this._el('calibration-meter-fill');
    this.calibrationStep = this._el('calibration-step');
    this.calibrationValue = this._el('calibration-value');
    this.calibrationProgress = this._el('calibration-progress');
    this.deathTip = this._el('death-tip');
    this.deathCountdown = this._el('death-countdown');
    this.endingTitle = this._el('ending-title');
    this.endingCopy = this._el('ending-copy');
    this.endingStats = this._el('ending-stats');
    this.bootError = this._el('boot-error');

    // 章節卡
    this.chapterCardKicker = this._el('chapter-card-kicker');
    this.chapterCardTitle = this._el('chapter-card-title');
    this.chapterCardLines = this._el('chapter-card-lines');

    // 設定表單元件
    this.settingModeMic = this._el('setting-mode-mic');
    this.settingModeKeyboard = this._el('setting-mode-keyboard');
    this.settingSensitivity = this._el('setting-sensitivity');
    this.sensitivityValue = this._el('sensitivity-value');
    this.settingVolume = this._el('setting-volume');
    this.volumeSettingValue = this._el('volume-setting-value');
    this.settingSubtitles = this._el('setting-subtitles');
    this.settingReducedMotion = this._el('setting-reduced-motion');

    /** @type {Record<string, Function[]>} */
    this._handlers = {};
    /** @type {Function|null} */
    this._onContinue = null;
    /** @type {number|null} */
    this._subTimer = null;
    /** @type {number|null} */
    this._toastTimer = null;
    this._currentScreen = SCREENS.start;

    this._settings = { ...DEFAULT_SETTINGS };

    this._initEvents();
  }

  _el(id) {
    if (this.root.getElementById) {
      return this.root.getElementById(id);
    }
    return this.root.querySelector ? this.root.querySelector(`#${id}`) : null;
  }

  _initEvents() {
    const bind = (el, action) => {
      if (!el) return;
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._trigger(action);
      });
    };

    bind(this.btnStart, 'start');
    bind(this.btnContinue, 'continue');
    bind(this.btnMicRetry, 'mic-retry');
    bind(this.btnCalibrate, 'calibrate');
    bind(this.btnSkipCalibration, 'skip-calibration');
    bind(this.btnResume, 'resume');
    bind(this.btnRestart, 'restart');
    bind(this.btnQuit, 'quit');
    bind(this.btnReplay, 'replay');
    bind(this.btnEndingMenu, 'quit');
    bind(this.btnResetProgress, 'reset-progress');

    // 章節卡進入按鈕
    if (this.btnNextChapter) {
      this.btnNextChapter.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (typeof this._onContinue === 'function') {
          const fn = this._onContinue;
          this._onContinue = null;
          fn();
        }
        this._trigger('next-chapter');
      });
    }

    // 設定面板開啟與關閉
    const openSettings = (ev) => {
      ev?.preventDefault();
      this.openSettings();
      this._trigger('settings');
    };
    if (this.btnSettings) this.btnSettings.addEventListener('click', openSettings);
    if (this.btnPauseSettings) this.btnPauseSettings.addEventListener('click', openSettings);

    const closeSettings = (ev) => {
      ev?.preventDefault();
      this.closeSettings();
    };
    if (this.btnCloseSettings) this.btnCloseSettings.addEventListener('click', closeSettings);
    if (this.btnSettingsDone) this.btnSettingsDone.addEventListener('click', closeSettings);

    const backdrop = this.settingsPanel?.querySelector('.settings__backdrop');
    if (backdrop) backdrop.addEventListener('click', closeSettings);

    // 設定控制項即時連動
    const syncControls = () => {
      const mode = this.settingModeKeyboard?.checked ? 'keyboard' : 'mic';
      const sens = Number(this.settingSensitivity?.value || 100);
      const vol = Number(this.settingVolume?.value || 80);
      const subs = Boolean(this.settingSubtitles?.checked);
      const redMot = Boolean(this.settingReducedMotion?.checked);

      if (this.sensitivityValue) this.sensitivityValue.textContent = `${sens}%`;
      if (this.volumeSettingValue) this.volumeSettingValue.textContent = `${vol}%`;

      this._settings = {
        mode,
        sensitivity: sens / 100,
        masterVolume: vol / 100,
        subtitles: subs,
        reducedMotion: redMot,
      };

      this._applyModeClass(mode);
      this._applyReducedMotionClass(redMot);
      this._trigger('settings-change', this.getSettings());
    };

    if (this.settingModeMic) this.settingModeMic.addEventListener('change', syncControls);
    if (this.settingModeKeyboard) this.settingModeKeyboard.addEventListener('change', syncControls);
    if (this.settingSensitivity) this.settingSensitivity.addEventListener('input', syncControls);
    if (this.settingVolume) this.settingVolume.addEventListener('input', syncControls);
    if (this.settingSubtitles) this.settingSubtitles.addEventListener('change', syncControls);
    if (this.settingReducedMotion) this.settingReducedMotion.addEventListener('change', syncControls);
  }

  _applyModeClass(mode) {
    const doc = this.root.ownerDocument || document;
    if (doc?.body) {
      doc.body.classList.toggle('mode-keyboard', mode === 'keyboard');
    }
    if (this.modeBadge) {
      this.modeBadge.textContent = mode === 'keyboard' ? 'KBD' : 'MIC';
    }
  }

  _applyReducedMotionClass(reduced) {
    const doc = this.root.ownerDocument || document;
    if (doc?.body) {
      doc.body.classList.toggle('reduced-motion', Boolean(reduced));
    }
  }

  _trigger(action, data) {
    const list = this._handlers[action];
    if (Array.isArray(list)) {
      for (const handler of list) {
        try {
          handler(data);
        } catch (err) {
          console.error(`UI handler error for [${action}]:`, err);
        }
      }
    }
  }

  /**
   * 註冊動作處理器。
   * @param {string} action
   * @param {Function} handler
   */
  on(action, handler) {
    if (typeof handler !== 'function') return;
    if (!this._handlers[action]) this._handlers[action] = [];
    this._handlers[action].push(handler);
  }

  /**
   * 切換全螢幕遮罩畫面。
   * @param {'start'|'calibration'|'chapter'|'pause'|'death'|'ending'|'none'} name
   */
  showScreen(name) {
    this._currentScreen = name;
    const screens = {
      start: this.screenStart,
      calibration: this.screenCalibration,
      chapter: this.screenChapter,
      pause: this.screenPause,
      death: this.screenDeath,
      ending: this.screenEnding,
    };

    for (const [key, el] of Object.entries(screens)) {
      if (!el) continue;
      if (key === name) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }

    if (this.hud) {
      if (name === 'none') {
        this.hud.classList.remove('hidden');
      } else {
        this.hud.classList.add('hidden');
      }
    }
  }

  openSettings() {
    if (this.settingsPanel) this.settingsPanel.classList.add('open');
  }

  closeSettings() {
    if (this.settingsPanel) this.settingsPanel.classList.remove('open');
  }

  /**
   * 設定畫面目前的設定值並同步表單。
   * @param {object} settings
   */
  setSettings(settings = {}) {
    this._settings = { ...this._settings, ...settings };
    const mode = this._settings.mode === 'keyboard' ? 'keyboard' : 'mic';
    if (this.settingModeMic) this.settingModeMic.checked = mode === 'mic';
    if (this.settingModeKeyboard) this.settingModeKeyboard.checked = mode === 'keyboard';

    const sens = Math.round((Number(this._settings.sensitivity) || 1) * 100);
    if (this.settingSensitivity) this.settingSensitivity.value = String(sens);
    if (this.sensitivityValue) this.sensitivityValue.textContent = `${sens}%`;

    const vol = Math.round((Number(this._settings.masterVolume) || 0.8) * 100);
    if (this.settingVolume) this.settingVolume.value = String(vol);
    if (this.volumeSettingValue) this.volumeSettingValue.textContent = `${vol}%`;

    if (this.settingSubtitles) this.settingSubtitles.checked = this._settings.subtitles !== false;
    if (this.settingReducedMotion) this.settingReducedMotion.checked = Boolean(this._settings.reducedMotion);

    this._applyModeClass(mode);
    this._applyReducedMotionClass(this._settings.reducedMotion);
  }

  /**
   * 取得目前設定。
   * @returns {{mode:string, sensitivity:number, masterVolume:number, subtitles:boolean, reducedMotion:boolean}}
   */
  getSettings() {
    return { ...this._settings };
  }

  /**
   * 更新 HUD 狀態。
   * @param {object} state GameSession.getState()
   */
  update(state) {
    if (!state) return;

    // 1) 聲量環
    const vol = Math.max(0, Math.min(100, Math.round(state.effectiveVolume ?? state.volume ?? 0)));
    const bandColor = state.band?.color || 'var(--ink-faint)';
    const bandLabel = state.band?.label || '靜默';

    if (this.volumeRing) {
      this.volumeRing.style.setProperty('--vol', String(vol));
      this.volumeRing.style.setProperty('--band-color', bandColor);
      this.volumeRing.setAttribute('aria-valuenow', String(vol));
    }
    if (this.volumeValue) this.volumeValue.textContent = String(vol);
    if (this.volumeLabel) this.volumeLabel.textContent = bandLabel;

    // 2) 氣息條
    const breath = Math.max(0, Math.min(100, Math.round(state.breath?.value ?? 100)));
    const isGasp = state.breath?.state === 'gasp';

    if (this.breathValue) this.breathValue.textContent = String(breath);
    if (this.breathFill) {
      this.breathFill.style.width = `${breath}%`;
      this.breathFill.classList.toggle('gasp', isGasp);
      this.breathFill.classList.toggle('low', !isGasp && breath <= 25);
    }

    // 3) 章節與目標
    if (this.chapterName) {
      const idx = (state.chapterIndex || 0) + 1;
      const name = state.chapter?.name || '';
      this.chapterName.textContent = `第 ${idx} 章 · ${name}`;
    }

    if (this.objectiveText) {
      if (state.objectives && state.objectives.length) {
        const current = state.objectives.find((o) => !o.done);
        if (current) {
          const prog = current.target > 1 ? `（${current.progress}/${current.target}）` : '';
          this.objectiveText.textContent = `${current.text}${prog}`;
        } else {
          this.objectiveText.textContent = '前往出口';
        }
      } else {
        this.objectiveText.textContent = '找到出口';
      }
    }

    // 4) 危險暗角
    if (this.dangerVignette) {
      const danger = Math.max(0, Math.min(1, Number(state.danger) || 0));
      this.dangerVignette.style.setProperty('--danger', danger.toFixed(2));
    }

    // 5) 提示訊息
    if (this.hint) {
      if (state.message) {
        this.hint.textContent = state.message;
        this.hint.classList.add('show');
      } else {
        this.hint.classList.remove('show');
      }
    }

    // 6) 死亡倒數
    if (state.status === 'dead' && this.deathCountdown) {
      this.deathCountdown.textContent = String(Math.ceil(state.deathRemaining || 0));
    }
  }

  /**
   * 顯示中置字幕（自動淡出）。
   * @param {string} text
   * @param {number} [seconds=5]
   */
  setSubtitle(text, seconds = 5) {
    if (!this.subtitle) return;
    if (this._subTimer) {
      clearTimeout(this._subTimer);
      this._subTimer = null;
    }

    if (!text || this._settings.subtitles === false) {
      this.subtitle.textContent = '';
      this.subtitle.classList.remove('show');
      return;
    }

    this.subtitle.textContent = text;
    this.subtitle.classList.add('show');
    this._subTimer = setTimeout(() => {
      this.subtitle?.classList.remove('show');
    }, Math.max(500, seconds * 1000));
  }

  /**
   * 顯示畫面上方 Toast 提示。
   * @param {string} text
   * @param {number} [seconds=2.5]
   */
  toast(text, seconds = 2.5) {
    if (!this.toastEl) return;
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }

    if (!text) {
      this.toastEl.textContent = '';
      this.toastEl.classList.remove('show');
      return;
    }

    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    this._toastTimer = setTimeout(() => {
      this.toastEl?.classList.remove('show');
    }, Math.max(500, seconds * 1000));
  }

  /**
   * 更新麥克風狀態顯示。
   * @param {'ready'|'keyboard'|'denied'|'no-device'|'unsupported'|'error'|string} status
   * @param {string} [detail]
   */
  setMicStatus(status, detail) {
    if (!this.micStatus) return;
    this.micStatus.className = 'meta-value';

    if (status === 'ready' || status === 'ok' || status === 'calibrated') {
      this.micStatus.textContent = '已啟用';
      this.micStatus.classList.add('ok');
      if (this.btnMicRetry) this.btnMicRetry.classList.add('hidden');
    } else if (status === 'keyboard') {
      this.micStatus.textContent = '鍵盤模式';
      if (this.btnMicRetry) this.btnMicRetry.classList.add('hidden');
    } else if (status === 'denied') {
      this.micStatus.textContent = '權限已拒絕';
      this.micStatus.classList.add('error');
      if (this.btnMicRetry) this.btnMicRetry.classList.remove('hidden');
    } else if (status === 'no-device') {
      this.micStatus.textContent = '找不到麥克風';
      this.micStatus.classList.add('error');
      if (this.btnMicRetry) this.btnMicRetry.classList.remove('hidden');
    } else if (status === 'unsupported') {
      this.micStatus.textContent = '瀏覽器不支援';
      this.micStatus.classList.add('error');
      if (this.btnMicRetry) this.btnMicRetry.classList.add('hidden');
    } else if (status === 'error') {
      this.micStatus.textContent = detail || '麥克風錯誤';
      this.micStatus.classList.add('error');
      if (this.btnMicRetry) this.btnMicRetry.classList.remove('hidden');
    } else {
      this.micStatus.textContent = detail || '尚未啟用';
    }
  }

  /**
   * 更新校準進度與數值。
   * @param {{step:number, progress:number, instruction?:string, value?:number, level?:number}} data
   */
  setCalibrationStep({ step = 1, progress = 0, instruction = '', value = 0, level } = {}) {
    if (this.calibrationStep) this.calibrationStep.textContent = `步驟 ${step} / 3`;
    if (this.calibrationInstruction && instruction) {
      this.calibrationInstruction.textContent = instruction;
    }
    if (this.calibrationProgress) {
      const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
      this.calibrationProgress.style.width = `${pct}%`;
    }
    if (this.calibrationValue) {
      this.calibrationValue.textContent = String(Math.round(value));
    }
    if (this.calibrationMeterFill) {
      const fillPct = Math.max(0, Math.min(100, Math.round(level !== undefined ? level * 100 : value)));
      this.calibrationMeterFill.style.width = `${fillPct}%`;
    }
  }

  /**
   * 顯示章節卡片。
   * @param {object} chapter
   * @param {Function} [onContinue]
   */
  showChapterCard(chapter, onContinue) {
    this._onContinue = onContinue || null;
    if (chapter) {
      const idx = (chapter.chapterIndex ?? chapter.index ?? 0) + 1;
      const numMap = ['一', '二', '三', '四'];
      const chNum = numMap[idx - 1] || String(idx);
      if (this.chapterCardKicker) {
        this.chapterCardKicker.textContent = `第${chNum}章 · ${chapter.subtitle || ''}`;
      }
      if (this.chapterCardTitle) {
        this.chapterCardTitle.textContent = chapter.name || '';
      }
      if (this.chapterCardLines && chapter.intro?.lines) {
        this.chapterCardLines.innerHTML = chapter.intro.lines
          .map((line) => `<p>${line}</p>`)
          .join('');
      }
    }
    this.showScreen('chapter');
  }

  /**
   * 顯示死亡畫面。
   * @param {object} [stats]
   */
  showDeath(stats = {}) {
    if (this.deathCountdown) this.deathCountdown.textContent = '3';
    if (this.deathTip) {
      const tips = [
        '牠不追人。牠追聲音。',
        '安靜不是安全。安靜只是讓牠慢一點。',
        '把聲音留在別的方向，牠會追錯地方。',
        '氣息是你的籌碼，不要一次耗盡。',
      ];
      if (stats && stats.deaths >= 3) {
        this.deathTip.textContent = '提示：把聲音留在別的方向，牠會追錯地方。';
      } else {
        this.deathTip.textContent = tips[(stats?.deaths || 0) % tips.length];
      }
    }
    this.showScreen('death');
  }

  /**
   * 顯示破關結局與統計。
   * @param {object} stats
   */
  showEnding(stats = {}) {
    if (this.endingTitle) this.endingTitle.textContent = '你活下來了';
    if (this.endingCopy) {
      this.endingCopy.innerHTML = `
        <p>鐘聲停了。水退了。你推開療養院的大門，霧正散開。</p>
        <p>身後的走廊很安靜，安靜得像從來沒有人住過。你摸了摸喉嚨，發現自己已經記不起說話的感覺。</p>
        <p>遠處，霧裡傳來一聲很輕的咳嗽。你沒有回頭。</p>
        <p style="color: var(--cyan); margin-top: 14px;">謝謝你，願意安靜到最後。</p>
      `;
    }
    if (this.endingStats) {
      const formatTime = (sec = 0) => {
        const s = Math.max(0, Math.floor(sec));
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
      };
      const modeText = this._settings?.mode === 'keyboard' ? '鍵盤模式' : '麥克風';
      this.endingStats.innerHTML = `
        <div class="stat"><span>通關時長</span><span>${formatTime(stats.time)}</span></div>
        <div class="stat"><span>死亡次數</span><span>${stats.deaths || 0}</span></div>
        <div class="stat"><span>尖叫次數</span><span>${stats.shouts || 0}</span></div>
        <div class="stat"><span>喘氣次數</span><span>${stats.gaspCount || 0}</span></div>
        <div class="stat"><span>控制模式</span><span>${modeText}</span></div>
        <div class="stat"><span>完成章節</span><span>4 / 4</span></div>
      `;
    }
    this.showScreen('ending');
  }

  /**
   * 設定「繼續遊戲」按鈕狀態。
   * @param {boolean} available
   * @param {number} [chapterIndex=0]
   */
  setContinueAvailable(available, chapterIndex = 0) {
    if (!this.btnContinue) return;
    if (available) {
      const names = ['醒', '走廊', '水室', '聽者'];
      const chName = names[chapterIndex] || `第 ${chapterIndex + 1} 章`;
      this.btnContinue.textContent = `繼續遊戲（第 ${chapterIndex + 1} 章 · ${chName}）`;
      this.btnContinue.classList.remove('hidden');
    } else {
      this.btnContinue.classList.add('hidden');
    }
  }

  /**
   * 顯示全域啟動或錯誤訊息。
   * @param {string} message
   */
  showBootError(message) {
    if (this.bootError) {
      this.bootError.textContent = message;
      this.bootError.classList.remove('hidden');
    }
  }
}
