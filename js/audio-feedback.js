// 《勿聲》HUSH — 程序化音效回饋（E1）
// 全部使用 Web Audio 的 OscillatorNode / BufferSource / BiquadFilter /
// StereoPanner 即時合成；不使用任何外部音檔。
// 初始化失敗時靜默降級，不得讓遊戲崩潰。

/** 同時最多允許的一次性發聲數（不含常駐環境音）。 */
const MAX_VOICES = 24;

/**
 * 將數值夾在區間內。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 將可能是 undefined / NaN 的值轉為有限數字。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 音效回饋引擎。
 *
 * 常駐層：低頻 drone、水聲、耳鳴。
 * 動態層：心跳、怪物腳步／低吼。
 * 事件層：event(evt) 依遊戲事件播放一次性音效。
 */
export class AudioFeedback {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {DynamicsCompressorNode|null} */
    this.limiter = null;

    this.ready = false;
    this.failed = false;
    this.disposed = false;
    this.status = 'idle';

    this.muted = false;
    this.masterVolume = 0.8;

    this.chapter = null;
    this.chapterIndex = 0;
    this._water = false;

    this._voices = new Set();
    this._maxVoices = MAX_VOICES;
    this._noiseBuffer = null;
    this._ambient = null;

    this._danger = 0;
    this._heartTimer = 0;
    this._stepTimer = 0;
    this._growlTimer = 0;
    this._lastError = null;
  }

  /**
   * 建立 AudioContext 與常駐音層。必須在使用者手勢後呼叫。
   * @returns {Promise<boolean>} 是否成功；失敗時遊戲仍可繼續（無聲）。
   */
  async init() {
    if (this.disposed) return false;
    if (this.ready) return true;

    try {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof Ctor !== 'function') {
        this.failed = true;
        this.status = 'unsupported';
        return false;
      }

      // 若之前初始化到一半失敗，先關閉殘留 context。
      if (this.ctx) {
        try {
          await this.ctx.close();
        } catch {
          // 忽略。
        }
        this.ctx = null;
      }

      const ctx = new Ctor();
      this.ctx = ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this._effectiveMasterVolume();

      if (typeof ctx.createDynamicsCompressor === 'function') {
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -18;
        this.limiter.knee.value = 20;
        this.limiter.ratio.value = 12;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.25;
        this.master.connect(this.limiter);
        this.limiter.connect(ctx.destination);
      } else {
        this.master.connect(ctx.destination);
      }

      this._buildAmbient();
      this._applyChapterAmbience();
      await this.resume();

      this.ready = true;
      this.failed = false;
      this.status = 'ready';
      return true;
    } catch (error) {
      // 靜默降級：不 throw，讓遊戲繼續。
      this._lastError = error;
      this.failed = true;
      this.ready = false;
      this.status = 'failed';

      try {
        if (this.ctx) await this.ctx.close();
      } catch {
        // 忽略。
      }
      this.ctx = null;
      this.master = null;
      this.limiter = null;
      this._ambient = null;
      return false;
    }
  }

  /**
   * 切換章節環境音。
   * @param {object} chapter 關卡物件
   * @param {number} [index] 章節索引
   */
  setChapter(chapter, index) {
    this.chapter = chapter && typeof chapter === 'object' ? chapter : null;
    const fallbackIndex = this.chapter && Number.isFinite(Number(this.chapter.index))
      ? Number(this.chapter.index)
      : 0;
    this.chapterIndex = clamp(Math.floor(finiteOr(index, fallbackIndex)), 0, 3);
    this._water = Boolean(this.chapter && this.chapter.water);
    this._applyChapterAmbience();
  }

  /**
   * 每幀更新動態音層：心跳、怪物腳步、低吼、耳鳴與 drone。
   * @param {object} state GameSession.getState() 的狀態
   * @param {number} dt 秒
   */
  update(state, dt) {
    if (!this.ready || this.disposed || !this.ctx) return;
    if (this.ctx.state !== 'running') return;

    const step = clamp(finiteOr(dt, 0), 0, 0.25);
    if (step <= 0) return;

    const s = state && typeof state === 'object' ? state : {};
    const targetDanger = clamp(finiteOr(s.danger, 0), 0, 1);
    this._danger += (targetDanger - this._danger) * (1 - Math.exp(-step * 3));

    const now = this.ctx.currentTime;
    const ambient = this._ambient;

    if (ambient) {
      const baseDrone = 0.03 + Math.min(3, this.chapterIndex) * 0.004;
      ambient.droneGain.gain.setTargetAtTime(baseDrone + this._danger * 0.05, now, 0.25);
      ambient.droneFilter.frequency.setTargetAtTime(
        180 + this._danger * 260 + this.chapterIndex * 30,
        now,
        0.3,
      );

      // 若章節狀態直接帶 water，也同步水聲。
      if (s.chapter && typeof s.chapter.water === 'boolean') this._water = s.chapter.water;
      const waterTarget = this._water ? 0.026 + this._danger * 0.012 : 0.0001;
      ambient.waterGain.gain.setTargetAtTime(waterTarget, now, 0.6);

      const screamRing = finiteOr(s.volume, 0) >= 86 ? 0.006 : 0;
      const ring = Math.max(0, this._danger - 0.5) * 0.04 + screamRing;
      ambient.tinnitusGain.gain.setTargetAtTime(Math.max(0.0001, ring), now, 0.3);
    }

    this._updateHeartbeat(step);
    this._updateMonster(s, step);
  }

  /**
   * 播放遊戲事件音效。
   * @param {{type:string, [key:string]:unknown}} evt
   */
  event(evt) {
    if (!this.ready || this.disposed || !evt || typeof evt !== 'object') return;

    try {
      switch (evt.type) {
        case 'log':
          this._playLog();
          break;
        case 'item':
          this._playItem();
          break;
        case 'checkpoint':
          this._playCheckpoint();
          break;
        case 'gasp-start':
          this._playGaspStart();
          break;
        case 'gasp-end':
          this._playGaspEnd();
          break;
        case 'monster-stunned':
          this._playMonsterStunned();
          break;
        case 'death':
          this._playDeath();
          break;
        case 'respawn':
          this._playRespawn();
          break;
        case 'boss-hit':
          this._playBossHit();
          break;
        case 'boss-defeated':
          this._playBossDefeated();
          break;
        case 'chapter-complete':
          this._playChapterComplete();
          break;
        case 'shout':
          this._playShout();
          break;
        case 'exit-locked':
          this._playExitLocked();
          break;
        case 'door':
          this._playDoor();
          break;
        case 'hint':
          // 提示由 UI 字幕承擔，不另外發聲。
          break;
        default:
          // 未知事件保持安靜，避免未來事件造成爆音。
          break;
      }
    } catch (error) {
      // 單一事件失敗不應中斷遊戲。
      this._lastError = error;
    }
  }

  /**
   * 設定主音量。
   * @param {number} value 0–1
   * @returns {number}
   */
  setMasterVolume(value) {
    this.masterVolume = clamp(finiteOr(value, 0.8), 0, 1);
    this._applyMasterGain();
    return this.masterVolume;
  }

  /**
   * 靜音／解除靜音。
   * @param {boolean} muted
   * @returns {boolean}
   */
  setMuted(muted) {
    this.muted = Boolean(muted);
    this._applyMasterGain();
    return this.muted;
  }

  /** 暫停 AudioContext。 @returns {Promise<boolean>} */
  async suspend() {
    if (!this.ctx) return false;
    try {
      if (this.ctx.state === 'running') {
        await this.ctx.suspend();
        this.status = 'suspended';
      }
      return true;
    } catch (error) {
      this._lastError = error;
      return false;
    }
  }

  /** 恢復 AudioContext。 @returns {Promise<boolean>} */
  async resume() {
    if (!this.ctx) return false;
    try {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.status === 'suspended') this.status = 'ready';
      return true;
    } catch (error) {
      this._lastError = error;
      return false;
    }
  }

  /** 停止所有音層並關閉 AudioContext。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.status = 'disposed';

    for (const voice of Array.from(this._voices)) this._releaseVoice(voice);

    const ambient = this._ambient;
    if (ambient) {
      for (const osc of ambient.droneOscs || []) {
        try {
          osc.stop();
        } catch {
          // 已停止。
        }
        try {
          osc.disconnect();
        } catch {
          // 已斷開。
        }
      }
      try {
        ambient.waterSource.stop();
      } catch {
        // 已停止。
      }
      for (const node of [
        ambient.waterSource,
        ambient.waterFilter,
        ambient.waterGain,
        ambient.droneFilter,
        ambient.droneGain,
        ambient.tinnitusOsc,
        ambient.tinnitusGain,
      ]) {
        try {
          if (node) node.disconnect();
        } catch {
          // 已斷開。
        }
      }
    }

    if (this.master) {
      try {
        this.master.disconnect();
      } catch {
        // 已斷開。
      }
    }
    if (this.limiter) {
      try {
        this.limiter.disconnect();
      } catch {
        // 已斷開。
      }
    }

    if (this.ctx) {
      try {
        const closing = this.ctx.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch {
        // 關閉失敗不影響結束流程。
      }
    }

    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this._ambient = null;
    this._noiseBuffer = null;
    this._voices.clear();
  }

  /**
   * 建立常駐環境音：低頻 drone、水聲、耳鳴。
   * @private
   */
  _buildAmbient() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    // 低頻 drone：三個微失諧振盪器 → lowpass → gain。
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.0001;

    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 220;
    droneFilter.Q.value = 0.8;

    droneFilter.connect(droneGain);
    droneGain.connect(this.master);

    const droneOscs = [];
    const droneSpecs = [
      { freq: 42, type: 'sine', gain: 0.5 },
      { freq: 42.6, type: 'sine', gain: 0.45 },
      { freq: 63, type: 'triangle', gain: 0.2 },
    ];

    for (const spec of droneSpecs) {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = spec.freq;

      const gain = ctx.createGain();
      gain.gain.value = spec.gain;

      osc.connect(gain);
      gain.connect(droneFilter);
      osc.start();
      droneOscs.push(osc);
    }

    // 水聲：循環白噪音 → bandpass → gain。
    const waterSource = ctx.createBufferSource();
    waterSource.buffer = this._getNoiseBuffer();
    waterSource.loop = true;

    const waterFilter = ctx.createBiquadFilter();
    waterFilter.type = 'bandpass';
    waterFilter.frequency.value = 650;
    waterFilter.Q.value = 0.7;

    const waterGain = ctx.createGain();
    waterGain.gain.value = 0.0001;

    waterSource.connect(waterFilter);
    waterFilter.connect(waterGain);
    waterGain.connect(this.master);
    waterSource.start();

    // 耳鳴：高頻正弦，音量由危險值控制。
    const tinnitusOsc = ctx.createOscillator();
    tinnitusOsc.type = 'sine';
    tinnitusOsc.frequency.value = 6200;

    const tinnitusGain = ctx.createGain();
    tinnitusGain.gain.value = 0.0001;

    tinnitusOsc.connect(tinnitusGain);
    tinnitusGain.connect(this.master);
    tinnitusOsc.start();

    this._ambient = {
      droneOscs,
      droneFilter,
      droneGain,
      waterSource,
      waterFilter,
      waterGain,
      tinnitusOsc,
      tinnitusGain,
    };
  }

  /**
   * 套用章節對應的環境音色。
   * @private
   */
  _applyChapterAmbience() {
    if (!this.ctx || !this._ambient) return;

    const now = this.ctx.currentTime;
    const index = clamp(Math.floor(finiteOr(this.chapterIndex, 0)), 0, 3);
    const baseFreqs = [42, 46, 52, 36];
    const filterFreqs = [180, 230, 300, 200];
    const base = baseFreqs[index];

    const oscs = this._ambient.droneOscs;
    if (oscs[0]) oscs[0].frequency.setTargetAtTime(base, now, 0.4);
    if (oscs[1]) oscs[1].frequency.setTargetAtTime(base * 1.008, now, 0.4);
    if (oscs[2]) oscs[2].frequency.setTargetAtTime(base * 1.5, now, 0.4);

    this._ambient.droneFilter.frequency.setTargetAtTime(filterFreqs[index], now, 0.5);
    this._ambient.waterGain.gain.setTargetAtTime(
      this._water ? 0.026 : 0.0001,
      now,
      0.8,
    );
  }

  /**
   * 心跳：危險越高越快、越大聲。
   * @param {number} dt
   * @private
   */
  _updateHeartbeat(dt) {
    this._heartTimer -= dt;

    if (this._danger <= 0.06) {
      this._heartTimer = 0;
      return;
    }

    if (this._heartTimer > 0) return;

    const interval = Math.max(0.34, 1.15 - this._danger * 0.75);
    const level = 0.12 + this._danger * 0.55;

    this._playHeartbeat(level);
    this._heartTimer = interval;
  }

  /**
   * 怪物腳步與低吼。依 distance 衰減、依相對方位做立體定位。
   * @param {object} state
   * @param {number} dt
   * @private
   */
  _updateMonster(state, dt) {
    const monster = state.monster;
    const distance = monster && Number(monster.distance);

    if (!Number.isFinite(distance) || distance > 16) {
      this._stepTimer = 0;
      this._growlTimer = 0;
      return;
    }

    const monsterState = monster && typeof monster.state === 'string' ? monster.state : 'idle';
    if (monsterState === 'stunned' || monster.stunned) {
      this._stepTimer = Math.min(this._stepTimer, 0.3);
      this._growlTimer = Math.min(this._growlTimer, 0.8);
      return;
    }

    const pan = this._monsterPan(state);
    const proximity = clamp(1 - distance / 14, 0, 1);

    this._stepTimer -= dt;
    if (this._stepTimer <= 0) {
      const strength = proximity * (monsterState === 'chase' ? 1 : 0.65);
      this._playFootstep(pan, strength);
      this._stepTimer = monsterState === 'chase' ? 0.42 : monsterState === 'investigate' ? 0.72 : 0.95;
    }

    this._growlTimer -= dt;
    if (this._growlTimer <= 0 && distance < 9 && (monsterState === 'chase' || monsterState === 'investigate')) {
      this._playGrowl(pan, proximity);
      this._growlTimer = monsterState === 'chase' ? 1.6 : 2.8;
    }
  }

  /**
   * 依玩家面向計算怪物左右聲道位置。
   * @param {object} state
   * @returns {number} -1（左）到 1（右）
   * @private
   */
  _monsterPan(state) {
    const monster = state.monster;
    const player = state.player;
    if (!monster || !player) return 0;

    const mx = Number(monster.x);
    const my = Number(monster.y);
    const px = Number(player.x);
    const py = Number(player.y);
    const angle = Number(player.angle);

    if (![mx, my, px, py, angle].every(Number.isFinite)) return 0;

    const target = Math.atan2(my - py, mx - px);
    let relative = target - angle;
    relative = Math.atan2(Math.sin(relative), Math.cos(relative));
    return clamp(Math.sin(relative), -1, 1);
  }

  /** @private */
  _playLog() {
    this._playTone({
      type: 'sine',
      freq: 880,
      attack: 0.002,
      decay: 0.05,
      gain: 0.008,
    });
  }

  /** @private */
  _playItem() {
    this._playBell([1046.5, 1568, 2093], 0.85, 0.035);
  }

  /** @private */
  _playCheckpoint() {
    this._playChord([261.63, 329.63, 392], 2.2, 0.03);
  }

  /** @private */
  _playGaspStart() {
    this._playNoise({
      filterType: 'bandpass',
      filterFreq: 600,
      freqEnd: 1400,
      q: 1.2,
      attack: 0.03,
      decay: 0.5,
      gain: 0.07,
    });
    this._playTone({
      type: 'sine',
      freq: 180,
      freqEnd: 110,
      filterType: 'lowpass',
      filterFreq: 400,
      attack: 0.02,
      decay: 0.4,
      gain: 0.02,
    });
  }

  /** @private */
  _playGaspEnd() {
    this._playNoise({
      filterType: 'bandpass',
      filterFreq: 500,
      freqEnd: 300,
      q: 1,
      attack: 0.02,
      decay: 0.4,
      gain: 0.018,
    });
  }

  /** @private */
  _playMonsterStunned() {
    this._playBell([1200, 1800, 2600], 0.5, 0.035);
    this._playNoise({
      filterType: 'bandpass',
      filterFreq: 2400,
      q: 2,
      attack: 0.005,
      decay: 0.3,
      gain: 0.03,
    });
    this._playTone({
      type: 'sine',
      freq: 90,
      freqEnd: 55,
      filterType: 'lowpass',
      filterFreq: 200,
      attack: 0.005,
      decay: 0.25,
      gain: 0.04,
    });
  }

  /** @private */
  _playDeath() {
    this._playTone({
      type: 'sawtooth',
      freq: 120,
      freqEnd: 30,
      filterType: 'lowpass',
      filterFreq: 320,
      q: 1.2,
      attack: 0.01,
      decay: 1.6,
      gain: 0.09,
    });
    this._playNoise({
      filterType: 'lowpass',
      filterFreq: 180,
      attack: 0.01,
      decay: 1.2,
      gain: 0.07,
    });
  }

  /** @private */
  _playRespawn() {
    this._playNoise({
      filterType: 'bandpass',
      filterFreq: 300,
      freqEnd: 1200,
      q: 0.9,
      attack: 0.15,
      decay: 0.7,
      gain: 0.05,
    });
    this._playTone({
      type: 'sine',
      freq: 220,
      freqEnd: 330,
      attack: 0.2,
      decay: 0.6,
      gain: 0.015,
    });
  }

  /** @private */
  _playBossHit() {
    this._playBell([196, 392, 587.33], 1.6, 0.05);
    this._playNoise({
      filterType: 'bandpass',
      filterFreq: 1800,
      q: 3,
      attack: 0.005,
      decay: 0.4,
      gain: 0.025,
    });
  }

  /** @private */
  _playBossDefeated() {
    this._playBell([110, 220, 330], 3.5, 0.06);
    this._playChord([261.63, 329.63, 392, 523.25], 3, 0.035);
  }

  /** @private */
  _playChapterComplete() {
    this._playChord([261.63, 329.63, 392, 523.25], 2.8, 0.04);
  }

  /** @private */
  _playShout() {
    this._playNoise({
      filterType: 'highpass',
      filterFreq: 320,
      attack: 0.005,
      decay: 0.35,
      gain: 0.12,
    });
    this._playTone({
      type: 'sine',
      freq: 90,
      freqEnd: 48,
      filterType: 'lowpass',
      filterFreq: 250,
      attack: 0.005,
      decay: 0.3,
      gain: 0.05,
    });
  }

  /** @private */
  _playExitLocked() {
    const now = this.ctx.currentTime;
    this._playTone({
      type: 'sine',
      freq: 72,
      filterType: 'lowpass',
      filterFreq: 180,
      attack: 0.01,
      decay: 0.22,
      gain: 0.06,
    });
    this._playTone({
      type: 'sine',
      freq: 55,
      t0: now + 0.24,
      filterType: 'lowpass',
      filterFreq: 160,
      attack: 0.01,
      decay: 0.3,
      gain: 0.055,
    });
  }

  /** @private */
  _playDoor() {
    this._playNoise({
      filterType: 'bandpass',
      filterFreq: 220,
      freqEnd: 90,
      q: 1.4,
      attack: 0.05,
      decay: 0.6,
      gain: 0.028,
    });
  }

  /**
   * 心跳（兩下）。
   * @param {number} level 0–1
   * @private
   */
  _playHeartbeat(level) {
    const now = this.ctx.currentTime;
    const peak = 0.03 + clamp(level, 0, 1) * 0.12;

    this._playTone({
      type: 'sine',
      freq: 60,
      freqEnd: 34,
      filterType: 'lowpass',
      filterFreq: 130,
      attack: 0.01,
      decay: 0.24,
      gain: peak,
      t0: now,
    });
    this._playTone({
      type: 'sine',
      freq: 56,
      freqEnd: 32,
      filterType: 'lowpass',
      filterFreq: 120,
      attack: 0.01,
      decay: 0.2,
      gain: peak * 0.6,
      t0: now + 0.16,
    });
  }

  /**
   * 怪物腳步。
   * @param {number} pan
   * @param {number} strength 0–1
   * @private
   */
  _playFootstep(pan, strength) {
    const s = clamp(strength, 0, 1);
    if (s <= 0.01) return;

    this._playNoise({
      filterType: 'lowpass',
      filterFreq: 320,
      q: 0.8,
      attack: 0.005,
      decay: 0.14,
      gain: 0.055 * s,
      pan,
    });
    this._playTone({
      type: 'sine',
      freq: 64,
      freqEnd: 42,
      filterType: 'lowpass',
      filterFreq: 140,
      attack: 0.005,
      decay: 0.18,
      gain: 0.025 * s,
      pan,
    });
  }

  /**
   * 怪物低吼。
   * @param {number} pan
   * @param {number} strength 0–1
   * @private
   */
  _playGrowl(pan, strength) {
    const s = clamp(strength, 0, 1);
    if (s <= 0.01) return;

    this._playTone({
      type: 'sawtooth',
      freq: 74,
      freqEnd: 52,
      filterType: 'lowpass',
      filterFreq: 240,
      q: 2.5,
      attack: 0.08,
      decay: 0.85,
      gain: 0.03 * s,
      pan,
    });
    this._playTone({
      type: 'sawtooth',
      freq: 77,
      freqEnd: 55,
      filterType: 'lowpass',
      filterFreq: 220,
      q: 2.2,
      attack: 0.1,
      decay: 0.8,
      gain: 0.014 * s,
      pan,
    });
  }

  /**
   * 鈴聲／鐘聲：多個正弦泛音，各自衰減。
   * @param {number[]} freqs
   * @param {number} duration
   * @param {number} gain
   * @param {object} [opts]
   * @private
   */
  _playBell(freqs, duration, gain, opts = {}) {
    const pan = finiteOr(opts.pan, 0);
    for (let index = 0; index < freqs.length; index += 1) {
      this._playTone({
        type: 'sine',
        freq: freqs[index],
        detune: index * 2,
        attack: 0.005,
        decay: duration * (1 - index * 0.08),
        gain: gain / (1 + index * 0.8),
        pan,
      });
    }
  }

  /**
   * 柔和和弦。
   * @param {number[]} freqs
   * @param {number} duration
   * @param {number} gain
   * @param {object} [opts]
   * @private
   */
  _playChord(freqs, duration, gain, opts = {}) {
    const pan = finiteOr(opts.pan, 0);
    const perNote = gain / Math.max(1, freqs.length);
    for (const freq of freqs) {
      this._playTone({
        type: 'triangle',
        freq,
        attack: 0.15,
        decay: duration,
        gain: perNote,
        pan,
      });
    }
  }

  /**
   * 建立單一振盪器音。所有音都經過 gain envelope，避免爆音。
   * @param {object} opts
   * @returns {OscillatorNode|null}
   * @private
   */
  _playTone(opts = {}) {
    if (!this._canPlay()) return null;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = Number.isFinite(Number(opts.t0)) ? Number(opts.t0) : now;
    const attack = Math.max(0.002, finiteOr(opts.attack, 0.01));
    const decay = Math.max(0.01, finiteOr(opts.decay, 0.3));
    const peak = Math.max(0.0002, finiteOr(opts.gain, 0.03));

    const osc = ctx.createOscillator();
    osc.type = typeof opts.type === 'string' ? opts.type : 'sine';
    osc.frequency.setValueAtTime(Math.max(20, finiteOr(opts.freq, 440)), t0);
    if (Number.isFinite(Number(opts.freqEnd))) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, Number(opts.freqEnd)),
        t0 + attack + decay,
      );
    }
    if (Number.isFinite(Number(opts.detune))) osc.detune.value = Number(opts.detune);

    let node = osc;
    let filter = null;

    if (typeof opts.filterType === 'string') {
      filter = ctx.createBiquadFilter();
      filter.type = opts.filterType;
      filter.frequency.setValueAtTime(Math.max(20, finiteOr(opts.filterFreq, 800)), t0);
      if (Number.isFinite(Number(opts.q))) filter.Q.value = Number(opts.q);
      node.connect(filter);
      node = filter;
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    node.connect(gain);
    const panner = this._connectPan(gain, finiteOr(opts.pan, 0));

    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.05);

    this._track(osc, [filter, gain, panner].filter(Boolean));
    return osc;
  }

  /**
   * 建立單一白噪音音。使用 bandpass / lowpass / highpass 塑形。
   * @param {object} opts
   * @returns {AudioBufferSourceNode|null}
   * @private
   */
  _playNoise(opts = {}) {
    if (!this._canPlay()) return null;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = Number.isFinite(Number(opts.t0)) ? Number(opts.t0) : now;
    const attack = Math.max(0.002, finiteOr(opts.attack, 0.01));
    const decay = Math.max(0.01, finiteOr(opts.decay, 0.3));
    const peak = Math.max(0.0002, finiteOr(opts.gain, 0.04));

    const source = ctx.createBufferSource();
    source.buffer = this._getNoiseBuffer();
    source.loop = true;

    let node = source;
    let filter = null;

    if (typeof opts.filterType === 'string') {
      filter = ctx.createBiquadFilter();
      filter.type = opts.filterType;
      filter.frequency.setValueAtTime(Math.max(20, finiteOr(opts.filterFreq, 800)), t0);
      if (Number.isFinite(Number(opts.freqEnd))) {
        filter.frequency.exponentialRampToValueAtTime(
          Math.max(20, Number(opts.freqEnd)),
          t0 + attack + decay,
        );
      }
      if (Number.isFinite(Number(opts.q))) filter.Q.value = Number(opts.q);
      node.connect(filter);
      node = filter;
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    node.connect(gain);
    const panner = this._connectPan(gain, finiteOr(opts.pan, 0));

    source.start(t0);
    source.stop(t0 + attack + decay + 0.05);

    this._track(source, [filter, gain, panner].filter(Boolean));
    return source;
  }

  /**
   * 將節點接到 master；若支援 StereoPanner，順便做左右定位。
   * @param {AudioNode} node
   * @param {number} pan
   * @returns {StereoPannerNode|null}
   * @private
   */
  _connectPan(node, pan) {
    const value = clamp(finiteOr(pan, 0), -1, 1);

    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = value;
      node.connect(panner);
      panner.connect(this.master);
      return panner;
    }

    node.connect(this.master);
    return null;
  }

  /**
   * 建立並快取 2 秒白噪音。
   * @returns {AudioBuffer}
   * @private
   */
  _getNoiseBuffer() {
    if (this._noiseBuffer) return this._noiseBuffer;

    const ctx = this.ctx;
    const length = Math.max(1, Math.floor(ctx.sampleRate * 2));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

    this._noiseBuffer = buffer;
    return buffer;
  }

  /**
   * 是否還能再開一個一次性發聲。
   * @returns {boolean}
   * @private
   */
  _canPlay() {
    return Boolean(this.ready && !this.disposed && this.ctx && this._voices.size < this._maxVoices);
  }

  /**
   * 追蹤一次性發聲，結束後自動斷開節點。
   * @param {AudioScheduledSourceNode} source
   * @param {AudioNode[]} nodes
   * @private
   */
  _track(source, nodes) {
    const voice = { source, nodes };
    this._voices.add(voice);
    source.onended = () => this._releaseVoice(voice);
  }

  /**
   * 釋放單一一次性發聲。
   * @param {{source:AudioScheduledSourceNode, nodes:AudioNode[]}} voice
   * @private
   */
  _releaseVoice(voice) {
    if (!this._voices.has(voice)) return;
    this._voices.delete(voice);

    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // 已斷開。
      }
    }
    try {
      voice.source.disconnect();
    } catch {
      // 已斷開。
    }
  }

  /**
   * 套用主音量／靜音。
   * @private
   */
  _applyMasterGain() {
    if (!this.master || !this.ctx) return;
    try {
      this.master.gain.setTargetAtTime(
        this._effectiveMasterVolume(),
        this.ctx.currentTime,
        0.05,
      );
    } catch {
      // 忽略已關閉的 context。
    }
  }

  /**
   * @returns {number} 0–1
   * @private
   */
  _effectiveMasterVolume() {
    return this.muted ? 0 : clamp(this.masterVolume, 0, 1);
  }
}
