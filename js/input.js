// 《勿聲》HUSH — 鍵盤與滑鼠輸入（E1）
// 只在使用者互動的 canvas 上運作；不攔截瀏覽器快捷鍵（F5／F12／Ctrl 組合）。

/** 本遊戲會處理的按鍵（以 KeyboardEvent.code 為準）。 */
const HANDLED_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
]);

/**
 * 判斷事件目標是否為文字輸入元件。若是，輸入管理器不攔截按鍵。
 * @param {EventTarget|null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;

  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 輸入管理器。
 *
 * 合約欄位：
 * - forward / back / strafeLeft / strafeRight / turnLeft / turnRight
 * - mouseDX（指標鎖定時累積）
 * - voiceHeld（空白鍵）
 * - pausePressed（Esc 邊緣觸發，需 consumePause() 清除）
 */
export class InputManager {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas || null;

    this._keys = new Set();
    this.mouseDX = 0;
    this._pausePressed = false;
    this.pointerLocked = false;
    this.attached = false;

    // 先綁定，attach / detach 才能使用同一個函式參考。
    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundKeyUp = this._onKeyUp.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundPointerLockChange = this._onPointerLockChange.bind(this);
    this._boundBlur = this._onBlur.bind(this);
    this._boundVisibilityChange = this._onVisibilityChange.bind(this);
  }

  /** 開始監聽。重複呼叫安全。 */
  attach() {
    if (this.attached) return;

    const win = typeof window !== 'undefined' ? window : null;
    const doc = typeof document !== 'undefined' ? document : null;
    if (!win || !doc) return;

    win.addEventListener('keydown', this._boundKeyDown, { passive: false });
    win.addEventListener('keyup', this._boundKeyUp);
    win.addEventListener('blur', this._boundBlur);

    doc.addEventListener('mousemove', this._boundMouseMove);
    doc.addEventListener('pointerlockchange', this._boundPointerLockChange);
    doc.addEventListener('visibilitychange', this._boundVisibilityChange);

    this.attached = true;
  }

  /** 停止監聽並釋放所有按鍵。重複呼叫安全。 */
  detach() {
    const win = typeof window !== 'undefined' ? window : null;
    const doc = typeof document !== 'undefined' ? document : null;

    if (win) {
      win.removeEventListener('keydown', this._boundKeyDown);
      win.removeEventListener('keyup', this._boundKeyUp);
      win.removeEventListener('blur', this._boundBlur);
    }
    if (doc) {
      doc.removeEventListener('mousemove', this._boundMouseMove);
      doc.removeEventListener('pointerlockchange', this._boundPointerLockChange);
      doc.removeEventListener('visibilitychange', this._boundVisibilityChange);
    }

    this.attached = false;
    this.pointerLocked = false;
    this.reset();

    if (doc && doc.pointerLockElement === this.canvas && typeof doc.exitPointerLock === 'function') {
      try {
        doc.exitPointerLock();
      } catch {
        // 瀏覽器可能因非使用者手勢而拒絕；忽略即可。
      }
    }
  }

  /**
   * 取得目前輸入狀態。mouseDX 不會因呼叫而清零，請用 consumeMouseDX()。
   * @returns {{forward:boolean, back:boolean, strafeLeft:boolean, strafeRight:boolean, turnLeft:boolean, turnRight:boolean, mouseDX:number, voiceHeld:boolean, pausePressed:boolean}}
   */
  getState() {
    const keys = this._keys;
    return {
      forward: keys.has('KeyW') || keys.has('ArrowUp'),
      back: keys.has('KeyS') || keys.has('ArrowDown'),
      strafeLeft: keys.has('KeyA'),
      strafeRight: keys.has('KeyD'),
      turnLeft: keys.has('ArrowLeft') || keys.has('KeyQ'),
      turnRight: keys.has('ArrowRight') || keys.has('KeyE'),
      mouseDX: this.mouseDX,
      voiceHeld: keys.has('Space'),
      pausePressed: this._pausePressed,
    };
  }

  /** 要求滑鼠指標鎖定。必須由使用者手勢（例如點擊）觸發。 */
  requestPointerLock() {
    if (!this.canvas || typeof this.canvas.requestPointerLock !== 'function') return false;
    try {
      const result = this.canvas.requestPointerLock();
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 取出並清空累積的滑鼠水平位移。
   * @returns {number}
   */
  consumeMouseDX() {
    const dx = this.mouseDX;
    this.mouseDX = 0;
    return dx;
  }

  /**
   * 取出並清除 Esc 暫停的邊緣觸發。
   * @returns {boolean}
   */
  consumePause() {
    const pressed = this._pausePressed;
    this._pausePressed = false;
    return pressed;
  }

  /** 釋放所有按鍵、清空滑鼠位移與暫停旗標。 */
  reset() {
    this._keys.clear();
    this.mouseDX = 0;
    this._pausePressed = false;
  }

  /** @returns {boolean} 目前是否由本 canvas 持有指標鎖定 */
  isPointerLocked() {
    const doc = typeof document !== 'undefined' ? document : null;
    return Boolean(this.pointerLocked && doc && doc.pointerLockElement === this.canvas);
  }

  /**
   * 鍵盤按下。
   * @param {KeyboardEvent} event
   * @private
   */
  _onKeyDown(event) {
    if (isTypingTarget(event.target)) return;

    // 不攔截 Ctrl / Cmd / Alt 組合鍵，保留瀏覽器與作業系統快捷鍵。
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // 不攔截 F5、F12 等功能鍵。
    if (typeof event.key === 'string' && /^F\d{1,2}$/.test(event.key)) return;

    const code = event.code;
    if (!HANDLED_CODES.has(code)) return;

    if (code === 'Escape') {
      // Esc 是邊緣觸發；長按不重複設定。刻意不 preventDefault，
      // 讓瀏覽器仍可依規則解除 pointer lock。
      if (!event.repeat && !this._keys.has('Escape')) this._pausePressed = true;
      this._keys.add('Escape');
      return;
    }

    event.preventDefault();
    this._keys.add(code);
  }

  /**
   * 鍵盤放開。keyup 一律清除，避免焦點切換造成卡鍵。
   * @param {KeyboardEvent} event
   * @private
   */
  _onKeyUp(event) {
    this._keys.delete(event.code);
  }

  /**
   * 滑鼠移動。只有指標鎖定時才累積水平位移。
   * @param {MouseEvent} event
   * @private
   */
  _onMouseMove(event) {
    if (!this.pointerLocked) return;
    const dx = Number(event.movementX);
    if (Number.isFinite(dx) && dx !== 0) this.mouseDX += dx;
  }

  /**
   * 指標鎖定狀態變更。
   * @private
   */
  _onPointerLockChange() {
    const doc = typeof document !== 'undefined' ? document : null;
    this.pointerLocked = Boolean(doc && doc.pointerLockElement === this.canvas);
    if (!this.pointerLocked) this.mouseDX = 0;
  }

  /**
   * 視窗失焦：釋放按鍵，避免玩家切回來時角色持續移動。
   * @private
   */
  _onBlur() {
    this.pointerLocked = false;
    this.reset();
  }

  /**
   * 分頁切到背景時同樣釋放按鍵。
   * @private
   */
  _onVisibilityChange() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc && doc.hidden) this.reset();
  }
}
