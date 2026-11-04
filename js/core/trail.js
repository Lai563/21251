// 《勿聲》HUSH — 聲紋殘留（E1）
// 本檔為純邏輯模組：不得使用 window / document / AudioContext / localStorage。

import { TRAIL } from './config.js';

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
 * 聲紋系統。
 *
 * - 聲量 >= minVolume 時才留下節點。
 * - 每 interval 秒最多新增一點（第一次出聲會立刻留下節點）。
 * - 節點壽命依音量線性介於 ttlMin–ttlMax，水區再乘 waterTtlMultiplier。
 * - 最多 maxPoints 點，超過淘汰最舊。
 */
export class TrailSystem {
  /**
   * @param {object} [opts] 可覆寫 TRAIL 數值，主要供測試使用。
   */
  constructor(opts = {}) {
    const src = opts && typeof opts === 'object' ? opts : {};

    this.interval = Math.max(0, finiteOr(src.interval, TRAIL.interval));
    this.ttlMin = Math.max(0, finiteOr(src.ttlMin, TRAIL.ttlMin));
    this.ttlMax = Math.max(this.ttlMin, finiteOr(src.ttlMax, TRAIL.ttlMax));
    this.maxPoints = Math.max(1, Math.floor(finiteOr(src.maxPoints, TRAIL.maxPoints)));
    this.minVolume = clamp(finiteOr(src.minVolume, TRAIL.minVolume), 0, 100);
    this.waterTtlMultiplier = Math.max(1, finiteOr(src.waterTtlMultiplier, TRAIL.waterTtlMultiplier));

    this._points = [];
    this._sinceSpawn = 0;
  }

  /**
   * 推進時間、老化既有節點，必要時新增一點。
   * @param {number} dt 秒
   * @param {{x:number, y:number, volume:number, water?:boolean}} sample
   * @returns {boolean} 這一幀是否新增節點
   */
  update(dt, sample = {}) {
    const step = Math.max(0, finiteOr(dt, 0));

    // 1. 老化與移除過期節點（age >= ttl）。
    if (step > 0 && this._points.length > 0) {
      for (const point of this._points) point.age += step;
      this._points = this._points.filter((point) => point.age < point.ttl);
    }

    this._sinceSpawn += step;

    const volume = clamp(finiteOr(sample.volume, 0), 0, 100);
    const x = Number(sample.x);
    const y = Number(sample.y);
    const canSpawn = volume >= this.minVolume && Number.isFinite(x) && Number.isFinite(y);

    if (!canSpawn) return false;

    // 第一次有效出聲立即留下節點；之後嚴格遵守 interval。
    const due = this._points.length === 0
      ? step > 0
      : this._sinceSpawn >= this.interval;

    if (!due) return false;

    const water = Boolean(sample.water);
    const baseTtl = this.ttlMin + (volume / 100) * (this.ttlMax - this.ttlMin);
    const ttl = baseTtl * (water ? this.waterTtlMultiplier : 1);

    this._points.push({
      x,
      y,
      intensity: clamp(volume / 100, 0, 1),
      age: 0,
      ttl,
      water,
    });

    this._sinceSpawn = 0;

    // 2. 淘汰最舊節點。
    while (this._points.length > this.maxPoints) this._points.shift();

    return true;
  }

  /**
   * 取得所有節點的副本（由舊到新）。
   * @returns {Array<{x:number, y:number, intensity:number, age:number, ttl:number, water:boolean}>}
   */
  getPoints() {
    return this._points.map((point) => ({ ...point }));
  }

  /**
   * 最新節點的副本。
   * @returns {{x:number, y:number, intensity:number, age:number, ttl:number, water:boolean}|null}
   */
  newest() {
    if (this._points.length === 0) return null;
    return { ...this._points[this._points.length - 1] };
  }

  /** 清空所有節點與計時器。 */
  clear() {
    this._points = [];
    this._sinceSpawn = 0;
  }
}
