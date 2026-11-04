// 《勿聲》HUSH — 遊戲狀態機與主迴圈（E3）
// 依 docs/architecture.md §6.6 規範實作：連接輸入、音訊、渲染、UI 與 GameSession。

import {
  DEFAULT_SETTINGS,
  SCREENS,
  STORAGE_KEYS,
  VERSION,
} from './core/config.js';
import { getChapter } from './core/levels.js';
import { GameSession, SessionStatus } from './core/session.js';
import { AudioEngine } from './audio.js';
import { AudioFeedback } from './audio-feedback.js';
import { InputManager } from './input.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';

function getStorage(key, fallback = null) {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : fallback;
  } catch {
    return fallback;
  }
}

function setStorage(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    if (!this.canvas) throw new Error('找不到 #game-canvas');

    this.settings = { ...DEFAULT_SETTINGS, ...getStorage(STORAGE_KEYS.settings, {}) };
    this.progress = getStorage(STORAGE_KEYS.progress, { chapterIndex: 0, completed: false });
    this.calibration = getStorage(STORAGE_KEYS.calibration, null);

    this.currentChapterIndex = this.progress.chapterIndex || 0;
    this.targetChapterIndex = 0;
    this.state = 'start'; // start | calibration | chapter-card | playing | paused | dead | ending
    this._prevState = 'start';
    this._disposed = false;

    // 模組實例
    this.input = new InputManager(this.canvas);
    this.audio = new AudioEngine();
    this.feedback = new AudioFeedback();
    this.renderer = new Renderer(this.canvas, { reducedMotion: this.settings.reducedMotion });
    this.ui = new UI(document);
    this.session = new GameSession(this.currentChapterIndex);

    // 套用既有設定
    this.ui.setSettings(this.settings);
    this.audio.setMode(this.settings.mode);
    this.audio.setSensitivity(this.settings.sensitivity);
    this.feedback.setMasterVolume(this.settings.masterVolume);
    this.feedback.setMuted(this.settings.muted);
    if (this.calibration) this.audio.setCalibration(this.calibration);

    this._lastTime = performance.now();
    this._boundTick = this.tick.bind(this);

    this._setupDebugHook();
    this._bindUI();
    this._bindWindowEvents();
  }

  _setupDebugHook() {
    const self = this;
    window.__HUSH__ = {
      game: self,
      get session() {
        return self.session;
      },
      set session(s) {
        self.session = s;
      },
      audio: self.audio,
      renderer: self.renderer,
      ui: self.ui,
      input: self.input,
      feedback: self.feedback,
      version: VERSION,
    };
  }

  _bindUI() {
    this.ui.on('start', () => this.handleStart(0));
    this.ui.on('continue', () => this.handleStart(this.progress.chapterIndex || 0));
    this.ui.on('calibrate', () => this.runCalibration());
    this.ui.on('skip-calibration', () => this.skipCalibration());
    this.ui.on('next-chapter', () => {});
    this.ui.on('resume', () => this.resume());
    this.ui.on('restart', () => this.restartChapter());
    this.ui.on('quit', () => this.quitToMenu());
    this.ui.on('replay', () => this.handleStart(0));
    this.ui.on('mic-retry', () => this.retryMic());
    this.ui.on('reset-progress', () => this.resetProgress());
    this.ui.on('settings-change', (newSettings) => this.applySettings(newSettings));
  }

  _bindWindowEvents() {
    window.addEventListener('resize', () => {
      this.renderer?.resize();
    });

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing') {
        this.input.requestPointerLock();
      }
    });

    window.addEventListener('blur', () => {
      if (this.state === 'playing') {
        this.pause();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') {
        this.pause();
      }
    });
  }

  boot() {
    this.ui.showScreen(SCREENS.start);
    this.renderer.resize();

    // 更新「繼續遊戲」按鈕
    const hasProgress = this.progress && this.progress.chapterIndex > 0 && !this.progress.completed;
    this.ui.setContinueAvailable(hasProgress, this.progress.chapterIndex);

    // 根據設定更新模式徽章與麥克風狀態提示
    if (this.settings.mode === 'keyboard') {
      this.ui.setMicStatus('keyboard');
    } else if (this.calibration) {
      this.ui.setMicStatus('calibrated');
    } else {
      this.ui.setMicStatus('idle', '尚未啟用');
    }

    requestAnimationFrame(this._boundTick);
  }

  applySettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    setStorage(STORAGE_KEYS.settings, this.settings);

    this.renderer.setReducedMotion(this.settings.reducedMotion);
    this.audio.setMode(this.settings.mode);
    this.audio.setSensitivity(this.settings.sensitivity);
    this.feedback.setMasterVolume(this.settings.masterVolume);
    this.feedback.setMuted(this.settings.muted);

    if (this.settings.mode === 'keyboard') {
      this.ui.setMicStatus('keyboard');
    } else {
      this.ui.setMicStatus(this.calibration ? 'calibrated' : 'idle');
    }
  }

  resetProgress() {
    removeStorage(STORAGE_KEYS.progress);
    removeStorage(STORAGE_KEYS.stats);
    removeStorage(STORAGE_KEYS.calibration);
    this.progress = { chapterIndex: 0, completed: false };
    this.calibration = null;
    this.ui.setContinueAvailable(false);
    this.ui.toast('已重設所有關卡進度與校準記錄');
  }

  async handleStart(chapterIndex = 0) {
    this.targetChapterIndex = Math.max(0, Math.min(3, chapterIndex));

    // 初始化程序化音效回饋（需使用者手勢）
    await this.feedback.init();

    if (this.settings.mode === 'keyboard') {
      this.audio.setMode('keyboard');
      this.showChapter(this.targetChapterIndex);
      return;
    }

    // 麥克風模式
    const micRes = await this.audio.startMic();
    if (!micRes.ok) {
      this.ui.setMicStatus(micRes.code, micRes.message);
      this.ui.toast('麥克風存取失敗，可至設定切換為鍵盤模式');
      return;
    }

    this.ui.setMicStatus('ready');

    if (this.calibration) {
      this.audio.setCalibration(this.calibration);
      this.showChapter(this.targetChapterIndex);
    } else {
      this.startCalibration(this.targetChapterIndex);
    }
  }

  async retryMic() {
    const res = await this.audio.startMic();
    if (res.ok) {
      this.ui.setMicStatus('ready');
      this.ui.toast('麥克風連線成功');
    } else {
      this.ui.setMicStatus(res.code, res.message);
      this.ui.toast('麥克風重試失敗');
    }
  }

  startCalibration(chapterIndex = 0) {
    this.targetChapterIndex = chapterIndex;
    this.state = 'calibration';
    this.ui.showScreen(SCREENS.calibration);
    this.ui.setCalibrationStep({
      step: 1,
      progress: 0,
      instruction: '先安靜三秒，讓麥克風記住環境底噪。',
      value: 0,
    });
  }

  async runCalibration() {
    this.ui.toast('開始校準……');
    try {
      const calib = await this.audio.calibrate((data) => {
        this.ui.setCalibrationStep(data);
      });
      this.calibration = calib;
      setStorage(STORAGE_KEYS.calibration, calib);
      this.ui.setMicStatus('calibrated');
      this.ui.toast('校準完成！');
      setTimeout(() => {
        this.showChapter(this.targetChapterIndex);
      }, 500);
    } catch (err) {
      console.warn('校準中斷或失敗：', err);
      this.skipCalibration();
    }
  }

  skipCalibration() {
    this.audio.stopCalibration();
    this.calibration = this.audio.getCalibration?.() || null;
    if (this.calibration) {
      setStorage(STORAGE_KEYS.calibration, this.calibration);
    }
    this.ui.toast('使用預設校準值');
    this.showChapter(this.targetChapterIndex);
  }

  showChapter(index = 0) {
    this.currentChapterIndex = Math.max(0, Math.min(3, index));
    this.state = 'chapter-card';
    const chapter = getChapter(this.currentChapterIndex);
    this.ui.showChapterCard(chapter, () => this.enterChapter(this.currentChapterIndex));
  }

  enterChapter(index = 0) {
    this.currentChapterIndex = Math.max(0, Math.min(3, index));
    this.session = new GameSession(this.currentChapterIndex);
    this.feedback.setChapter(this.session.chapter, this.currentChapterIndex);

    this.input.attach();
    this.ui.showScreen('none');
    this.state = 'playing';

    // 儲存目前所在章節進度
    setStorage(STORAGE_KEYS.progress, {
      chapterIndex: this.currentChapterIndex,
      completed: false,
      timestamp: Date.now(),
    });
  }

  pause() {
    if (this.state !== 'playing' && this.state !== 'dead') return;
    this._prevState = this.state;
    this.state = 'paused';
    this.feedback.suspend();
    this.ui.showScreen(SCREENS.pause);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = this._prevState || 'playing';
    this.feedback.resume();
    this.ui.showScreen(this.state === 'dead' ? SCREENS.death : 'none');
  }

  restartChapter() {
    this.enterChapter(this.currentChapterIndex);
  }

  quitToMenu() {
    this.state = 'start';
    this.input.detach();
    this.feedback.suspend();
    this.ui.showScreen(SCREENS.start);

    const hasProgress = this.progress && this.progress.chapterIndex > 0 && !this.progress.completed;
    this.ui.setContinueAvailable(hasProgress, this.progress.chapterIndex);
  }

  handleEvent(evt, sessionState) {
    this.feedback.event(evt);

    switch (evt.type) {
      case 'item':
        this.ui.toast(`取得：${evt.label}`);
        break;
      case 'door':
        this.ui.toast('一道門打開了');
        break;
      case 'checkpoint':
        this.ui.toast('已記錄安靜點');
        break;
      case 'log':
        this.ui.setSubtitle(`${evt.title}：${evt.text}`, 6);
        break;
      case 'gasp-start':
        this.ui.setSubtitle('（呼吸耗盡……被迫喘氣中）', 3);
        break;
      case 'gasp-end':
        break;
      case 'shout':
        break;
      case 'monster-stunned':
        this.ui.toast('尖叫震退了牠！');
        this.renderer.addShake(8);
        break;
      case 'boss-hit':
        this.ui.toast(`壓制中……還剩 ${evt.remaining} 次`);
        this.renderer.addShake(6);
        break;
      case 'boss-defeated':
        this.ui.toast('祭壇的沉默已被打破！出口已開啟！');
        this.renderer.addShake(12);
        break;
      case 'exit-locked':
        this.ui.toast(`出口已上鎖：需要 ${evt.missing?.join('、') || '更多線索'}`);
        break;
      case 'hint':
        this.ui.toast(evt.text, 4);
        break;
      case 'death':
        this.state = 'dead';
        this.ui.showDeath(sessionState.stats);
        break;
      case 'respawn':
        this.state = 'playing';
        this.ui.showScreen('none');
        this.ui.toast('回到安靜點');
        break;
      case 'chapter-complete':
        this.handleChapterComplete(evt, sessionState);
        break;
    }
  }

  handleChapterComplete(evt, sessionState) {
    const curIdx = evt.chapterIndex;
    const nextIdx = curIdx + 1;

    const progress = {
      chapterIndex: Math.min(3, nextIdx),
      completed: nextIdx >= 4,
      timestamp: Date.now(),
    };
    this.progress = progress;
    setStorage(STORAGE_KEYS.progress, progress);
    this.ui.setContinueAvailable(!progress.completed, progress.chapterIndex);

    const savedStats = getStorage(STORAGE_KEYS.stats, { deaths: 0, shouts: 0, gaspCount: 0, time: 0 });
    const totalStats = {
      deaths: (savedStats.deaths || 0) + (evt.stats?.deaths || 0),
      shouts: (savedStats.shouts || 0) + (evt.stats?.shouts || 0),
      gaspCount: (savedStats.gaspCount || 0) + (evt.stats?.gaspCount || 0),
      time: (savedStats.time || 0) + (evt.stats?.time || 0),
    };
    setStorage(STORAGE_KEYS.stats, totalStats);

    if (nextIdx < 4) {
      this.state = 'chapter-card';
      const nextChapter = getChapter(nextIdx);
      this.ui.showChapterCard(nextChapter, () => this.enterChapter(nextIdx));
    } else {
      this.state = 'ending';
      this.ui.showEnding(totalStats);
    }
  }

  tick(now) {
    if (this._disposed) return;
    requestAnimationFrame(this._boundTick);

    const step = Math.min(0.1, (now - this._lastTime) / 1000);
    this._lastTime = now;

    const inputState = this.input.getState();

    if (this.input.consumePause()) {
      if (this.state === 'playing') {
        this.pause();
      } else if (this.state === 'paused') {
        this.resume();
      }
    }

    if (this.state === 'playing' || this.state === 'dead') {
      this.audio.update(step, inputState);
      this.session.setVolume(this.audio.volume);
      const events = this.session.update(step, inputState);
      const sessionState = this.session.getState();

      for (const evt of events) {
        this.handleEvent(evt, sessionState);
      }

      this.renderer.render(sessionState, now / 1000, step);
      this.ui.update(sessionState);
      this.feedback.update(sessionState, step);
    }
  }

  dispose() {
    this._disposed = true;
    this.input.detach();
    this.audio.dispose();
    this.feedback.dispose();
    this.renderer.dispose();
  }
}

// 瀏覽器端自動初始化
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const init = () => {
    const game = new Game();
    game.boot();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
