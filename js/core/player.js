// 《勿聲》HUSH — 玩家移動（純邏輯，不依賴 DOM）
// 座標：x 向右、y 向下，1 格 = 1 世界單位；角度 0 指向 +x，順時針為正。
// 碰撞採「圓形近似 AABB + X/Y 分軸移動」，可沿牆滑動。

import { PLAYER } from './config.js';

const TWO_PI = Math.PI * 2;
/** 內部移動時的最大單步長度（世界單位），避免高速穿過格子邊角。 */
const MAX_STEP = 0.08;
/** dt 上限（與 session 的 clamp 一致，避免分頁切回時暴衝）。 */
const MAX_DT = 0.1;

/**
 * 將角度正規化到 (-π, π]，避免長時間旋轉累積浮點誤差。
 * @param {number} a
 * @returns {number}
 */
function normalizeAngle(a) {
  if (!Number.isFinite(a)) return 0;
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r <= -Math.PI) r += TWO_PI;
  return r;
}

/**
 * 玩家角色。只處理移動、轉向、碰撞；不碰任何瀏覽器 API。
 */
export class Player {
  /**
   * @param {number} x 初始 x（世界座標，格中心為 x+0.5）
   * @param {number} y 初始 y
   * @param {number} angle 初始面向（弧度）
   */
  constructor(x = 0.5, y = 0.5, angle = 0) {
    this._x = Number.isFinite(x) ? x : 0.5;
    this._y = Number.isFinite(y) ? y : 0.5;
    this._angle = normalizeAngle(Number.isFinite(angle) ? angle : 0);
  }

  /** @returns {number} */
  get x() {
    return this._x;
  }

  /** @returns {number} */
  get y() {
    return this._y;
  }

  /** @returns {number} */
  get angle() {
    return this._angle;
  }

  /**
   * 立即傳送到指定位置（重生／換章用）。
   * @param {number} x
   * @param {number} y
   * @param {number} [angle] 省略時保留目前角度
   */
  teleport(x, y, angle) {
    if (Number.isFinite(x)) this._x = x;
    if (Number.isFinite(y)) this._y = y;
    if (Number.isFinite(angle)) this._angle = normalizeAngle(angle);
  }

  /**
   * 推進一幀。
   * @param {number} dt 秒
   * @param {{forward?:boolean,back?:boolean,strafeLeft?:boolean,strafeRight?:boolean,turnLeft?:boolean,turnRight?:boolean,mouseDX?:number}} [input]
   * @param {object} [level] 關卡（需 width/height/tileAt/isSolid，選配 doors/grid）
   */
  update(dt, input, level) {
    const inp = input || {};
    let step = Number.isFinite(dt) ? dt : 0;
    if (step < 0) step = 0;
    if (step > MAX_DT) step = MAX_DT;

    // ---- 轉向：滑鼠優先疊加，鍵盤以 turnSpeed 旋轉 ----
    const mouseDX = Number(inp.mouseDX);
    if (Number.isFinite(mouseDX) && mouseDX !== 0) {
      this._angle += mouseDX * PLAYER.mouseSensitivity;
    }
    let turn = 0;
    if (inp.turnLeft) turn -= 1;
    if (inp.turnRight) turn += 1;
    if (turn !== 0) this._angle += turn * PLAYER.turnSpeed * step;
    this._angle = normalizeAngle(this._angle);

    if (step <= 0) return;

    // ---- 移動方向（世界座標） ----
    const cos = Math.cos(this._angle);
    const sin = Math.sin(this._angle);
    let mx = 0;
    let my = 0;
    if (inp.forward) {
      mx += cos;
      my += sin;
    }
    if (inp.back) {
      mx -= cos;
      my -= sin;
    }
    // 右向量 = dir 旋轉 +90°（y 向下座標） = (-sin, cos)
    if (inp.strafeRight) {
      mx += -sin;
      my += cos;
    }
    if (inp.strafeLeft) {
      mx += sin;
      my += -cos;
    }

    const len = Math.hypot(mx, my);
    if (len < 1e-9) return;

    // 對角移動正規化，避免斜走更快
    mx /= len;
    my /= len;

    let speed = PLAYER.speed;
    if (this._inWater(level, this._x, this._y)) speed *= 0.75;

    const totalX = mx * speed * step;
    const totalY = my * speed * step;
    const totalLen = Math.hypot(totalX, totalY);
    const subSteps = Math.max(1, Math.ceil(totalLen / MAX_STEP));
    const stepX = totalX / subSteps;
    const stepY = totalY / subSteps;

    // X/Y 分開嘗試：撞牆時只損失該軸，另一軸仍可滑動。
    for (let i = 0; i < subSteps; i++) {
      if (stepX !== 0) {
        const nx = this._x + stepX;
        if (!this._blocked(level, nx, this._y)) this._x = nx;
      }
      if (stepY !== 0) {
        const ny = this._y + stepY;
        if (!this._blocked(level, this._x, ny)) this._y = ny;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 碰撞
  // ---------------------------------------------------------------------------

  /**
   * 以玩家半徑檢查某位置是否與實體格重疊。
   * @param {object|null} level
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  _blocked(level, x, y) {
    if (!level) return false;
    const r = PLAYER.radius;
    const minCX = Math.floor(x - r);
    const maxCX = Math.floor(x + r);
    const minCY = Math.floor(y - r);
    const maxCY = Math.floor(y + r);

    const width = Number.isFinite(level.width)
      ? level.width
      : Array.isArray(level.grid) && level.grid[0]
        ? level.grid[0].length
        : Infinity;
    const height = Number.isFinite(level.height)
      ? level.height
      : Array.isArray(level.grid)
        ? level.grid.length
        : Infinity;

    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        if (cx < 0 || cy < 0 || cx >= width || cy >= height) return true;
        if (this._solidTile(level, cx, cy)) return true;
      }
    }
    return false;
  }

  /**
   * 單格是否阻擋玩家。優先看地圖字元，其次才詢問 level.isSolid。
   * 門（D）只有在 doors 標記 open/unlocked 時可通行。
   * @param {object} level
   * @param {number} cx 格座標（整數）
   * @param {number} cy
   * @returns {boolean}
   */
  _solidTile(level, cx, cy) {
    let tile = null;
    if (typeof level.tileAt === 'function') {
      tile = level.tileAt(cx + 0.5, cy + 0.5);
    } else if (Array.isArray(level.grid) && level.grid[cy]) {
      tile = level.grid[cy][cx];
    }

    if (tile === '#' || tile === 'P') return true;
    if (tile === 'D') return !this._doorOpen(level, cx, cy);

    // 已知可通行字元：不再呼叫 isSolid，避免重複判定（也避開門的語意衝突）。
    if (typeof tile === 'string' && tile.length === 1 && '.~ESQIMA'.includes(tile)) {
      return false;
    }

    if (typeof level.isSolid === 'function') {
      try {
        return !!level.isSolid(cx + 0.5, cy + 0.5);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * 查詢門是否已開啟。
   * @param {object} level
   * @param {number} cx
   * @param {number} cy
   * @returns {boolean}
   */
  _doorOpen(level, cx, cy) {
    if (typeof level.isDoorOpen === 'function') {
      try {
        if (level.isDoorOpen(cx, cy)) return true;
      } catch {
        /* 忽略，改用 doors 陣列 */
      }
    }
    const doors = level.doors;
    if (!Array.isArray(doors)) return false;
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      if (!d) continue;
      const dx = Math.floor(Number(d.x));
      const dy = Math.floor(Number(d.y));
      if (dx === cx && dy === cy) {
        if (d.open === true || d.unlocked === true || d.isOpen === true) return true;
      }
    }
    return false;
  }

  /**
   * 玩家所在格是否為積水（'~'）。水區移動速度 ×0.75。
   * @param {object|null} level
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  _inWater(level, x, y) {
    if (!level) return false;
    if (typeof level.isWater === 'function') {
      try {
        if (level.isWater(x, y)) return true;
      } catch {
        /* 忽略，改用地圖字元 */
      }
    }
    let tile = null;
    if (typeof level.tileAt === 'function') {
      tile = level.tileAt(x, y);
    } else if (Array.isArray(level.grid)) {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      const row = level.grid[cy];
      tile = row ? row[cx] : null;
    }
    return tile === '~';
  }
}
