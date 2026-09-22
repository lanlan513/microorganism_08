// 菌落抢地盘 —— 纯规则引擎（零依赖、无副作用、确定性）。
// 服务端裁决、CLI 回放校验、浏览器回放页共用这同一份代码，
// 保证同一盘棋在任何地方重放出来的结果完全一致。

export const EMPTY = 0;
export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const DEFAULTS = {
  size: 16,        // 棋盘边长（格）
  nutrients: 12,   // 营养点数量（镜像对称撒布，保证公平）
  toxinTTL: 6,     // 抗菌素持续多少 ply
  maxChain: 3,     // 一回合内最多囤积的连击数（吃营养获得）
  thinkMs: 20000,  // 每手思考时限（服务端权威时钟）
  graceMs: 300,    // 超时宽限（补偿网络在途时间）
  forfeitMs: 30000,// 断线宽限：超过判负
  maxPlies: 4000,  // 兜底手数上限，到上限按地盘结算
};

// mulberry32 —— 确定性伪随机，只用于开局撒营养点
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGame(opts = {}) {
  const size = opts.size ?? DEFAULTS.size;
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const rng = mulberry32(seed);
  const cells = new Array(size * size).fill(EMPTY);
  const nutrients = new Array(size * size).fill(0);
  const mid = size >> 1;
  // 两株菌分别落在培养皿左右两端
  cells[mid * size + 1] = 1;
  cells[mid * size + (size - 2)] = 2;
  // 镜像对称撒营养点
  const want = opts.nutrients ?? DEFAULTS.nutrients;
  let placed = 0, guard = 0;
  while (placed < want && guard++ < 20000) {
    const x = 1 + Math.floor(rng() * (size - 2));
    const y = Math.floor(rng() * size);
    for (const [cx, cy] of [[x, y], [size - 1 - x, size - 1 - y]]) {
      if (placed >= want) break;
      const i = cy * size + cx;
      if (cells[i] === EMPTY && !nutrients[i]) { nutrients[i] = 1; placed++; }
    }
  }
  return {
    size, seed,
    cells, nutrients,
    toxinOwner: new Array(size * size).fill(0), // 0=无 1/2=属于谁
    toxinUntil: new Array(size * size).fill(0), // 抗菌素失效的 ply 序号
    seats: opts.seats ?? ['P1', 'P2'],
    current: 0,          // 当前行动方（座位号 0/1）
    chainLeft: 0,        // 本回合剩余连击数
    ply: 0,              // 已执行的 ply 数
    counts: [1, 1],      // 双方占地
    emptyLeft: size * size - 2,
    maxChain: opts.maxChain ?? DEFAULTS.maxChain,
    toxinTTL: opts.toxinTTL ?? DEFAULTS.toxinTTL,
    maxPlies: opts.maxPlies ?? DEFAULTS.maxPlies,
    status: 'playing',   // playing | finished
    winner: null,        // 0 | 1 | 'draw'
    winReason: null,     // encircle | territory | cap | timeout | forfeit | stalemate
    noGrowStreak: 0,     // 连续多少手没有生长（用于终结"毒战僵局"）
    noGrowLimit: opts.noGrowLimit ?? DEFAULTS.toxinTTL * 2 + 4,
  };
}

export function inBounds(size, x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size;
}

function adjacentOwn(state, x, y, me) {
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (inBounds(state.size, nx, ny) && state.cells[ny * state.size + nx] === me) return true;
  }
  return false;
}

// 抗菌素只压制对手，不挡自己
export function toxinBlocks(state, i, me) {
  return state.toxinUntil[i] > state.ply && state.toxinOwner[i] !== EMPTY && state.toxinOwner[i] !== me;
}

// 某座位的全部合法手：grows=可生长的空格，toxins=可分泌抗菌素的己方细胞
export function legalMoves(state, seat) {
  const me = seat + 1;
  const size = state.size;
  const grows = [];
  const growSet = new Set();
  const toxins = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (state.cells[i] !== me) continue;
      let toxinUseful = false;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(size, nx, ny)) continue;
        const j = ny * size + nx;
        if (state.cells[j] !== EMPTY) continue;
        if (!(state.toxinUntil[j] > state.ply && state.toxinOwner[j] === me)) {
          toxinUseful = true; // 存在能新扩张抗菌素的空邻居
        }
        if (!toxinBlocks(state, j, me) && !growSet.has(j)) {
          growSet.add(j);
          grows.push([nx, ny]);
        }
      }
      if (toxinUseful) toxins.push([x, y]);
    }
  }
  return { grows, toxins };
}

export function hasAnyMove(state, seat) {
  const { grows, toxins } = legalMoves(state, seat);
  return grows.length > 0 || toxins.length > 0;
}

/**
 * 裁决一手。move = { seat, kind: 'grow'|'toxin', x, y }
 * 返回 { ok:true, events:[...] } 或 { ok:false, reason }。
 * 成功时原地修改 state —— 服务端持有权威状态，回放时从 init 重新折叠。
 */
export function applyMove(state, move) {
  if (state.status !== 'playing') return { ok: false, reason: 'finished' };
  const { seat, kind, x, y } = move;
  if (seat !== state.current) return { ok: false, reason: 'not-your-turn' };
  const size = state.size;
  if (!inBounds(size, x, y)) return { ok: false, reason: 'out-of-bounds' };
  const i = y * size + x;
  const me = seat + 1;
  const events = [];

  if (kind === 'grow') {
    if (state.cells[i] !== EMPTY) return { ok: false, reason: 'occupied' };
    if (toxinBlocks(state, i, me)) return { ok: false, reason: 'blocked-by-toxin' };
    if (!adjacentOwn(state, x, y, me)) return { ok: false, reason: 'not-adjacent' };
    state.cells[i] = me;
    state.counts[seat]++;
    state.emptyLeft--;
    let nutrient = false;
    if (state.nutrients[i]) {
      state.nutrients[i] = 0;
      nutrient = true;
      state.chainLeft = Math.min(state.chainLeft + 1, state.maxChain);
    }
    events.push({ type: 'grow', seat, x, y, nutrient });
    state.lastGrew = true;
  } else if (kind === 'toxin') {
    if (state.cells[i] !== me) return { ok: false, reason: 'not-own-cell' };
    const targets = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(size, nx, ny)) continue;
      const j = ny * size + nx;
      if (state.cells[j] !== EMPTY) continue;
      // 只算"新扩张"的格子：未被自己抗菌素覆盖的空格才算合法目标。
      // 不允许在已控制的格子上反复续期空刷（否则双方被围死时会无限刷毒）。
      if (state.toxinUntil[j] > state.ply && state.toxinOwner[j] === me) continue;
      targets.push([nx, ny]);
    }
    if (!targets.length) return { ok: false, reason: 'no-target' };
    for (const [nx, ny] of targets) {
      const j = ny * size + nx;
      state.toxinOwner[j] = me;
      state.toxinUntil[j] = state.ply + state.toxinTTL;
    }
    events.push({ type: 'toxin', seat, x, y, targets });
    state.lastGrew = false;
  } else {
    return { ok: false, reason: 'bad-kind' };
  }

  advance(state);
  if (state.status === 'finished') {
    events.push({ type: 'end', winner: state.winner, reason: state.winReason });
  }
  return { ok: true, events };
}

// 一手落完后推进：结算连锁、交接回合、判定围死/占满
function advance(state) {
  state.ply++;
  state.noGrowStreak = state.lastGrew ? 0 : state.noGrowStreak + 1;
  if (state.emptyLeft === 0) return finishTerritory(state, 'territory');
  if (state.ply >= state.maxPlies) return finishTerritory(state, 'cap');
  if (state.noGrowStreak >= state.noGrowLimit) return finishTerritory(state, 'stalemate');
  if (state.chainLeft > 0) {
    state.chainLeft--;
    if (hasAnyMove(state, state.current)) return; // 连击继续
    state.chainLeft = 0;                          // 无处可长，连击作废
  }
  state.current = 1 - state.current;
  if (!hasAnyMove(state, state.current)) {
    // 轮到的一方没有任何合法手 —— 被围死
    finish(state, 1 - state.current, 'encircle');
  }
}

function finish(state, winner, reason) {
  state.status = 'finished';
  state.winner = winner;
  state.winReason = reason;
}

function finishTerritory(state, reason) {
  const [a, b] = state.counts;
  finish(state, a === b ? 'draw' : (a > b ? 0 : 1), reason);
}

// 外部原因终局（超时 / 断线弃赛），由服务端调用
export function finishExternal(state, winner, reason) {
  if (state.status !== 'playing') return false;
  finish(state, winner, reason);
  return true;
}

// FNV-1a 32bit —— 状态指纹，写进每条日志，回放时逐手校验
export function stateHash(state) {
  const s = [
    state.size,
    state.cells.join(''),
    state.nutrients.join(''),
    state.toxinOwner.join(''),
    state.toxinUntil.join(','),
    state.current, state.chainLeft, state.ply,
    state.noGrowStreak, state.lastGrew ? 1 : 0,
    state.counts[0], state.counts[1],
    state.status, state.winner ?? '-', state.winReason ?? '-',
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
