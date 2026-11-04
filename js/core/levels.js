// 《勿聲》HUSH — 關卡定義與地圖查詢（純邏輯，禁止 DOM）
// 地圖字元： # 牆、P 柱、. 地板、~ 積水、D 門、E 出口、S 出生、Q 安靜點、I 收集物、M 怪物出生、A 祭壇
//
// 座標一律使用「格中心」：格子 (cx,cy) 的中心 = (cx+0.5, cy+0.5)。
// getChapter() 每次都會從原始字串重新解析，回傳全新物件，避免跨局污染。

const RAW = [
  {
    id: 'ch1',
    name: '醒',
    subtitle: '地下鍋爐室',
    duration: 300,
    hearing: 1.0,
    sonarRange: 15,
    water: false,
    ambient: 'boiler',
    spawnAngle: 0,
    map: [
      '#################',
      '#S...#..#.......#',
      '#....#..#....I..#',
      '#....D..D.......#',
      '#.I..#..#.......#',
      '#....#..#.......#',
      '######..#########',
      '#....#..#..P....#',
      '#....#..#.......#',
      '#.Q..D..D...I...#',
      '#....#..#..M..Q.#',
      '#....#..#.......#',
      '######..#########',
      '#...............#',
      '#.............E.#',
      '#..Q............#',
      '#################',
    ],
    items: [
      { id: 'valve', x: 2, y: 4, label: '主壓力閥' },
      { id: 'coil', x: 13, y: 2, label: '點火線圈' },
      { id: 'gauge', x: 12, y: 9, label: '壓力錶' },
    ],
    quietPoints: [
      {
        id: 'q1-tape',
        x: 2,
        y: 9,
        title: '錄音帶 · 值班員',
        text: '「鍋爐壓力一直在掉。有人在夜裡把閥門一個一個關上，我沒聽見腳步聲。」',
      },
      {
        id: 'q1-radio',
        x: 14,
        y: 10,
        title: '無線電 · 雜訊',
        text: '「如果你聽見這段話，別回答。牠會把回聲當成邀請。」',
      },
      {
        id: 'q1-wall',
        x: 3,
        y: 15,
        title: '牆上的刻痕',
        text: '「安靜不是安全。安靜只是讓牠慢一點。」',
      },
    ],
    doors: [
      { id: 'd1-west', x: 5, y: 3, requires: ['valve'] },
      { id: 'd1-east', x: 8, y: 3, requires: ['valve'] },
      { id: 'd1-west-mid', x: 5, y: 9, requires: ['valve'] },
      { id: 'd1-east-mid', x: 8, y: 9, requires: ['coil'] },
    ],
    exit: { x: 14, y: 14, requires: ['valve', 'coil', 'gauge'] },
    altar: null,
    objectives: [
      { id: 'items', kind: 'items', text: '找回三個鍋爐零件', target: 3 },
      { id: 'quiet', kind: 'quiet', text: '在安靜點留下紀錄', target: 1 },
      { id: 'exit', kind: 'exit', text: '帶著零件離開鍋爐室', target: 1 },
    ],
    intro: {
      title: '醒',
      lines: [
        '你在地下鍋爐室醒來。手電筒壞了，只剩耳朵。',
        '低聲能照亮腳邊；安靜能讓牠慢下來。',
        '出聲，你才看得見。但牠也聽得見。',
      ],
    },
    outro: {
      title: '鍋爐停了',
      lines: ['最後一道閥門關上時，整棟樓安靜得不自然。', '走廊另一端，有東西在模仿你的呼吸。'],
    },
    hints: [
      { at: 8, text: '低聲（21–55）能照亮腳邊，但會在地面留下聲紋。' },
      { at: 32, text: '氣息歸零時你會被迫喘氣——那聲音也會引來牠。' },
      { at: 75, text: '安靜點會記錄重生位置，並回復一點氣息。' },
    ],
    visual: { wall: '#8fd6c9', water: '#2f6f7a', accent: '#ffcf7a', fog: '#04070a' },
  },

  {
    id: 'ch2',
    name: '走廊',
    subtitle: '療養院主棟',
    duration: 480,
    hearing: 1.1,
    sonarRange: 17,
    water: false,
    ambient: 'corridor',
    spawnAngle: 0,
    map: [
      '###################',
      '#S.....#...#......#',
      '#......#...#...I..#',
      '#......D...D......#',
      '#...I..#...#......#',
      '#......#...#....Q.#',
      '#......#...#......#',
      '########...########',
      '#...............M.#',
      '#.................#',
      '########...########',
      '#......#...#......#',
      '#......#...#....Q.#',
      '#......D...D......#',
      '#......#...#......#',
      '#...I..#...#...E..#',
      '#......#...#......#',
      '#.Q....#...#......#',
      '###################',
    ],
    items: [
      { id: 'badge', x: 4, y: 4, label: '員工識別證' },
      { id: 'tape', x: 15, y: 2, label: '廣播母帶' },
      { id: 'key', x: 4, y: 15, label: '水室鑰匙' },
    ],
    quietPoints: [
      {
        id: 'q2-radio',
        x: 16,
        y: 5,
        title: '廣播 · 三樓',
        text: '「三樓病患請回到房間。重複，請回到房間。不要回應走廊上的敲門聲。」',
      },
      {
        id: 'q2-tape',
        x: 16,
        y: 12,
        title: '錄音帶 · 護理師',
        text: '「我們試過所有人一起唱歌。牠停下來了，停了整整四秒。然後牠開始唱。」',
      },
      {
        id: 'q2-wall',
        x: 2,
        y: 17,
        title: '牆上的刻痕',
        text: '「牠不追人。牠追聲音。所以我們把聲音留在錯的地方。」',
      },
    ],
    doors: [
      { id: 'd2-nw', x: 7, y: 3, requires: ['badge'] },
      { id: 'd2-ne', x: 11, y: 3, requires: ['badge'] },
      { id: 'd2-sw', x: 7, y: 13, requires: ['tape'] },
      { id: 'd2-se', x: 11, y: 13, requires: ['key'] },
    ],
    exit: { x: 15, y: 15, requires: ['badge', 'tape', 'key'] },
    altar: null,
    objectives: [
      { id: 'items', kind: 'items', text: '取得三件院內物品', target: 3 },
      { id: 'quiet', kind: 'quiet', text: '找到一處安靜點', target: 1 },
      { id: 'exit', kind: 'exit', text: '前往水室入口', target: 1 },
    ],
    intro: {
      title: '走廊',
      lines: [
        '主棟的走廊比記憶中更長。廣播每隔一段時間就重播同一句話。',
        '大聲吼叫能震退靠近的牠；代價是整層樓都會知道你在哪。',
        '你也可以把聲紋留在反方向。牠只會沿著聲音走。',
      ],
    },
    outro: {
      title: '水聲',
      lines: ['你推開水室的鐵門。', '腳下傳來不該有的水聲——比你踏出的那一步，慢了一拍。'],
    },
    hints: [
      { at: 8, text: '尖叫（86 以上）能震退附近的牠，但會引來全區注意。' },
      { at: 40, text: '聲紋會留在地面。刻意在錯的方向出聲，可以誤導牠。' },
      { at: 90, text: '上鎖的門需要對應物品。留意安靜點附近的紀錄。' },
    ],
    visual: { wall: '#9fbfd0', water: '#2c5560', accent: '#ff9f6e', fog: '#05070b' },
  },

  {
    id: 'ch3',
    name: '水室',
    subtitle: '淹水的地下層',
    duration: 600,
    hearing: 1.15,
    sonarRange: 16,
    water: true,
    ambient: 'water',
    spawnAngle: 0,
    map: [
      '#####################',
      '#S...#~~~~~~P~~~~~~~#',
      '#...Q#~~~~~~~~~~~~~~#',
      '#....D~~~~~~~~~~~~~~#',
      '#..I.#~~~~~~~~~~.I..#',
      '#....#~~~~~~~~~~~~~~#',
      '######~~~~~~~~~~~~~~#',
      '######~~~~~~~~~~~~~~#',
      '######~~~~~~P~~~~M~~#',
      '######~~~~~~~~~~Q~~~#',
      '############D########',
      '#~~~~~~~~~~~~~~~~~~~#',
      '#~~~~P~~~~~~~~P~~~~~#',
      '#~~P~~~~~~P~~~~~~~~~#',
      '#~~~~~~~~~~~~~~P~~~~#',
      '#~~~~~~~~~~~~~~~~~~~#',
      '#~~~~~~~~~~~~~~~.Q.~#',
      '#~~~~~~~I~~~~~~~~~~~#',
      '#~~~~~~~~~~~~~~~~~E.#',
      '#~~~~~~~~~~~~~~~~~~~#',
      '#####################',
    ],
    items: [
      { id: 'valveA', x: 3, y: 4, label: '進水閥' },
      { id: 'valveB', x: 17, y: 4, label: '排水閥' },
      { id: 'valveC', x: 8, y: 17, label: '壓力閥' },
    ],
    quietPoints: [
      {
        id: 'q3-radio',
        x: 4,
        y: 2,
        title: '水面上的無線電',
        text: '「水位還在上升。聲音在水裡傳得比空氣遠，別讓牠聽見你以為很遠的聲音。」',
      },
      {
        id: 'q3-tape',
        x: 16,
        y: 9,
        title: '錄音帶 · 潛水員',
        text: '「我數過牠的腳步。四步、停、四步。停的時候，牠在聽水面的漣漪。」',
      },
      {
        id: 'q3-diary',
        x: 17,
        y: 16,
        title: '潮濕的日記',
        text: '「如果水開始震動，不要跑。跑動的水聲比吼叫更清楚。」',
      },
    ],
    doors: [
      { id: 'd3-gate', x: 5, y: 3, requires: ['valveA'] },
      { id: 'd3-flood', x: 12, y: 10, requires: ['valveB'] },
    ],
    exit: { x: 18, y: 18, requires: ['valveA', 'valveB', 'valveC'] },
    altar: null,
    objectives: [
      { id: 'items', kind: 'items', text: '關閉三個水閥', target: 3 },
      { id: 'quiet', kind: 'quiet', text: '在水室找到落腳處', target: 1 },
      { id: 'exit', kind: 'exit', text: '從排水口離開', target: 1 },
    ],
    intro: {
      title: '水室',
      lines: [
        '地下層泡在及膝的水裡。每一步都像在替自己報路。',
        '水面讓聲音傳得更遠，牠的聽覺也更靈敏。',
        '水裡移動較慢，聲紋停留更久。你留下的每一道回聲，都會比陸地上更難散去。',
      ],
    },
    outro: {
      title: '退水',
      lines: ['最後一個水閥關上，水位慢慢退去。', '中庭的鐘，自己響了一聲。'],
    },
    hints: [
      { at: 8, text: '水區讓牠的聽覺範圍變成 1.5 倍，聲紋也更持久。' },
      { at: 45, text: '涉水移動較慢。必要時停下來，讓氣息回復。' },
      { at: 100, text: '安靜點可以拉開距離，也能記錄重生位置。' },
    ],
    visual: { wall: '#7fd8e8', water: '#1f6f86', accent: '#b9f2ff', fog: '#03080c' },
  },

  {
    id: 'ch4',
    name: '聽者',
    subtitle: '教堂式中庭',
    duration: 600,
    hearing: 1.25,
    sonarRange: 19,
    water: false,
    ambient: 'atrium',
    spawnAngle: -Math.PI / 2,
    map: [
      '#######################',
      '#..........E..........#',
      '#.....................#',
      '###########D###########',
      '#....#.....M.....#....#',
      '#.I..#...........#..I.#',
      '#....D...........D....#',
      '#....#...........#....#',
      '#....#.....A.....#....#',
      '#....#...........#....#',
      '#....#...P...P...#....#',
      '#....#...........#....#',
      '#.Q..#...........#..Q.#',
      '#....#...........#....#',
      '#....#...P...P...#....#',
      '#....#.....I.....#....#',
      '#....#...........#....#',
      '#....#.....Q.....#....#',
      '#....#...........#....#',
      '#....#.....S.....#....#',
      '#....#...........#....#',
      '#....#...........#....#',
      '#######################',
    ],
    items: [
      { id: 'key', x: 11, y: 15, label: '執事鑰匙' },
      { id: 'roster', x: 2, y: 5, label: '唱詩班名冊' },
      { id: 'mallet', x: 20, y: 5, label: '鐘槌' },
    ],
    quietPoints: [
      {
        id: 'q4-tape',
        x: 11,
        y: 17,
        title: '錄音帶 · 最後一班',
        text: '「我們把鐘敲響，牠就會轉頭。但鐘聲只能騙牠一次。三次之後，牠會記住敲鐘的人。」',
      },
      {
        id: 'q4-radio',
        x: 2,
        y: 12,
        title: '鐘樓的廣播',
        text: '「中庭的祭壇是唯一能壓過牠的東西。連續三次，不能停。停下來的人，會被聽見。」',
      },
      {
        id: 'q4-prayer',
        x: 20,
        y: 12,
        title: '牆上的禱詞',
        text: '「願我們的声音足夠大，蓋過自己的心跳。」',
      },
    ],
    doors: [
      { id: 'd4-west', x: 5, y: 6, requires: ['key'] },
      { id: 'd4-east', x: 17, y: 6, requires: ['key'] },
      { id: 'd4-exit', x: 11, y: 3, requires: ['mallet'] },
    ],
    exit: { x: 11, y: 1, requires: ['key', 'roster', 'mallet'] },
    altar: { x: 11, y: 8, requiredShouts: 3 },
    objectives: [
      { id: 'items', kind: 'items', text: '取得三件聖物', target: 3 },
      { id: 'altar', kind: 'altar', text: '對祭壇連續吼叫三次', target: 3 },
      { id: 'exit', kind: 'exit', text: '在牠沉默時離開中庭', target: 1 },
    ],
    intro: {
      title: '聽者',
      lines: [
        '中庭的長椅全數朝向中央。祭壇上沒有神像，只有一口倒吊的鐘。',
        '牠在等。等一個足夠大的聲音，讓牠確定你在哪裡。',
        '對祭壇連續吼叫三次。用你的聲音，壓過牠的。',
      ],
    },
    outro: {
      title: '寂靜之後',
      lines: [
        '鐘聲停了。牠站在原地，像一尊終於想起自己形狀的雕像。',
        '你走出中庭。門在身後闔上，沒有發出任何聲音。',
        '這一次，安靜是你的。',
      ],
    },
    hints: [
      { at: 8, text: '靠近祭壇，連續尖叫三次。每次吼叫都會震退牠。' },
      { at: 35, text: '牠就在中庭。必要時先繞開，取得三件聖物。' },
      { at: 80, text: '出口需要三件聖物，也需要牠被壓制。' },
    ],
    visual: { wall: '#cfe6f2', water: '#33566b', accent: '#ff6b7f', fog: '#06060a' },
  },
];

const WALKABLE = new Set(['.', '~', 'D', 'E', 'S', 'Q', 'I', 'M', 'A']);
const SOLID = new Set(['#', 'P']);
const ENTITY_CHARS = {
  S: 'spawn',
  M: 'monster',
  I: 'item',
  Q: 'quiet',
  D: 'door',
  E: 'exit',
  A: 'altar',
};

function cellKey(cx, cy) {
  return `${cx},${cy}`;
}

function keyFromPoint(x, y) {
  return cellKey(Math.floor(x), Math.floor(y));
}

/**
 * 解析單一章節。每次呼叫都回傳全新物件。
 * @param {number} index 0..3
 */
export function getChapter(index = 0) {
  const safe = Math.max(0, Math.min(RAW.length - 1, Number(index) | 0));
  const def = RAW[safe];
  const rows = def.map;
  const height = rows.length;
  const width = rows[0].length;

  for (let y = 0; y < height; y += 1) {
    if (rows[y].length !== width) {
      throw new Error(`關卡 ${def.id} 第 ${y} 列寬度 ${rows[y].length}，應為 ${width}`);
    }
  }
  for (let x = 0; x < width; x += 1) {
    if (rows[0][x] !== '#' || rows[height - 1][x] !== '#') {
      throw new Error(`關卡 ${def.id} 最外圈必須是牆（x=${x}）`);
    }
  }
  for (let y = 0; y < height; y += 1) {
    if (rows[y][0] !== '#' || rows[y][width - 1] !== '#') {
      throw new Error(`關卡 ${def.id} 最外圈必須是牆（y=${y}）`);
    }
  }

  const grid = rows.map((row) => row.split(''));
  const found = { S: [], M: [], I: [], Q: [], D: [], E: [], A: [] };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ch = grid[y][x];
      if (Object.prototype.hasOwnProperty.call(found, ch)) found[ch].push({ x, y });
      if (!WALKABLE.has(ch) && !SOLID.has(ch)) {
        throw new Error(`關卡 ${def.id} 有未知地圖字元「${ch}」於 (${x},${y})`);
      }
    }
  }

  // 宣告的實體必須與地圖字元一致。
  const expectChar = (list, ch, kind) => {
    for (const e of list) {
      const row = grid[e.y];
      if (!row || row[e.x] !== ch) {
        const actual = row && row[e.x] !== undefined ? row[e.x] : '越界';
        throw new Error(`關卡 ${def.id} 的 ${kind} ${e.id || `${e.x},${e.y}`} 應在 (${e.x},${e.y}) 為「${ch}」，實際為「${actual}」`);
      }
    }
  };
  expectChar(def.items, 'I', 'item');
  expectChar(def.quietPoints, 'Q', 'quietPoint');
  expectChar(def.doors, 'D', 'door');
  expectChar(def.altar ? [def.altar] : [], 'A', 'altar');
  expectChar([def.exit], 'E', 'exit');
  expectChar([{ x: found.S[0]?.x ?? -1, y: found.S[0]?.y ?? -1 }], 'S', 'spawn');

  if (found.S.length !== 1) throw new Error(`關卡 ${def.id} 必須恰好有一個 S`);
  if (found.M.length < 1) throw new Error(`關卡 ${def.id} 至少需要一個 M`);
  if (found.I.length !== def.items.length) throw new Error(`關卡 ${def.id} 的 I 數量與 items 不一致`);
  if (found.Q.length !== def.quietPoints.length) throw new Error(`關卡 ${def.id} 的 Q 數量與 quietPoints 不一致`);
  if (found.D.length !== def.doors.length) throw new Error(`關卡 ${def.id} 的 D 數量與 doors 不一致`);
  if (found.E.length !== 1) throw new Error(`關卡 ${def.id} 必須恰好有一個 E`);
  if (found.A.length !== (def.altar ? 1 : 0)) throw new Error(`關卡 ${def.id} 的 A 數量與 altar 不一致`);

  const spawnCell = found.S[0];
  const spawn = { x: spawnCell.x + 0.5, y: spawnCell.y + 0.5, angle: def.spawnAngle || 0 };

  const level = {
    index: safe,
    id: def.id,
    name: def.name,
    subtitle: def.subtitle,
    duration: def.duration,
    hearing: def.hearing,
    sonarRange: def.sonarRange,
    water: def.water,
    ambient: def.ambient,
    width,
    height,
    grid,
    spawn,
    monsterSpawns: found.M.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 })),
    items: def.items.map((it) => ({ ...it, x: it.x + 0.5, y: it.y + 0.5 })),
    quietPoints: def.quietPoints.map((q) => ({ ...q, x: q.x + 0.5, y: q.y + 0.5 })),
    doors: def.doors.map((d) => ({ ...d, requires: [...d.requires], x: d.x + 0.5, y: d.y + 0.5 })),
    exit: { ...def.exit, requires: [...def.exit.requires], x: def.exit.x + 0.5, y: def.exit.y + 0.5 },
    altar: def.altar
      ? { ...def.altar, x: def.altar.x + 0.5, y: def.altar.y + 0.5 }
      : null,
    objectives: def.objectives.map((o) => ({ ...o })),
    intro: { title: def.intro.title, lines: [...def.intro.lines] },
    outro: { title: def.outro.title, lines: [...def.outro.lines] },
    hints: def.hints.map((h) => ({ ...h })),
    visual: { ...def.visual },
    /** 由 session 維護：已開啟的門（cell key 集合）。預設全部關閉。 */
    doorsOpen: new Set(),
  };

  level.tileAt = (x, y) => tileAt(level, x, y);
  level.isSolid = (x, y) => isSolid(level, x, y);
  level.isWalkable = (x, y, opts) => isWalkable(level, x, y, opts);

  return level;
}

/** 回傳地圖字元；越界視為牆。 */
export function tileAt(level, x, y) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (!level || !level.grid || cx < 0 || cy < 0 || cx >= level.width || cy >= level.height) return '#';
  return level.grid[cy][cx];
}

export function isSolid(level, x, y) {
  return SOLID.has(tileAt(level, x, y));
}

/**
 * 是否可通行。
 * opts.doorsOpen 可為 true / false / Set<"cx,cy">。
 * 未指定時：若 level.doorsOpen 存在則沿用（session 會設定），否則視為全部開啟。
 */
export function isWalkable(level, x, y, opts = {}) {
  const tile = tileAt(level, x, y);
  if (SOLID.has(tile)) return false;
  if (!WALKABLE.has(tile)) return false;
  if (tile !== 'D') return true;

  let doorsOpen = opts.doorsOpen;
  if (doorsOpen === undefined) {
    doorsOpen = level.doorsOpen !== undefined ? level.doorsOpen : true;
  }
  if (doorsOpen === true) return true;
  if (doorsOpen === false || doorsOpen == null) return false;
  if (typeof doorsOpen.has === 'function') {
    return doorsOpen.has(keyFromPoint(x, y));
  }
  return false;
}

/** BFS：回傳不含起點、含終點的格中心路徑；找不到回 []。 */
export function findPath(level, start, goal, opts = {}) {
  if (!level || !start || !goal) return [];
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const gx = Math.floor(goal.x);
  const gy = Math.floor(goal.y);
  if (sx === gx && sy === gy) return [];
  if (!isWalkable(level, gx + 0.5, gy + 0.5, opts)) return [];

  const width = level.width;
  const height = level.height;
  const total = width * height;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const startIdx = sy * width + sx;
  const goalIdx = gy * width + gx;
  seen[startIdx] = 1;
  queue[tail++] = startIdx;

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (head < tail) {
    const cur = queue[head++];
    if (cur === goalIdx) break;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (let i = 0; i < dirs.length; i += 1) {
      const nx = cx + dirs[i][0];
      const ny = cy + dirs[i][1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (seen[ni]) continue;
      if (!isWalkable(level, nx + 0.5, ny + 0.5, opts)) continue;
      seen[ni] = 1;
      prev[ni] = cur;
      queue[tail++] = ni;
    }
  }

  if (!seen[goalIdx]) return [];
  const cells = [];
  let cur = goalIdx;
  while (cur !== startIdx && cur !== -1) {
    const cx = cur % width;
    const cy = (cur - cx) / width;
    cells.push({ x: cx + 0.5, y: cy + 0.5 });
    cur = prev[cur];
  }
  cells.reverse();
  return cells;
}

/** 方便測試／工具使用：回傳章節基本資料（不含地圖）。 */
export const CHAPTERS = RAW.map((c) => ({
  id: c.id,
  name: c.name,
  subtitle: c.subtitle,
  duration: c.duration,
  hearing: c.hearing,
  sonarRange: c.sonarRange,
  water: c.water,
  ambient: c.ambient,
}));

export const CHAPTER_COUNT = RAW.length;
