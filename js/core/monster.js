// 《勿聲》HUSH — 聽者 AI（純邏輯，禁止 DOM）
// 盲眼，只追聲音：持續聲源（玩家）＋地面聲紋。BFS 尋路，直線可走時走直線。
import { MONSTER } from './config.js';
import { findPath, isWalkable } from './levels.js';

const EPS = 1e-6;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * 圓形是否能在 (x,y) 站立。
 * 以格子包圍盒逐一檢查，取圓心到格子的最近點距離。
 */
function canOccupy(level, x, y, radius, doorsOpen) {
  if (!level) return false;
  const minX = Math.floor(x - radius);
  const maxX = Math.floor(x + radius);
  const minY = Math.floor(y - radius);
  const maxY = Math.floor(y + radius);
  const r2 = radius * radius;
  for (let cy = minY; cy <= maxY; cy += 1) {
    for (let cx = minX; cx <= maxX; cx += 1) {
      if (isWalkable(level, cx + 0.5, cy + 0.5, { doorsOpen })) continue;
      const nx = clamp(x, cx, cx + 1);
      const ny = clamp(y, cy, cy + 1);
      const dx = x - nx;
      const dy = y - ny;
      if (dx * dx + dy * dy < r2) return false;
    }
  }
  return true;
}

/** 直線是否可走（取樣，避免依賴 raycast 模組）。 */
function clearLine(level, x1, y1, x2, y2, radius, doorsOpen) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < EPS) return true;
  const steps = Math.max(2, Math.ceil(dist / 0.2));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    if (!canOccupy(level, x1 + dx * t, y1 + dy * t, radius, doorsOpen)) return false;
  }
  return true;
}

/** 從聲紋中挑「最新且強」的一個；超出聽覺範圍者忽略。 */
function pickTrail(trails, x, y, range) {
  if (!Array.isArray(trails) || !trails.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const t of trails) {
    if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
    const ttl = t.ttl || 0;
    const age = t.age || 0;
    if (ttl <= 0 || age >= ttl) continue;
    const intensity = clamp(t.intensity ?? 0.5, 0, 1);
    if (intensity <= 0.05) continue;
    const d = distance(x, y, t.x, t.y);
    // 強度越高，能吸引的距離越遠。
    const effectiveRange = range * (0.55 + 0.65 * intensity);
    if (d > effectiveRange) continue;
    const remaining = 1 - age / ttl;
    const score = intensity * 2 + remaining * 1.5 - d * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

export class Listener {
  constructor(spawn = { x: 0, y: 0 }, opts = {}) {
    this.rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    this.spawn = { x: spawn.x, y: spawn.y };
    this.x = spawn.x;
    this.y = spawn.y;
    this.state = 'idle';
    this.target = null;
    this.path = [];
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.stunRemaining = 0;
    this.stunCooldown = 0;
    this.lostTimer = 0;
    this.wanderTimer = 0;
    this.wanderPoint = null;
    this.speedScale = typeof opts.speedScale === 'number' ? opts.speedScale : 1;
    this.stunCount = 0;
    this.lastSeenAt = 0;
    this.age = 0;
  }

  reset(spawn) {
    if (spawn && Number.isFinite(spawn.x) && Number.isFinite(spawn.y)) {
      this.spawn = { x: spawn.x, y: spawn.y };
    }
    this.x = this.spawn.x;
    this.y = this.spawn.y;
    this.state = 'idle';
    this.target = null;
    this.path = [];
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.stunRemaining = 0;
    this.stunCooldown = 0;
    this.lostTimer = 0;
    this.wanderTimer = 0;
    this.wanderPoint = null;
  }

  get radius() {
    return MONSTER.radius;
  }

  get stunned() {
    return this.state === 'stunned';
  }

  /** @returns {{stunned:boolean, kill:boolean}} */
  update(dt, ctx = {}) {
    const step = clamp(Number(dt) || 0, 0, 0.1);
    const result = { stunned: false, kill: false };
    if (step <= 0) return result;

    const level = ctx.level;
    if (!level) return result;

    this.age += step;
    const player = ctx.player || null;
    const volume = clamp(Number(ctx.volume) || 0, 0, 100);
    const hearing = Number.isFinite(ctx.hearing) ? ctx.hearing : 1;
    const waterMul = ctx.water ? 1.5 : 1;
    const doorsOpen = level.doorsOpen !== undefined ? level.doorsOpen : true;
    const bossMul = ctx.boss ? 1.12 : 1;
    const toPlayer = player ? distance(this.x, this.y, player.x, player.y) : Infinity;

    this.stunCooldown = Math.max(0, this.stunCooldown - step);

    // 1) 被震退：不聽、不動。
    if (this.state === 'stunned') {
      this.stunRemaining = Math.max(0, this.stunRemaining - step);
      if (this.stunRemaining <= 0) {
        this.state = 'returning';
        this.target = { x: this.spawn.x, y: this.spawn.y };
        this.path = [];
        this.pathIndex = 0;
        this.lostTimer = 0;
      }
      return result;
    }

    // 2) 尖叫震退（距離夠近、冷卻結束）。
    if (volume >= 86 && toPlayer <= MONSTER.stunRange && this.stunCooldown <= 0) {
      this.state = 'stunned';
      this.stunRemaining = MONSTER.stunDuration;
      this.stunCooldown = MONSTER.stunCooldown;
      this.stunCount += 1;
      this.target = null;
      this.path = [];
      this.pathIndex = 0;
      this.lostTimer = 0;
      result.stunned = true;
      return result;
    }

    // 3) 聽覺：持續聲源優先。
    const hearRange = MONSTER.hearingBase * hearing * (0.35 + volume / 100) * waterMul;
    let heardPlayer = false;
    if (volume >= 21 && player && toPlayer <= hearRange) {
      heardPlayer = true;
      this.state = 'chase';
      this.target = { x: player.x, y: player.y };
      this.lostTimer = 0;
    } else {
      const trail = pickTrail(ctx.trails, this.x, this.y, hearRange);
      if (trail) {
        this.state = 'investigate';
        this.target = { x: trail.x, y: trail.y };
        this.lostTimer = 0;
      } else if (this.state === 'chase' || this.state === 'investigate') {
        // 失去目標後仍朝最後位置前進，4 秒後返回出生點。
        this.lostTimer += step;
        if (this.lostTimer >= MONSTER.loseTrailTime) {
          this.state = 'returning';
          this.target = { x: this.spawn.x, y: this.spawn.y };
          this.path = [];
          this.pathIndex = 0;
          this.lostTimer = 0;
        }
      }
    }

    // 4) 狀態各自的速度與目標。
    let speed = MONSTER.speedIdle;
    if (this.state === 'chase') {
      speed = MONSTER.speedChase;
    } else if (this.state === 'investigate') {
      speed = MONSTER.speedInvestigate;
    } else if (this.state === 'returning') {
      speed = MONSTER.speedInvestigate;
      this.target = { x: this.spawn.x, y: this.spawn.y };
    } else if (this.state === 'idle') {
      speed = MONSTER.speedIdle;
      this.updateWander(step, level, doorsOpen);
    }
    speed *= this.speedScale * bossMul;

    // 5) 移動。
    if (this.target) {
      const d = distance(this.x, this.y, this.target.x, this.target.y);
      const arriveRadius = this.state === 'idle' ? 0.35 : this.state === 'returning' ? 0.7 : 0.45;
      if (d <= arriveRadius) {
        if (this.state === 'returning') {
          this.state = 'idle';
          this.target = null;
          this.path = [];
          this.pathIndex = 0;
          this.wanderTimer = 0;
        } else if (this.state === 'idle') {
          this.target = null;
          this.wanderPoint = null;
          this.wanderTimer = 0.4 + this.rng() * 1.4;
        } else if (this.state === 'investigate') {
          // 抵達聲源後停下來聽一會，再返回。
          this.state = 'returning';
          this.target = { x: this.spawn.x, y: this.spawn.y };
          this.path = [];
          this.pathIndex = 0;
        }
      } else {
        this.repathTimer -= step;
        const straight = clearLine(level, this.x, this.y, this.target.x, this.target.y, MONSTER.radius, doorsOpen);
        if (straight) {
          this.path = [];
          this.pathIndex = 0;
          this.moveToward(level, this.target.x, this.target.y, speed * step, doorsOpen);
        } else {
          if (this.repathTimer <= 0 || !this.path.length) {
            this.repathTimer = MONSTER.pathInterval;
            this.path = findPath(
              level,
              { x: this.x, y: this.y },
              { x: this.target.x, y: this.target.y },
              { doorsOpen },
            );
            this.pathIndex = 0;
          }
          if (this.path.length) {
            let wp = this.path[this.pathIndex];
            while (wp && distance(this.x, this.y, wp.x, wp.y) < 0.24) {
              this.pathIndex += 1;
              wp = this.path[this.pathIndex];
            }
            if (wp) {
              const canSee = clearLine(level, this.x, this.y, wp.x, wp.y, MONSTER.radius, doorsOpen);
              if (canSee) this.moveToward(level, wp.x, wp.y, speed * step, doorsOpen);
            }
          }
        }
      }
    }

    // 6) 接觸玩家。
    if (player) {
      const d = distance(this.x, this.y, player.x, player.y);
      if (d <= MONSTER.contactRadius) {
        result.kill = true;
        if (typeof ctx.onKill === 'function') ctx.onKill();
      }
    }

    return result;
  }

  updateWander(dt, level, doorsOpen) {
    this.wanderTimer -= dt;
    if (this.target && this.wanderPoint) return;
    if (this.wanderTimer > 0) return;

    for (let attempt = 0; attempt < 14; attempt += 1) {
      const angle = this.rng() * Math.PI * 2;
      const radius = 0.6 + this.rng() * MONSTER.wanderRadius;
      const tx = this.spawn.x + Math.cos(angle) * radius;
      const ty = this.spawn.y + Math.sin(angle) * radius;
      if (isWalkable(level, tx, ty, { doorsOpen })) {
        this.wanderPoint = { x: tx, y: ty };
        this.target = { x: tx, y: ty };
        this.path = [];
        this.pathIndex = 0;
        this.repathTimer = 0;
        return;
      }
    }
    this.wanderTimer = 1 + this.rng() * 1.5;
  }

  moveToward(level, tx, ty, stepLength, doorsOpen) {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < EPS || stepLength <= 0) return;
    const step = Math.min(stepLength, dist);
    const ux = dx / dist;
    const uy = dy / dist;

    const nx = this.x + ux * step;
    if (canOccupy(level, nx, this.y, MONSTER.radius, doorsOpen)) this.x = nx;

    const ny = this.y + uy * step;
    if (canOccupy(level, this.x, ny, MONSTER.radius, doorsOpen)) this.y = ny;
  }
}
