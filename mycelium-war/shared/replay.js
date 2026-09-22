// 回放折叠器：把 JSONL 事件流重新过一遍引擎，逐手校验状态指纹。
// Node CLI（tools/replay.js）和浏览器回放页（public/replay.js）共用。
import { createGame, applyMove, finishExternal, stateHash } from './engine.js';

/**
 * @param events 已解析的日志事件对象数组（按 seq 顺序）
 * @returns { frames, problems, end, finalState }
 *   frames[i] = { state, label, move? } —— 第 i 手之后的局面（frames[0] 为开局）
 */
export function replayEvents(events) {
  const problems = [];
  const frames = [];
  let state = null;
  let end = null;

  for (const ev of events) {
    if (ev.type === 'init') {
      state = createGame({
        seed: ev.seed, size: ev.size, seats: ev.seats,
        maxChain: ev.maxChain, toxinTTL: ev.toxinTTL, maxPlies: ev.maxPlies,
        nutrients: ev.nutrients,
      });
      const h = stateHash(state);
      if (ev.hash && ev.hash !== h) {
        problems.push(`init: 开局指纹不一致 日志=${ev.hash} 回放=${h}`);
      }
      frames.push({ state: structuredClone(state), label: '开局', hash: h });
    } else if (ev.type === 'move') {
      if (!state) { problems.push(`#${ev.seq}: move 出现在 init 之前`); continue; }
      const r = applyMove(state, { seat: ev.seat, kind: ev.kind, x: ev.x, y: ev.y });
      if (!r.ok) {
        problems.push(`#${ev.seq}: 回放落子被引擎拒绝（${r.reason}）${ev.kind}@(${ev.x},${ev.y})`);
        continue;
      }
      const h = stateHash(state);
      if (ev.hash && ev.hash !== h) {
        problems.push(`#${ev.seq}: 状态指纹不一致 日志=${ev.hash} 回放=${h}`);
      }
      const who = state.seats?.[ev.seat] ?? `P${ev.seat + 1}`;
      frames.push({
        state: structuredClone(state),
        label: `#${ev.ply} ${who} ${ev.kind === 'grow' ? '生长' : '抗菌素'} (${ev.x},${ev.y})`,
        move: ev, hash: h,
      });
    } else if (ev.type === 'end') {
      end = ev;
      if (state && state.status === 'finished') {
        if (state.winner !== ev.winner) {
          problems.push(`#${ev.seq}: 赢家不一致 日志=${ev.winner} 回放=${state.winner}`);
        }
        if (ev.hash && ev.hash !== stateHash(state)) {
          problems.push(`#${ev.seq}: 终局指纹不一致 日志=${ev.hash} 回放=${stateHash(state)}`);
        }
      } else if (state) {
        // 外部终局（超时 / 断线弃赛）：日志本身就是裁决来源，按日志补全终局
        const ok = finishExternal(state, ev.winner, ev.reason);
        if (!ok) {
          problems.push(`#${ev.seq}: 无法按日志外部终局（状态异常）`);
        } else {
          const h = stateHash(state);
          if (ev.hash && ev.hash !== h) {
            problems.push(`#${ev.seq}: 终局指纹不一致 日志=${ev.hash} 回放=${h}`);
          }
          frames.push({
            state: structuredClone(state),
            label: `终局 ${ev.winner === 'draw' ? '平局' : `P${ev.winner + 1} 胜`}（${ev.reason}）`,
            hash: h,
          });
        }
      }
    }
    // presence / reject / turn 等事件只作审计，不影响局面折叠
  }

  if (state && state.status === 'finished' && !end) {
    problems.push('回放终局但日志缺少 end 事件');
  }
  return { frames, problems, end, finalState: state };
}

export function parseJsonl(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
