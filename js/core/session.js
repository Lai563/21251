// 《勿聲》HUSH — GameSession 整合核心（純邏輯，禁止 DOM）
// 依 docs/architecture.md §5.8 實作：氣息、聲紋、玩家、互動、怪物、死亡與章節流程。
import { getBand, BREATH, TRAIL, PLAYER, INTERACTION } from './config.js';
import { getChapter, isWalkable, tileAt } from './levels.js';
import { Listener } from './monster.js';

// 瀏覽器層與 E1／E2 模組可能尚未就緒；以動態 import 取得，失敗時使用內建後備實作。
let PlayerCtor = null;
let BreathCtor = null;
let TrailCtor = null;
try {
  const mod = await import('./player.js');
  if (typeof mod.Player === 'function') PlayerCtor = mod.Player;
} catch {
  PlayerCtor = null;
}
try {
  const mod = await import('./breath.js');
  if (typeof mod.BreathModel === 'function') BreathCtor = mod.BreathModel;
} catch {
  BreathCtor = null;
}
try {
  const mod = await import('./trail.js');
  if (typeof mod.TrailSystem === 'function') TrailCtor = mod.TrailSystem;
} catch {
  TrailCtor = null;
}

export const SessionStatus = Object.freeze({
  PLAYING: 'playing',
  DEAD: 'dead',
  COMPLETE: 'complete',
});

export function mulberry32(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function canOccupy(level, x, y, radius, doorsOpen) {
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

/** 後備玩家：與 core/player.js 同介面，確保 E2 尚未完成時仍可遊玩。 */
class FallbackPlayer {
  constructor(x = 0, y = 0, angle = 0) {
    this.x = x;
    this.y = y;
    this.angle = angle;
  }

  update(dt, input = {}, level) {
    const turn = (input.turnRight ? 1 : 0) - (input.turnLeft ? 1 : 0);
    this.angle += turn * PLAYER.turnSpeed * dt;
    this.angle += (Number(input.mouseDX) || 0) * PLAYER.mouseSensitivity;

    let forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    let strafe = (input.strafeRight ? 1 : 0) - (input.strafeLeft ? 1 : 0);
    if (!forward && !strafe) return;
    const len = Math.hypot(forward, strafe) || 1;
    forward /= len;
    strafe /= len;

    let speed = PLAYER.speed;
    if (tileAt(level, this.x, this.y) === '~') speed *= 0.75;
    const doorsOpen = level && level.doorsOpen !== undefined ? level.doorsOpen : true;
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const dx = (cos * forward + Math.cos(this.angle + Math.PI / 2) * strafe) * speed * dt;
    const dy = (sin * forward + Math.sin(this.angle + Math.PI / 2) * strafe) * speed * dt;

    if (canOccupy(level, this.x + dx, this.y, PLAYER.radius, doorsOpen)) this.x += dx;
    if (canOccupy(level, this.x, this.y + dy, PLAYER.radius, doorsOpen)) this.y += dy;
  }

  teleport(x, y, angle) {
    if (Number.isFinite(x)) this.x = x;
    if (Number.isFinite(y)) this.y = y;
    if (Number.isFinite(angle)) this.angle = angle;
  }
}

/** 後備氣息模型：與 core/breath.js 同介面。 */
class FallbackBreath {
  constructor() {
    this.reset();
  }

  reset() {
    this._value = BREATH.max;
    this.state = 'normal';
    this.gaspRemaining = 0;
  }

  get value() {
    return this._value;
  }

  set value(v) {
    this._value = clamp(Number(v) || 0, 0, BREATH.max);
  }

  update(dt, volume) {
    let startedGasp = false;
    let endedGasp = false;

    if (this.state === 'gasp') {
      this.gaspRemaining = Math.max(0, this.gaspRemaining - dt);
      this._value = 0;
      if (this.gaspRemaining <= 0) {
        this.state = 'normal';
        this._value = BREATH.afterGasp;
        endedGasp = true;
      }
      return { value: this._value, state: this.state, gaspRemaining: this.gaspRemaining, startedGasp, endedGasp };
    }

    const band = getBand(volume);
    const drain = BREATH.drain[band.id] ?? 0;
    if (drain < 0) {
      this._value = Math.min(BREATH.max, this._value + -drain * dt);
    } else if (drain > 0) {
      this._value = Math.max(0, this._value - drain * dt);
    }

    if (this._value <= 0) {
      this._value = 0;
      this.state = 'gasp';
      this.gaspRemaining = BREATH.gaspDuration;
      startedGasp = true;
    }

    return { value: this._value, state: this.state, gaspRemaining: this.gaspRemaining, startedGasp, endedGasp };
  }
}

/** 後備聲紋系統：與 core/trail.js 同介面。 */
class FallbackTrail {
  constructor() {
    this.points = [];
    this.timer = 0;
  }

  update(dt, { x, y, volume, water } = {}) {
    this.timer += dt;
    for (const p of this.points) p.age += dt;
    this.points = this.points.filter((p) => p.age < p.ttl);

    if (volume >= TRAIL.minVolume && this.timer >= TRAIL.interval) {
      this.timer = 0;
      const ttl =
        (TRAIL.ttlMin + (clamp(volume, 0, 100) / 100) * (TRAIL.ttlMax - TRAIL.ttlMin)) *
        (water ? TRAIL.waterTtlMultiplier : 1);
      this.points.push({
        x,
        y,
        intensity: clamp(volume, 0, 100) / 100,
        age: 0,
        ttl,
        water: Boolean(water),
      });
      if (this.points.length > TRAIL.maxPoints) {
        this.points.splice(0, this.points.length - TRAIL.maxPoints);
      }
      return true;
    }
    return false;
  }

  getPoints() {
    return this.points.map((p) => ({ ...p }));
  }

  newest() {
    return this.points.length ? { ...this.points[this.points.length - 1] } : null;
  }

  clear() {
    this.points = [];
    this.timer = 0;
  }
}

export class GameSession {
  constructor(chapterIndex = 0, opts = {}) {
    this.chapterIndex = clamp(Number(chapterIndex) | 0, 0, 3);
    this.rng = typeof opts.rng === 'function' ? opts.rng : mulberry32(opts.seed ?? 0x9e3779b9);
    this.autoRespawn = opts.autoRespawn !== false;
    this._build();
  }

  _build() {
    this.chapter = getChapter(this.chapterIndex);
    this.level = this.chapter;

    const P = typeof PlayerCtor === 'function' ? PlayerCtor : FallbackPlayer;
    const B = typeof BreathCtor === 'function' ? BreathCtor : FallbackBreath;
    const T = typeof TrailCtor === 'function' ? TrailCtor : FallbackTrail;

    this.player = new P(this.chapter.spawn.x, this.chapter.spawn.y, this.chapter.spawn.angle);
    this.breath = new B();
    this.trail = new T();
    this.monsters = this.chapter.monsterSpawns.map((spawn) => new Listener(spawn, { rng: this.rng }));
    this.monster = this.monsters[0] || null;

    this.items = this.chapter.items.map((it) => ({ ...it, collected: false }));
    this.quietPoints = this.chapter.quietPoints.map((q) => ({ ...q, activated: false, logged: false }));
    this.doors = this.chapter.doors.map((d) => ({ ...d, requires: [...d.requires], open: d.requires.length === 0 }));
    this.exit = {
      x: this.chapter.exit.x,
      y: this.chapter.exit.y,
      requires: [...this.chapter.exit.requires],
      unlocked: false,
    };
    this.altar = this.chapter.altar
      ? {
          x: this.chapter.altar.x,
          y: this.chapter.altar.y,
          requiredShouts: this.chapter.altar.requiredShouts,
          progress: 0,
          defeated: false,
        }
      : null;
    this.objectives = this.chapter.objectives.map((o) => ({ ...o, done: false, progress: 0 }));
    this.checkpoint = { x: this.chapter.spawn.x, y: this.chapter.spawn.y };

    this.status = SessionStatus.PLAYING;
    this.time = 0;
    this._lastDt = 0;
    this.volume = 0;
    this.effectiveVolume = 0;
    this._lastBandId = getBand(0).id;
    this.danger = 0;
    this.message = '';
    this.deathRemaining = 0;
    this.stats = { deaths: 0, shouts: 0, gaspCount: 0, items: 0, time: 0 };

    this._quietDwell = 0;
    this._quietId = null;
    this._altarCooldown = 0;
    this._exitLockedTimer = 0;
    this._hintIndex = 0;
    this._playerDegraded = false;

    this._syncDoors();
    this._syncObjectives();
    this.exit.unlocked = this._isExitUnlocked();
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 100);
  }

  update(dt, input = {}) {
    const events = [];
    const step = clamp(Number(dt) || 0, 0, 0.1);
    this._lastDt = step;

    if (this.status === SessionStatus.COMPLETE) return events;

    // 死亡計時（沒有讀取畫面，3 秒後自動重生）。
    if (this.status === SessionStatus.DEAD) {
      this.deathRemaining = Math.max(0, this.deathRemaining - step);
      if (this.autoRespawn && this.deathRemaining <= 0) {
        this.respawn();
        events.push({ type: 'respawn' });
      }
      return events;
    }

    this.time += step;

    // 1) 氣息
    const breathResult = this.breath.update(step, this.volume) || {};
    if (breathResult.startedGasp) {
      this.stats.gaspCount += 1;
      events.push({ type: 'gasp-start' });
    }
    if (breathResult.endedGasp) {
      events.push({ type: 'gasp-end' });
    }
    const breathState = this.breath.state || breathResult.state || 'normal';
    this.effectiveVolume = breathState === 'gasp' ? BREATH.gaspVolume : this.volume;

    const band = getBand(this.effectiveVolume);
    if (band.id === 'scream' && this._lastBandId !== 'scream' && breathState !== 'gasp') {
      this.stats.shouts += 1;
      events.push({ type: 'shout' });
    }
    this._lastBandId = band.id;

    // 2) 聲紋
    const onWater = tileAt(this.level, this.player.x, this.player.y) === '~';
    this.trail.update(step, {
      x: this.player.x,
      y: this.player.y,
      volume: this.effectiveVolume,
      water: onWater,
    });

    // 3) 玩家移動
    try {
      this.player.update(step, input || {}, this.level);
    } catch (err) {
      this._degradePlayer(err);
    }

    // 4) 互動
    const px = this.player.x;
    const py = this.player.y;

    for (const it of this.items) {
      if (!it.collected && dist(px, py, it.x, it.y) <= INTERACTION.itemRadius) {
        it.collected = true;
        this.stats.items += 1;
        this.message = `取得：${it.label}`;
        events.push({ type: 'item', id: it.id, label: it.label });
      }
    }
    this._openDoors(events);

    this._updateQuiet(step, events);
    this._updateAltar(step, events);

    this._exitLockedTimer = Math.max(0, this._exitLockedTimer - step);
    this.exit.unlocked = this._isExitUnlocked();

    if (dist(px, py, this.exit.x, this.exit.y) <= INTERACTION.exitRadius) {
      if (this.exit.unlocked) {
        this.status = SessionStatus.COMPLETE;
        this.stats.time = this.time;
        this._syncObjectives();
        events.push({
          type: 'chapter-complete',
          chapterIndex: this.chapterIndex,
          stats: { ...this.stats },
        });
        return events;
      }
      if (this._exitLockedTimer <= 0) {
        this._exitLockedTimer = INTERACTION.exitLockedCooldown;
        events.push({ type: 'exit-locked', missing: this._missingRequirements() });
      }
    }

    // 5) 怪物
    for (const m of this.monsters) {
      const res = m.update(step, {
        level: this.level,
        player: { x: px, y: py },
        volume: this.effectiveVolume,
        trails: this.trail.getPoints(),
        hearing: this.chapter.hearing,
        water: this.chapter.water,
        boss: Boolean(this.altar),
        onKill: () => this._die('listener', events),
      });
      if (res && res.stunned) {
        events.push({ type: 'monster-stunned', x: m.x, y: m.y });
      }
    }

    // 6) 危險值
    let danger = 0;
    for (const m of this.monsters) {
      const d = dist(px, py, m.x, m.y);
      let f = clamp(1 - d / 8, 0, 1) * (m.state === 'chase' ? 1 : 0.55);
      if (m.state === 'stunned') f *= 0.2;
      if (f > danger) danger = f;
    }
    this.danger = danger;

    // 7) 提示
    while (this._hintIndex < this.chapter.hints.length && this.time >= this.chapter.hints[this._hintIndex].at) {
      const hint = this.chapter.hints[this._hintIndex];
      this._hintIndex += 1;
      this.message = hint.text;
      events.push({ type: 'hint', text: hint.text });
    }

    // 8) 統計與目標
    this.stats.time = this.time;
    this.stats.items = this.items.reduce((n, it) => n + (it.collected ? 1 : 0), 0);
    this._syncObjectives();

    return events;
  }

  getState() {
    const band = getBand(this.effectiveVolume);
    const breathState = this.breath.state || 'normal';
    const breathValue = typeof this.breath.value === 'number' ? this.breath.value : 0;
    const px = this.player.x;
    const py = this.player.y;

    const monsters = this.monsters.map((m) => {
      const d = dist(px, py, m.x, m.y);
      let danger = clamp(1 - d / 8, 0, 1) * (m.state === 'chase' ? 1 : 0.55);
      if (m.state === 'stunned') danger *= 0.2;
      return {
        x: m.x,
        y: m.y,
        state: m.state,
        distance: d,
        stunned: m.state === 'stunned',
        danger,
        stunRemaining: m.stunRemaining,
      };
    });

    return {
      chapterIndex: this.chapterIndex,
      chapter: this.chapter,
      status: this.status,
      time: this.time,
      dt: this._lastDt,
      player: { x: px, y: py, angle: this.player.angle },
      volume: this.volume,
      effectiveVolume: this.effectiveVolume,
      band: { id: band.id, label: band.label, index: band.index, color: band.color },
      breath: {
        value: breathValue,
        state: breathState,
        gaspRemaining: this.breath.gaspRemaining || 0,
      },
      monster: monsters[0] || null,
      monsters,
      trails: this.trail.getPoints(),
      items: this.items.map((it) => ({ ...it })),
      quietPoints: this.quietPoints.map((q) => ({ ...q })),
      doors: this.doors.map((d) => ({ id: d.id, x: d.x, y: d.y, open: d.open })),
      objectives: this.objectives.map((o) => ({
        id: o.id,
        text: o.text,
        done: o.done,
        progress: o.progress,
        target: o.target,
      })),
      exit: { x: this.exit.x, y: this.exit.y, unlocked: this.exit.unlocked, requires: [...this.exit.requires] },
      altar: this.altar
        ? {
            x: this.altar.x,
            y: this.altar.y,
            requiredShouts: this.altar.requiredShouts,
            progress: this.altar.progress,
            defeated: this.altar.defeated,
          }
        : null,
      checkpoint: { x: this.checkpoint.x, y: this.checkpoint.y },
      danger: this.danger,
      message: this.message,
      stats: { ...this.stats },
      deathRemaining: this.deathRemaining,
    };
  }

  reset() {
    this._build();
  }

  respawn() {
    this.player.teleport(this.checkpoint.x, this.checkpoint.y);
    this.breath.reset();
    this.trail.clear();
    for (const m of this.monsters) m.reset();
    this.status = SessionStatus.PLAYING;
    this.deathRemaining = 0;
    this.danger = 0;
    this.effectiveVolume = 0;
    this._lastBandId = getBand(0).id;
    this._quietDwell = 0;
    this._quietId = null;
    this._altarCooldown = 0;
    this._exitLockedTimer = 0;
  }

  /** 供測試使用：直接移動玩家。 */
  teleport(x, y) {
    if (typeof this.player.teleport === 'function') {
      this.player.teleport(x, y);
    } else {
      this.player.x = x;
      this.player.y = y;
    }
  }

  _degradePlayer(err) {
    if (this._playerDegraded) return;
    this._playerDegraded = true;
    const fallback = new FallbackPlayer(this.player.x, this.player.y, this.player.angle);
    fallback.lastError = err;
    this.player = fallback;
  }

  _restoreBreath(amount) {
    if (typeof this.breath.restore === 'function') {
      this.breath.restore(amount);
      return;
    }
    try {
      this.breath.value = Math.min(BREATH.max, (Number(this.breath.value) || 0) + amount);
    } catch {
      // 若 E1 的 BreathModel 只有 getter，仍不影響其他流程。
    }
  }

  _itemCollected(id) {
    const it = this.items.find((x) => x.id === id);
    return Boolean(it && it.collected);
  }

  _syncDoors() {
    const open = new Set();
    for (const d of this.doors) {
      if (d.open) open.add(`${Math.floor(d.x)},${Math.floor(d.y)}`);
    }
    this.level.doorsOpen = open;
  }

  _openDoors(events) {
    let changed = false;
    for (const d of this.doors) {
      if (d.open) continue;
      if (d.requires.every((id) => this._itemCollected(id))) {
        d.open = true;
        changed = true;
        events.push({ type: 'door', id: d.id });
      }
    }
    if (changed) this._syncDoors();
  }

  _updateQuiet(step, events) {
    const px = this.player.x;
    const py = this.player.y;
    let nearest = null;
    let nearestDist = Infinity;
    for (const q of this.quietPoints) {
      const d = dist(px, py, q.x, q.y);
      if (d <= INTERACTION.quietRadius && d < nearestDist) {
        nearest = q;
        nearestDist = d;
      }
    }

    if (!nearest) {
      this._quietDwell = 0;
      this._quietId = null;
      return;
    }
    if (this._quietId !== nearest.id) {
      this._quietId = nearest.id;
      this._quietDwell = 0;
    }
    this._quietDwell += step;
    if (this._quietDwell < INTERACTION.quietDwell) return;

    this.checkpoint = { x: nearest.x, y: nearest.y };
    if (nearest.activated) return;

    nearest.activated = true;
    this._restoreBreath(INTERACTION.checkpointBreath);
    this.message = nearest.title;
    events.push({ type: 'checkpoint', id: nearest.id });
    if (!nearest.logged) {
      nearest.logged = true;
      events.push({ type: 'log', id: nearest.id, title: nearest.title, text: nearest.text });
    }
  }

  _updateAltar(step, events) {
    if (!this.altar) return;
    this._altarCooldown = Math.max(0, this._altarCooldown - step);
    if (this.altar.defeated) return;

    const d = dist(this.player.x, this.player.y, this.altar.x, this.altar.y);
    if (d > INTERACTION.altarRadius) return;
    if (this.effectiveVolume < 86) return;
    if (this._altarCooldown > 0) return;

    this.altar.progress += 1;
    this._altarCooldown = INTERACTION.altarCooldown;
    const remaining = Math.max(0, this.altar.requiredShouts - this.altar.progress);
    events.push({
      type: 'boss-hit',
      remaining,
      progress: this.altar.progress,
      required: this.altar.requiredShouts,
    });
    if (this.altar.progress >= this.altar.requiredShouts) {
      this.altar.defeated = true;
      this.exit.unlocked = this._isExitUnlocked();
      events.push({ type: 'boss-defeated' });
    }
  }

  _isExitUnlocked() {
    const itemsOk = this.exit.requires.every((id) => this._itemCollected(id));
    const altarOk = !this.altar || this.altar.defeated;
    return itemsOk && altarOk;
  }

  _missingRequirements() {
    const missing = [];
    for (const id of this.exit.requires) {
      const it = this.items.find((x) => x.id === id);
      if (!it || !it.collected) missing.push(it ? it.label : id);
    }
    if (this.altar && !this.altar.defeated) missing.push('祭壇的沉默');
    return missing;
  }

  _syncObjectives() {
    const collected = this.items.reduce((n, it) => n + (it.collected ? 1 : 0), 0);
    const activated = this.quietPoints.reduce((n, q) => n + (q.activated ? 1 : 0), 0);
    for (const o of this.objectives) {
      if (o.kind === 'items') {
        o.progress = collected;
        o.done = collected >= o.target;
      } else if (o.kind === 'quiet') {
        o.progress = activated;
        o.done = activated >= o.target;
      } else if (o.kind === 'altar') {
        o.progress = this.altar ? this.altar.progress : 0;
        o.done = Boolean(this.altar && this.altar.defeated);
      } else if (o.kind === 'exit') {
        o.progress = this.status === SessionStatus.COMPLETE ? 1 : 0;
        o.done = this.status === SessionStatus.COMPLETE;
      } else {
        o.progress = 0;
        o.done = false;
      }
    }
  }

  _die(cause, events) {
    if (this.status !== SessionStatus.PLAYING) return;
    this.status = SessionStatus.DEAD;
    this.deathRemaining = 3;
    this.stats.deaths += 1;
    events.push({ type: 'death', cause });
  }
}
