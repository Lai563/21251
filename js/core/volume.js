// 《勿聲》HUSH — 音量正規化與平滑（E1）
// 本檔為純邏輯模組：不得使用 window / document / AudioContext / localStorage。
// 測試會在 Node 直接 import。

import { getBand, KEYBOARD_VOICE } from './config.js';

/** 預設校準值（dBFS）。沒有麥克風或略過校準時使用。 */
export const DEFAULT_CALIBRATION = Object.freeze({
  noiseDb: -50,
  quietDb: -35,
  loudDb: -12,
});

const MIN_DB = -100;
const MAX_DB = 0;
/** 校準曲線的膝點：小聲說話對應的正規化音量。 */
const QUIET_KNEE_VALUE = 35;

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
 * 將可能是 undefined / NaN / 字串的值轉為有限數字。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 整理校準物件，確保 noiseDb < quietDb < loudDb，避免除以零或反向映射。
 * @param {object} calibration
 * @returns {{noiseDb:number, quietDb:number, loudDb:number}}
 */
function sanitizeCalibration(calibration) {
  const src = calibration && typeof calibration === 'object' ? calibration : DEFAULT_CALIBRATION;
  const noiseDb = finiteOr(src.noiseDb, DEFAULT_CALIBRATION.noiseDb);
  let loudDb = finiteOr(src.loudDb, DEFAULT_CALIBRATION.loudDb);

  // 至少保留 3dB 動態範圍，否則整條曲線會退化。
  if (loudDb <= noiseDb + 3) loudDb = noiseDb + 12;

  const span = loudDb - noiseDb;
  let quietDb = finiteOr(src.quietDb, noiseDb + span * 0.6);
  if (quietDb <= noiseDb) quietDb = noiseDb + span * 0.6;
  if (quietDb >= loudDb) quietDb = noiseDb + span * 0.6;

  return { noiseDb, quietDb, loudDb };
}

/**
 * RMS 轉 dBFS。0 會被視為極小值，避免 log(0) 變成 -Infinity。
 * @param {number} rms
 * @returns {number} 20 * log10(max(rms, 1e-8))
 */
export function rmsToDb(rms) {
  const value = Number(rms);
  const safe = Number.isFinite(value) ? Math.max(value, 1e-8) : 1e-8;
  return 20 * Math.log10(safe);
}

/**
 * 由三段校準的 RMS 建立 dB 門檻。
 * 會自動修正反向或過窄的區間，讓 normalizeVolume 永遠可運作。
 * @param {{noiseRms?:number, quietRms?:number, loudRms?:number}} samples
 * @returns {{noiseDb:number, quietDb:number, loudDb:number}}
 */
export function createCalibration(samples = {}) {
  const src = samples && typeof samples === 'object' ? samples : {};

  const toDb = (rms, fallback) => {
    const n = Number(rms);
    if (!Number.isFinite(n)) return fallback;
    return clamp(rmsToDb(n), MIN_DB, MAX_DB);
  };

  let noiseDb = toDb(src.noiseRms, DEFAULT_CALIBRATION.noiseDb);
  let quietDb = toDb(src.quietRms, DEFAULT_CALIBRATION.quietDb);
  let loudDb = toDb(src.loudRms, DEFAULT_CALIBRATION.loudDb);

  // 底噪與小聲至少差 3dB；小聲與大喊至少差 6dB。
  if (quietDb < noiseDb + 3) quietDb = noiseDb + 6;
  if (loudDb < quietDb + 6) loudDb = quietDb + 10;

  return { noiseDb, quietDb, loudDb };
}

/**
 * 將 dBFS 正規化到 0–100。
 * - noiseDb 以下 = 0
 * - loudDb 以上 = 100
 * - quietDb 作為膝點，對應 35，讓「小聲」落在低聲區間。
 * @param {number} db
 * @param {{noiseDb:number, quietDb:number, loudDb:number}} calibration
 * @returns {number} 0–100
 */
export function normalizeVolume(db, calibration = DEFAULT_CALIBRATION) {
  const value = Number(db);
  if (!Number.isFinite(value)) return 0;

  const cal = sanitizeCalibration(calibration);
  if (value <= cal.noiseDb) return 0;
  if (value >= cal.loudDb) return 100;

  const quietDb = clamp(cal.quietDb, cal.noiseDb + 1e-6, cal.loudDb - 1e-6);
  if (value <= quietDb) {
    const ratio = (value - cal.noiseDb) / (quietDb - cal.noiseDb);
    return clamp(ratio * QUIET_KNEE_VALUE, 0, QUIET_KNEE_VALUE);
  }

  const ratio = (value - quietDb) / (cal.loudDb - quietDb);
  return clamp(QUIET_KNEE_VALUE + ratio * (100 - QUIET_KNEE_VALUE), QUIET_KNEE_VALUE, 100);
}

/**
 * 麥克風音量追蹤器：RMS → dB → 0–100，再以指數平滑。
 * attack 80ms / release 250ms 為時間常數（time constant）。
 */
export class VolumeTracker {
  /**
   * @param {{noiseDb:number, quietDb:number, loudDb:number}} [calibration]
   */
  constructor(calibration = DEFAULT_CALIBRATION) {
    this._calibration = sanitizeCalibration(calibration);
    this._value = 0;
    this._target = 0;
    /** 上升時間常數（秒） */
    this.attack = 0.08;
    /** 下降時間常數（秒） */
    this.release = 0.25;
  }

  /**
   * 推入一個 RMS 取樣並回傳平滑後的音量。
   * @param {number} rms
   * @param {number} [dt] 秒
   * @returns {number} 0–100
   */
  push(rms, dt = 1 / 60) {
    const step = clamp(finiteOr(dt, 0), 0, 1);
    const target = normalizeVolume(rmsToDb(rms), this._calibration);
    this._target = target;

    if (step <= 0) return this._value;

    const tau = target > this._value ? this.attack : this.release;
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-step / tau);
    this._value += (target - this._value) * alpha;
    this._value = clamp(this._value, 0, 100);

    // 接近目標時直接貼齊，讓邊界判定與測試可重現。
    if (Math.abs(target - this._value) < 1e-4) this._value = target;
    return this._value;
  }

  /** 歸零（切換模式、暫停或重新開始時使用）。 */
  reset() {
    this._value = 0;
    this._target = 0;
  }

  /** @returns {number} 目前平滑音量 0–100 */
  get value() {
    return this._value;
  }

  /** @returns {object} 目前音量區間（來自 config.getBand） */
  get band() {
    return getBand(this._value);
  }

  /**
   * 更換校準值。不會重設目前音量，讓校準後可無縫接續。
   * @param {{noiseDb:number, quietDb:number, loudDb:number}} calibration
   * @returns {VolumeTracker}
   */
  setCalibration(calibration) {
    this._calibration = sanitizeCalibration(calibration);
    return this;
  }
}

/**
 * 鍵盤替代發聲：按住線性上升到 100，放開線性下降。
 * 預設 attack 1.0s、release 0.35s（來自 config.KEYBOARD_VOICE）。
 */
export class KeyboardVoice {
  /**
   * @param {{attack?:number, release?:number}} [opts]
   */
  constructor(opts = KEYBOARD_VOICE) {
    const src = opts && typeof opts === 'object' ? opts : KEYBOARD_VOICE;
    this.attack = Math.max(0, finiteOr(src.attack, KEYBOARD_VOICE.attack));
    this.release = Math.max(0, finiteOr(src.release, KEYBOARD_VOICE.release));
    this._value = 0;
  }

  /**
   * 更新鍵盤發聲值。
   * @param {number} dt 秒
   * @param {boolean} held 是否按住發聲鍵
   * @returns {number} 0–100
   */
  update(dt, held) {
    const step = Math.max(0, finiteOr(dt, 0));
    if (step <= 0) return this._value;

    if (held) {
      this._value = this.attack <= 0 ? 100 : this._value + (100 / this.attack) * step;
    } else {
      this._value = this.release <= 0 ? 0 : this._value - (100 / this.release) * step;
    }

    this._value = clamp(this._value, 0, 100);
    return this._value;
  }

  /** 歸零。 */
  reset() {
    this._value = 0;
  }

  /** @returns {number} 目前鍵盤發聲值 0–100 */
  get value() {
    return this._value;
  }
}
