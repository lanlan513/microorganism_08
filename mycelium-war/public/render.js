// Canvas 渲染器：手写棋盘 + 菌落生长边缘。
// 按 devicePixelRatio 缩放，线条对齐物理像素，不发虚。
// 对局页和回放页共用。

const COLORS = {
  agar1: '#f7efd9', agar2: '#efdfba',
  rim: '#cbb98f', rimHi: '#fff8e6',
  grid: 'rgba(120, 90, 40, 0.10)',
  p1: '#0ea888', p1Dark: '#0b7a63', p1Glow: 'rgba(14,168,136,0.28)',
  p2: '#e0457b', p2Dark: '#a82c58', p2Glow: 'rgba(224,69,123,0.28)',
  nutrient: '#f5b301',
  toxin: '#8b5cf6',
  pending1: 'rgba(14,168,136,0.42)',
  pending2: 'rgba(224,69,123,0.42)',
};

// 每格确定性伪随机（菌落形态抖动用，不随帧变化）
function cellRand(x, y, salt = 0) {
  let h = (x * 73856093) ^ (y * 19349663) ^ (salt * 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let cssW = 0, cssH = 0, dpr = 1;
  let mqCleanup = null;

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(50, rect.width);
    cssH = Math.max(50, rect.height);
    // 物理像素尺寸 = CSS 尺寸 × dpr，再用 setTransform 映射，保证锐利
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    watchDpr();
  }

  // 拖到别的显示器 / 浏览器缩放导致 dpr 变化时重适配
  function watchDpr() {
    mqCleanup?.();
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const cb = () => resize();
    mq.addEventListener?.('change', cb, { once: true });
    mqCleanup = () => mq.removeEventListener?.('change', cb);
  }

  window.addEventListener('resize', resize);
  resize();

  function layout(state) {
    const pad = 26;
    const n = state.size;
    const cell = Math.min((cssW - pad * 2) / n, (cssH - pad * 2) / n);
    const w = cell * n, h = cell * n;
    return { x0: (cssW - w) / 2, y0: (cssH - h) / 2, cell, w, h };
  }

  function cellAt(state, px, py) {
    const { x0, y0, cell } = layout(state);
    const x = Math.floor((px - x0) / cell);
    const y = Math.floor((py - y0) / cell);
    if (x < 0 || y < 0 || x >= state.size || y >= state.size) return null;
    return { x, y };
  }

  function cellCenter(state, x, y) {
    const { x0, y0, cell } = layout(state);
    return { x: x0 + (x + 0.5) * cell, y: y0 + (y + 0.5) * cell };
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * view = { state, turn?, mySeat?, pendings?:[{kind,x,y}], flashes?:[{x,y,until}],
   *          hover?:{x,y}|null, now }
   */
  function draw(view) {
    const { state, now } = view;
    ctx.clearRect(0, 0, cssW, cssH);
    if (!state) return;
    const L = layout(state);
    const n = state.size;

    // ---- 培养皿 ----
    const dishPad = 14;
    const g = ctx.createRadialGradient(
      cssW / 2, cssH / 2, 10,
      cssW / 2, cssH / 2, Math.max(L.w, L.h) * 0.75,
    );
    g.addColorStop(0, COLORS.agar1);
    g.addColorStop(1, COLORS.agar2);
    roundRect(L.x0 - dishPad, L.y0 - dishPad, L.w + dishPad * 2, L.h + dishPad * 2, 22);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.rim;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.rimHi;
    roundRect(L.x0 - dishPad + 3, L.y0 - dishPad + 3, L.w + dishPad * 2 - 6, L.h + dishPad * 2 - 6, 19);
    ctx.stroke();

    // ---- 网格（0.5px 偏移对齐物理像素） ----
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const gx = Math.round(L.x0 + i * L.cell) + 0.5;
      const gy = Math.round(L.y0 + i * L.cell) + 0.5;
      ctx.moveTo(gx, L.y0);
      ctx.lineTo(gx, L.y0 + L.h);
      ctx.moveTo(L.x0, gy);
      ctx.lineTo(L.x0 + L.w, gy);
    }
    ctx.stroke();

    // ---- 营养点 ----
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!state.nutrients[y * n + x]) continue;
        const c = cellCenter(state, x, y);
        const pulse = 1 + 0.15 * Math.sin(now / 400 + x * 1.7 + y * 2.3);
        const r = L.cell * 0.16 * pulse;
        const ng = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r * 2.4);
        ng.addColorStop(0, 'rgba(245,179,1,0.9)');
        ng.addColorStop(1, 'rgba(245,179,1,0)');
        ctx.fillStyle = ng;
        ctx.beginPath(); ctx.arc(c.x, c.y, r * 2.4, 0, 7); ctx.fill();
        ctx.fillStyle = COLORS.nutrient;
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 7); ctx.fill();
      }
    }

    // ---- 抗菌素区域 ----
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (!(state.toxinUntil[i] > state.ply) || state.toxinOwner[i] === 0) continue;
        const left = state.toxinUntil[i] - state.ply;
        const alpha = Math.min(0.5, 0.16 + 0.05 * left) * (0.85 + 0.15 * Math.sin(now / 260 + x + y));
        ctx.fillStyle = `rgba(139,92,246,${alpha.toFixed(3)})`;
        ctx.fillRect(L.x0 + x * L.cell + 1, L.y0 + y * L.cell + 1, L.cell - 2, L.cell - 2);
        // 小叉标记
        const c = cellCenter(state, x, y);
        const r = L.cell * 0.14;
        ctx.strokeStyle = 'rgba(109,60,220,0.75)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x + r, c.y + r);
        ctx.moveTo(c.x + r, c.y - r); ctx.lineTo(c.x - r, c.y + r);
        ctx.stroke();
      }
    }

    // ---- 菌落（含生长边缘的菌丝） ----
    for (let seat = 0; seat < 2; seat++) {
      const me = seat + 1;
      const base = seat === 0 ? COLORS.p1 : COLORS.p2;
      const dark = seat === 0 ? COLORS.p1Dark : COLORS.p2Dark;
      const glow = seat === 0 ? COLORS.p1Glow : COLORS.p2Glow;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (state.cells[y * n + x] !== me) continue;
          const px = L.x0 + x * L.cell;
          const py = L.y0 + y * L.cell;
          const j1 = cellRand(x, y, 1), j2 = cellRand(x, y, 2);
          const inset = 1 + j1 * 1.5;
          const rad = Math.min(L.cell * 0.32, 4 + j2 * 4);
          // 菌落体
          ctx.fillStyle = base;
          roundRect(px + inset, py + inset, L.cell - inset * 2, L.cell - inset * 2, rad);
          ctx.fill();
          // 内部纹理（菌褶）
          ctx.fillStyle = dark;
          const dots = 2 + Math.floor(j1 * 3);
          for (let d = 0; d < dots; d++) {
            const rx = px + L.cell * (0.25 + 0.5 * cellRand(x, y, 10 + d));
            const ry = py + L.cell * (0.25 + 0.5 * cellRand(x, y, 20 + d));
            ctx.beginPath(); ctx.arc(rx, ry, Math.max(0.8, L.cell * 0.045), 0, 7); ctx.fill();
          }
          // 生长边缘：朝空邻居伸出的菌丝尖
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
            if (state.cells[ny * n + nx] !== 0) continue;
            const tips = 2 + Math.floor(cellRand(x, y, 30 + dx * 3 + dy * 7) * 3);
            for (let t = 0; t < tips; t++) {
              const rr = cellRand(x, y, 40 + t * 11 + dx * 5 + dy * 13);
              const wob = Math.sin(now / 320 + rr * 6.28) * 0.18;
              const off = (t + 0.5) / tips - 0.5;
              const sx = px + L.cell * (0.5 + dx * 0.42 + (dy !== 0 ? off * 0.6 : 0));
              const sy = py + L.cell * (0.5 + dy * 0.42 + (dx !== 0 ? off * 0.6 : 0));
              const len = L.cell * (0.16 + rr * 0.14);
              const ex = sx + (dx + (dy !== 0 ? wob : 0)) * len;
              const ey = sy + (dy + (dx !== 0 ? wob : 0)) * len;
              ctx.strokeStyle = glow;
              ctx.lineWidth = Math.max(1, L.cell * 0.05);
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(sx, sy);
              ctx.lineTo(ex, ey);
              ctx.stroke();
              ctx.fillStyle = base;
              ctx.beginPath(); ctx.arc(ex, ey, Math.max(0.7, L.cell * 0.035), 0, 7); ctx.fill();
            }
          }
        }
      }
    }

    // ---- 预测中的落子（未确认幽灵：半透明 + 蚂蚁线） ----
    for (const p of view.pendings ?? []) {
      const px = L.x0 + p.x * L.cell;
      const py = L.y0 + p.y * L.cell;
      const mine = view.mySeat === 0;
      ctx.fillStyle = p.kind === 'toxin' ? 'rgba(139,92,246,0.35)' : (mine ? COLORS.pending1 : COLORS.pending2);
      roundRect(px + 2, py + 2, L.cell - 4, L.cell - 4, Math.min(6, L.cell * 0.3));
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.lineDashOffset = -(now / 40) % 7;
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = p.kind === 'toxin' ? COLORS.toxin : (mine ? COLORS.p1Dark : COLORS.p2Dark);
      roundRect(px + 2, py + 2, L.cell - 4, L.cell - 4, Math.min(6, L.cell * 0.3));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- 被拒绝的落子：红叉闪现后消失（纠错不留幽灵） ----
    for (const f of view.flashes ?? []) {
      const k = Math.max(0, (f.until - now) / 600);
      if (k <= 0) continue;
      const c = cellCenter(state, f.x, f.y);
      const r = L.cell * 0.3;
      ctx.strokeStyle = `rgba(220,38,38,${k.toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x + r, c.y + r);
      ctx.moveTo(c.x + r, c.y - r); ctx.lineTo(c.x - r, c.y + r);
      ctx.stroke();
    }

    // ---- 悬停提示 ----
    if (view.hover && view.turn && view.mySeat != null && state.status === 'playing'
        && view.turn.current === view.mySeat) {
      const { x, y } = view.hover;
      const isGrow = view.turn.legal?.grows?.some(([gx, gy]) => gx === x && gy === y);
      const isToxin = view.turn.legal?.toxins?.some(([tx, ty]) => tx === x && ty === y);
      if (isGrow || isToxin) {
        ctx.strokeStyle = isGrow ? 'rgba(20,120,90,0.8)' : 'rgba(109,60,220,0.8)';
        ctx.lineWidth = 2;
        roundRect(L.x0 + x * L.cell + 1.5, L.y0 + y * L.cell + 1.5, L.cell - 3, L.cell - 3, Math.min(6, L.cell * 0.3));
        ctx.stroke();
      }
    }
  }

  return { draw, resize, cellAt, cellCenter, layout };
}
