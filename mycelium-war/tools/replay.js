// CLI 回放：node tools/replay.js logs/<gameId>.jsonl
// 把整盘日志重新过一遍引擎，逐手核对状态指纹，并比对赢家。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayEvents, parseJsonl } from '../shared/replay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];

function usage() {
  console.log('用法: node tools/replay.js <日志文件.jsonl>');
  process.exit(2);
}
if (!file) usage();

const text = fs.readFileSync(file, 'utf8');
const events = parseJsonl(text);
const { frames, problems, end, finalState } = replayEvents(events);

if (!frames.length) {
  console.error('✗ 日志中没有 init 事件，无法回放');
  process.exit(1);
}

const s0 = frames[0].state;
console.log(`棋盘 ${s0.size}×${s0.size}  种子 ${s0.seed}  共 ${frames.length - 1} 手`);
console.log('─'.repeat(48));
for (let i = 1; i < frames.length; i++) {
  console.log(`  ${frames[i].label}  hash=${frames[i].hash}`);
}
console.log('─'.repeat(48));

const reasonText = {
  encircle: '围死', territory: '占满结算', cap: '手数上限',
  stalemate: '毒战僵局', timeout: '超时判负', forfeit: '断线弃赛',
};
const name = (w) => (w === 'draw' ? '平局' : s0.seats[w] ?? `P${w + 1}`);

if (end) {
  console.log(`日志赢家: ${name(end.winner)}（${reasonText[end.reason] ?? end.reason}）`);
} else if (finalState.status === 'finished') {
  console.log(`日志未记录 end 事件；引擎判定赢家: ${name(finalState.winner)}`);
}
if (finalState.status === 'finished') {
  console.log(`回放赢家: ${name(finalState.winner)}（${reasonText[finalState.winReason] ?? finalState.winReason}）`);
  console.log(`占地: ${finalState.counts[0]} vs ${finalState.counts[1]}`);
}

if (problems.length) {
  console.error('\n✗ 回放校验失败：');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
const sameWinner = !end || finalState.status !== 'finished' || end.winner === finalState.winner;
if (!sameWinner) {
  console.error('✗ 日志赢家与回放赢家不一致');
  process.exit(1);
}
console.log('\n✓ 回放校验通过：所有状态指纹一致，赢家一致，可完整重放出同一盘棋。');
