// 自动对弈机器人 / 测试操作工具。
// 用法:
//   node tools/bot.js <对局页URL>        单个机器人
//   node tools/bot.js <base> <gameId> <seat> <token>
// 作为模块导出 Bot 类供集成测试用：SSE 事件驱动、断线重连、幂等重发都走真实协议。
import { randomUUID } from 'node:crypto';

// ---- 极简 SSE 客户端（Node 20 fetch ReadableStream） ----
export async function sseOpen(base, gameId, seat, token, handler) {
  const ctrl = new AbortController();
  const resp = await fetch(
    `${base}/api/games/${gameId}/events?seat=${seat}&token=${encodeURIComponent(token)}`,
    { headers: { accept: 'text/event-stream' }, signal: ctrl.signal },
  );
  if (!resp.ok || !resp.body) throw new Error('SSE 连接失败 ' + resp.status);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let closed = false;

  (async () => {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (data) {
            try { handler(event, JSON.parse(data)); } catch (e) { console.error('SSE handler', e); }
          }
        }
      }
    } catch { /* abort */ }
    handler('__close', {});
  })();

  return {
    close() { closed = true; ctrl.abort(); reader.cancel().catch(() => {}); },
    get closed() { return closed; },
  };
}

export class Bot {
  constructor(base, gameId, seat, token, opts = {}) {
    this.base = base;
    this.gameId = gameId;
    this.seat = seat;
    this.token = token;
    this.thinkMs = opts.thinkMs ?? 30;
    this.toxinRate = opts.toxinRate ?? 0.15;
    this.snapshot = null;
    this.ended = false;
    this.moves = 0;
    this.endEvent = null;
    this.conn = null;
    this.acting = false;
    this.random = opts.seed ? mulberry(opts.seed) : Math.random;
  }

  async connect() {
    this.conn = await sseOpen(this.base, this.gameId, this.seat, this.token, (ev, d) => this.on(ev, d));
  }
  disconnect() { this.conn?.close(); this.conn = null; }
  async reconnect() { this.disconnect(); await this.connect(); }

  on(ev, d) {
    if (ev === '__close') return;
    if (ev === 'snapshot') {
      this.snapshot = d;
      if (d.state.status === 'finished') { this.ended = true; this.endEvent = { winner: d.state.winner, reason: d.state.winReason }; }
    } else if (ev === 'move') {
      this.snapshot = { ...this.snapshot, state: d.state, turn: d.turn };
    } else if (ev === 'turn') {
      if (this.snapshot) this.snapshot.turn = d;
    } else if (ev === 'end') {
      this.ended = true;
      this.endEvent = d;
    }
    this.maybeAct();
  }

  maybeAct() {
    if (this.acting || this.ended || !this.snapshot) return;
    const { state, turn } = this.snapshot;
    if (!state || state.status !== 'playing' || turn?.current !== this.seat) return;
    this.acting = true;
    const delay = this.thinkMs;
    setTimeout(() => {
      this.acting = false;
      this.playOne().catch(() => {});
    }, delay);
  }

  choose() {
    const { state, turn } = this.snapshot;
    const grows = turn.legal.grows;
    const toxins = turn.legal.toxins;
    if (!grows.length) {
      return toxins.length ? { kind: 'toxin', ...pick(toxins, this.random) } : null;
    }
    // 优先吃营养点
    for (const [x, y] of grows) {
      if (state.nutrients[y * state.size + x]) return { kind: 'grow', x, y };
    }
    // 偶尔在对方逼近时分泌抗菌素
    if (toxins.length && this.random() < this.toxinRate) {
      return { kind: 'toxin', ...pick(toxins, this.random) };
    }
    // 向中央 + 向对方推进的方向生长（有偏好的随机）
    const cx = (state.size - 1) / 2;
    const dir = this.seat === 0 ? 1 : -1;
    const scored = grows.map(([x, y]) => {
      const toward = this.seat === 0 ? x : state.size - 1 - x;
      const center = -Math.abs(y - cx);
      const jitter = this.random() * 2;
      return { x, y, s: toward * 2 + center + jitter };
    });
    scored.sort((a, b) => b.s - a.s);
    return { kind: 'grow', x: scored[0].x, y: scored[0].y };
  }

  async playOne(moveId = randomUUID()) {
    const mv = this.choose();
    if (!mv) return null;
    return this.submit(moveId, mv);
  }

  // 直接提交（测试里可以传固定 moveId 做幂等验证）
  async submit(moveId, mv) {
    const r = await fetch(`${this.base}/api/games/${this.gameId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.token, moveId, ...mv }),
    });
    const ack = await r.json();
    if (ack.ok) this.moves++;
    return ack;
  }

  waitForEnd(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.ended) { clearInterval(iv); resolve(this.endEvent); }
        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('等待终局超时')); }
      }, 20);
    });
  }
}

function pick(arr, rnd) {
  const [x, y] = arr[Math.floor(rnd() * arr.length)];
  return { x, y };
}
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- CLI ----
async function main() {
  const args = process.argv.slice(2);
  let base, gameId, seat, token;
  const m = args[0]?.match(/^(https?:\/\/[^/]+)\/\?game=([0-9a-f]+)&seat=(\d+)&token=(.+)$/);
  if (m) {
    [, base, gameId, seat, token] = m;
  } else if (args.length >= 4) {
    [base, gameId, seat, token] = args;
  } else {
    console.log('用法: node tools/bot.js <对局页URL>  或  node tools/bot.js <base> <gameId> <seat> <token>');
    process.exit(2);
  }
  const bot = new Bot(base, gameId, +seat, token);
  await bot.connect();
  bot.waitForEnd(3600_000).then((e) => {
    console.log(`终局: winner=${e.winner} reason=${e.reason} 本bot落子 ${bot.moves}`);
    process.exit(0);
  });
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(console.error);
