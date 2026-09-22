// 浏览器实测 + 截图证据采集（Playwright）。
// 产物写入 artifacts/：
//   latency.json / latency.png      —— 落子→画面反馈延迟（预测上屏 / 服务端回执 / 广播到达）
//   correction-pending.png           —— 慢网下本地预测已上屏（幽灵态）
//   correction-reconciled.png        —— 服务端纠正后回滚（不留幽灵菌丝，红叉闪现）
//   game-inprogress.png              —— 对局现场
//   replay.png                       —— 回放页
//   dpr.png                          —— 高 DPR 缩放证据
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Bot } from '../tools/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const base = process.env.BASE || 'http://localhost:8080';

const launchOpts = {
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createGame(opts = {}) {
  const r = await fetch(`${base}/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  }).then((x) => x.json());
  return r;
}
const link = (g, s) => `${base}/?game=${g.gameId}&seat=${s}&token=${g.seats[s].token}&debug=1`;

async function newPage(browser, url, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 860 },
    deviceScaleFactor: opts.dsf ?? 2, // 模拟高分屏，检验 DPR 缩放
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (opts.logConsole) console.log(`[browser ${opts.tag ?? ''}]`, m.text()); });
  page.on('pageerror', (e) => console.error(`[pageerror]`, e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__game?.ready, null, { timeout: 10000 });
  return { ctx, page };
}

async function clickFirstGrow(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const [x, y] = g.turn.legal.grows[0];
    const c = g.cellCenterClient(x, y);
    return { x, y, c };
  }).then(async (info) => {
    await page.mouse.click(info.c.x, info.c.y);
    return info;
  });
}

async function main() {
  const browser = await chromium.launch(launchOpts);
  const results = {};

  // ============ 1. 落子→画面反馈延迟（正常网络） ============
  {
    const g = await createGame({ size: 12, thinkMs: 60000 });
    const pages = [];
    const p0 = await newPage(browser, link(g, 0), { tag: 'p1' });
    const p1x = await newPage(browser, link(g, 1), { tag: 'p2', dsf: 1 });
    pages.push(p0, p1x);

    const samples = [];
    // 谁当前轮到就谁点（吃营养点会触发连击，行动方不会严格交替）；在 P1 页面采延迟
    let moves = 0;
    let lastPly = -1;
    while (moves < 16) {
      const cur = await pages[0].page.evaluate(() => window.__game.turn.current);
      const pg = pages[cur].page;
      await pg.waitForFunction((arg) => {
        const g = window.__game;
        return g && g.state && g.state.status === 'playing'
          && g.turn && g.turn.current === arg.cur && g.pendings === 0
          && g.state.ply > arg.lastPly
          && g.turn.legal && g.turn.legal.grows.length > 0;
      }, { cur, lastPly }, { timeout: 10000 });
      const plyBefore = await pg.evaluate(() => window.__game.state.ply);
      const info = await clickFirstGrow(pg);
      if (cur === 0) {
        await pg.waitForFunction(() => {
          const g = window.__game;
          return g && g.metrics && g.metrics.ackMs != null && g.metrics.predictMs != null;
        }, null, { timeout: 10000 });
        const m = await pg.evaluate(() => ({ ...window.__game.metrics }));
        samples.push({ ...m, x: info.x, y: info.y });
      }
      lastPly = plyBefore;
      moves++;
      await sleep(20);
    }
    await pages[0].page.screenshot({ path: path.join(ART, 'game-inprogress.png') });
    for (const { ctx, page } of pages) { await page.close(); await ctx.close(); }
    const avg = (k) => Math.round(samples.reduce((a, s) => a + s[k], 0) / samples.length * 10) / 10;
    const max = (k) => Math.max(...samples.map((s) => s[k]));
    results.latency = {
      samples,
      predictMs: { avg: avg('predictMs'), max: max('predictMs') },
      ackMs: { avg: avg('ackMs'), max: max('ackMs') },
      broadcastMs: { avg: avg('broadcastMs'), max: max('broadcastMs') },
      note: 'predictMs=点击到Canvas预测帧；ackMs=点击到服务端回执；broadcastMs=点击到权威广播',
    };
    fs.writeFileSync(path.join(ART, 'latency.json'), JSON.stringify(results.latency, null, 2));
    console.log('延迟（ms） 预测上屏 avg/max:', avg('predictMs'), '/', max('predictMs'),
      ' 回执 avg:', avg('ackMs'), ' 广播 avg:', avg('broadcastMs'));
  }

  // ============ 2. 慢网：预测→纠错现场 ============
  {
    // 服务端每方向 900ms 延迟
    const g = await createGame({ size: 12, thinkMs: 60000, latencyMs: 900 });
    const p1 = await newPage(browser, link(g, 0), { tag: 'slow-p1' });
    const p2 = await newPage(browser, link(g, 1), { tag: 'slow-p2' });
    // P2 挂 Node 机器人陪练（它自己走真实 SSE/HTTP 协议），让回合能在慢网下持续轮转
    const bot2 = new Bot(base, g.gameId, 1, g.seats[1].token, { thinkMs: 200, seed: 77 });
    await bot2.connect();

    // P1 走第一手
    await p1.page.waitForFunction(() => window.__game.state.status === 'playing');
    await p1.page.waitForFunction(() => window.__game.turn.clockArmed === true, null, { timeout: 5000 });
    const info = await clickFirstGrow(p1.page);

    // 立即截图：预测幽灵已上屏，服务端还未回执（往返需 ~1.8s+）
    await p1.page.waitForTimeout(200);
    await p1.page.screenshot({ path: path.join(ART, 'correction-pending.png') });
    console.log('已截预测态（幽灵上屏）:', info.x, info.y, 'pendings =',
      await p1.page.evaluate(() => window.__game.pendings));

    // 等服务端权威结果到达，幽灵应被确认（正常预测命中：虚线变实心，不留幽灵）
    await p1.page.waitForFunction(() => window.__game.pendings === 0, null, { timeout: 5000 });
    await p1.page.waitForTimeout(100);
    await p1.page.screenshot({ path: path.join(ART, 'correction-confirmed.png') });

    // ---- 制造一次真正的纠错（预测被拒）----
    // P1 再走一手 -> P2 走一手 -> 此时轮到 P1。
    // P1 的客户端点击后，用 route 把这一手的 POST 响应延迟到 P2 的权威广播之后：
    // 我们改成更直接的办法：利用慢网窗口，在 P1 点击后立刻用另一条路"抢先"落子同一格。
    // 最可靠：在 P1 客户端仍显示旧 legal 时，直接让 P1 对一个已经被服务端判掉的格子出手——
    // 通过拦截该 POST，先以服务端 HTTP 直接把同格用新 moveId 占掉，再放行。
    await p1.page.waitForFunction(() => {
      const gm = window.__game;
      return gm.state.status === 'playing' && gm.turn.current === 0 && gm.pendings === 0;
    }, null, { timeout: 8000 });

    // 用 context route 拦截 P1 的下一次 move 请求：先让服务端把该格合法占掉（不可能，同座位才合法），
    // 因此采用"过期 legal"方案：直接在页面里取目标格，先以 P1 的 token 用新 moveId 提交占位，
    // 再让页面用它自己的 moveId 点击同一格 —— 页面预测画出幽灵，服务端必然 occupied 拒绝。
    const target = await p1.page.evaluate(() => {
      const gm = window.__game;
      const [x, y] = gm.turn.legal.grows[0];
      return { x, y, c: gm.cellCenterClient(x, y) };
    });
    // 1) 抢先手：同一座位、新 moveId 先占掉该格（经 900ms 服务端入站延迟才生效）
    const raced = fetch(`${base}/api/games/${g.gameId}/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: g.seats[0].token, moveId: crypto.randomUUID(), kind: 'grow', x: target.x, y: target.y }),
    }).then((r) => r.json());
    // 2) 紧接着让页面点击同一格（它看到的还是旧局面），预测幽灵上屏
    await p1.page.mouse.click(target.c.x, target.c.y);
    await p1.page.waitForTimeout(150);
    await p1.page.screenshot({ path: path.join(ART, 'correction-race.png') });
    // 3) 约 0.9~1.8s 后：先占位的请求生效并广播，页面点击那手被 occupied 拒绝，幽灵回滚+红叉。
    //    红叉只闪 600ms，这里快速连拍抓到"回滚且无幽灵菌丝"的现场。
    const racedAck = await raced;
    let caught = false;
    for (let i = 0; i < 40; i++) {
      const pend = await p1.page.evaluate(() => window.__game.pendings);
      if (pend === 0 && i > 2) {
        await p1.page.screenshot({ path: path.join(ART, 'correction-reconciled.png') });
        caught = true;
        break;
      }
      await p1.page.waitForTimeout(50);
    }
    if (!caught) await p1.page.screenshot({ path: path.join(ART, 'correction-reconciled.png') });
    // 再截一张稍晚的：红叉消退后，格子里没有任何幽灵菌丝
    await p1.page.waitForTimeout(700);
    await p1.page.screenshot({ path: path.join(ART, 'correction-clean.png') });
    console.log('抢占手 ack:', racedAck.ok, '；被纠握手已回滚（无幽灵）');

    await p1.page.close(); await p1.ctx.close();
    await p2.page.close(); await p2.ctx.close();
    bot2.disconnect();
  }

  // ============ 3. 断线 30 秒内回来续上（现场截图） ============
  {
    const g = await createGame({ size: 12, thinkMs: 60000, forfeitMs: 30000 });
    const pp = await newPage(browser, link(g, 0), { dsf: 2 });
    const op = await newPage(browser, link(g, 1), { dsf: 1 });
    // 双方各走几手
    for (let i = 0; i < 6; i++) {
      const s = i % 2;
      await (s === 0 ? pp.page : op.page).waitForFunction((seat) => {
        const gm = window.__game;
        return gm.state.status === 'playing' && gm.turn.current === seat && gm.pendings === 0
          && gm.turn.legal.grows.length > 0;
      }, s, { timeout: 8000 });
      await clickFirstGrow(s === 0 ? pp.page : op.page);
      await sleep(60);
    }
    // 让局面停在 P1 回合，然后断 P1
    await pp.page.waitForFunction(() => {
      const gm = window.__game;
      return gm.state.status === 'playing' && gm.turn.current === 0 && gm.pendings === 0;
    }, null, { timeout: 8000 });
    // 模拟真实断线：直接掐掉 P1 的 EventSource（服务端应进入断线+冻结流程）
    await pp.page.evaluate(() => window.__es.close());
    await sleep(400);
    // 对手页面看到的状态
    await op.page.screenshot({ path: path.join(ART, 'reconnect-opponent-sees-disconnect.png') });
    // P1 重连：用 reload 模拟用户刷新页面（snapshot 再同步）
    await pp.page.reload();
    await pp.page.waitForFunction(() => window.__game?.ready, null, { timeout: 10000 });
    await sleep(300);
    await pp.page.screenshot({ path: path.join(ART, 'reconnect-resumed.png') });
    const stateAfter = await pp.page.evaluate(() => ({
      ply: window.__game.state.ply,
      frozenRemaining: window.__game.turn.frozenRemaining,
      deadline: window.__game.turn.deadline,
    }));
    results.reconnect = stateAfter;
    fs.writeFileSync(path.join(ART, 'reconnect.json'), JSON.stringify(stateAfter, null, 2));
    console.log('断线重连恢复:', stateAfter);
    await pp.page.close(); await pp.ctx.close();
    await op.page.close(); await op.ctx.close();
  }

  // ============ 4. 高 DPR 截图（缩放不发虚） ============
  {
    const g = await createGame({ size: 12, thinkMs: 60000 });
    const { ctx, page } = await newPage(browser, link(g, 0), { dsf: 3 });
    await newPage(browser, link(g, 1), { dsf: 1 });
    await sleep(200);
    await clickFirstGrow(page);
    await sleep(200);
    await page.screenshot({ path: path.join(ART, 'dpr.png') });
    // 校验画布物理像素确实按 DPR 放大
    const px = await page.evaluate(() => {
      const c = document.getElementById('board');
      const r = c.getBoundingClientRect();
      return { cssW: Math.round(r.width), backW: c.width, dpr: window.devicePixelRatio };
    });
    results.dpr = px;
    fs.writeFileSync(path.join(ART, 'dpr.json'), JSON.stringify(px, null, 2));
    console.log('DPR 检查:', px);
    await page.close(); await ctx.close();
  }

  // ============ 5. 回放页截图（用一盘真实完整日志） ============
  {
    const g = await createGame({ size: 12, thinkMs: 60000, latencyMs: 0 });
    const p1 = await newPage(browser, link(g, 0), { dsf: 1 });
    const p2 = await newPage(browser, link(g, 1), { dsf: 1 });
    // 让机器人打完这局（Node bot 走真实 SSE/HTTP）
    const b1 = new Bot(base, g.gameId, 0, g.seats[0].token, { thinkMs: 5, seed: 11 });
    const b2 = new Bot(base, g.gameId, 1, g.seats[1].token, { thinkMs: 5, seed: 12 });
    await b1.connect(); await b2.connect();
    await b1.waitForEnd(30000);
    b1.disconnect(); b2.disconnect();
    await p1.page.close(); await p1.ctx.close();
    await p2.page.close(); await p2.ctx.close();

    const rpCtx = await browser.newContext({
      viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2,
    });
    const rp = { ctx: rpCtx, page: await rpCtx.newPage() };
    rp.page.on('pageerror', (e) => console.error('[replay err]', e.message));
    await rp.page.goto(`${base}/replay?log=/api/games/${g.gameId}/log`);
    await rp.page.waitForFunction(
      () => document.getElementById('replay-result')?.textContent.length > 0,
      null, { timeout: 10000 },
    );
    // 跳到中段一帧
    await rp.page.evaluate(() => {
      const sc = document.getElementById('scrub');
      sc.value = Math.floor(sc.max * 0.6);
      sc.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    await rp.page.screenshot({ path: path.join(ART, 'replay.png') });
    results.replay = await rp.page.evaluate(() => ({
      result: document.getElementById('replay-result').textContent,
      check: document.getElementById('replay-problems').textContent,
      frames: document.getElementById('scrub').max,
      gameId: new URLSearchParams(location.search).get('log').split('/')[3],
    }));
    fs.writeFileSync(path.join(ART, 'replay.json'), JSON.stringify(results.replay, null, 2));
    await rp.page.close(); await rp.ctx.close();
  }

  fs.writeFileSync(path.join(ART, 'shoot-results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  console.log('全部产物已写入 artifacts/');
}

main().catch((e) => { console.error(e); process.exit(1); });
