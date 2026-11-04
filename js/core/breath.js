// 《勿聲》HUSH — 氣息模型（E1）
// 本檔為純邏輯模組：不得使用 window / document / AudioContext / localStorage。

import { BREATH, getBand } from './config.js';

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
 * 氣息模型。
 *
 * 規則：
 * - 靜默區間回復（config.BREATH.drain.silent 為負值）。
 * - 低聲／呼喊／尖叫依 band 消耗。
 * - 歸零立刻進入 gasp，為期 3 秒；期間 value 鎖 0。
 * - gasp 結束後回復到 afterGasp（預設 100）。
 *
 * 單次 update 不會在結束 gasp 後繼續處理剩餘 dt，避免同一次呼叫又觸發
 * 第二次狀態轉移；這在 dt 很大（例如分頁返回）時特別重要。
 */
export class BreathModel {
  /**
   * @param {object} [opts] 可覆寫 BREATH 數值，主要供測試使用。
   */
  constructor(opts = {}) {
    const src = opts && typeof opts === 'object' ? opts : {};
    this.max = Math.max(1, finiteOr(src.max, BREATH.max));
    this.drain = {
      ...BREATH.drain,
      ...(src.drain && typeof src.drain === 'object' ? src.drain : {}),
    };
    this.regen = Math.max(0, finiteOr(src.regen, BREATH.regen));
    this.gaspDuration = Math.max(0, finiteOr(src.gaspDuration, BREATH.gaspDuration));
    this.afterGasp = clamp(finiteOr(src.afterGasp, BREATH.afterGasp), 0, this.max);
    this.reset();
  }

  /** 回到滿氣息、正常狀態。 */
  reset() {
    this._value = this.max;
    this._state = 'normal';
    this._gaspRemaining = 0;
  }

  /**
   * 依目前音量推進氣息。
   * @param {number} dt 秒
   * @param {number} volume 0–100
   * @returns {{value:number, state:'normal'|'gasp', gaspRemaining:number, startedGasp:boolean, endedGasp:boolean}}
   */
  update(dt, volume) {
    const step = Math.max(0, finiteOr(dt, 0));
    let startedGasp = false;
    let endedGasp = false;

    if (this._state === 'gasp') {
      this._value = 0;

      if (step < this._gaspRemaining) {
        this._gaspRemaining -= step;
      } else {
        // 這幀的 dt 足以結束喘氣。剩餘時間直接捨棄，確保每次狀態轉移
        // 都只發生一次，且結束後必定是 afterGasp。
        this._gaspRemaining = 0;
        this._state = 'normal';
        this._value = this.afterGasp;
        endedGasp = true;
      }

      return this._result(startedGasp, endedGasp);
    }

    if (step <= 0) return this._result(false, false);

    const band = getBand(volume);
    const rate = this._drainFor(band.id); // 正值 = 每秒消耗；負值 = 每秒回復

    this._value = clamp(this._value - rate * step, 0, this.max);

    if (this._value <= 0 && rate > 0) {
      this._value = 0;
      this._state = 'gasp';
      this._gaspRemaining = this.gaspDuration;
      startedGasp = true;
    }

    return this._result(startedGasp, endedGasp);
  }

  /**
   * 取得 band 對應的每秒變化率。未知 band 會退回 regen 或 0。
   * @param {string} bandId
   * @returns {number}
   */
  _drainFor(bandId) {
    const value = Number(this.drain[bandId]);
    if (Number.isFinite(value)) return value;
    return bandId === 'silent' ? -this.regen : 0;
  }

  /**
   * 組裝回傳物件。
   * @param {boolean} startedGasp
   * @param {boolean} endedGasp
   * @returns {{value:number, state:'normal'|'gasp', gaspRemaining:number, startedGasp:boolean, endedGasp:boolean}}
   */
  _result(startedGasp, endedGasp) {
    return {
      value: this._value,
      state: this._state,
      gaspRemaining: this._gaspRemaining,
      startedGasp,
      endedGasp,
    };
  }

  /** @returns {number} 目前氣息 0–max */
  get value() {
    return this._value;
  }

  /** @returns {'normal'|'gasp'} 目前狀態 */
  get state() {
    return this._state;
  }

  /** @returns {number} 喘氣剩餘秒數；正常狀態為 0 */
  get gaspRemaining() {
    return this._gaspRemaining;
  }
}
