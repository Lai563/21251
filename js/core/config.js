// 《勿聲》HUSH — 共用常數（LEAD 凍結檔，工程師請勿修改）
// 所有數值單位：秒、世界格。

export const VERSION = '1.0.0';

/** 相機水平視野（弧度） */
export const FOV = (66 * Math.PI) / 180;

/** 聲量四區間。getBand() 以「上限」判定，避免浮點 20.5 落錯區間。 */
export const VOLUME_BANDS = Object.freeze([
  { id: 'silent',  min: 0,  max: 20,  label: '靜默', color: '#6f8b96', vision: 2.6,  trail: 0,    index: 0 },
  { id: 'whisper', min: 21, max: 55,  label: '低聲', color: '#7fe3cf', vision: 7.0,  trail: 0.45, index: 1 },
  { id: 'call',    min: 56, max: 85,  label: '呼喊', color: '#ffd166', vision: 12.0, trail: 0.8,  index: 2 },
  { id: 'scream',  min: 86, max: 100, label: '尖叫', color: '#ff5d73', vision: 18.0, trail: 1,    index: 3 },
]);

export function getBand(volume) {
  const v = Math.max(0, Math.min(100, Number(volume) || 0));
  if (v <= 20) return VOLUME_BANDS[0];
  if (v <= 55) return VOLUME_BANDS[1];
  if (v <= 85) return VOLUME_BANDS[2];
  return VOLUME_BANDS[3];
}

/** 氣息：靜默回復，出聲消耗；歸零強制喘氣。 */
export const BREATH = Object.freeze({
  max: 100,
  drain: { silent: -8, whisper: 4.5, call: 10, scream: 18 }, // 負值 = 每秒回復
  regen: 8,
  gaspDuration: 3,
  gaspVolume: 88,
  afterGasp: 100,
});

/** 聲紋殘留：3–5 秒，水區更久。 */
export const TRAIL = Object.freeze({
  interval: 0.5,
  ttlMin: 3,
  ttlMax: 5,
  maxPoints: 64,
  minVolume: 21,
  waterTtlMultiplier: 1.4,
});

export const PLAYER = Object.freeze({
  radius: 0.22,
  speed: 2.35,
  turnSpeed: 2.1,
  mouseSensitivity: 0.0022,
  eyeHeight: 0.5,
});

export const MONSTER = Object.freeze({
  radius: 0.3,
  speedIdle: 0.55,
  speedInvestigate: 1.15,
  speedChase: 1.9,
  stunRange: 6.5,
  stunDuration: 3.2,
  stunCooldown: 5,
  contactRadius: 0.48,
  loseTrailTime: 4,
  pathInterval: 0.35,
  hearingBase: 8.5,
  wanderRadius: 4,
});

export const INTERACTION = Object.freeze({
  itemRadius: 0.62,
  quietRadius: 1.0,
  quietDwell: 0.8,
  exitRadius: 0.85,
  altarRadius: 2.6,
  altarCooldown: 1.2,
  checkpointBreath: 30,
  exitLockedCooldown: 3,
});

export const SONAR = Object.freeze({
  maxRange: 20,
  minRange: 2.2,
  pulseSpeed: 22,
  pulseWidth: 2.4,
});

export const KEYBOARD_VOICE = Object.freeze({
  attack: 1.0,
  release: 0.35,
});

export const STORAGE_KEYS = Object.freeze({
  settings: 'hush.settings.v1',
  calibration: 'hush.calibration.v1',
  progress: 'hush.progress.v1',
  stats: 'hush.stats.v1',
});

export const SCREENS = Object.freeze({
  start: 'start',
  calibration: 'calibration',
  chapter: 'chapter',
  pause: 'pause',
  death: 'death',
  ending: 'ending',
  none: 'none',
});

/** 方便 UI 使用的預設設定 */
export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'mic',
  sensitivity: 1,
  masterVolume: 0.8,
  muted: false,
  subtitles: true,
  reducedMotion: false,
});
