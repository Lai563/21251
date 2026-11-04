// 靜態檢查：檔案完整性、HTML 必要 id、外部資源、JS 語法。
// 執行：npm run check
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

const REQUIRED = [
  'index.html', 'styles.css', 'package.json',
  'js/core/config.js', 'js/core/volume.js', 'js/core/breath.js', 'js/core/trail.js',
  'js/core/player.js', 'js/core/raycast.js', 'js/core/levels.js', 'js/core/monster.js', 'js/core/session.js',
  'js/audio.js', 'js/input.js', 'js/audio-feedback.js', 'js/renderer.js', 'js/ui.js', 'js/game.js',
];

const IDS = [
  'app', 'game-canvas', 'hud', 'volume-ring', 'volume-value', 'volume-label', 'breath-fill',
  'breath-value', 'chapter-name', 'objective-text', 'subtitle', 'danger-vignette', 'hint',
  'screen-start', 'screen-calibration', 'screen-pause', 'screen-death', 'screen-chapter', 'screen-ending',
  'settings-panel', 'btn-start', 'btn-calibrate', 'btn-skip-calibration', 'btn-resume', 'btn-restart',
  'btn-settings', 'btn-next-chapter', 'btn-replay', 'btn-mic-retry', 'mic-status',
];

for (const rel of REQUIRED) {
  if (!existsSync(path.join(ROOT, rel))) errors.push(`缺少檔案：${rel}`);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

for (const file of walk(path.join(ROOT, 'js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    errors.push(`語法錯誤：${path.relative(ROOT, file)}\n${err.stderr?.toString() || err.message}`);
  }
}

const html = existsSync(path.join(ROOT, 'index.html')) ? readFileSync(path.join(ROOT, 'index.html'), 'utf8') : '';
for (const id of IDS) {
  if (!new RegExp(`id=["']${id}["']`).test(html)) errors.push(`index.html 缺少 id="${id}"`);
}
if (!/src=["']js\/game\.js["']/.test(html)) errors.push('index.html 未載入 js/game.js');
if (!/href=["']styles\.css["']/.test(html)) errors.push('index.html 未載入 styles.css');

const browserFiles = ['index.html', 'styles.css', ...walk(path.join(ROOT, 'js')).map((f) => path.relative(ROOT, f))];
for (const rel of browserFiles) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  for (const url of matches) {
    if (/localhost|127\.0\.0\.1|w3\.org/.test(url)) continue;
    errors.push(`外部網路資源：${rel} → ${url}`);
  }
}

if (!existsSync(path.join(ROOT, 'tests', 'unit'))) warnings.push('尚未建立 tests/unit');
if (!existsSync(path.join(ROOT, 'tests', 'integration'))) warnings.push('尚未建立 tests/integration');

console.log('《勿聲》HUSH 靜態檢查');
console.log(`檔案：${REQUIRED.length} 項必要檔案`);
console.log(`JS：${walk(path.join(ROOT, 'js')).length} 個檔案語法檢查`);
console.log(`HTML：${IDS.length} 個必要 id`);
if (warnings.length) {
  console.log('\n警告：');
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.error('\n失敗：');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n通過。');
