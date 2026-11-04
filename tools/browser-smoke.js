// 瀏覽器煙霧測試：啟動靜態伺服器 + Chrome/Edge headless（CDP），
// 走一遍開始→鍵盤模式→第一章→發聲→死亡重生→章節完成，並收集 console error。
//
// 用法：node tools/browser-smoke.js [--port 5199] [--keep]
// 產物：tests/artifacts/*.png（若目錄可寫）
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5199);
const KEEP = args.includes('--keep');
const DEBUG_PORT = 9333;
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge；可用 CHROME_PATH 指定。');
}

async function waitForHttp(url, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await wait(200);
  }
  throw new Error(`伺服器未啟動：${url}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 8000, label = expression) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch {}
      await wait(120);
    }
    throw new Error(`等待逾時：${label}`);
  }

  async screenshot(name) {
    await mkdir(ARTIFACTS, { recursive: true });
    const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(ARTIFACTS, `${name}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  async click(id) {
    const ok = await this.evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`找不到按鈕 #${id}`);
  }
}

async function main() {
  const browser = findBrowser();
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  let chrome;
  let tempDir;
  const failures = [];
  const consoleErrors = [];

  try {
    await waitForHttp(`http://127.0.0.1:${PORT}/`);
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'hush-smoke-'));
    chrome = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${tempDir}`,
      '--window-size=1280,720',
      'about:blank',
    ], { stdio: 'ignore' });

    await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到可用的頁面 target');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new CDP(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
      }
    });

    const url = `http://127.0.0.1:${PORT}/`;
    await cdp.send('Page.navigate', { url });
    await cdp.waitFor('document.readyState === "complete"');
    await wait(700);

    await cdp.screenshot('01-start');
    console.log('✓ 開始畫面載入');

    // 切換鍵盤模式（避免 headless 麥克風與 15 秒校準）
    await cdp.click('btn-settings');
    await cdp.waitFor('document.getElementById("settings-panel").classList.contains("open")');
    await cdp.evaluate('document.getElementById("setting-mode-keyboard").click()');
    await cdp.click('btn-settings-done');
    await wait(200);

    await cdp.click('btn-start');
    await wait(500);
    const onCalibration = await cdp.evaluate('document.getElementById("screen-calibration").classList.contains("active")');
    if (onCalibration) {
      await cdp.click('btn-skip-calibration');
      await wait(400);
    }
    await cdp.waitFor('document.getElementById("screen-chapter").classList.contains("active")', 6000, '章節卡');
    await cdp.screenshot('02-chapter');
    console.log('✓ 章節卡');

    await cdp.click('btn-next-chapter');
    await cdp.waitFor('!document.getElementById("hud").classList.contains("hidden")', 6000, 'HUD');
    await wait(500);
    await cdp.screenshot('03-gameplay-quiet');
    const boot = await cdp.evaluate('!!window.__HUSH__ && !!window.__HUSH__.session');
    if (!boot) failures.push('window.__HUSH__ 未掛載');
    console.log('✓ 進入第一章');

    // 按住空白鍵發聲，確認音量上升、畫面變亮
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await wait(1600);
    const vol = await cdp.evaluate('window.__HUSH__?.audio?.volume ?? window.__HUSH__?.session?.getState()?.volume ?? -1');
    await cdp.screenshot('04-gameplay-voice');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    if (typeof vol === 'number' && vol < 50) failures.push(`鍵盤模式音量未上升（${vol}）`);
    console.log(`✓ 鍵盤發聲，音量 ${Math.round(vol)}`);

    // 死亡與 3 秒重生
    await cdp.evaluate(`(() => {
      const h = window.__HUSH__; const s = h.session;
      s.monster.x = s.player.x; s.monster.y = s.player.y;
      return true;
    })()`);
    await wait(500);
    const dead = await cdp.evaluate('window.__HUSH__?.session?.getState()?.status === "dead"');
    await cdp.screenshot('05-death');
    if (!dead) failures.push('怪物接觸未觸發死亡');
    await wait(3400);
    const alive = await cdp.evaluate('window.__HUSH__?.session?.getState()?.status === "playing"');
    if (!alive) failures.push('死亡後未在 3 秒重生');
    console.log('✓ 死亡與重生');

    // 第一章完成：依序傳送到所有物品與出口
    const complete = await cdp.evaluate(`(async () => {
      const s = window.__HUSH__.session;
      for (const it of s.getState().items) {
        s.teleport(it.x, it.y);
        await new Promise(r => setTimeout(r, 180));
      }
      const st = s.getState();
      s.teleport(st.exit.x, st.exit.y);
      await new Promise(r => setTimeout(r, 600));
      return s.getState().status;
    })()`);
    await wait(600);
    await cdp.screenshot('06-chapter-complete');
    if (complete !== 'complete') failures.push(`第一章未完成（status=${complete}）`);
    console.log(`✓ 第一章完成（${complete}）`);

    const hasCanvasPixels = await cdp.evaluate(`(() => {
      const c = document.getElementById('game-canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 40) if (d[i] + d[i+1] + d[i+2] > 12) lit++;
      return lit;
    })()`);
    if (hasCanvasPixels < 20) failures.push('canvas 幾乎沒有輸出像素');
    console.log(`✓ Canvas 輸出（亮點樣本 ${hasCanvasPixels}）`);

    const filtered = consoleErrors.filter((e) => e && !/favicon|Autoplay|AudioContext was not allowed/i.test(e));
    if (filtered.length) failures.push(`console error：${filtered.slice(0, 5).join(' | ')}`);

    ws.close();
  } catch (err) {
    failures.push(err.message);
    console.error(err);
  } finally {
    try { chrome?.kill(); } catch {}
    try { server.kill(); } catch {}
    if (!KEEP && tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n===== 瀏覽器煙霧測試 =====');
  if (failures.length) {
    console.error(`失敗 ${failures.length} 項：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('全部通過。截圖在 tests/artifacts/');
}

main();
