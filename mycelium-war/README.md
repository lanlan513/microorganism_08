# 菌落抢地盘（Mycelium War）

两株菌在培养皿两端开局，轮流往中间铺菌丝、抢营养点、分泌抗菌素压制对方。
先占满培养皿（比地盘），或把对方围到无路可走的一方获胜。

## 设计底线：服务端权威

浏览器**只画结果、只提交意图**。落子顺序、思考时限、胜负判定全部在
`server/server.js` 裁决，客户端没有任何能改变对局结果的逻辑：

- 每一手必须 `POST /api/games/:id/move`，服务端过一遍规则引擎（`shared/engine.js`）后
  通过 SSE 广播权威局面；客户端预测被拒就立即回滚，不留幽灵菌丝。
- 每手带状态指纹（FNV-1a 哈希），写进 JSONL 日志；回放时逐手核对，确保
  **同一盘日志只能重放出同一盘棋和同一个赢家**。
- 思考时钟完全由服务端 `deadline` 驱动，协议中没有任何客户端时间字段，
  本机时钟快慢/篡改都与超时判定无关。客户端只用每条消息的 `serverNow` 做偏移校准显示。
- token 鉴权座位，伪造 token 一律 403。

## 玩法

- 点**空格**：从自家菌落边缘生长菌丝（必须四邻接自家菌，不能隔空长）。
- 点**自家菌落**：向周围空格分泌抗菌素，6 手内对方无法长入（只压制对手，不挡自己）。
- 吃到**金色营养点**：获得连击，可连走多手（最多囤 3 次）。
- 胜：占满培养皿按占地结算 / 把对方围死（无格可长也无法分泌抗菌素）/
  连续 16 手双方都只能刷毒（毒战僵局）按地盘结算 / 超时 / 断线超 30 秒弃赛。

## 运行

```bash
npm start                 # 启动服务端，默认 8080（PORT=xxxx npm start 改端口）
# 浏览器打开 http://localhost:8080 创建对局，把其中一个座位链接发给对手
```

大厅可设置棋盘大小、思考时限、以及**模拟弱网延迟**（每方向 300/900ms，用于演示预测纠错）。

两个机器人对战（从命令行直接打）：

```bash
node tools/bot.js "http://localhost:8080/?game=<id>&seat=0&token=<token>"
```

## 测试与回放

```bash
npm test                  # 7 项集成测试（真实 HTTP + SSE）
node tools/replay.js logs/<gameId>.jsonl   # CLI 回放：逐手核对指纹+赢家
```

浏览器回放页：对局结束后点 HUD 里的「查看本局回放」，或直接打开
`/replay?log=/api/games/<id>/log`，可逐帧播放/拖动进度条。

浏览器实测与截图证据（需要 Playwright）：

```bash
npm i -D playwright
npx playwright install chromium
node tools/shoot.mjs       # 产物写入 artifacts/
```

## 边界情况如何处理

| 情况 | 处理 |
| --- | --- |
| 两人同时落子到同一格 | 服务端串行裁决，只有当前行动方的第一手生效；另一方/重复请求被拒，日志只有一条 `move` |
| 断线又回来 | 自己回合断线则**冻结思考时钟**（封存剩余时间，不流逝）；30 秒（可配）内重连，SSE 重连即下发完整快照再同步，时钟用剩余时间恢复继续 |
| 断线不回 | 超过宽限判 `forfeit` 负，对方胜 |
| 同一手重复提交 | 客户端每手生成 `moveId`（UUID），服务端对 `moveId` 幂等；串行重发返回带 `duplicate:true` 的原结果，并发重发共享同一处理承诺，永远只生效一次 |
| 弱网 | 客户端先本地预测上屏（半透明虚线格），每 2.5s 幂等重发；收到拒绝或权威快照即回滚+红叉闪现，6 秒兜底清除，不留幽灵菌丝 |
| 双方时钟不一致 | 协议无客户端时间；倒计时是服务端 `deadline` 的本地投影，用 `serverNow` 偏移校准；判超时只看服务端收包时刻 |

## 目录

```
shared/engine.js    纯规则引擎（服务端、CLI 回放、浏览器回放共用同一份）
shared/replay.js    JSONL 事件流折叠重放 + 指纹校验
server/server.js    权威服务端：HTTP + SSE，零运行时依赖
public/             Canvas 渲染器、对局页、回放页（无框架，原生 ES Module）
tools/bot.js        SSE 机器人 / 测试操作工具
tools/replay.js     CLI 回放校验
tools/shoot.mjs     Playwright 实测延迟与截图
test/integration.mjs 7 项集成测试
logs/               对局 JSONL 日志（含每手指纹）；metrics-*.jsonl 为客户端实测延迟
artifacts/          验收截图与数据
```
