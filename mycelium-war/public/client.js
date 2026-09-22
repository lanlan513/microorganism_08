// 对局客户端：只画结果、只提交意图。
// 落子顺序 / 思考时限 / 胜负判定全部在服务端；这里的本地预测只是"显示层猜测"，
// 一切以服务端回执和广播为准，纠错时立刻回滚，不留幽灵菌丝。
import { createRenderer } from '/render.js';

const q = new URLSearchParams(location.search);
const gameId = q.get('game');
const seat = q.get('seat') !== null ? +q.get('seat') : null;
const token = q.get('token');
const debug = q.get('debug') === '1';

const $ = (id) => document.getElementById(id);

const REASON_TEXT = {
  'not-your-turn': '还没轮到你',
  occupied: '这格已经被占了',
  'blocked-by-toxin': '被对方的抗菌素压制',
  'not-adjacent': '菌丝只能贴着自家菌落生长',
  'not-own-cell': '只能在自己的菌落上分泌抗菌素',
  'no-target': '周围没有可压制的空格',
  'out-of-bounds': '超出培养皿了',
  'too-late': '超时了（以服务端时钟为准）',
  finished: '对局已结束',
  'bad-kind': '非法操作',
};
const reasonText = (r) => REASON_TEXT[r] ?? r;

if (!gameId || seat == null || !token) {
  showLobby();
} else {
  startGame();
}

/* ================= 大厅：创建对局 ================= */
function showLobby() {
  $('lobby').style.display = 'flex';
  $('game').style.display = 'none';
  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      size: +$('f-size').value,
      thinkMs: +$('f-think').value * 1000,
      latencyMs: +$('f-latency').value,
    };
    const r = await fetch('/api/games', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((x) => x.json());
    $('invite').style.display = 'block';
    $('link-p1').value = location.origin + r.seats[0].url;
    $('link-p2').value = location.origin + r.seats[1].url;
    $('link-replay').href = r.replayUrl;
  });
}

/* ================= 对局 ================= */
function startGame() {
  $('lobby').style.display = 'none';
  $('game').style.display = 'flex';
  $('seat-badge').textContent = seat === 0 ? '你执 青菌（先手）' : '你执 赤菌（后手）';

  const renderer = createRenderer($('board'));
  let state = null;
  let turn = null;
  let endInfo = null;
  let clockOffset = 0; // serverNow - clientNow，每条服务端消息都重新校准
  const pendings = new Map(); // moveId -> { kind, x, y, sentAt, retried, acked }
  const flashes = [];
  let hover = null;
  const metrics = { predictMs: null, ackMs: null, broadcastMs: null };

  const syncClock = (serverNow) => {
    if (serverNow) clockOffset = serverNow - Date.now();
  };

  function toast(msg, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function logLine(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    $('event-log').prepend(el);
    while ($('event-log').children.length > 30) $('event-log').lastChild.remove();
  }

  /* ---------- SSE：服务端 → 客户端 ---------- */
  function connect() {
    const es = new EventSource(`/api/games/${gameId}/events?seat=${seat}&token=${token}`);
    window.__es = es;

    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false);

    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      syncClock(d.serverNow);
      state = d.state;
      turn = d.turn;
      endInfo = state.status === 'finished' ? { winner: state.winner, reason: state.winReason } : endInfo;
      // 再同步 = 纠错：丢弃所有未确认预测，以权威状态重画，不留幽灵
      if (pendings.size) {
        pendings.clear();
        toast('已与服务端重新同步，未确认的落子已回滚');
      }
      logLine(`⟳ 同步快照 ply=${state.ply}`);
      renderHud();
    });

    es.addEventListener('move', (e) => {
      const d = JSON.parse(e.data);
      syncClock(d.serverNow);
      state = d.state;
      turn = d.turn;
      const p = pendings.get(d.moveId);
      if (p) metrics.broadcastMs = +(performance.now() - p.sentAt).toFixed(1);
      pendings.delete(d.moveId);
      // 权威状态落子后，若我们的某个预测格已被占，立即撤掉该预测（纠错）
      for (const [id, pd] of pendings) {
        if (state.cells[pd.y * state.size + pd.x] !== 0) pendings.delete(id);
      }
      logLine(`#${d.ply} ${d.seat === 0 ? '青' : '赤'} ${d.kind === 'grow' ? '生长' : '抗菌素'} (${d.x},${d.y}) hash=${d.hash}`);
      renderHud();
    });

    es.addEventListener('turn', (e) => {
      const d = JSON.parse(e.data);
      syncClock(d.serverNow);
      turn = d;
      renderHud();
    });

    es.addEventListener('presence', (e) => {
      const d = JSON.parse(e.data);
      syncClock(d.serverNow);
      $('opp-dot').className = 'dot ' + (d.connected[1 - seat] ? 'on' : 'off');
      $('opp-status').textContent = d.connected[1 - seat]
        ? '对手在线'
        : `对手断线（${Math.round((d.forfeitAt - d.serverNow) / 1000)}s 内未归判负）`;
      logLine(d.connected[d.seat] ? '● 有玩家上线' : '○ 有玩家断线');
    });

    es.addEventListener('end', (e) => {
      const d = JSON.parse(e.data);
      syncClock(d.serverNow);
      state = d.state;
      endInfo = { winner: d.winner, reason: d.reason };
      pendings.clear();
      logLine(`★ 终局：${winnerText(d.winner)}（${reasonTextEnd(d.reason)}）`);
      renderHud();
    });
  }

  function setConn(on) {
    $('conn-dot').className = 'dot ' + (on ? 'on' : 'off');
    $('conn-text').textContent = on ? '已连接' : '连接中断，重连中…';
  }

  const winnerText = (w) => (w === 'draw' ? '平局' : w === seat ? '你赢了' : '你输了');
  const reasonTextEnd = (r) => ({
    encircle: '围死', territory: '占满结算', cap: '手数上限结算',
    stalemate: '毒战僵局按地盘结算', timeout: '超时判负', forfeit: '断线弃赛',
  }[r] ?? r);

  /* ---------- 落子：本地预测 → 服务端裁决 → 回执/纠错 ---------- */
  const canvas = $('board');

  canvas.addEventListener('pointermove', (e) => {
    if (!state) return;
    const rect = canvas.getBoundingClientRect();
    hover = renderer.cellAt(state, e.clientX - rect.left, e.clientY - rect.top);
  });
  canvas.addEventListener('pointerleave', () => { hover = null; });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state || state.status !== 'playing') return;
    if (!turn || turn.current !== seat) { toast('还没轮到你'); return; }
    const rect = canvas.getBoundingClientRect();
    const cell = renderer.cellAt(state, e.clientX - rect.left, e.clientY - rect.top);
    if (!cell) return;
    const me = seat + 1;
    const occupant = state.cells[cell.y * state.size + cell.x];
    const kind = occupant === me ? 'toxin' : 'grow';
    // 提示性校验（只为少发垃圾请求；最终裁决权在服务端）
    const legal = kind === 'grow'
      ? turn.legal?.grows?.some(([x, y]) => x === cell.x && y === cell.y)
      : turn.legal?.toxins?.some(([x, y]) => x === cell.x && y === cell.y);
    if (!legal) {
      toast(kind === 'grow' ? '这里不能生长' : '这个菌落暂时无法分泌抗菌素');
      return;
    }
    const moveId = crypto.randomUUID();
    const t0 = performance.now();
    pendings.set(moveId, { kind, x: cell.x, y: cell.y, sentAt: t0, retried: false, acked: false });
    // 预测立刻上屏，并实测"落子→画面"延迟
    requestAnimationFrame(() => {
      metrics.predictMs = +(performance.now() - t0).toFixed(1);
      if (debug) renderMetrics();
    });
    sendMove(moveId, kind, cell.x, cell.y, t0);
  });

  async function sendMove(moveId, kind, x, y, t0, isRetry = false) {
    try {
      const r = await fetch(`/api/games/${gameId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, moveId, kind, x, y }),
      });
      const ack = await r.json();
      const p = pendings.get(moveId);
      if (p) p.acked = true;
      metrics.ackMs = +(performance.now() - t0).toFixed(1);
      if (debug) renderMetrics();
      reportMetrics();
      if (!ack.ok) {
        // 服务端拒绝 → 纠错回滚：撤掉预测，红叉闪现
        pendings.delete(moveId);
        flashes.push({ x, y, until: performance.now() + 600 });
        toast(`落子被服务端拒绝：${reasonText(ack.reason)}`);
        logLine(`✗ 拒绝 ${kind}@(${x},${y})：${ack.reason}`);
      }
      // ack.ok 的情况：等 move 广播到达后清掉预测（广播即权威结果）
    } catch {
      // 网络异常：2.5s 后用同一 moveId 重发（服务端幂等，同一手只生效一次）
      const p = pendings.get(moveId);
      if (p && !p.retried) {
        p.retried = true;
        toast('网络不稳定，正在重发这一手…');
        setTimeout(() => {
          const p2 = pendings.get(moveId);
          if (p2 && !p2.acked) sendMove(moveId, kind, x, y, t0, true);
        }, 2500);
      }
    }
  }

  // 兜底：超过 6s 无任何回执的预测直接回滚，绝不留幽灵
  setInterval(() => {
    const now = performance.now();
    for (const [id, p] of pendings) {
      if (now - p.sentAt > 6000) {
        pendings.delete(id);
        toast('一手落子未获服务端确认，已回滚');
      }
    }
  }, 1000);

  function reportMetrics() {
    fetch(`/api/games/${gameId}/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, metrics: { ...metrics } }),
    }).catch(() => {});
  }

  /* ---------- HUD ---------- */
  function renderHud() {
    if (!state) return;
    $('score').textContent = `青 ${state.counts[0]} : ${state.counts[1]} 赤`;
    if (endInfo) {
      $('turn-text').textContent = `对局结束 — ${winnerText(endInfo.winner)}（${reasonTextEnd(endInfo.reason)}）`;
      $('clock').textContent = '—';
      $('replay-link').style.display = 'inline';
      $('replay-link').href = `/replay?log=/api/games/${gameId}/log`;
      return;
    }
    const mine = turn && turn.current === seat;
    $('turn-text').textContent = turn
      ? (mine ? '轮到你：点空格生长菌丝，点自家菌落分泌抗菌素' : '对方思考中…')
      : '等待对手加入…';
    if (turn && turn.chainLeft > 0 && mine) {
      $('turn-text').textContent += `（连击 ×${turn.chainLeft}）`;
    }
  }

  function renderMetrics() {
    $('metrics').textContent =
      `预测上屏 ${metrics.predictMs ?? '—'}ms · 服务端回执 ${metrics.ackMs ?? '—'}ms · 广播到达 ${metrics.broadcastMs ?? '—'}ms`;
  }

  // 倒计时：完全由服务端 deadline 驱动。
  // clockOffset 用每条服务端消息校准，本机时钟再偏也不影响判定 —— 判超时的是服务端。
  function tickClock() {
    if (turn && turn.clockArmed && !endInfo) {
      if (turn.deadline) {
        const remain = Math.max(0, turn.deadline - (Date.now() + clockOffset));
        const s = (remain / 1000).toFixed(1);
        $('clock').textContent = `⏱ ${s}s`;
        $('clock').classList.toggle('urgent', remain < 3000);
      } else if (turn.frozenRemaining != null) {
        $('clock').textContent = `⏸ 对方断线，时钟冻结（剩 ${(turn.frozenRemaining / 1000).toFixed(1)}s）`;
        $('clock').classList.remove('urgent');
      } else {
        $('clock').textContent = '⏱ —';
      }
    } else if (!turn?.clockArmed && !endInfo) {
      $('clock').textContent = '等待双方就绪…';
      $('clock').classList.remove('urgent');
    }
  }

  /* ---------- 渲染主循环 ---------- */
  function frame() {
    const now = performance.now();
    for (let i = flashes.length - 1; i >= 0; i--) {
      if (flashes[i].until < now) flashes.splice(i, 1);
    }
    renderer.draw({
      state, turn, mySeat: seat,
      pendings: [...pendings.values()],
      flashes, hover, now,
    });
    tickClock();
    requestAnimationFrame(frame);
  }

  connect();
  renderHud();
  if (debug) {
    $('metrics').style.display = 'block';
    renderMetrics();
  }
  requestAnimationFrame(frame);

  // 暴露给自动化测试/截图脚本的小钩子
  window.__game = {
    get ready() { return !!state; },
    get state() { return state; },
    get turn() { return turn; },
    get pendings() { return pendings.size; },
    metrics,
    cellCenterClient(x, y) {
      const rect = canvas.getBoundingClientRect();
      const c = renderer.cellCenter(state, x, y);
      return { x: rect.left + c.x, y: rect.top + c.y };
    },
  };
}
