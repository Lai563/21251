// 《勿聲》HUSH — Canvas 2D 第一人稱聲納線稿渲染器
// 內部固定解析度 640×360（CSS 負責放大），全部圖形以程序化 Canvas 路徑繪製，不使用圖片。
// HUD 由 DOM 負責，這裡只畫 canvas。
//
// 視覺邏輯：
//   1. 以音量 band 的 vision 半徑決定牆面基礎可見度；安靜時近乎全黑。
//   2. 聲納脈衝（pulses）由玩家位置向外擴散，波前掃過牆面時短暫增亮。
//   3. 精靈以 zBuffer（每欄垂直距離）做遮擋，依 depth 由遠而近繪製。
//   4. 後處理：顆粒、掃描線、暗角、危險紅邊與輕微撕裂。

import { FOV, SONAR, PLAYER, getBand } from './core/config.js';
import { castRay } from './core/raycast.js';

const WIDTH = 640;
const HEIGHT = 360;
const HORIZON = HEIGHT / 2;
const COLUMNS = 320;
const COLUMN_W = WIDTH / COLUMNS; // 2px
const HALF_FOV_TAN = Math.tan(FOV / 2);
const MAX_CAST = 42;
const MAX_PULSES = 8;

/** @param {number} v @param {number} a @param {number} b */
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** @param {number} v */
function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

/** 以字串產生穩定的 0..1 相位，避免精靈閃爍同步。 */
function hashPhase(str) {
  let h = 2166136261;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 離屏素材（只建立一次，避免每幀產生 gradient）
// ---------------------------------------------------------------------------

/** @param {number} size */
function makeNoiseCanvas(size = 128) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeScanlineCanvas() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 4, 4);
  g.fillStyle = 'rgba(0, 0, 0, 0.55)';
  g.fillRect(0, 0, 4, 1);
  return c;
}

/** @param {string} center @param {string} mid @param {string} edge */
function makeVignetteCanvas(center, mid, edge) {
  const c = document.createElement('canvas');
  c.width = WIDTH;
  c.height = HEIGHT;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(
    WIDTH / 2,
    HEIGHT / 2,
    HEIGHT * 0.16,
    WIDTH / 2,
    HEIGHT / 2,
    HEIGHT * 0.78,
  );
  grad.addColorStop(0, center);
  grad.addColorStop(0.55, mid);
  grad.addColorStop(1, edge);
  g.fillStyle = grad;
  g.fillRect(0, 0, WIDTH, HEIGHT);
  return c;
}

/** @param {number} r @param {number} g @param {number} b */
function makeGlowCanvas(r, g, b) {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(0.28, `rgba(${r},${g},${b},0.32)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grad;
  x.fillRect(0, 0, size, size);
  return c;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{reducedMotion?:boolean}} [opts]
   */
  constructor(canvas, opts = {}) {
    if (!canvas) throw new Error('Renderer 需要一個 canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('無法取得 2D context');

    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.ctx.imageSmoothingEnabled = false;

    this.reducedMotion = !!opts.reducedMotion;
    this.shake = 0;
    this.pulses = [];
    this.zBuffer = new Float32Array(COLUMNS);

    this._time = 0;
    this._px = 0;
    this._py = 0;
    this._dirX = 1;
    this._dirY = 0;
    this._planeX = 0;
    this._planeY = HALF_FOV_TAN;
    this._water = false;

    this._lastBandIndex = null;
    this._lastChapter = null;
    this._pulseTimer = 0;
    this._lastSprites = 0;
    this._lastFrameMs = 0;
    this._disposed = false;

    /** @type {WeakMap<object, object>} 章節 → raycast 用的 level 介面 */
    this._levelCache = new WeakMap();

    // 量化亮度色表：每幀每欄只查表，不建立新字串。
    this._fillColors = new Array(33);
    this._lineColors = new Array(33);
    this._edgeColors = new Array(33);
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      this._fillColors[i] = `rgba(46,118,118,${(t * 0.22).toFixed(3)})`;
      this._lineColors[i] = `rgba(188,246,240,${(t * 0.95).toFixed(3)})`;
      this._edgeColors[i] = `rgba(142,230,224,${(t * 0.85).toFixed(3)})`;
    }

    this._bgGradient = this.ctx.createLinearGradient(0, 0, 0, HEIGHT);
    this._bgGradient.addColorStop(0, '#010203');
    this._bgGradient.addColorStop(0.34, '#020607');
    this._bgGradient.addColorStop(0.47, '#04090b');
    this._bgGradient.addColorStop(0.5, '#081214');
    this._bgGradient.addColorStop(0.54, '#050d0f');
    this._bgGradient.addColorStop(0.78, '#030a0c');
    this._bgGradient.addColorStop(1, '#020608');

    this._waterGradient = this.ctx.createLinearGradient(0, HORIZON, 0, HEIGHT);
    this._waterGradient.addColorStop(0, 'rgba(40,190,165,0)');
    this._waterGradient.addColorStop(0.55, 'rgba(35,160,145,0.05)');
    this._waterGradient.addColorStop(1, 'rgba(45,205,175,0.16)');

    this._noiseCanvas = makeNoiseCanvas(128);
    this._noisePattern = this.ctx.createPattern(this._noiseCanvas, 'repeat');
    this._scanCanvas = makeScanlineCanvas();
    this._scanPattern = this.ctx.createPattern(this._scanCanvas, 'repeat');

    this._vignette = makeVignetteCanvas(
      'rgba(0,0,0,0)',
      'rgba(0,0,0,0.22)',
      'rgba(0,0,0,0.88)',
    );
    this._dangerVignette = makeVignetteCanvas(
      'rgba(110,0,18,0)',
      'rgba(120,4,22,0.12)',
      'rgba(150,8,28,0.85)',
    );

    this._glows = {
      teal: makeGlowCanvas(130, 255, 230),
      white: makeGlowCanvas(225, 255, 250),
      red: makeGlowCanvas(255, 64, 84),
      warm: makeGlowCanvas(255, 198, 120),
    };
  }

  /** 固定內部解析度；CSS 已負責等比放大。 */
  resize() {
    if (this._disposed) return;
    if (this.canvas.width !== WIDTH) this.canvas.width = WIDTH;
    if (this.canvas.height !== HEIGHT) this.canvas.height = HEIGHT;
    this.ctx.imageSmoothingEnabled = false;
  }

  /**
   * @param {boolean} value
   */
  setReducedMotion(value) {
    this.reducedMotion = !!value;
    if (this.reducedMotion) this.shake = 0;
  }

  /**
   * 疊加畫面震動（像素）。reducedMotion 時仍會記錄，但渲染時忽略。
   * @param {number} amount
   */
  addShake(amount) {
    const a = num(amount);
    if (a <= 0) return;
    this.shake = Math.min(14, this.shake + a);
  }

  /** 除錯用統計。 */
  getStats() {
    return {
      pulses: this.pulses.length,
      sprites: this._lastSprites,
      columns: COLUMNS,
      frameMs: this._lastFrameMs,
      shake: this.shake,
    };
  }

  dispose() {
    this._disposed = true;
    this.pulses.length = 0;
    this._levelCache = new WeakMap();
    this._noisePattern = null;
    this._scanPattern = null;
    this._noiseCanvas = null;
    this._scanCanvas = null;
    this._vignette = null;
    this._dangerVignette = null;
    this._glows = null;
    this._bgGradient = null;
    this._waterGradient = null;
    this.ctx = null;
  }

  // -------------------------------------------------------------------------
  // 主渲染
  // -------------------------------------------------------------------------

  /**
   * @param {object|null} state GameSession.getState()；開場可為 null
   * @param {number} time 秒
   * @param {number} dt 秒
   */
  render(state, time, dt) {
    if (this._disposed || !this.ctx) return;
    const ctx = this.ctx;
    const t0 =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : 0;
    const t = num(time);
    const d = clamp(num(dt), 0, 0.1);
    this._time = t;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 開場／尚無 session：只畫黑。
    if (!state) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      this.pulses.length = 0;
      this._lastBandIndex = null;
      this._lastChapter = null;
      this._lastSprites = 0;
      this._lastFrameMs = t0 ? performance.now() - t0 : 0;
      return;
    }

    const chapterIndex = Number.isFinite(state.chapterIndex) ? state.chapterIndex : null;
    if (this._lastChapter === null) {
      this._lastChapter = chapterIndex;
    } else if (chapterIndex !== null && chapterIndex !== this._lastChapter) {
      this._lastChapter = chapterIndex;
      this.pulses.length = 0;
      this._lastBandIndex = null;
      this._pulseTimer = 0;
    }

    const p = state.player || {};
    const px = num(p.x, 0.5);
    const py = num(p.y, 0.5);
    const angle = num(p.angle, 0);
    this._setCamera(px, py, angle);

    const volume = clamp(
      Number.isFinite(state.effectiveVolume) ? state.effectiveVolume : num(state.volume),
      0,
      100,
    );
    const configBand = getBand(volume);
    const bandIndex =
      state.band && Number.isFinite(state.band.index)
        ? clamp(state.band.index | 0, 0, 3)
        : configBand.index;
    const vision = configBand.vision;
    const level = this._resolveLevel(state);
    this._water = this._detectWater(state, level, px, py);

    // ---- 聲納脈衝：跨入更高 band 或持續出聲 ----
    if (this._lastBandIndex === null) {
      this._lastBandIndex = bandIndex;
    } else if (bandIndex > this._lastBandIndex) {
      this._spawnPulse(0.9 + bandIndex * 0.22, vision);
    }
    this._lastBandIndex = bandIndex;

    if (volume > 20) {
      this._pulseTimer += d;
      const interval = Math.max(0.55, 1.3 - bandIndex * 0.18);
      if (this._pulseTimer >= interval) {
        this._pulseTimer = 0;
        this._spawnPulse(0.3 + bandIndex * 0.13, vision);
      }
    } else {
      this._pulseTimer = 0;
    }
    this._updatePulses(d);

    // ---- 震動／呼吸感 ----
    let shakeX = 0;
    let shakeY = 0;
    if (!this.reducedMotion && this.shake > 0.02) {
      shakeX = (Math.random() * 2 - 1) * this.shake;
      shakeY = (Math.random() * 2 - 1) * this.shake;
    }
    this.shake *= Math.exp(-7 * d);
    if (this.shake < 0.04) this.shake = 0;
    const breathe = this.reducedMotion ? 0 : Math.sin(t * 0.9) * 1.2;

    ctx.setTransform(1, 0, 0, 1, shakeX, shakeY + breathe);
    ctx.fillStyle = '#000';
    ctx.fillRect(-10, -10, WIDTH + 20, HEIGHT + 20);

    this._drawBackground(t, volume);
    this._drawWalls(level, vision);

    const sprites = this._collectSprites(state, t, vision);
    this._lastSprites = sprites.length;
    for (let i = 0; i < sprites.length; i++) {
      this._drawSprite(sprites[i], state, t, volume);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._drawPost(state, t, volume);

    this._lastFrameMs = t0 ? performance.now() - t0 : 0;
  }

  // -------------------------------------------------------------------------
  // 相機與投影
  // -------------------------------------------------------------------------

  _setCamera(px, py, angle) {
    this._px = px;
    this._py = py;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    this._dirX = dirX;
    this._dirY = dirY;
    this._planeX = -dirY * HALF_FOV_TAN;
    this._planeY = dirX * HALF_FOV_TAN;
  }

  /**
   * 將世界座標投影到螢幕。depth 為相機平面深度（可直接與 zBuffer 比較）。
   * @param {number} wx
   * @param {number} wy
   * @returns {{sx:number,depth:number,floorY:number,scale:number}|null}
   */
  _project(wx, wy) {
    const dx = wx - this._px;
    const dy = wy - this._py;
    const det = this._planeX * this._dirY - this._dirX * this._planeY;
    if (Math.abs(det) < 1e-9) return null;
    const inv = 1 / det;
    const tx = inv * (this._dirY * dx - this._dirX * dy);
    const ty = inv * (-this._planeY * dx + this._planeX * dy);
    if (!(ty > 0.08)) return null;
    return {
      sx: WIDTH * 0.5 * (1 + tx / ty),
      depth: ty,
      floorY: HORIZON + (PLAYER.eyeHeight * HEIGHT) / ty,
      scale: HEIGHT / ty,
    };
  }

  // -------------------------------------------------------------------------
  // 關卡介面
  // -------------------------------------------------------------------------

  /**
   * state.chapter 可能只是資料物件；這裡建立 raycast 需要的 level 介面，
   * 並把每幀最新的 state.doors（open 狀態）接上去。
   * @param {object} state
   * @returns {object|null}
   */
  _resolveLevel(state) {
    const chapter = state.level || state.chapter;
    if (!chapter || typeof chapter !== 'object') return null;

    let adapter = this._levelCache.get(chapter);
    if (!adapter) {
      const grid = Array.isArray(chapter.grid) ? chapter.grid : null;
      const width = Number.isFinite(chapter.width)
        ? chapter.width
        : grid && grid[0]
          ? grid[0].length
          : 0;
      const height = Number.isFinite(chapter.height) ? chapter.height : grid ? grid.length : 0;

      const tileAt =
        typeof chapter.tileAt === 'function'
          ? (x, y) => chapter.tileAt(x, y)
          : (x, y) => {
              const cx = Math.floor(x);
              const cy = Math.floor(y);
              if (!grid || cx < 0 || cy < 0 || cx >= width || cy >= height) return '#';
              const row = grid[cy];
              const tile = row ? row[cx] : null;
              return typeof tile === 'string' ? tile : '#';
            };

      adapter = {
        width,
        height,
        grid,
        tileAt,
        doors: [],
      };
      this._levelCache.set(chapter, adapter);
    }

    if (Array.isArray(state.doors)) adapter.doors = state.doors;
    else if (Array.isArray(chapter.doors)) adapter.doors = chapter.doors;
    else adapter.doors = [];
    return adapter;
  }

  /**
   * @param {object} state
   * @param {object|null} level
   * @param {number} px
   * @param {number} py
   * @returns {boolean}
   */
  _detectWater(state, level, px, py) {
    const chapter = state.chapter;
    if (chapter && chapter.water === true) return true;
    if (level && typeof level.tileAt === 'function') {
      return level.tileAt(px, py) === '~';
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 聲納脈衝
  // -------------------------------------------------------------------------

  /**
   * @param {number} strength
   * @param {number} vision
   */
  _spawnPulse(strength, vision) {
    const maxRadius = Math.max(5, Math.min(SONAR.maxRange, vision + 3));
    const speed = SONAR.pulseSpeed;
    this.pulses.push({
      age: 0,
      ttl: maxRadius / speed,
      speed,
      strength,
      maxRadius,
    });
    if (this.pulses.length > MAX_PULSES) this.pulses.shift();
  }

  /** @param {number} dt */
  _updatePulses(dt) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const pulse = this.pulses[i];
      pulse.age += dt;
      if (pulse.age >= pulse.ttl) this.pulses.splice(i, 1);
    }
  }

  // -------------------------------------------------------------------------
  // 背景
  // -------------------------------------------------------------------------

  /**
   * @param {number} time
   * @param {number} volume
   */
  _drawBackground(time, volume) {
    const ctx = this.ctx;
    ctx.fillStyle = this._bgGradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 地平線微光：越大聲越明顯。
    const horizonAlpha = 0.05 + (volume / 100) * 0.1;
    ctx.fillStyle = `rgba(120,220,210,${horizonAlpha.toFixed(3)})`;
    ctx.fillRect(0, HORIZON - 1, WIDTH, 1);

    if (this._water) {
      ctx.fillStyle = this._waterGradient;
      ctx.fillRect(0, HORIZON, WIDTH, HEIGHT - HORIZON);

      // 水面反光：幾條低成本的横向微光。
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const y = HORIZON + 18 + i * 30 + Math.sin(time * 1.3 + i * 1.7) * 6;
        const a = 0.025 + 0.02 * Math.sin(time * 2.1 + i);
        ctx.fillStyle = `rgba(90,230,200,${a.toFixed(3)})`;
        const x = ((Math.sin(time * 0.6 + i * 2.3) * 0.5 + 0.5) * WIDTH) | 0;
        ctx.fillRect(x - 90, y, 180, 1);
      }
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // 牆面 raycasting
  // -------------------------------------------------------------------------

  /**
   * @param {object|null} level
   * @param {number} vision
   */
  _drawWalls(level, vision) {
    const ctx = this.ctx;
    const dirX = this._dirX;
    const dirY = this._dirY;
    const planeX = this._planeX;
    const planeY = this._planeY;
    const px = this._px;
    const py = this._py;
    const maxDist = Math.max(MAX_CAST, vision + 12);

    // 先把脈衝半徑算好，避免每欄重算。
    const pulseCount = this.pulses.length;
    const pulseRadius = new Array(pulseCount);
    const pulseStrength = new Array(pulseCount);
    for (let i = 0; i < pulseCount; i++) {
      const pulse = this.pulses[i];
      pulseRadius[i] = pulse.age * pulse.speed;
      pulseStrength[i] =
        pulse.strength * (1 - pulse.age / pulse.ttl) * (1 - pulse.age / pulse.ttl);
    }

    let prevMapX = -9999;
    let prevMapY = -9999;

    for (let col = 0; col < COLUMNS; col++) {
      const cameraX = (2 * (col + 0.5)) / COLUMNS - 1;
      const rdx = dirX + planeX * cameraX;
      const rdy = dirY + planeY * cameraX;
      const x = col * COLUMN_W;

      if (!level) {
        this.zBuffer[col] = Infinity;
        continue;
      }

      const hit = castRay(level, px, py, rdx, rdy, maxDist);
      if (!hit.hit || hit.tile === null) {
        this.zBuffer[col] = Infinity;
        prevMapX = hit.mapX;
        prevMapY = hit.mapY;
        continue;
      }

      const perp = Math.max(0.0001, hit.dist);
      this.zBuffer[col] = perp;

      const rayLen = Math.hypot(rdx, rdy);
      const radial = perp * rayLen;

      // 基礎可見度：距離越遠越暗；極近牆面永遠留一點微光。
      let b = Math.pow(clamp(1 - radial / (vision * 1.12), 0, 1), 0.85);
      b += clamp((1.7 - radial) / 1.7, 0, 1) * 0.26;

      // 聲納波前
      for (let i = 0; i < pulseCount; i++) {
        const delta = Math.abs(radial - pulseRadius[i]);
        if (delta < SONAR.pulseWidth) {
          const w = 1 - delta / SONAR.pulseWidth;
          b += pulseStrength[i] * w * w;
        }
      }

      // 側面較暗，強化線稿立體感。
      if (hit.side === 1) b *= 0.72;
      b = clamp(b, 0, 1);

      const lvl = Math.round(b * 32);
      if (lvl <= 0) {
        prevMapX = hit.mapX;
        prevMapY = hit.mapY;
        continue;
      }

      const h = HEIGHT / perp;
      const top = HORIZON - h * 0.5;
      const bottom = HORIZON + h * 0.5;
      const drawTop = Math.max(0, top);
      const drawBottom = Math.min(HEIGHT, bottom);
      const drawH = drawBottom - drawTop;
      if (drawH <= 0) continue;

      // 牆面本體：低透明度填色，避免整片死黑。
      ctx.fillStyle = this._fillColors[lvl];
      ctx.fillRect(x, drawTop, COLUMN_W, drawH);

      // 牆頂／牆底輪廓線（線稿感）。
      ctx.fillStyle = this._lineColors[lvl];
      if (top >= -1 && top < HEIGHT) ctx.fillRect(x, top, COLUMN_W, 1);
      if (bottom > 0 && bottom <= HEIGHT + 1) ctx.fillRect(x, bottom - 1, COLUMN_W, 1);

      // 格子邊界（相鄰欄位 mapX/mapY 改變）畫垂直輪廓。
      if (hit.mapX !== prevMapX || hit.mapY !== prevMapY) {
        ctx.fillStyle = this._edgeColors[lvl];
        ctx.fillRect(x, drawTop, 1, drawH);
      }
      prevMapX = hit.mapX;
      prevMapY = hit.mapY;
    }
  }

  // -------------------------------------------------------------------------
  // 精靈收集與繪製
  // -------------------------------------------------------------------------

  /**
   * @param {object} state
   * @param {number} time
   * @param {number} vision
   * @returns {Array<object>}
   */
  _collectSprites(state, time, vision) {
    const list = [];
    const maxDepth = Math.max(8, vision * 1.6 + 4);

    /** @param {string} kind @param {number} wx @param {number} wy @param {object} data */
    const add = (kind, wx, wy, data) => {
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
      const p = this._project(wx, wy);
      if (!p) return;
      if (p.depth > maxDepth) return;
      if (p.sx < -140 || p.sx > WIDTH + 140) return;
      list.push({ kind, data, sx: p.sx, depth: p.depth, floorY: p.floorY, scale: p.scale });
    };

    if (Array.isArray(state.trails)) {
      for (let i = 0; i < state.trails.length; i++) {
        const tr = state.trails[i];
        if (!tr) continue;
        const age = num(tr.age);
        const ttl = num(tr.ttl, 1);
        if (ttl <= 0 || age >= ttl) continue;
        add('trail', num(tr.x, NaN), num(tr.y, NaN), tr);
      }
    }

    if (Array.isArray(state.items)) {
      for (let i = 0; i < state.items.length; i++) {
        const item = state.items[i];
        if (!item || item.collected) continue;
        add('item', num(item.x, NaN), num(item.y, NaN), item);
      }
    }

    if (Array.isArray(state.quietPoints)) {
      for (let i = 0; i < state.quietPoints.length; i++) {
        const q = state.quietPoints[i];
        if (!q) continue;
        add('quiet', num(q.x, NaN), num(q.y, NaN), q);
      }
    }

    if (state.exit) {
      add('exit', num(state.exit.x, NaN), num(state.exit.y, NaN), state.exit);
    }

    if (state.altar) {
      add('altar', num(state.altar.x, NaN), num(state.altar.y, NaN), state.altar);
    }

    if (state.monster) {
      const m = state.monster;
      add('monster', num(m.x, NaN), num(m.y, NaN), m);
    }

    // 由遠而近（painter's algorithm）
    list.sort((a, b) => b.depth - a.depth);
    return list;
  }

  /**
   * @param {object} sp
   * @param {object} state
   * @param {number} time
   * @param {number} volume
   */
  _drawSprite(sp, state, time, volume) {
    switch (sp.kind) {
      case 'trail':
        this._drawTrail(sp, time);
        break;
      case 'item':
        this._drawItem(sp, time);
        break;
      case 'quiet':
        this._drawQuiet(sp, time);
        break;
      case 'exit':
        this._drawExit(sp, time);
        break;
      case 'altar':
        this._drawAltar(sp, time);
        break;
      case 'monster':
        this._drawMonster(sp, state, time);
        break;
      default:
        break;
    }
  }

  /** 中心欄位是否被牆遮擋。 */
  _occluded(sx, depth) {
    const col = clamp(Math.floor(sx / COLUMN_W), 0, COLUMNS - 1);
    return this.zBuffer[col] < depth - 0.02;
  }

  /**
   * 回傳精靈在畫面上可見的連續欄位範圍（供 clip）。
   * @param {number} sx
   * @param {number} halfWidth 螢幕像素
   * @param {number} depth
   * @returns {{x0:number,x1:number}|null}
   */
  _visibleSpan(sx, halfWidth, depth) {
    const c0 = Math.max(0, Math.floor((sx - halfWidth) / COLUMN_W));
    const c1 = Math.min(COLUMNS - 1, Math.floor((sx + halfWidth) / COLUMN_W));
    let first = -1;
    let last = -1;
    for (let c = c0; c <= c1; c++) {
      if (this.zBuffer[c] > depth - 0.02) {
        if (first < 0) first = c;
        last = c;
      }
    }
    if (first < 0) return null;
    return { x0: first * COLUMN_W, x1: (last + 1) * COLUMN_W };
  }

  /** @param {CanvasImageSource} glow */
  _drawGlow(glow, x, y, size, alpha) {
    if (!glow || alpha <= 0.005 || size <= 1) return;
    const ctx = this.ctx;
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.drawImage(glow, x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = 1;
  }

  // ---- 聲紋（地面漣漪） -----------------------------------------------------

  _drawTrail(sp, time) {
    if (this._occluded(sp.sx, sp.depth)) return;
    const tr = sp.data;
    const age = num(tr.age);
    const ttl = num(tr.ttl, 1);
    const fade = clamp(1 - age / ttl, 0, 1);
    const intensity = clamp(num(tr.intensity, 0.6), 0, 1);
    if (fade <= 0.01) return;

    const water = !!tr.water;
    const alpha = clamp((0.1 + intensity * 0.5) * fade * (water ? 1.3 : 1), 0, 0.9);
    if (alpha < 0.02) return;

    const ctx = this.ctx;
    const size = clamp(0.24 * sp.scale, 2, 44) * (1 + (1 - fade) * 0.3);
    const cy = sp.floorY;

    ctx.save();
    ctx.strokeStyle = water
      ? `rgba(118,255,214,${alpha.toFixed(3)})`
      : `rgba(152,240,230,${alpha.toFixed(3)})`;
    ctx.lineWidth = sp.depth < 2 ? 1.5 : 1;

    for (let i = 0; i < 2; i++) {
      const r = size * (0.55 + i * 0.45);
      ctx.beginPath();
      ctx.ellipse(sp.sx, cy, r, r * 0.42, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 兩個小腳印，讓聲紋讀起來像「有人走過」。
    const foot = size * 0.22;
    const wobble = this.reducedMotion ? 0 : Math.sin(time * 3 + sp.sx * 0.05) * 0.6;
    ctx.beginPath();
    ctx.moveTo(sp.sx - foot, cy - size * 0.08);
    ctx.lineTo(sp.sx - foot + wobble, cy + size * 0.06);
    ctx.moveTo(sp.sx + foot, cy - size * 0.05);
    ctx.lineTo(sp.sx + foot - wobble, cy + size * 0.09);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 物品（漂浮菱形） -----------------------------------------------------

  _drawItem(sp, time) {
    if (this._occluded(sp.sx, sp.depth)) return;
    const item = sp.data;
    const phase = hashPhase(item.id) * Math.PI * 2;
    const bob = Math.sin(time * 2.3 + phase) * 0.05 * sp.scale;
    const size = clamp(0.15 * sp.scale, 2, 18);
    const cy = sp.floorY - 0.52 * sp.scale + bob;
    const pulse = 0.65 + 0.35 * Math.sin(time * 2.8 + phase);

    this._drawGlow(this._glows.teal, sp.sx, cy, size * 9, 0.3 * pulse);

    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = `rgba(184,255,240,${(0.55 + 0.35 * pulse).toFixed(3)})`;
    ctx.fillStyle = 'rgba(130,255,232,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sp.sx, cy - size * 1.5);
    ctx.lineTo(sp.sx + size * 0.8, cy);
    ctx.lineTo(sp.sx, cy + size * 1.5);
    ctx.lineTo(sp.sx - size * 0.8, cy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 微光十字
    ctx.strokeStyle = `rgba(210,255,248,${(0.25 + 0.3 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(sp.sx - size * 0.4, cy);
    ctx.lineTo(sp.sx + size * 0.4, cy);
    ctx.moveTo(sp.sx, cy - size * 0.4);
    ctx.lineTo(sp.sx, cy + size * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 安靜點（小光點／波紋） -----------------------------------------------

  _drawQuiet(sp, time) {
    if (this._occluded(sp.sx, sp.depth)) return;
    const q = sp.data;
    const activated = !!q.activated;
    const phase = hashPhase(q.id) * Math.PI * 2;
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.1 + phase);
    const size = clamp(0.11 * sp.scale, 1.5, 12);
    const cy = sp.floorY - 0.32 * sp.scale;

    const ctx = this.ctx;
    const alpha = activated ? 0.22 : 0.4 + 0.35 * pulse;
    const glow = activated ? this._glows.white : this._glows.teal;
    this._drawGlow(glow, sp.sx, cy, size * 12, alpha * 0.7);

    // 地面波紋
    ctx.save();
    ctx.strokeStyle = activated
      ? `rgba(140,190,190,${(alpha * 0.5).toFixed(3)})`
      : `rgba(150,250,235,${(alpha * 0.7).toFixed(3)})`;
    ctx.lineWidth = 1;
    const r = clamp(0.42 * sp.scale, 2, 40) * (activated ? 1 : 0.8 + pulse * 0.3);
    ctx.beginPath();
    ctx.ellipse(sp.sx, sp.floorY, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 光點
    ctx.fillStyle = activated
      ? 'rgba(190,225,225,0.45)'
      : `rgba(220,255,248,${(0.5 + 0.4 * pulse).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(sp.sx, cy, Math.max(1, size * 0.55), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- 出口（門框微光） -----------------------------------------------------

  _drawExit(sp, time) {
    const exit = sp.data;
    const w = 0.95 * sp.scale;
    const h = 1.9 * sp.scale;
    if (w < 3 || h < 4) return;
    const span = this._visibleSpan(sp.sx, w * 0.8, sp.depth);
    if (!span) return;

    const unlocked = !!exit.unlocked;
    const phase = hashPhase('exit') * Math.PI * 2;
    const pulse = 0.65 + 0.35 * Math.sin(time * 1.8 + phase);
    const col = unlocked ? '140,255,235' : '255,192,120';
    const alpha = unlocked ? 0.45 + 0.3 * pulse : 0.26 + 0.12 * pulse;
    const base = sp.floorY;
    const top = base - h;

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(span.x0, 0, span.x1 - span.x0, HEIGHT);
    ctx.clip();

    this._drawGlow(
      unlocked ? this._glows.teal : this._glows.warm,
      sp.sx,
      base - h * 0.5,
      Math.max(w * 2.6, h * 1.2),
      alpha * 0.55,
    );

    ctx.strokeStyle = `rgba(${col},${alpha.toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sp.sx - w / 2, top, w, h);
    if (w > 6 && h > 8) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${col},${(alpha * 0.55).toFixed(3)})`;
      ctx.strokeRect(sp.sx - w / 2 + 2, top + 2, w - 4, h - 4);
    }

    // 門楣與地面門檻
    ctx.strokeStyle = `rgba(${col},${(alpha * 0.8).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(sp.sx - w * 0.62, top);
    ctx.lineTo(sp.sx + w * 0.62, top);
    ctx.moveTo(sp.sx - w * 0.62, base);
    ctx.lineTo(sp.sx + w * 0.62, base);
    ctx.stroke();
    ctx.restore();
  }

  // ---- 祭壇（鐘形輪廓） -----------------------------------------------------

  _drawAltar(sp, time) {
    const altar = sp.data;
    const w = 0.6 * sp.scale;
    const h = 1.15 * sp.scale;
    if (w < 2 || h < 3) return;
    const span = this._visibleSpan(sp.sx, w * 0.9, sp.depth);
    if (!span) return;

    const phase = hashPhase('altar') * Math.PI * 2;
    const pulse = 0.6 + 0.4 * Math.sin(time * 1.5 + phase);
    const base = sp.floorY;
    const top = base - h;

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(span.x0, 0, span.x1 - span.x0, HEIGHT);
    ctx.clip();

    this._drawGlow(this._glows.warm, sp.sx, base - h * 0.55, Math.max(w * 3, h * 1.5), 0.22 + 0.16 * pulse);

    ctx.strokeStyle = `rgba(220,240,225,${(0.45 + 0.3 * pulse).toFixed(3)})`;
    ctx.fillStyle = 'rgba(190,220,205,0.07)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sp.sx - w * 0.5, base - h * 0.22);
    ctx.quadraticCurveTo(sp.sx - w * 0.55, top + h * 0.2, sp.sx - w * 0.22, top + h * 0.06);
    ctx.quadraticCurveTo(sp.sx, top - h * 0.02, sp.sx + w * 0.22, top + h * 0.06);
    ctx.quadraticCurveTo(sp.sx + w * 0.55, top + h * 0.2, sp.sx + w * 0.5, base - h * 0.22);
    ctx.lineTo(sp.sx + w * 0.64, base - h * 0.1);
    ctx.lineTo(sp.sx - w * 0.64, base - h * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 鐘舌
    ctx.beginPath();
    ctx.arc(sp.sx, base - h * 0.18, Math.max(1, w * 0.07), 0, Math.PI * 2);
    ctx.stroke();

    // 已完成的吼叫進度：鐘身外側短弧
    const progress = clamp(num(altar.progress), 0, 99);
    const required = Math.max(1, num(altar.requiredShouts, 1));
    const ratio = clamp(progress / required, 0, 1);
    if (ratio > 0) {
      ctx.strokeStyle = `rgba(255,120,110,${(0.5 + 0.3 * pulse).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sp.sx, base - h * 0.5, w * 0.85, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- 怪物（高瘦人形剪影） -------------------------------------------------

  _drawMonster(sp, state, time) {
    const m = sp.data;
    const h = 1.92 * sp.scale;
    const w = 0.6 * sp.scale;
    if (h < 6 || w < 2) return;

    const span = this._visibleSpan(sp.sx, w * 0.75, sp.depth);
    if (!span) return;

    const stunned = m.stunned === true || m.state === 'stunned';
    const danger = clamp(num(m.danger), 0, 1);
    const close = clamp(1 - sp.depth / 8, 0, 1);
    const flicker = this.reducedMotion
      ? 1
      : 0.7 + 0.3 * Math.sin(time * 24 + sp.depth * 3.1);
    const alpha = clamp((0.3 + danger * 0.55 + close * 0.2) * (stunned ? 1 : flicker), 0, 0.98);

    const base = sp.floorY;
    const headR = h * 0.085;
    const headY = base - h + headR * 1.15;
    const sway = this.reducedMotion ? 0 : Math.sin(time * 1.6 + sp.depth) * w * 0.05;
    const j = (i) => (this.reducedMotion ? 0 : Math.sin(time * 11 + i * 2.17) * w * 0.025);

    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(span.x0, 0, span.x1 - span.x0, HEIGHT);
    ctx.clip();

    if (!stunned && danger > 0.25) {
      this._drawGlow(this._glows.red, sp.sx, base - h * 0.55, h * 1.1, danger * 0.16);
    }

    // 高瘦、不規則邊緣的人形。
    ctx.beginPath();
    ctx.moveTo(sp.sx + sway, headY - headR);
    ctx.quadraticCurveTo(
      sp.sx + w * 0.16 + sway,
      headY - headR * 0.55,
      sp.sx + w * 0.13 + sway,
      headY + headR * 0.85,
    );
    ctx.lineTo(sp.sx + w * 0.4 + j(1), base - h * 0.7);
    ctx.lineTo(sp.sx + w * 0.58 + j(2), base - h * 0.48);
    ctx.lineTo(sp.sx + w * 0.52 + j(3), base - h * 0.26);
    ctx.lineTo(sp.sx + w * 0.38 + j(4), base - h * 0.42);
    ctx.lineTo(sp.sx + w * 0.3 + j(5), base - h * 0.17);
    ctx.lineTo(sp.sx + w * 0.25 + j(6), base);
    ctx.lineTo(sp.sx + w * 0.07 + j(7), base);
    ctx.lineTo(sp.sx - w * 0.09 + j(8), base);
    ctx.lineTo(sp.sx - w * 0.24 + j(9), base - h * 0.15);
    ctx.lineTo(sp.sx - w * 0.3 + j(10), base - h * 0.44);
    ctx.lineTo(sp.sx - w * 0.53 + j(11), base - h * 0.3);
    ctx.lineTo(sp.sx - w * 0.6 + j(12), base - h * 0.5);
    ctx.lineTo(sp.sx - w * 0.39 + j(13), base - h * 0.72);
    ctx.lineTo(sp.sx - w * 0.13 + sway, headY + headR * 0.85);
    ctx.quadraticCurveTo(
      sp.sx - w * 0.16 + sway,
      headY - headR * 0.55,
      sp.sx + sway,
      headY - headR,
    );
    ctx.closePath();

    if (stunned) {
      // 被震退：反白、靜止。
      ctx.fillStyle = 'rgba(224,246,246,0.88)';
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    } else {
      ctx.fillStyle = 'rgba(2,5,7,0.94)';
      const rim = danger > 0.55 ? '255,92,110' : '138,226,214';
      ctx.strokeStyle = `rgba(${rim},${alpha.toFixed(3)})`;
    }
    ctx.fill();
    ctx.lineWidth = sp.depth < 3 ? 1.6 : 1.1;
    ctx.stroke();

    if (!stunned) {
      // 體內微弱縱線，讓剪影在近距離仍可辨識。
      ctx.strokeStyle = `rgba(130,210,200,${(alpha * 0.28).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sp.sx, headY + headR);
      ctx.lineTo(sp.sx + w * 0.02, base - h * 0.2);
      ctx.stroke();
    }

    // 頭部輪廓（略微不規則）
    ctx.strokeStyle = stunned
      ? 'rgba(255,255,255,0.9)'
      : `rgba(150,232,220,${(alpha * 0.75).toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(
      sp.sx + sway,
      headY,
      headR * 0.9,
      headR * 1.12,
      this.reducedMotion ? 0 : Math.sin(time * 1.2) * 0.12,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 後處理
  // -------------------------------------------------------------------------

  /**
   * @param {object} state
   * @param {number} time
   * @param {number} volume
   */
  _drawPost(state, time, volume) {
    const ctx = this.ctx;
    const danger = clamp(num(state.danger), 0, 1);

    // 掃描線
    if (this._scanPattern) {
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = this._scanPattern;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.globalAlpha = 1;
    }

    // 顆粒雜訊：預生成 noise canvas，以隨機位移貼上。
    if (this._noisePattern) {
      const ox = (Math.random() * 128) | 0;
      const oy = (Math.random() * 128) | 0;
      ctx.save();
      ctx.globalAlpha = 0.035 + (volume / 100) * 0.025;
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(-ox, -oy);
      ctx.fillStyle = this._noisePattern;
      ctx.fillRect(0, 0, WIDTH + 128, HEIGHT + 128);
      ctx.restore();
    }

    // 暗角
    if (this._vignette) ctx.drawImage(this._vignette, 0, 0);

    // 危險：紅色邊緣＋輕微色偏／撕裂
    if (danger > 0.01) {
      if (this._dangerVignette) {
        ctx.globalAlpha = clamp(danger * 0.7, 0, 0.75);
        ctx.drawImage(this._dangerVignette, 0, 0);
        ctx.globalAlpha = 1;
      }
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = `rgba(255,18,46,${(0.03 * danger).toFixed(3)})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = `rgba(0,210,230,${(0.02 * danger).toFixed(3)})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.restore();

      if (!this.reducedMotion && danger > 0.45 && Math.random() < danger * 0.35) {
        this._tear(danger);
      }
    }

    // 喘氣：畫面邊緣短暫泛紅
    const breath = state.breath;
    if (breath && breath.state === 'gasp') {
      const pulse = 0.5 + 0.5 * Math.sin(time * 7);
      ctx.globalAlpha = 0.18 + 0.18 * pulse;
      if (this._dangerVignette) ctx.drawImage(this._dangerVignette, 0, 0);
      ctx.globalAlpha = 1;
    }

    // 死亡：畫面轉黑，只留心跳般的紅光
    if (state.status === 'dead') {
      const pulse = 0.5 + 0.5 * Math.sin(time * 5);
      ctx.fillStyle = `rgba(0,0,0,${(0.55 + 0.12 * pulse).toFixed(3)})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      if (this._dangerVignette) {
        ctx.globalAlpha = 0.35 + 0.25 * pulse;
        ctx.drawImage(this._dangerVignette, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
  }

  /**
   * 危險時的輕微水平撕裂（直接從 canvas 自身取樣，成本低且次數有限）。
   * @param {number} danger
   */
  _tear(danger) {
    const ctx = this.ctx;
    const count = 1 + ((Math.random() * 3) | 0);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < count; i++) {
      const sy = (Math.random() * HEIGHT) | 0;
      const sh = 2 + ((Math.random() * 9) | 0);
      const off = (Math.random() * 2 - 1) * 7 * danger;
      ctx.drawImage(this.canvas, 0, sy, WIDTH, sh, off, sy, WIDTH, sh);
    }
    ctx.restore();
  }
}
