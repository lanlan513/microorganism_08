// 浏览器回放页：拉取 JSONL 日志，用与服务端同一份引擎折叠重放，逐帧给人看。
import { createRenderer } from '/render.js';
import { replayEvents, parseJsonl } from '/shared/replay.js';

const q = new URLSearchParams(location.search);
const logUrl = q.get('log') || '/api/games';
const renderer = createRenderer(document.getElementById('replay-canvas'));
const $ = (id) => document.getElementById(id);

let frames = [];
let index = 0;
let playing = false;
let timer = null;

async function load() {
  $('replay-src').textContent = logUrl;
  const text = await fetch(logUrl).then((r) => {
    if (!r.ok) throw new Error('日志加载失败 ' + r.status);
    return r.text();
  });
  const events = parseJsonl(text);
  const { frames: fs, problems, end, finalState } = replayEvents(events);
  frames = fs;
  if (!frames.length) throw new Error('日志为空');
  $('scrub').max = frames.length - 1;
  showFrame(index);

  const winText = { encircle: '围死', territory: '占满结算', cap: '手数上限结算', stalemate: '毒战僵局按地盘结算', timeout: '超时', forfeit: '断线弃赛' };
  const wt = end
    ? (end.winner === 'draw' ? '平局' : `${['青菌', '赤菌'][end.winner]} 胜`)
    : (finalState?.status === 'finished' ? ([ '青菌','赤菌'][finalState.winner] ?? '') + ' 胜' : '未终局');
  $('replay-result').textContent =
    `结果：${wt}${end ? `（${winText[end.reason] ?? end.reason}）` : ''} · 共 ${frames.length - 1} 手`;
  $('replay-problems').textContent = problems.length
    ? '⚠ 校验异常：\n' + problems.join('\n')
    : '✓ 每一手的状态指纹与日志完全一致，重放出的赢家与日志相同。';
}

function showFrame(i) {
  index = Math.max(0, Math.min(frames.length - 1, i));
  const f = frames[index];
  renderer.draw({
    state: f.state,
    mySeat: -1,
    pendings: [], flashes: [], hover: null,
    now: performance.now(),
  });
  $('frame-label').textContent = `${index} / ${frames.length - 1} · ${f.label}`;
  $('scrub').value = index;
}

$('btn-first').onclick = () => { pause(); showFrame(0); };
$('btn-prev').onclick  = () => { pause(); showFrame(index - 1); };
$('btn-next').onclick  = () => { pause(); showFrame(index + 1); };
$('scrub').addEventListener('input', () => { pause(); showFrame(+$('scrub').value); });

$('btn-play').onclick = () => {
  if (playing) { pause(); return; }
  playing = true;
  $('btn-play').textContent = '⏸ 暂停';
  const speed = +$('speed').value;
  const step = () => {
    if (!playing) return;
    if (index >= frames.length - 1) { pause(); return; }
    showFrame(index + 1);
    timer = setTimeout(step, speed);
  };
  step();
};
function pause() {
  playing = false;
  $('btn-play').textContent = '▶ 播放';
  clearTimeout(timer);
}

load().catch((err) => {
  $('frame-label').textContent = String(err);
  $('replay-problems').textContent = err.stack;
});
