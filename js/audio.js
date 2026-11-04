// 《勿聲》HUSH — 麥克風音量分析與校準（E1）
// 隱私邊界：只使用 AnalyserNode 讀取時域 RMS；不建立 MediaRecorder、
// 不錄音、不上傳、不寫 localStorage。麥克風節點不接入 destination。

import { getBand } from './core/config.js';
import {
  DEFAULT_CALIBRATION,
  createCalibration,
  normalizeVolume,
  rmsToDb,
  VolumeTracker,
  KeyboardVoice,
} from './core/volume.js';

/** 校準每段長度（秒）。 */
const CALIBRATION_SEGMENT_SECONDS = 3;
/** 校準取樣間隔（毫秒）。 */
const CALIBRATION_SAMPLE_MS = 50;

/** 三段校準指示。 */
const CALIBRATION_STEPS = Object.freeze([
  {
    step: 1,
    instruction: '請保持安靜，讓麥克風記住環境底噪。',
  },
  {
    step: 2,
    instruction: '請用平常說話的音量，小聲說一句話。',
  },
  {
    step: 3,
    instruction: '請對麥克風大喊一次。',
  },
]);

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
 * 整理 dB 校準物件，確保 noiseDb < quietDb < loudDb。
 * @param {object} input
 * @returns {{noiseDb:number, quietDb:number, loudDb:number}}
 */
function sanitizeDbCalibration(input) {
  const src = input && typeof input === 'object' ? input : {};
  const noiseDb = finiteOr(src.noiseDb, DEFAULT_CALIBRATION.noiseDb);
  let loudDb = finiteOr(src.loudDb, DEFAULT_CALIBRATION.loudDb);

  if (loudDb <= noiseDb + 3) loudDb = noiseDb + 12;

  const span = loudDb - noiseDb;
  let quietDb = finiteOr(src.quietDb, noiseDb + span * 0.6);
  if (quietDb <= noiseDb) quietDb = noiseDb + span * 0.6;
  if (quietDb >= loudDb) quietDb = noiseDb + span * 0.6;

  return { noiseDb, quietDb, loudDb };
}

/**
 * 是否處於非安全來源。localhost / 127.0.0.1 / https / file 視為安全。
 * @returns {boolean}
 */
function isInsecureContext() {
  if (typeof globalThis.isSecureContext === 'boolean') return !globalThis.isSecureContext;

  const location = globalThis.location;
  if (!location) return false;
  if (location.protocol === 'https:' || location.protocol === 'file:') return false;

  const host = String(location.hostname || '');
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
}

/**
 * 麥克風／鍵盤音量引擎。
 *
 * 使用方式（E3）：
 * ```js
 * const audio = new AudioEngine();
 * await audio.startMic();               // 必須在使用者手勢中呼叫
 * await audio.calibrate(onProgress);    // 可略過
 * audio.setMode('keyboard');            // 無麥克風備援
 * audio.update(dt, input);
 * ```
 */
export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this.source = null;
    /** @type {AnalyserNode|null} */
    this.analyser = null;

    this._timeData = null;
    this._tracker = new VolumeTracker(DEFAULT_CALIBRATION);
    this._keyboard = new KeyboardVoice();
    this._calibration = { ...DEFAULT_CALIBRATION };
    this._sensitivity = 1;

    /** @type {'mic'|'keyboard'} */
    this.mode = 'mic';
    /** @type {number} 0–100 平滑音量 */
    this.volume = 0;
    /** @type {object} 目前音量區間 */
    this.band = getBand(0);
    /** @type {number} 0–1 即時音量（給音量環） */
    this.level = 0;
    /** @type {string} idle / requesting / ready / calibrating / suspended / 錯誤碼 / disposed */
    this.status = 'idle';

    this._micReady = false;
    this._micRms = 0;
    this._disposed = false;
    this._calibrating = false;
    this._calibrationToken = 0;
    this._lastError = null;
  }

  /**
   * 要求麥克風權限並建立分析鏈。可重複呼叫；權限被拒後再次呼叫會重新詢問。
   * @returns {Promise<{ok:true}|{ok:false, code:string, message:string}>}
   */
  async startMic() {
    if (this._disposed) {
      return this._fail('unknown', '音訊引擎已關閉，請重新整理頁面。');
    }

    const nav = globalThis.navigator;
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      return this._fail('unsupported', '此瀏覽器不支援麥克風存取，請改用鍵盤模式。');
    }

    if (isInsecureContext()) {
      return this._fail('insecure', '麥克風只能在 HTTPS 或 localhost 下使用，請改用鍵盤模式。');
    }

    const context = this._ensureContext();
    if (!context) {
      return this._fail('unsupported', '此瀏覽器不支援 Web Audio，請改用鍵盤模式。');
    }

    this.status = 'requesting';

    try {
      // 必須在使用者手勢後 resume；getUserMedia 的權限視窗也可能讓 context 暫停。
      await this.resume();

      const stream = await nav.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });

      this._stopStream();
      this.stream = stream;
      this._connectStream(stream);

      this._micReady = true;
      this.mode = 'mic';
      this.status = 'ready';

      await this.resume();
      return { ok: true };
    } catch (error) {
      this._micReady = false;
      this._stopStream();
      return this._mapMicError(error);
    }
  }

  /**
   * 三段各 3 秒的校準：環境底噪 → 小聲說話 → 大喊。
   * 中途可呼叫 stopCalibration()；中止時回傳目前（或預設）校準值，不拋錯。
   * @param {(progress:{step:number, progress:number, instruction:string, value:number})=>void} [onProgress]
   * @returns {Promise<{noiseDb:number, quietDb:number, loudDb:number}>}
   */
  async calibrate(onProgress) {
    if (this._disposed) return this.getCalibration();

    if (!this._micReady) {
      const result = await this.startMic();
      if (!result.ok) return this.getCalibration();
    }

    const token = ++this._calibrationToken;
    this._calibrating = true;
    this.status = 'calibrating';
    await this.resume();

    const samplesByStep = [];

    for (let index = 0; index < CALIBRATION_STEPS.length; index += 1) {
      const stepInfo = CALIBRATION_STEPS[index];
      const samples = [];
      const startedAt = this._nowMs();

      while (true) {
        if (this._disposed || token !== this._calibrationToken) {
          this._calibrating = false;
          if (this.status === 'calibrating') this.status = this._micReady ? 'ready' : 'idle';
          return this.getCalibration();
        }

        const elapsed = (this._nowMs() - startedAt) / 1000;
        const progress = clamp(elapsed / CALIBRATION_SEGMENT_SECONDS, 0, 1);
        const rms = this._readRms();
        samples.push(rms);

        const value = normalizeVolume(rmsToDb(rms), this._calibration);
        this._emitProgress(onProgress, {
          step: stepInfo.step,
          progress,
          instruction: stepInfo.instruction,
          value,
        });

        if (progress >= 1) break;
        await this._sleep(CALIBRATION_SAMPLE_MS);
      }

      samplesByStep.push(this._median(samples));
    }

    if (this._disposed || token !== this._calibrationToken) {
      this._calibrating = false;
      if (this.status === 'calibrating') this.status = this._micReady ? 'ready' : 'idle';
      return this.getCalibration();
    }

    const calibration = createCalibration({
      noiseRms: samplesByStep[0],
      quietRms: samplesByStep[1],
      loudRms: samplesByStep[2],
    });

    this.setCalibration(calibration);
    this._tracker.reset();
    this._calibrating = false;
    this.status = this._micReady ? 'ready' : 'idle';
    return calibration;
  }

  /**
   * 中止進行中的校準。calibrate() 會回傳目前校準值。
   */
  stopCalibration() {
    this._calibrationToken += 1;
    this._calibrating = false;
    if (this.status === 'calibrating') {
      this.status = this._micReady ? 'ready' : 'idle';
    }
  }

  /**
   * 每幀更新音量。
   * @param {number} dt 秒
   * @param {{voiceHeld?:boolean}} [input]
   */
  update(dt, input = {}) {
    if (this._disposed) return;

    const step = clamp(finiteOr(dt, 0), 0, 0.25);
    if (step <= 0) {
      this.band = getBand(this.volume);
      return;
    }

    if (this.mode === 'keyboard') {
      const raw = this._keyboard.update(step, Boolean(input && input.voiceHeld));
      const scaled = clamp(raw * this._sensitivity, 0, 100);
      this.volume = scaled;
      this.level = clamp(scaled / 100, 0, 1);
      this.band = getBand(this.volume);
      return;
    }

    const rms = this._micReady ? this._readRms() : 0;
    this._micRms = rms;

    const instant = normalizeVolume(rmsToDb(rms), this._calibration);
    const smoothed = this._tracker.push(rms, step);
    const scaled = clamp(smoothed * this._sensitivity, 0, 100);

    this.volume = scaled;
    this.level = clamp((instant * this._sensitivity) / 100, 0, 1);
    this.band = getBand(this.volume);
  }

  /**
   * 切換控制模式。切到鍵盤時會停止麥克風音軌（關閉瀏覽器麥克風指示燈）。
   * 切回麥克風前，E3 需再次呼叫 startMic()。
   * @param {'mic'|'keyboard'} mode
   * @returns {'mic'|'keyboard'}
   */
  setMode(mode) {
    if (mode !== 'mic' && mode !== 'keyboard') return this.mode;

    if (mode !== this.mode) {
      this._tracker.reset();
      this._keyboard.reset();
      this.volume = 0;
      this.level = 0;
      this.band = getBand(0);
    }

    if (mode === 'keyboard') this._stopStream();

    this.mode = mode;
    return this.mode;
  }

  /**
   * 設定靈敏度，乘在正規化音量後再 clamp。
   * @param {number} value 0.5–2
   * @returns {number}
   */
  setSensitivity(value) {
    const n = finiteOr(value, 1);
    this._sensitivity = clamp(n, 0.5, 2);
    return this._sensitivity;
  }

  /**
   * 設定 dB 校準值。
   * @param {{noiseDb:number, quietDb:number, loudDb:number}} calibration
   * @returns {{noiseDb:number, quietDb:number, loudDb:number}}
   */
  setCalibration(calibration) {
    this._calibration = sanitizeDbCalibration(calibration);
    this._tracker.setCalibration(this._calibration);
    return this.getCalibration();
  }

  /** @returns {{noiseDb:number, quietDb:number, loudDb:number}} 校準值副本 */
  getCalibration() {
    return { ...this._calibration };
  }

  /** @returns {number} 0–1 即時音量 */
  getLevel() {
    return clamp(this.level, 0, 1);
  }

  /** 暫停 AudioContext（暫停遊戲時使用）。 @returns {Promise<boolean>} */
  async suspend() {
    if (!this.context) return false;
    try {
      if (this.context.state === 'running') {
        await this.context.suspend();
        if (this.status === 'ready') this.status = 'suspended';
      }
      return true;
    } catch (error) {
      this._lastError = error;
      return false;
    }
  }

  /** 恢復 AudioContext。 @returns {Promise<boolean>} */
  async resume() {
    if (!this.context) return false;
    try {
      if (this.context.state === 'suspended') await this.context.resume();
      if (this.status === 'suspended') this.status = 'ready';
      return true;
    } catch (error) {
      this._lastError = error;
      return false;
    }
  }

  /** 停止麥克風、關閉 AudioContext，並釋放所有節點。 */
  dispose() {
    this.stopCalibration();
    this._stopStream();

    if (this.context) {
      try {
        const closing = this.context.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch {
        // 靜默降級：關閉失敗不影響遊戲結束流程。
      }
    }

    this.context = null;
    this._timeData = null;
    this._disposed = true;
    this.status = 'disposed';
    this.volume = 0;
    this.level = 0;
    this.band = getBand(0);
  }

  /**
   * 建立 AudioContext。必須在使用者手勢後呼叫。
   * @returns {AudioContext|null}
   * @private
   */
  _ensureContext() {
    if (this.context) return this.context;

    try {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof Ctor !== 'function') return null;

      try {
        this.context = new Ctor({ latencyHint: 'interactive' });
      } catch {
        this.context = new Ctor();
      }
      return this.context;
    } catch (error) {
      this._lastError = error;
      this.context = null;
      return null;
    }
  }

  /**
   * 建立 MediaStreamSource → AnalyserNode。刻意不接到 destination。
   * @param {MediaStream} stream
   * @private
   */
  _connectStream(stream) {
    const context = this.context;
    if (!context) throw new Error('AudioContext 尚未建立');

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;

    source.connect(analyser);

    this.source = source;
    this.analyser = analyser;
    this._timeData = new Float32Array(analyser.fftSize);
  }

  /**
   * 停止目前麥克風音軌並斷開節點。
   * @private
   */
  _stopStream() {
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // 已斷開或 context 已關閉。
      }
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // 忽略個別音軌停止失敗。
        }
      }
    }

    this.source = null;
    this.analyser = null;
    this._timeData = null;
    this.stream = null;
    this._micReady = false;
    this._micRms = 0;
  }

  /**
   * 讀取時域 RMS。
   * @returns {number}
   * @private
   */
  _readRms() {
    if (!this.analyser || !this._timeData) return 0;

    try {
      this.analyser.getFloatTimeDomainData(this._timeData);
      let sum = 0;
      for (let i = 0; i < this._timeData.length; i += 1) {
        const sample = this._timeData[i];
        sum += sample * sample;
      }
      return Math.sqrt(sum / this._timeData.length);
    } catch (error) {
      this._lastError = error;
      return 0;
    }
  }

  /**
   * 將 getUserMedia 錯誤轉成合約錯誤碼與繁中訊息。
   * @param {unknown} error
   * @returns {{ok:false, code:string, message:string}}
   * @private
   */
  _mapMicError(error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return this._fail('denied', '麥克風權限被拒絕。請允許麥克風後重試，或改用鍵盤模式。');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return this._fail('no-device', '找不到可用的麥克風。請確認裝置已連線，或改用鍵盤模式。');
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'ConstraintNotSatisfiedError') {
      return this._fail('no-device', '麥克風目前無法讀取，可能被其他程式占用。請關閉其他應用程式後重試，或改用鍵盤模式。');
    }
    if (name === 'SecurityError') {
      return this._fail('insecure', '瀏覽器基於安全限制拒絕麥克風。請使用 HTTPS 或 localhost，或改用鍵盤模式。');
    }
    if (name === 'TypeError') {
      return this._fail('unsupported', '此瀏覽器不支援所需的麥克風設定，請改用鍵盤模式。');
    }

    this._lastError = error;
    return this._fail('unknown', '無法啟動麥克風。請稍後重試，或改用鍵盤模式。');
  }

  /**
   * 設定錯誤狀態並回傳合約格式。
   * @param {string} code
   * @param {string} message
   * @returns {{ok:false, code:string, message:string}}
   * @private
   */
  _fail(code, message) {
    this.status = code;
    this._lastError = { code, message };
    return { ok: false, code, message };
  }

  /**
   * 安全呼叫進度回呼；UI 出錯不應中斷校準。
   * @param {Function|undefined} callback
   * @param {object} payload
   * @private
   */
  _emitProgress(callback, payload) {
    if (typeof callback !== 'function') return;
    try {
      callback(payload);
    } catch {
      // 忽略 UI 回呼錯誤。
    }
  }

  /**
   * 以 setTimeout 等待；沒有 setTimeout 時直接結束。
   * @param {number} ms
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout;
      if (typeof timer === 'function') timer(resolve, ms);
      else resolve();
    });
  }

  /**
   * 取得毫秒時間。
   * @returns {number}
   * @private
   */
  _nowMs() {
    const performance = globalThis.performance;
    if (performance && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  /**
   * 取中位數（忽略非有限值）。
   * @param {number[]} values
   * @returns {number}
   * @private
   */
  _median(values) {
    const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (finite.length === 0) return 0;
    const middle = Math.floor(finite.length / 2);
    if (finite.length % 2 === 1) return finite[middle];
    return (finite[middle - 1] + finite[middle]) / 2;
  }
}
