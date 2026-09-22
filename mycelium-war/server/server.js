// 服务端：权威主持对局。
// - 客户端只画结果：落子顺序、思考时限、胜负判定全部在这里裁决
// - SSE 广播局面，POST 提交落子；每次广播携带 serverNow 供客户端校准时钟
// - 全部事件追加写入 logs/<gameId>.jsonl，可完整重放
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as engine from '../shared/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOGS_DIR = process.env.LOGS_DIR || path.join(ROOT, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 8) => crypto.randomBytes(n).toString('hex');
const num = (v, dflt) => (Number.isFinite(+v) && +v >= 0 ? +v : dflt);

class Room {
  constructor(opts = {}) {
    this.id = rand(4);
    this.config = {
      thinkMs: num(opts.thinkMs, engine.DEFAULTS.thinkMs),
      graceMs: num(opts.graceMs, engine.DEFAULTS.graceMs),
      forfeitMs: num(opts.forfeitMs, engine.DEFAULTS.forfeitMs),
      latencyMs: num(opts.latencyMs, 0), // 模拟弱网：入站/出站各延迟这么多
    };
    this.state = engine.createGame(opts);
    this.tokens = [rand(8), rand(8)];
    this.clients = [new Set(), new Set()]; // 每座位的 SSE 连接
    this.connected = [false, false];
    this.seenMoves = new Map();            // moveId -> ack（幂等去重）
    this.seq = 0;
    this.clockArmed = false;               // 双方都连上后才启动时钟
    this.deadline = null;                  // 当前手的截止时间（服务端时钟）
    this.turnTimer = null;
    this.frozenRemaining = null;           // 断线冻结时剩余的思考时间
    this.forfeitTimers = [null, null];
    this.createdAt = Date.now();
    this.logPath = path.join(LOGS_DIR, `${this.id}.jsonl`);
    this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.logEvent('init', {
      seed: this.state.seed,
      size: this.state.size,
      seats: this.state.seats,
      config: this.config,
      maxChain: this.state.maxChain,
      toxinTTL: this.state.toxinTTL,
      maxPlies: this.state.maxPlies,
      nutrients: this.state.nutrients.reduce((a, b) => a + b, 0),
      hash: engine.stateHash(this.state),
    });
  }

  logEvent(type, data) {
    const rec = { seq: ++this.seq, t: Date.now(), type, ...data };
    this.logStream.write(JSON.stringify(rec) + '\n');
    return rec;
  }

  // 广播给两个座位；latencyMs 模拟弱网 outbound 延迟
  emit(type, data, { broadcast = true } = {}) {
    const rec = this.logEvent(type, data);
    if (!broadcast) return rec;
    const msg = `event: ${type}\ndata: ${JSON.stringify(rec)}\n\n`;
    const send = () => {
      for (const set of this.clients) {
        for (const res of set) {
          try { res.write(msg); } catch { /* 连接已断 */ }
        }
      }
    };
    if (this.config.latencyMs) setTimeout(send, this.config.latencyMs);
    else send();
    return rec;
  }

  turnPayload() {
    return {
      serverNow: Date.now(),
      current: this.state.current,
      chainLeft: this.state.chainLeft,
      clockArmed: this.clockArmed,
      deadline: this.clockArmed ? this.deadline : null,
      frozenRemaining: this.clockArmed ? this.frozenRemaining : null,
      legal: this.state.status === 'playing'
        ? engine.legalMoves(this.state, this.state.current)
        : { grows: [], toxins: [] },
      counts: this.state.counts,
    };
  }

  snapshot(seat) {
    return {
      state: this.state,
      seat,
      connected: this.connected,
      config: this.config,
      hash: engine.stateHash(this.state),
      turn: this.turnPayload(),
      serverNow: Date.now(),
    };
  }

  // 为当前行动方上弦计时；断线则冻结
  armTurn({ announce = false } = {}) {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (this.state.status !== 'playing' || !this.clockArmed) return;
    const cur = this.state.current;
    if (!this.connected[cur]) {
      if (this.frozenRemaining == null) {
        this.frozenRemaining = this.deadline
          ? Math.max(0, this.deadline - Date.now())
          : this.config.thinkMs;
      }
      this.deadline = null;
      return;
    }
    const think = this.frozenRemaining ?? this.config.thinkMs;
    this.frozenRemaining = null;
    this.deadline = Date.now() + think;
    this.turnTimer = setTimeout(() => this.onTimeout(), think + this.config.graceMs);
    if (announce) this.emit('turn', this.turnPayload());
  }

  onTimeout() {
    if (this.state.status !== 'playing') return;
    const loser = this.state.current;
    if (!this.connected[loser]) return; // 断线者时钟已冻结，双保险
    if (!engine.finishExternal(this.state, 1 - loser, 'timeout')) return;
    this.logEvent('timeout', { loser });
    this.emit('end', {
      winner: 1 - loser, reason: 'timeout',
      hash: engine.stateHash(this.state), state: this.state, serverNow: Date.now(),
    });
    this.clearTimers();
  }

  onForfeit(seat) {
    if (this.connected[seat] || this.state.status !== 'playing') return;
    if (!engine.finishExternal(this.state, 1 - seat, 'forfeit')) return;
    this.emit('end', {
      winner: 1 - seat, reason: 'forfeit',
      hash: engine.stateHash(this.state), state: this.state, serverNow: Date.now(),
    });
    this.clearTimers();
  }

  clearTimers() {
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    for (let s = 0; s < 2; s++) {
      clearTimeout(this.forfeitTimers[s]);
      this.forfeitTimers[s] = null;
    }
  }

  onConnect(seat, res) {
    this.clients[seat].add(res);
    this.connected[seat] = true;
    clearTimeout(this.forfeitTimers[seat]);
    this.forfeitTimers[seat] = null;
    if (!this.clockArmed && this.connected[0] && this.connected[1]) {
      this.clockArmed = true; // 人齐，时钟启动
      if (this.state.status === 'playing') this.armTurn({ announce: true });
    }
    // 断线重连：若正轮到TA且时钟被冻结，用冻结的剩余时间恢复
    if (this.clockArmed && this.state.status === 'playing'
        && this.state.current === seat && this.deadline == null) {
      this.armTurn({ announce: true });
    }
    this.emit('presence', { connected: this.connected, seat, serverNow: Date.now() });
  }

  onDisconnect(seat, res) {
    this.clients[seat].delete(res);
    if (this.clients[seat].size > 0) return; // 同座位还有别的标签页
    this.connected[seat] = false;
    // 若正轮到TA：冻结思考时钟（剩余时间封存，回来接着用）
    if (this.state.status === 'playing' && this.clockArmed
        && this.state.current === seat && this.deadline != null) {
      this.frozenRemaining = Math.max(0, this.deadline - Date.now());
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
      this.deadline = null;
    }
    this.forfeitTimers[seat] = setTimeout(() => this.onForfeit(seat), this.config.forfeitMs);
    this.emit('presence', {
      connected: this.connected, seat,
      forfeitAt: Date.now() + this.config.forfeitMs,
      serverNow: Date.now(),
    });
  }

  async handleMove(seat, body) {
    const { moveId, kind, x, y } = body ?? {};
    if (typeof moveId !== 'string' || !moveId || moveId.length > 80) {
      return { http: 400, ack: { ok: false, reason: 'bad-move-id' } };
    }
    // 幂等：同一 moveId 重复提交（哪怕并发）只裁决一次。
    // 已完成 -> 直接回放首次结果；处理中 -> 共享同一处理承诺。
    const seen = this.seenMoves.get(moveId);
    if (seen) {
      if (seen.pending) return seen.pending;
      return { http: 200, ack: { ...seen.ack, duplicate: true } };
    }
    const pending = this.processMove(seat, { moveId, kind, x, y });
    this.seenMoves.set(moveId, { pending });
    const result = await pending;
    this.seenMoves.set(moveId, { ack: result.ack });
    return result;
  }

  async processMove(seat, { moveId, kind, x, y }) {
    if (this.config.latencyMs) await sleep(this.config.latencyMs); // 模拟弱网 inbound

    const t0 = performance.now();
    const now = Date.now();
    let ack;

    if (this.state.status !== 'playing') {
      ack = { ok: false, reason: 'finished', serverNow: now };
    } else if (seat !== this.state.current) {
      ack = { ok: false, reason: 'not-your-turn', serverNow: now, ply: this.state.ply };
    } else if (this.clockArmed && this.deadline != null && now > this.deadline) {
      // 超过截止时间：以服务端收到请求的时刻为准，直接拒。
      // graceMs 只用于超时定时器（给在途请求最后机会），不放宽这里的判定。
      ack = { ok: false, reason: 'too-late', serverNow: now, ply: this.state.ply };
      setImmediate(() => this.onTimeout());
    } else {
      const r = engine.applyMove(this.state, { seat, kind, x, y });
      if (!r.ok) {
        ack = { ok: false, reason: r.reason, serverNow: now, ply: this.state.ply };
        this.logEvent('reject', { moveId, seat, kind, x, y, reason: r.reason });
      } else {
        this.armTurn(); // 重新上弦（若时钟已启动）
        const hash = engine.stateHash(this.state);
        const applyMs = +(performance.now() - t0).toFixed(2);
        this.emit('move', {
          moveId, seat, kind, x, y,
          ply: this.state.ply, hash, applyMs,
          events: r.events,
          state: this.state,
          turn: this.turnPayload(),
          serverNow: now,
        });
        if (this.state.status === 'finished') {
          this.emit('end', {
            winner: this.state.winner, reason: this.state.winReason,
            hash, state: this.state, serverNow: Date.now(),
          });
          this.clearTimers();
        }
        ack = { ok: true, ply: this.state.ply, hash, serverNow: now, applyMs };
      }
    }
    return { http: 200, ack };
  }
}

export function createGameServer() {
  const rooms = new Map();

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('bad-json')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(res, filePath) {
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      // ---------- 静态资源 ----------
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return serveStatic(res, path.join(ROOT, 'public', 'index.html'));
      }
      if (req.method === 'GET' && p === '/replay') {
        return serveStatic(res, path.join(ROOT, 'public', 'replay.html'));
      }
      if (req.method === 'GET' && p.startsWith('/shared/')) {
        const f = path.normalize(path.join(ROOT, p));
        if (!f.startsWith(path.join(ROOT, 'shared'))) return sendJson(res, 403, {});
        return serveStatic(res, f);
      }
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        const f = path.normalize(path.join(ROOT, 'public', p));
        if (!f.startsWith(path.join(ROOT, 'public'))) return sendJson(res, 403, {});
        return serveStatic(res, f);
      }

      // ---------- 对局 API ----------
      if (req.method === 'POST' && p === '/api/games') {
        const opts = await readBody(req);
        const room = new Room(opts);
        rooms.set(room.id, room);
        return sendJson(res, 200, {
          gameId: room.id,
          seats: [0, 1].map((s) => ({
            seat: s,
            token: room.tokens[s],
            url: `/?game=${room.id}&seat=${s}&token=${room.tokens[s]}`,
          })),
          replayUrl: `/replay?log=/api/games/${room.id}/log`,
          logUrl: `/api/games/${room.id}/log`,
        });
      }

      const m = p.match(/^\/api\/games\/([0-9a-f]+)\/(state|events|move|log|metrics)$/);
      if (!m) return sendJson(res, 404, { error: 'not-found' });
      const room = rooms.get(m[1]);
      if (!room) return sendJson(res, 404, { error: 'no-such-game' });
      const route = m[2];

      if (req.method === 'GET' && route === 'log') {
        return serveStatic(res, room.logPath);
      }

      if (req.method === 'GET' && route === 'state') {
        const seat = +u.searchParams.get('seat');
        if (room.tokens[seat] !== u.searchParams.get('token')) {
          return sendJson(res, 403, { error: 'bad-token' });
        }
        return sendJson(res, 200, room.snapshot(seat));
      }

      if (req.method === 'GET' && route === 'events') {
        const seat = +u.searchParams.get('seat');
        if (room.tokens[seat] !== u.searchParams.get('token')) {
          res.writeHead(403); res.end(); return;
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.socket?.setNoDelay?.(true);
        res.write('retry: 1000\n\n');
        // 每个新连接先给一份完整快照 —— 重连即自动再同步（纠错不留幽灵）
        res.write(`event: snapshot\ndata: ${JSON.stringify(room.snapshot(seat))}\n\n`);
        room.onConnect(seat, res);
        const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { /* noop */ } }, 15000);
        req.on('close', () => {
          clearInterval(hb);
          room.onDisconnect(seat, res);
        });
        return;
      }

      if (req.method === 'POST' && route === 'move') {
        const body = await readBody(req);
        const seat = [0, 1].find((s) => room.tokens[s] === body.token);
        if (seat === undefined) return sendJson(res, 403, { error: 'bad-token' });
        const { http, ack } = await room.handleMove(seat, body);
        return sendJson(res, http, ack);
      }

      if (req.method === 'POST' && route === 'metrics') {
        const body = await readBody(req);
        const seat = [0, 1].find((s) => room.tokens[s] === body.token);
        if (seat === undefined) return sendJson(res, 403, { error: 'bad-token' });
        const line = JSON.stringify({ t: Date.now(), seat, ...body.metrics }) + '\n';
        fs.appendFile(path.join(LOGS_DIR, `metrics-${room.id}.jsonl`), line, () => {});
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'not-found' });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });

  return { server, rooms };
}

// 直接运行：node server/server.js [PORT]
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = +(process.env.PORT || process.argv[2] || 8080);
  const { server } = createGameServer();
  server.listen(port, () => {
    console.log(`菌落抢地盘 server @ http://localhost:${server.address().port}`);
    console.log(`创建对局后把邀请链接发给对手即可开局；回放页：http://localhost:${server.address().port}/replay`);
  });
}
