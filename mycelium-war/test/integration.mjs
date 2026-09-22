// 集成测试：真实 HTTP + SSE 协议，服务端进程内启动（端口 0 随机）。
// 覆盖验收点：完整对局重放、断线重连/判负、幂等重复提交、同格并发、时钟以服务端为准。
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.LOGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'test-logs');
fs.mkdirSync(process.env.LOGS_DIR, { recursive: true });

const { createGameServer } = await import('../server/server.js');
const { replayEvents, parseJsonl } = await import('../shared/replay.js');
const { Bot } = await import('../tools/bot.js');

let passed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}  (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err);
    process.exitCode = 1;
  }
}

const server = createGameServer().server;
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

async function createGame(opts = {}) {
  const r = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  }).then((x) => x.json());
  return {
    id: r.gameId,
    seat: [
      { seat: 0, token: r.seats[0].token },
      { seat: 1, token: r.seats[1].token },
    ],
    log: async () => fetch(`${base}/api/games/${r.gameId}/log`).then((x) => x.text()),
  };
}
const postMove = (g, s, body) => fetch(`${base}/api/games/${g.id}/move`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: g.seat[s].token, ...body }),
}).then(async (x) => ({ status: x.status, ...(await x.json()) }));
const getSnapshot = (g, s) => fetch(
  `${base}/api/games/${g.id}/state?seat=${s}&token=${encodeURIComponent(g.seat[s].token)}`,
).then((x) => x.json());
const countEvents = (text, type) => parseJsonl(text).filter((e) => e.type === type).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n══ 菌落抢地盘 集成测试 ══');

/* ── 1. 完整对局：日志重放出同一盘棋、同一个赢家（验收①） ── */
await test('完整对局：机器人对战到终局，日志重放赢家/指纹一致', async () => {
  const g = await createGame({ size: 12, thinkMs: 60000, nutrients: 8, seed: 42 });
  const a = new Bot(base, g.id, 0, g.seat[0].token, { thinkMs: 8, toxinRate: 0.2, seed: 1 });
  const b = new Bot(base, g.id, 1, g.seat[1].token, { thinkMs: 8, toxinRate: 0.2, seed: 2 });
  await a.connect();
  await b.connect();
  const end = await a.waitForEnd(30000);
  a.disconnect(); b.disconnect();

  const text = await g.log();
  fs.writeFileSync(path.join(process.env.LOGS_DIR, `full-${g.id}.jsonl`), text);
  const events = parseJsonl(text);
  const moves = events.filter((e) => e.type === 'move');
  assert.ok(moves.length > 30, `手数过少: ${moves.length}`);
  const { problems, end: endLog, finalState } = replayEvents(events);
  assert.deepEqual(problems, [], '逐手指纹校验存在不一致:\n' + problems.join('\n'));
  assert.equal(finalState.status, 'finished');
  assert.equal(endLog.winner, finalState.winner, '重放赢家与日志不同');
  assert.equal(endLog.hash, events.findLast((e) => e.type === 'end')?.hash);
  console.log(`    共 ${moves.length} 手，赢家=P${end.winner === 'draw' ? '-' : end.winner + 1}（${end.reason}）`);
});

/* ── 2. 同一手重复提交只生效一次（验收③），含并发 ── */
await test('幂等：同一 moveId 串行+并发重复提交只生效一次', async () => {
  const g = await createGame({ size: 12, thinkMs: 60000, seed: 7 });
  const [lc0, lc1] = await Promise.all([
    sseConnectLight(base, g, 0), sseConnectLight(base, g, 1),
  ]);
  await sleep(60);
  const cur0 = (await getSnapshot(g, 0)).turn.current;
  const snap = await getSnapshot(g, cur0);
  const [x, y] = snap.turn.legal.grows[0];
  const moveId = crypto.randomUUID();
  // 同一个 moveId 连发两次（串行重发，模拟超时重传）
  const r1 = await postMove(g, cur0, { moveId, kind: 'grow', x, y });
  const r2 = await postMove(g, cur0, { moveId, kind: 'grow', x, y });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r2.duplicate, true, '第二次应标记 duplicate');
  assert.equal(r2.ply, r1.ply, '重复提交不得再推进手数');
  const after = await getSnapshot(g, cur0);
  assert.equal(after.state.cells[y * 12 + x], cur0 + 1, '格子只被占一次');

  // 弱网延迟下三个并发同 moveId 请求
  const g2 = await createGame({ size: 12, thinkMs: 60000, latencyMs: 300, seed: 9 });
  await Promise.all([sseConnectLight(base, g2, 0), sseConnectLight(base, g2, 1)]);
  await sleep(80);
  const snap2 = await getSnapshot(g2, 0);
  const [x2, y2] = snap2.turn.legal.grows[0];
  const mid2 = crypto.randomUUID();
  const rs = await Promise.all([1, 2, 3].map(() =>
    postMove(g2, 0, { moveId: mid2, kind: 'grow', x: x2, y: y2 })));
  assert.ok(rs.every((r) => r.ok), '并发重复请求都应返回首次成功结果');
  const text = await g2.log();
  const sameMoves = parseJsonl(text).filter(
    (e) => e.type === 'move' && e.moveId === mid2,
  );
  assert.equal(sameMoves.length, 1, '同一 moveId 在日志中只能出现一条 move');
  lc0.close(); lc1.close();
});

/* ── 3. 两个人同时落子到同一格：只有一个生效（服务端串行裁决） ── */
await test('同格并发：双端同时点一格，服务端只裁决出一手', async () => {
  const g = await createGame({ size: 12, thinkMs: 60000, seed: 11 });
  const [c0, c1] = await Promise.all([
    sseConnectLight(base, g, 0), sseConnectLight(base, g, 1),
  ]);
  await sleep(80);
  const snap = await getSnapshot(g, 0);
  const [x, y] = snap.turn.legal.grows[0];
  const [rA, rB, rA2] = await Promise.all([
    postMove(g, 0, { moveId: crypto.randomUUID(), kind: 'grow', x, y }), // 当前方
    postMove(g, 1, { moveId: crypto.randomUUID(), kind: 'grow', x, y }), // 非当前方
    postMove(g, 0, { moveId: crypto.randomUUID(), kind: 'grow', x, y }), // 同方重复抢格
  ]);
  assert.equal(rA.ok, true);
  assert.equal(rB.ok, false);
  // rB 与 rA 同批并发：要么抢在 rA 落账前被以"还没轮到你"拒绝，
  // 要么在 rA 后被以"该格已占"拒绝——两种都是服务端串行裁决的拒绝结果。
  assert.ok(['not-your-turn', 'occupied'].includes(rB.reason), `rB 意外原因 ${rB.reason}`);
  assert.equal(rA2.ok, false);
  // rA2 同理可能在切换回合前/后被拒，关键是只有一手真正生效。
  assert.ok(['occupied', 'not-your-turn'].includes(rA2.reason), `rA2 意外原因 ${rA2.reason}`);
  const text = await g.log();
  assert.equal(countEvents(text, 'move'), 1, '同格竞争只应产生一条 move 日志');
  c0.close(); c1.close();
});

/* ── 4. 断线 30 秒内回来续上：时钟冻结、快照再同步、棋局继续（验收②） ── */
await test('断线重连：思考时钟冻结，重连后快照恢复并继续对局', async () => {
  const g = await createGame({ size: 12, thinkMs: 60000, forfeitMs: 30000, seed: 13 });
  const [c0, c1] = await Promise.all([
    sseConnectLight(base, g, 0), sseConnectLight(base, g, 1),
  ]);
  await sleep(60);

  // 手工交替走几手，把回合停在 P1
  const grow = async (seat) => {
    const s = await getSnapshot(g, seat);
    const [x, y] = s.turn.legal.grows[0];
    return postMove(g, seat, { moveId: crypto.randomUUID(), kind: 'grow', x, y });
  };
  await grow(0); await sleep(20); await grow(1); await sleep(20);
  const before = await getSnapshot(g, 0);
  assert.equal(before.turn.current, 0);
  assert.equal(before.turn.clockArmed, true);
  assert.ok(before.turn.deadline, '断线前应有 deadline');

  // P1 断线：自己的思考时钟冻结
  c0.close();
  await sleep(250);
  const frozen = await getSnapshot(g, 0);
  assert.equal(frozen.turn.deadline, null, '断线期间 deadline 应冻结');
  assert.ok(frozen.turn.frozenRemaining > 0, '应封存剩余思考时间');
  const frozenRem = frozen.turn.frozenRemaining;
  await sleep(500);
  const frozen2 = await getSnapshot(g, 0);
  assert.ok(Math.abs(frozen2.turn.frozenRemaining - frozenRem) < 60,
    `冻结期间剩余时间不应流逝（${frozenRem} -> ${frozen2.turn.frozenRemaining}）`);
  assert.equal(frozen2.state.status, 'playing', '30 秒宽限内不得判负');

  // 在 30 秒宽限内回来：快照再同步，时钟用封存的剩余时间恢复
  const c0b = await sseConnectLight(base, g, 0);
  await sleep(250);
  const after = await getSnapshot(g, 0);
  assert.ok(after.turn.deadline, '重连后时钟恢复');
  assert.ok(after.turn.frozenRemaining == null, '冻结应解除');
  assert.equal(after.state.ply, frozen.state.ply, '重连快照手数一致');

  // 棋局继续：让两个机器人接手打完
  const a = new Bot(base, g.id, 0, g.seat[0].token, { thinkMs: 5, seed: 5 });
  const b = new Bot(base, g.id, 1, g.seat[1].token, { thinkMs: 5, seed: 6 });
  await a.connect(); await b.connect();
  const end = await a.waitForEnd(20000);
  a.disconnect(); b.disconnect();
  c0b.close(); c1.close();
  const text = await g.log();
  const { problems, end: endLog } = replayEvents(parseJsonl(text));
  assert.deepEqual(problems, []);
  assert.equal(endLog.winner, end.winner, '重放赢家一致');
});

/* ── 5. 断线超时不归判负，且重放赢家一致 ── */
await test('断线弃赛：超过宽限判负，日志重放同结果', async () => {
  const g = await createGame({ size: 12, thinkMs: 60000, forfeitMs: 600, graceMs: 100, seed: 17 });
  const [c0, c1] = await Promise.all([
    sseConnectLight(base, g, 0), sseConnectLight(base, g, 1),
  ]);
  await sleep(50);
  // 当前方（P1）断线，等到 forfeitMs
  c0.close();
  await sleep(1200);
  const text = await g.log();
  const end = parseJsonl(text).findLast((e) => e.type === 'end');
  assert.ok(end, '应有 end 事件');
  assert.equal(end.reason, 'forfeit');
  assert.equal(end.winner, 1);
  const { problems, end: endLog } = replayEvents(parseJsonl(text));
  assert.deepEqual(problems, []);
  assert.equal(endLog.winner, 1);
  c1.close();
});

/* ── 6. 时钟以服务端为准：本机时钟快慢都不能改判（验收④相关） ── */
await test('超时判定：只认服务端时间，伪造客户端时间无效', async () => {
  const g = await createGame({ size: 12, thinkMs: 400, graceMs: 1000, seed: 19 });
  const a = new Bot(base, g.id, 0, g.seat[0].token, { thinkMs: 999999, seed: 8 }); // 故意不思考
  const b = new Bot(base, g.id, 1, g.seat[1].token, { thinkMs: 999999, seed: 9 });
  await a.connect(); await b.connect();
  const snap0 = await getSnapshot(g, 0);
  const skew = snap0.turn.deadline - snap0.serverNow;
  assert.ok(Math.abs(skew - 400) < 60, `deadline 应≈thinkMs，实际 ${skew}`);
  // 等过 deadline（400ms）但还没到服务端超时定时器（1400ms），此时落子应被判 too-late。
  // 协议里根本没有客户端时间字段；即便塞一个"我还早"的伪造字段也无用。
  await sleep(600);
  const late = await postMove(g, 0, {
    moveId: crypto.randomUUID(), kind: 'grow',
    x: snap0.turn.legal.grows[0][0], y: snap0.turn.legal.grows[0][1],
    clientNow: 0, clientDeadline: 9999999999999,
  });
  assert.equal(late.ok, false);
  assert.ok(['too-late', 'finished'].includes(late.reason), `应判 too-late/finished，实际 ${late.reason}`);
  const end = await a.waitForEnd(3000);
  assert.equal(end.reason, 'timeout');
  assert.equal(end.winner, 1);
  const text = await g.log();
  const { problems, end: endLog } = replayEvents(parseJsonl(text));
  assert.deepEqual(problems, []);
  assert.equal(endLog.winner, 1, '超时判负重放结果一致');
  a.disconnect(); b.disconnect();
});

/* ── 7. 服务端权威：非法落子一律拒绝，且日志有 reject 审计 ── */
await test('非法落子：不贴边生长/对方格上操作均拒绝', async () => {
  const g = await createGame({ size: 12, thinkMs: 60000, seed: 23 });
  const [c0, c1] = await Promise.all([
    sseConnectLight(base, g, 0), sseConnectLight(base, g, 1),
  ]);
  await sleep(60);
  // 远离己方菌落的空格
  const r1 = await postMove(g, 0, { moveId: crypto.randomUUID(), kind: 'grow', x: 10, y: 10 });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'not-adjacent');
  // 在对方菌格上"生长"
  const r2 = await postMove(g, 0, { moveId: crypto.randomUUID(), kind: 'grow', x: 10, y: 6 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'occupied');
  // 坏 token
  const r3 = await fetch(`${base}/api/games/${g.id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'forged', moveId: crypto.randomUUID(), kind: 'grow', x: 2, y: 6 }),
  });
  assert.equal(r3.status, 403);
  const text = await g.log();
  assert.ok(countEvents(text, 'reject') >= 2, '拒绝要有审计日志');
  c0.close(); c1.close();
});

// 轻量 SSE 连接：只为占座/触发 presence，不做决策
async function sseConnectLight(base, g, seat) {
  const ctrl = new AbortController();
  const resp = await fetch(
    `${base}/api/games/${g.id}/events?seat=${seat}&token=${encodeURIComponent(g.seat[seat].token)}`,
    { signal: ctrl.signal },
  );
  return { close: () => ctrl.abort(), _r: resp };
}

setTimeout(() => {
  console.log(`\n${passed} 项通过${process.exitCode ? '，有失败项' : '，全部通过'}。`);
  server.close();
  process.exit(process.exitCode ?? 0);
}, 2000);
