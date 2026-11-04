// 《勿聲》HUSH — 射線投射（純邏輯，不依賴 DOM）
// DDA 網格行進，供 renderer 畫牆與 AI/互動判斷視線。
//
// 重要：castRay 回傳的 dist 是「相機平面垂直距離」。
// renderer 以 dir + plane*cameraX（未正規化）產生射線，標準公式
//   dist = (mapX - ox + (1 - stepX) / 2) / rayDirX
// 即為垂直距離，可直接做魚眼修正與 zBuffer 比較。
// 若呼叫端傳入已正規化的射線，dist 則等同歐氏距離。

const MISS_TILE = null;

/**
 * 取得地圖字元。優先使用 level.tileAt，否則退回 level.grid。
 * @param {object} level
 * @param {number} x 世界座標
 * @param {number} y
 * @returns {string|null}
 */
function readTile(level, x, y) {
  if (!level) return null;
  if (typeof level.tileAt === 'function') {
    const t = level.tileAt(x, y);
    return typeof t === 'string' ? t : null;
  }
  const grid = level.grid;
  if (!Array.isArray(grid)) return null;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const row = grid[cy];
  if (!row) return null;
  const t = row[cx];
  return typeof t === 'string' ? t : null;
}

/**
 * 取得地圖尺寸（允許 level 只提供 grid）。
 * @param {object} level
 * @returns {{width:number,height:number}}
 */
function readSize(level) {
  let width = Number(level.width);
  let height = Number(level.height);
  if (!Number.isFinite(width) || width <= 0) {
    const grid = level.grid;
    width = Array.isArray(grid) && grid[0] ? grid[0].length : 0;
  }
  if (!Number.isFinite(height) || height <= 0) {
    const grid = level.grid;
    height = Array.isArray(grid) ? grid.length : 0;
  }
  return { width, height };
}

/**
 * 門是否開啟（與 player.js 採相同語意）。
 * @param {object} level
 * @param {number} cx
 * @param {number} cy
 * @returns {boolean}
 */
function doorOpen(level, cx, cy) {
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
    if (Math.floor(Number(d.x)) === cx && Math.floor(Number(d.y)) === cy) {
      if (d.open === true || d.unlocked === true || d.isOpen === true) return true;
    }
  }
  return false;
}

/** 已知可通行字元（不呼叫 level.isSolid，避免語意衝突與額外開銷）。 */
const PASSABLE = '.~ESQIMA';

/**
 * 單格是否為實體（牆、柱、關閉的門）。越界視為實體。
 * @param {object} level
 * @param {number} cx 整數格座標
 * @param {number} cy
 * @param {number} width
 * @param {number} height
 * @param {string|null} [tile] 已知字元（可省略）
 * @returns {boolean}
 */
function solidCell(level, cx, cy, width, height, tile) {
  if (cx < 0 || cy < 0 || cx >= width || cy >= height) return true;

  let t = tile;
  if (t === undefined) t = readTile(level, cx + 0.5, cy + 0.5);
  if (t === null || t === undefined) {
    if (typeof level.isSolid === 'function') {
      try {
        return !!level.isSolid(cx + 0.5, cy + 0.5);
      } catch {
        return true;
      }
    }
    return true;
  }
  if (t === '#' || t === 'P') return true;
  if (t === 'D') return !doorOpen(level, cx, cy);
  if (typeof t === 'string' && t.length === 1 && PASSABLE.includes(t)) return false;

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
 * 以 DDA 投射單條射線。
 *
 * @param {object} level 需有 width/height/tileAt（或 grid）與選配 isSolid/doors
 * @param {number} ox 射線起點 x
 * @param {number} oy 射線起點 y
 * @param {number} rayDirX 射線方向 x（可未正規化；renderer 會傳 dir+plane*cameraX）
 * @param {number} rayDirY 射線方向 y
 * @param {number} [maxDist=32] 最大行進距離（世界單位）
 * @returns {{dist:number,tile:string|null,side:number,mapX:number,mapY:number,hit:boolean}}
 *   dist 為相機平面垂直距離；未命中時 dist = maxDist、tile = null、hit = false。
 */
export function castRay(level, ox, oy, rayDirX, rayDirY, maxDist = 32) {
  const miss = {
    dist: Number.isFinite(maxDist) && maxDist > 0 ? maxDist : 0,
    tile: MISS_TILE,
    side: 0,
    mapX: -1,
    mapY: -1,
    hit: false,
  };

  if (!level) return miss;
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) return miss;
  if (!Number.isFinite(rayDirX) || !Number.isFinite(rayDirY)) return miss;

  const rayLen = Math.hypot(rayDirX, rayDirY);
  if (rayLen < 1e-9) return miss; // 零向量：直接視為未命中，避免無限迴圈
  if (!Number.isFinite(maxDist) || maxDist <= 0) return miss;

  const { width, height } = readSize(level);
  if (width <= 0 || height <= 0) return miss;

  // 起點必須在地圖內
  let mapX = Math.floor(ox);
  let mapY = Math.floor(oy);
  if (mapX < 0 || mapY < 0 || mapX >= width || mapY >= height) {
    miss.mapX = mapX;
    miss.mapY = mapY;
    return miss;
  }

  // 以正規化方向計算「沿射線前進的歐氏距離」，用來判斷 maxDist；
  // 但回傳的 dist 仍以原始 rayDir 計算，保留垂直距離語意。
  const ndx = rayDirX / rayLen;
  const ndy = rayDirY / rayLen;

  const stepX = ndx < 0 ? -1 : 1;
  const stepY = ndy < 0 ? -1 : 1;

  const deltaX = ndx === 0 ? Infinity : Math.abs(1 / ndx);
  const deltaY = ndy === 0 ? Infinity : Math.abs(1 / ndy);

  let sideDistX =
    ndx === 0
      ? Infinity
      : ndx < 0
        ? (ox - mapX) * deltaX
        : (mapX + 1 - ox) * deltaX;
  let sideDistY =
    ndy === 0
      ? Infinity
      : ndy < 0
        ? (oy - mapY) * deltaY
        : (mapY + 1 - oy) * deltaY;

  // 安全上限：最長對角線走訪格數 + 緩衝，杜絕任何浮點意外造成的無限迴圈。
  const maxSteps = (width + height) * 4 + 16;
  let side = 0;
  let traveled = 0;
  let steps = 0;

  while (steps++ < maxSteps) {
    if (sideDistX < sideDistY) {
      traveled = sideDistX;
      sideDistX += deltaX;
      mapX += stepX;
      side = 0;
    } else {
      traveled = sideDistY;
      sideDistY += deltaY;
      mapY += stepY;
      side = 1;
    }

    if (!Number.isFinite(traveled) || traveled > maxDist) break;
    if (mapX < 0 || mapY < 0 || mapX >= width || mapY >= height) break;

    const tile = readTile(level, mapX + 0.5, mapY + 0.5);
    if (solidCell(level, mapX, mapY, width, height, tile)) {
      // 垂直於相機平面的距離（未正規化 rayDir 版本）
      let dist;
      if (side === 0) {
        dist = rayDirX === 0 ? Infinity : (mapX - ox + (1 - stepX) / 2) / rayDirX;
      } else {
        dist = rayDirY === 0 ? Infinity : (mapY - oy + (1 - stepY) / 2) / rayDirY;
      }
      if (!Number.isFinite(dist)) dist = traveled;
      if (dist < 0) dist = 0;

      return {
        dist,
        tile: typeof tile === 'string' ? tile : '#',
        side,
        mapX,
        mapY,
        hit: true,
      };
    }
  }

  miss.mapX = mapX;
  miss.mapY = mapY;
  return miss;
}

/**
 * 兩點之間是否有視線（牆／柱／關閉的門會阻擋）。
 * 以固定步長取樣，越界視為阻擋。
 *
 * @param {object} level
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {boolean}
 */
export function hasLineOfSight(level, x1, y1, x2, y2) {
  if (!level) return false;
  if (![x1, y1, x2, y2].every(Number.isFinite)) return false;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return true;

  const { width, height } = readSize(level);
  if (width <= 0 || height <= 0) return false;

  // 0.05 世界單位 ≈ 每格 20 個樣本，足夠避免穿過 1 格厚的牆。
  const steps = Math.min(8192, Math.max(1, Math.ceil(dist / 0.05)));
  const sx = dx / steps;
  const sy = dy / steps;

  // 起點若已在實體格內（理論上不會），先視為無視線。
  const startTile = readTile(level, x1, y1);
  if (solidCell(level, Math.floor(x1), Math.floor(y1), width, height, startTile)) {
    return false;
  }

  for (let i = 1; i <= steps; i++) {
    const x = x1 + sx * i;
    const y = y1 + sy * i;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return false;
    const tile = readTile(level, cx + 0.5, cy + 0.5);
    if (solidCell(level, cx, cy, width, height, tile)) return false;
  }

  return true;
}
