# 《勿聲》HUSH — 技術架構與模組合約 v1.0

> 本文件是工程的唯一介面真相（single source of truth）。所有模組必須依照此合約實作；若必須改介面，先在 `docs/integration-notes-<角色>.md` 記錄，並保持向後相容。
> 企劃來源：`../plan.md`。產品細節：`product-spec.md`。驗收：`acceptance-criteria.md`。

## 1. 交付形式

- 純前端、免 build、免外部 CDN、免外部素材、免網路。
- 啟動：`npm start`（Node 靜態伺服器）→ `http://localhost:5173`。
- 瀏覽器：Chrome / Edge / Firefox 桌面版。ES Modules。
- 渲染：Canvas 2D 第一人稱 raycasting（640×360 內部解析度，等比放大，image-rendering: pixelated）。
- 音訊：Web Audio API 程序化合成；麥克風只做 RMS 音量分析，**不錄音、不上傳、不保留音訊**。
- 所有 UI 為繁體中文。

## 2. 目錄與檔案所有權

```
hush/
├─ index.html                  LEAD（凍結 DOM 結構）
├─ styles.css                  LEAD（凍結視覺樣式）
├─ js/
│  ├─ core/config.js           LEAD（凍結，不得修改）
│  ├─ core/volume.js           E1
│  ├─ core/breath.js           E1
│  ├─ core/trail.js            E1
│  ├─ core/player.js           E2
│  ├─ core/raycast.js          E2
│  ├─ core/levels.js           E3
│  ├─ core/monster.js          E3
│  ├─ core/session.js          E3
│  ├─ audio.js                 E1
│  ├─ input.js                 E1
│  ├─ audio-feedback.js        E1
│  ├─ renderer.js              E2
│  ├─ ui.js                    E3
│  └─ game.js                  E3
├─ docs/                       PM1 / PM2 / LEAD
├─ tests/unit/                 T1
├─ tests/integration/          T2
└─ tools/serve.js              LEAD
```

**禁止越界修改他人檔案。** 需要對方改東西時，寫進 `docs/integration-notes-<角色>.md` 並回報。

## 3. 座標、地圖與時間

- 世界為格子地圖，`x` 向右、`y` 向下，1 格 = 1 世界單位。
- 玩家／怪物座標為浮點數（格中心 = `x+0.5`）。角度 `0` 指向 `+x`，順時針為正。
- 玩家半徑 `0.22`；怪物半徑 `0.3`。
- 相機：FOV 66°，眼高 0.5。`dir=(cos a, sin a)`，`plane=(-sin a, cos a)*tan(FOV/2)`。
- 時間單位為秒；`dt` 由 game loop 傳入，session 內部 clamp 到 `[0, 0.1]`。

### 地圖字元

| 字元 | 意義 | 可通行 |
|---|---|---|
| `#` | 牆 | 否 |
| `P` | 柱子／大型障礙 | 否 |
| `.` | 地板 | 是 |
| `~` | 積水地板 | 是（移動 ×0.75、聲音傳遞 ×1.5、聲紋壽命 ×1.4） |
| `D` | 門（由 `doors` 解鎖） | 解鎖後是 |
| `E` | 出口觸發格 | 是 |
| `S` | 玩家出生點 | 是 |
| `Q` | 安靜點 | 是 |
| `I` | 可收集物 | 是 |
| `M` | 怪物出生點 | 是 |
| `A` | 祭壇／鐘 | 是 |

地圖必須是矩形；最外圈必須是 `#`。實體座標以格中心表示（例如 `x: 3.5, y: 4.5`）。

## 4. `js/core/config.js`（LEAD 提供，凍結）

輸出：

```js
export const VERSION
export const FOV
export const VOLUME_BANDS        // [{id,min,max,label,color,vision,trail}]
export function getBand(volume)  // 回傳 band 物件
export const BREATH              // {max,drain:{silent,whisper,call,scream},regen,gaspDuration,gaspVolume,afterGasp}
export const TRAIL               // {interval,ttlMin,ttlMax,maxPoints,minVolume}
export const PLAYER              // {radius,speed,turnSpeed,mouseSensitivity,eyeHeight}
export const MONSTER             // {radius,speedIdle,speedInvestigate,speedChase,stunRange,stunDuration,stunCooldown,contactRadius,loseTrailTime,pathInterval}
export const INTERACTION         // {itemRadius,quietRadius,quietDwell,exitRadius,altarRadius}
export const SONAR               // {maxRange,minRange,pulseSpeed,pulseWidth}
export const KEYBOARD_VOICE      // {attack,release}
export const STORAGE_KEYS
export const SCREENS
```

四區間（必須一致）：`0–20 靜默`、`21–55 低聲`、`56–85 呼喊`、`86–100 尖叫`。

## 5. 核心純邏輯模組（Node 可 import，禁止碰 DOM／window）

> 測試會在 Node 24 直接 import 這些檔案。**不得**在 core/ 內使用 `window`、`document`、`AudioContext`、`localStorage`。

### 5.1 `core/volume.js`（E1）

```js
export const DEFAULT_CALIBRATION = { noiseDb: -50, quietDb: -35, loudDb: -12 };
export function rmsToDb(rms)                  // 20*log10(max(rms,1e-8))
export function createCalibration({noiseRms, quietRms, loudRms}) // -> {noiseDb,quietDb,loudDb}
export function normalizeVolume(db, calibration) // 0..100，noiseDb 以下 = 0，loudDb 以上 = 100
export class VolumeTracker {
  constructor(calibration = DEFAULT_CALIBRATION)
  push(rms, dt) -> number       // attack 80ms / release 250ms 的指數平滑
  reset()
  get value()
  get band()
  setCalibration(c)
}
export class KeyboardVoice {
  constructor(opts = KEYBOARD_VOICE)
  update(dt, held) -> number    // 按住 1.0s 內 0→100，放開 0.35s 內衰減
  reset()
  get value()
}
```

### 5.2 `core/breath.js`（E1）

```js
export class BreathModel {
  constructor()
  update(dt, volume) -> { value, state, gaspRemaining, startedGasp, endedGasp }
  // state: 'normal' | 'gasp'
  // 依 band 消耗：silent 回復、whisper/call/scream 消耗；歸零進入 gasp 3s
  // gasp 期間 value 鎖 0、對外 volume 由 session 覆寫為 BREATH.gaspVolume
  reset()
  get value()
}
```

### 5.3 `core/trail.js`（E1）

```js
export class TrailSystem {
  constructor(opts = {})
  update(dt, { x, y, volume, water }) -> boolean  // 是否新增節點
  getPoints() -> [{ x, y, intensity, age, ttl, water }]
  // intensity 0..1；ttl = TRAIL.ttlMin + volume/100*(ttlMax-ttlMin)，水區 ×1.4
  newest() -> point|null
  clear()
}
```

### 5.4 `core/player.js`（E2）

```js
export class Player {
  constructor(x, y, angle)
  update(dt, input, level) // input: {forward,back,strafeLeft,strafeRight,turnLeft,turnRight,mouseDX}
  // 圓形碰撞 + 沿牆滑動；水區速度 ×0.75；不可穿過關閉的門
  teleport(x, y, angle?)
  get x, y, angle
}
```

### 5.5 `core/raycast.js`（E2）

```js
export function castRay(level, ox, oy, rayDirX, rayDirY, maxDist = 32)
// 回傳 { dist, tile, side, mapX, mapY }
// dist 為「垂直於相機平面」的距離：呼叫端用 dir + plane*cameraX 產生未正規化 rayDir。
// level 需有 width,height,tileAt(x,y),isSolid(x,y)
export function hasLineOfSight(level, x1, y1, x2, y2) // 供 AI／互動使用
```

### 5.6 `core/levels.js`（E3）

```js
export const CHAPTERS // 4 章，符合 product-spec 的目標與文本
export function getChapter(index) // 回傳 deep-ish 的關卡物件（含解析後 grid）
export function isSolid(level, x, y)
export function isWalkable(level, x, y, { doorsOpen = true } = {})
export function findPath(level, start, goal, opts = {}) // BFS，回傳 [{x,y}...] 格中心，找不到回 []
```

關卡物件：

```js
{
  id, name, subtitle, duration, hearing, sonarRange, water, ambient,
  width, height, grid,            // grid[y][x] 字元
  spawn: {x,y,angle},
  monsterSpawns: [{x,y}],
  items: [{id,x,y,label}],
  quietPoints: [{id,x,y,title,text}],
  doors: [{id,x,y,requires:[itemId]}],
  exit: {x,y,requires:[itemId]},
  altar: null | {x,y,requiredShouts},
  objectives: [{id,text,target}],
  intro: {title, lines:[...]},
  outro: {title, lines:[...]},
  hints: [{at:seconds, text}],
  visual: {wall, water, accent, fog}
}
```

### 5.7 `core/monster.js`（E3）

```js
export class Listener {
  constructor(spawn, opts = {})
  reset(spawn?)
  update(dt, ctx)
  // ctx: { level, player:{x,y}, volume, trails:[...], hearing, water, boss:boolean }
  // 狀態：'idle' | 'investigate' | 'chase' | 'stunned' | 'returning'
  // 盲眼、只追聲音：持續聲源 + 聲紋節點（取最新且最強）；BFS 尋路；直線可走時直線。
  // volume>=86 且距離 <= MONSTER.stunRange → stunned（有冷卻）
  // 接觸 player <= contactRadius → ctx.onKill?.()
  get state, x, y, stunRemaining, target
}
```

### 5.8 `core/session.js`（E3）— 整合核心

```js
export const SessionStatus = { PLAYING:'playing', DEAD:'dead', COMPLETE:'complete' };
export class GameSession {
  constructor(chapterIndex = 0, opts = {}) // opts: {rng, autoRespawn=true}
  setVolume(v)                 // 0..100（game 每幀設定）
  update(dt, input) -> Event[] // 推進玩家、氣息、聲紋、怪物、互動、死亡計時
  getState() -> State
  reset()
  respawn()
}
```

`State`：

```js
{
  chapterIndex, chapter, status, time, dt,
  player:{x,y,angle},
  volume, effectiveVolume, band:{id,label,index,color},
  breath:{value,state,gaspRemaining},
  monster:{x,y,state,distance,stunned,danger},
  trails:[{x,y,intensity,age,ttl,water}],
  items:[{id,x,y,label,collected}],
  quietPoints:[{id,x,y,title,activated}],
  doors:[{id,x,y,open}],
  objectives:[{id,text,done,progress,target}],
  exit:{x,y,unlocked},
  altar:{x,y,requiredShouts,progress}|null,
  checkpoint:{x,y},
  danger,                     // 0..1，用於心跳／畫面撕裂
  message,
  stats:{deaths,shouts,gaspCount,items,time}
}
```

`Event`（至少）：

```js
{type:'log', id, title, text}
{type:'item', id, label}
{type:'door', id}
{type:'checkpoint', id}
{type:'gasp-start'} {type:'gasp-end'}
{type:'monster-stunned'}
{type:'death', cause}
{type:'respawn'}
{type:'chapter-complete', chapterIndex, stats}
{type:'boss-hit', remaining}
{type:'boss-defeated'}
{type:'exit-locked', missing:[...]}
{type:'hint', text}
{type:'shout'} // 進入 scream 區間時觸發一次（供音效）
```

規則：
- 每幀 `effectiveVolume = breath.state==='gasp' ? BREATH.gaspVolume : volume`。
- 玩家進入 `quietPoint` 半徑並停留 `quietDwell` → 設為 checkpoint、`activated=true`、回 30 氣息、發 `checkpoint`；第一次進入發 `log`。
- 收集物：距離 ≤ itemRadius → collected、更新 objectives、發 `item`。
- 門：所有 `requires` 都 collected → open，發 `door`。
- 出口：所有 `requires` 完成且玩家在 exitRadius → `status='COMPLETE'`、發 `chapter-complete`。未解鎖時靠近發 `exit-locked`（每 3 秒最多一次）。
- 死亡：怪物接觸 → `status='DEAD'`、stats.deaths++、發 `death`；3 秒後自動重生於 checkpoint、怪物重置、氣息全滿、聲紋清空、發 `respawn`。**無讀取畫面**。
- 第 4 章祭壇：玩家在 altarRadius 內且 `effectiveVolume>=86`，每次冷卻 1.2s 記一次 `boss-hit`；達 requiredShouts → `boss-defeated` 並解鎖出口。
- 章節 3 水區：monster hearing ×1.5，聲紋更持久。
- 怪物每幀依 state 計算 danger：`clamp(1 - distance/8, 0, 1) * (state==='chase'?1:0.55)`。
- `rng` 可注入（預設 mulberry32），確保測試可重現。

## 6. 瀏覽器層

### 6.1 `js/audio.js`（E1）

```js
export class AudioEngine {
  constructor()
  async startMic() -> {ok:true} | {ok:false, code, message}
  // code: 'unsupported'|'denied'|'no-device'|'insecure'
  async calibrate(onProgress) -> calibration // onProgress({step, progress, instruction})
  // 步驟：noise 3s → quiet 3s → loud 3s；允許 skip（回 DEFAULT_CALIBRATION）
  update(dt, input) // input.voiceHeld 供鍵盤模式；更新 this.volume / this.band
  setMode('mic'|'keyboard')
  setSensitivity(0.5..2)
  get volume, band, mode, status
  getLevel() // 0..1 即時音量（給音量環）
  dispose()
}
```

- 必須在使用者手勢後才 `AudioContext`/`getUserMedia`。
- 只保留 AnalyserNode 的時域 RMS，不建立 MediaRecorder、不寫入任何儲存。
- 權限失敗要能明確回報，讓 UI 提供「鍵盤模式」。

### 6.2 `js/input.js`（E1）

```js
export class InputManager {
  constructor(canvas)
  attach() / detach()
  getState() -> {forward,back,strafeLeft,strafeRight,turnLeft,turnRight,mouseDX,voiceHeld,pausePressed}
  requestPointerLock()
  consumeMouseDX()
  reset()
}
```

- WASD／方向鍵移動與轉向；`Space` 在鍵盤模式代表發聲；`Esc` 暫停；滑鼠指標鎖定後左右轉向。
- 方向鍵：↑↓ 前後、←→ 轉向；A/D 平移、Q/E 轉向（可選）。
- 不得攔截 F5/F12 等瀏覽器快捷鍵。

### 6.3 `js/audio-feedback.js`（E1）

```js
export class AudioFeedback {
  async init()
  setChapter(chapter, index)
  update(state, dt)      // 心跳（danger）、低頻 drone、怪物腳步、水聲
  event(evt)             // 依事件播放音效
  setMasterVolume(v) / setMuted(b) / suspend() / resume() / dispose()
}
```

- 全部用 OscillatorNode / BufferSource 白噪音 / BiquadFilter / PannerNode 合成。
- 不得使用外部音檔。

### 6.4 `js/renderer.js`（E2）

```js
export class Renderer {
  constructor(canvas, opts = {})
  resize()
  render(state, time, dt) // 第一人稱聲納線稿、聲紋、怪物、物件、HUD 以外的後處理
  addShake(amount)
  setReducedMotion(bool)
  dispose()
}
```

視覺要求：
- 全黑底；牆面以單色線稿（青白）呈現，亮度隨「聲量照明半徑」與「聲納脈衝波前」衰減。
- 安靜時近乎全黑，只能看到極近距離；音量越大看得越遠。
- 每次跨入更高音量區間，產生向外擴散的聲納脈衝；波前掃過牆面時短暫發亮。
- 聲紋：地面上的青白色同心漣漪／腳印，3–5 秒淡出。
- 怪物：高瘦人形剪影＋不規則輪廓，靠近時閃爍；被震退時反白。
- 物品、安靜點、出口、祭壇有不同圖形與微弱光暈。
- 後處理：顆粒雜訊、暗角、掃描線、危險時輕微畫面撕裂／色偏；`reducedMotion` 時關閉 shake／撕裂。
- 精靈需用 raycast z-buffer 做遮擋；地板上的聲紋需正確透視。
- 內部解析度 640×360，`ctx.imageSmoothingEnabled=false`。

### 6.5 `js/ui.js`（E3）

```js
export class UI {
  constructor(root = document)
  update(state)                       // 音量環、氣息、章節、目標、危險、字幕
  showScreen(name)                    // SCREENS: 'start'|'calibration'|'chapter'|'pause'|'death'|'ending'|'none'
  setSubtitle(text, seconds = 5)
  toast(text, seconds = 2.5)
  setMicStatus(status, detail)
  setCalibrationStep({step, progress, instruction})
  showChapterCard(chapter, onContinue)
  showDeath(stats)
  showEnding(stats)
  on(action, handler)                 // 'start'|'calibrate'|'skip-calibration'|'resume'|'restart'|'settings'|'next-chapter'|'replay'|'mic-retry'|'quit'|'continue'
  setSettings(settings)
  getSettings()
}
```

`index.html` 必須包含（id 固定）：
`#app`, `#game-canvas`, `#hud`, `#volume-ring`, `#volume-value`, `#volume-label`, `#breath-fill`, `#breath-value`, `#chapter-name`, `#objective-text`, `#subtitle`, `#danger-vignette`, `#hint`, `#screen-start`, `#screen-calibration`, `#screen-pause`, `#screen-death`, `#screen-chapter`, `#screen-ending`, `#settings-panel`, `#btn-start`, `#btn-calibrate`, `#btn-skip-calibration`, `#btn-resume`, `#btn-restart`, `#btn-settings`, `#btn-next-chapter`, `#btn-replay`, `#btn-mic-retry`, `#mic-status`。

### 6.6 `js/game.js`（E3）

- 建立 `Renderer`、`AudioEngine`、`AudioFeedback`、`InputManager`、`UI`、`GameSession`。
- 狀態機：`boot → start → calibration → chapter-card → playing ⇄ paused / dead → chapter-complete → ending`。
- 每幀：input → audio.update → session.setVolume → session.update → renderer.render → ui.update → feedback.update。
- 事件 → UI（字幕／toast）＋ AudioFeedback.event。
- 進度與設定存 `localStorage`：`hush.settings.v1`、`hush.calibration.v1`、`hush.progress.v1`、`hush.stats.v1`。
- 第 1 次開始顯示耳機／隱私提示；麥克風失敗提供鍵盤模式；`Esc` 暫停；頁面失焦自動暫停。
- 章節完成解鎖下一章；第 4 章後顯示結局與統計（時長、死亡次數、尖叫次數、完成率）。
- 提供 debug 掛鉤 `window.__HUSH__ = { game, session, audio, renderer }` 供測試（不影響正常遊玩）。

## 7. 效能與相容

- 目標 60fps，最低 30fps；每幀 raycast 欄數 320（640 內部寬度每 2px 一欄），精靈排序後繪製。
- 不使用外部字型；CSS 使用系統字型堆疊。
- 不發出任何網路請求（含 CDN、字型、圖片、音檔）。
- `prefers-reduced-motion` 與設定皆可降低動態。

## 8. 測試介面

- `package.json`: `"type":"module"`、`npm test` = `node --test tests/unit tests/integration`、`npm start` = `node tools/serve.js`。
- 單元測試只 import `js/core/*`。
- 整合測試用 `GameSession` 模擬輸入與音量，不啟動瀏覽器。
- 靜態檢查：HTML 引用的檔案存在、無 `http://` / `https://` 外部資源、所有 JS 可被 `node --check` 解析。
- 瀏覽器煙霧測試：以 Edge/Chrome headless 載入頁面，確認無 console error、canvas 有像素輸出（若環境允許）。

## 9. 完成定義（Definition of Done）

1. `npm test` 全綠。
2. `npm start` 後可從開始畫面完整玩完 4 章（含死亡重生、章節切換、結局）。
3. 麥克風模式與鍵盤模式皆可通關；無麥克風時有明確替代路徑。
4. 無 console error、無外部網路請求。
5. 驗收文件中的 P0 全部通過。
