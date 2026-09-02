# ChatPanel 修复编队调度台账(2026-09-02)

> 调度者维护。每有 agent 交付就更新本文。agent **不提交**,由调度者统一收口。

## 基准

- 工作树:`/Users/elian/Documents/od-wt-chat-panel`,分支 `feat/chat-panel-next-impl`,PR #7518
- 起点 commit:`17eb85068b`(已推 origin,工作树干净)
- **唯一最新设计基准**:PR #7170 @ `8015870095348aa40655ef70edec6ac4de6fcc1b`
  - 生成页(浏览器验收用):`/Users/elian/Documents/od-design-artifacts/chat-panel-next-pr7170-8015870.html`(md5 `495992a904b6674dd07db4e0cb8d6f19`)
  - 场景稿:`/Users/elian/Documents/od-design-artifacts/chat-panel-scene-pr7170-8015870.html`
  - 设计源码:`git show 8015870095348aa40655ef70edec6ac4de6fcc1b:docs/design/chat-panel/src/<file>`
  - 已验证:该 commit 上 `build.mjs` 重跑生成页 md5 一字不差,src 与生成页同步,不存在"src 旧、html 新"
- **旧稿仅用于 diff**:`/Users/elian/Documents/od-design-artifacts/chat-panel-next.html`(md5 `28ea4c65…`,= `1bbdce0b06`)
- 中间稿(08-30,`50cfe50cfe`,md5 `aaa6a94f…`)在 `~/Downloads/chat-panel-next (1).html`,已不是基准
- 旧→新真实变更:10 个文件,2075 增 / 650 删

## 文件独占分区(防止并行 agent 互相覆盖)

| 组 | 独占文件 |
|---|---|
| G1 QuestionForm | `QuestionForm.tsx`、`viewer/composio.css`、`artifacts/question-form.ts` |
| G2 执行记录/thinking/Todo | `chat/ExecutionShell.tsx`、`chat/primitives/record.module.css`、`Foldable.tsx`、`ThinkingMarkdown.*`、`useThinkingStream.ts`、`PlanPill.*`、`ToolCard.tsx` |
| G3 分享/导出/产物卡 | `FileOpsSummary.tsx`、`viewer/tools.css`、`OdCard.module.css` |
| G4 Upgrade/错误/重连 | `UpgradeCard.*`、`RunErrorCard.*`、`Reconnect.*`、`runtime/amr-guidance.ts`、`runtime/chat/reconnect-state.ts` |
| G5 Composer/引用/队列 | `ChatComposer.tsx`、`styles/chat.css`、Quote* 组件 |
| G6 next-step | `AssistantMessage.tsx`、`viewer/theater.css`、prompts |
| G7 生图计数/媒体 | `ChatPane.tsx`、`daemon/routes/media.ts`、`contracts/api/media.ts` |
| G8 分诊 | 不改源码,只写 `scratchpad/g8-triage-report.md` |

i18n(`i18n/types.ts` + 19 个 locale)是共享面,G1/G4/G5/G6 都可能加 key —— **收口时重点查冲突**。

## 派单与状态

| 组 | 承接 | 状态 |
|---|---|---|
| G1 | 颜色选择器、数值滑块、多选计数两段式、OPEND-2402、2401 | 运行中 |
| G2 | **修红 CI(2 个 Todo 用例)**、thinking 流窗口 16px、执行层级排版、skipped token、OPEND-2557、2548、2417 | 运行中 |
| G3 | OPEND-2552、2559、2560 复验、2547 复验、artifact overlay + 16px modal | 运行中 |
| G4 | Upgrade 卡改版(CTA 移底排 + 配色翻转)、错误卡 16px、重连字重;**错误卡文案只审计不改** | 运行中 |
| G5 | OPEND-2551、2546、用户气泡 #121212 / 静音 #a3a3a3、队列 icon + steer | 运行中 |
| G6 | OPEND-2558、2497、2500、2412 + **五条 prompt 路径 next-step 契约审计** | 运行中 |
| G7 | OPEND-2195 生图逐张计数、2543/2544 边界复验补洞 | 运行中 |
| G8 | OPEND-2419、2416、2414、2194、2410 分诊定位(不改码) | 运行中 |

## 明确挂起 / 不做

- **选项列表分组能力(常用/更多折叠)** —— 用户挂起待讨论,任何 agent 不得实现
- **`FormOption` 行尾副标(language-code)** —— 需扩 schema,同上挂起
- **OPEND-2545 图片历史版本语义** —— 有独立待评审设计 `chat-artifact-versioning-design.md`,不得顺手做 mtime cache-bust
- **错误卡「从失败处重试」→「重试」** —— 产品逻辑,G4 只出审计结论

## 已知未决

- PR #7518 CI 红:`ToolCard.todo.test.tsx` + `assistant-message-unfinished-todos.test.tsx`,疑似折叠延迟挂载性能补丁回归 → G2 负责
- Plane 附件 22 份只落盘 4 份,18 份因 401 + 组织策略拦截未取得(见 `evidence/plane-chatpanel-2026-09-01/attachments/manifest.md`)
- Plane 写 API:**必须用 curl**,python urllib 会被 Cloudflare 按 UA 挡成 403
- 附件二进制(12MB)故意留在 git 外,只提交 manifest

## 已同步到 Plane

2026-09-02 已把 22 项置为「进行中」(只 PATCH `state`,未动 assignees)。改前全量快照:
`scratchpad/plane_module_BEFORE_1033.json`

## Plane 状态流转纪律

工具:`scratchpad/plane-state.sh <inprog|done|testing> <编号...>`(只 PATCH `state`,不动 assignee;必须 curl,urllib 被 Cloudflare 挡)。

流转规则:
1. **派单即置「进行中」** —— agent 一开工就改,让用户实时看见。
2. **「开发完成」必须先证明红测能看见缺陷** —— 撤掉实现后精确变红、恢复后变绿,两边都留输出。只有 commit 存在、只有测试绿,都**不够**。
3. 依赖真机 / 真实 AMR / 打包客户端才能确认的,停在「进行中」,在本文写明缺什么证据。

### 已流转

| 编号 | 状态 | 证据 |
|---|---|---|
| OPEND-2549 | **开发完成** | 撤 `question-form-detect.ts` → 精确红 `counts the legacy child-tag form…`;撤 `design-delivery.ts` → 精确红 `does not report a malformed closed question form as a successful text answer`;恢复后各 18/18 绿 |
| OPEND-2497 | **开发完成** | G6 交付。撤 `AssistantMessage.tsx` → 新用例 `renders the agent-written suggestions on a completed turn with no produced file (OPEND-2497)` 精确红;恢复后 23 passed。另加失败/取消轮的反向守卫,和「点击只填草稿」的参数级断言(`setDraft(text, {entryFrom:'next_step'})`) |
| OPEND-2550 | 进行中 | commit `c3bf52b67f` 带 121 行新测试,但 `AssistantMessage.tsx` 当前由 G6 独占,**无法安全做撤销复验**。等 G6 交付后由调度者补验再流转 |
| OPEND-2543 / 2544 | 进行中 | 已提交 `f8b6c6c248`,G7 正在做边界补洞(mtime 容差、同尺寸撞车、注册窗口),验完再流转 |
| OPEND-2560 / 2547 | 进行中 | 前一轮已改,G3 正在复验是否误伤其他卡型,验完再流转 |

## 2026-09-02 调度者发现的回归(重要)

`AssistantMessage.test.tsx > never shows the tool-op summary and the produced-files block at once (P0 recvqaerXd82bE)` 红。

**这是 commit `c3bf52b67f`(OPEND-2550)引入的,不是既有红。** G6 曾判为「既有失败、疑似 G3 在飞」——它对照的 HEAD 已含该 commit,所以判错。

冲突的两条不变量:
- 2550 要:`producedFiles === undefined` = 尚未结算 → 回落工具行证据;`[]` = 权威空 → 不回落
- P0 要:有真实 `Write` 工具行 + 有 `declareTurnCards` 声明,即使 `producedFiles: []` 也必须出卡

`c3bf52b67f` 新增的 `if (produced.length === 0) return [];` 是断点。那条 P0 fixture 证明 **daemon 会在确实写了文件的回合给出 `[]`**,所以「`[]` = 权威空」这个语义在当前数据链上站不住。

已转 G6 修(它独占 `AssistantMessage.tsx`),要求:两条不变量都要绿、各自撤销复验、**不许为了 P0 变绿把 2550 退回去**。

## Plane 附件:资产 401 已复核

调度者亲自复验:带 API key 直取 `/api/assets/v2/.../<asset-id>/` 对 2558、2550 均返回 **HTTP 401**(58 字节 JSON,不是图)。manifest 记录的 18 份 blocked 属实,API key 无资产读权限。
唯一已验证可行的路径是**已登录浏览器**(前一轮 2557/2559/2560 三张就是这么拿到的,记为 `embedded-image-snapshot`)。
影响:OPEND-2558(Urgent)、2550(Urgent)、2552(High)描述为空或仅图,**没有原件就无法下手,不能靠猜**。

## G8 分诊结论(2026-09-02,已核实采纳)

### 四张单子是同一个 run

OPEND-2410 / 2414 / 2416 / 2419 全部诞生于同一次会话的同一个 run(`3fc3b3ae`,08-28 07:17→08:02,44.7 分钟),建单时刻分别落在 run 内 +6.8 / +12.7 / +19.6 / +31.3 分钟。此前当四件事分诊,所以每次都找不到抓手。

| 单号 | 结论 |
|---|---|
| 2419 | **不是卡死,是模型行为**。最长静默 150s 且都是正在跑的 Bash;结束态 `cancel_requested` exit 143(用户自己停的);产出 3 个文件。44.7 分钟去向:模型思考 28.5min(64%)、卡在 4KB/s 维基图片下载 14.1min(32%)、真正写产物 2.1min(5%)。模型在上一轮 plan 里写了「抓不到就退化成占位」却从未执行,而是 `sleep 75→110→150` 轮询 + 三次重启抓取脚本。全程可见文本仅 221 字符 |
| 2416 | **与 2419 重复**,建议并单。建单那刻 run 正常推进,「卡住」是感知不是状态 |
| 2414 | **模型压根没发 question form**。四个 run 的文本流 + 思维流全文检索,`<question-form` 出现 **0 次** → 「解析不出」「解析了没渲染」都被排除。根因在 `apps/daemon/src/prompts/discovery.ts` 的 RULE 1:把发问设成默认不发。**与 §23 的 direction-cards 缺陷无关**(那个的前提是表单已发出) |
| 2410 | **旧结论推翻**。不是「模型可以选择不发计划」,是**清单工具根本没暴露**(详见下节)。按 agent 实测:claude **0/3** 个 run 发清单(47 次工具全是 Bash),AMR 4/18 发、共 10 次 TodoWrite。用户当时猜的方向对,但准确说不是提示词,是工具暴露 —— 而系统提示里有 **17 处**让模型用一个它拿不到的工具 |
| 2194 | **已置开发完成**。分支比单子要求的更彻底:没按单子加映射,而是在 `acpToolName` 入口做权威归一。差分实测:main 版在带描述性 title 时产出 `Other`(清单整个消失),分支版 5/5 正确;仓内测试 4/4 绿;beta.7 诊断包 18 个真实 AMR run 精确 `"TodoWrite"` 10 次、零 mangling |

### ⚠️ 生产缺陷:Claude 的 Todo 卡在所有已发布版本里都画不出来(调度者已复核)

- `22e2ee0ec3 fix(daemon): let Claude Code draw the Todos card again` **不在 `origin/main`、不在任何 tag**,只活在若干 feature 分支(含本分支)
- main **有**解析侧:`claude-stream.ts:145/161/186` 把 `TaskCreate`/`TaskUpdate` 归一成 `TodoWrite`
- main **没有**那个 env 开关(`CLAUDE_CODE_ENABLE_TODO_TOOLS`)→ Claude Code ≥2.1.x 不向模型暴露 plan 工具族
- 净效果:**已发布版本里那段归一逻辑在等一个永远不会到达的事件**;`open-design-v0.21.0` 上确认没有
- 本分支有(`apps/daemon/src/runtimes/env.ts:99-100`)
- **待用户拍板**:是否单独往 main 提一条修复(参照模板/插件上下文那次 PR #7533 的打法)

### 新发现的缺陷:daemon 把同一个 tool_use 发两遍(已派 G8 修,不开单)

`claude-stream.ts` 的去重守卫是单向的:`assistant` 那条路查集合,`content_block_stop` 那条路只 add、自己从不查。beta.4 三个 run 无一例外,40/40 对 input 逐字节相同。已在当前分支复现(5 形态 4 绿 1 红)。
用户影响小(web 侧有一层去重兜着),但 `events.jsonl` 是脏的,任何不去重的消费方看到 2 倍工具数。
按用户「自己的发现自己跟进,不自建 issue」的规矩,不开 Plane 单,直接派 G8 修。

### 需要产品拍板的三处

1. **2414 的发问阈值**:速度 vs 确定性,`discovery.ts` 目前写死选了速度
2. **2419 的进度面**:`quietMs` 探测还在算但**自 08-27 起无人消费**(产品撤了「上游响应慢」文案、要求保留探测)。本案真正没被覆盖的形态是「流很活跃但 28 分钟没有产物落地」
3. 2416 是否与 2419 并单

### G8 自查掉的一个错(值得记)

它一度拿 beta.7 包当「已修复」对照组,得出「重复率 0%」。但 beta.7 那 20 个 run **全是 AMR,根本不走 claude-stream**,对照组无效。修正后没有任何证据表明已修复,才转去写复现脚本。

### 仍缺的证据

1. `0.21.1-beta.7` 的构建 SHA —— 「beta.7 已含 2194 修复」是从产出字符串反推的高置信推断,不是直接证据。诊断包 manifest 记 version/channel 但**不记 SHA**,建议补该字段
2. claude 侧发清单率样本仅 n=3,发版验收建议补 flag on/off 各 3 轮对照
3. 现有包只对 `agent_thought_chunk` 采样 `acp_raw_event_shape`,看不到 ACP 工具帧原始键集

## 产品裁决:设计稿与产品口径冲突的项(2026-09-02)

> 这类冲突会反复出现,统一记在这里。**产品口头裁决 > 设计稿**。

### 1. 思考区不要滚动窗口(推翻最新设计稿)

用户与设计同学线下讨论后决定,原话:
> 先不要这个滚动的了,这里文本就和外面普通文本一样有个流式的效果就行,不要这个滚动效果了,**滚动太慢了,也很难看清**

- **作废**:设计稿 `.stream-viewport` / `thinking-stream.css` / `thinking-stream.js` 那一套(固定高度视口 + 自动滚动跟随 + 上下渐隐遮罩)。「很难看清」指的就是遮罩把上下行淡化掉了。
- **要的**:思考正文与普通正文同一套流式逐字浮现(blur-in),自然高度、不设视口、不裁剪。
- **保留**:灰底容器本身、折叠/展开行为。
- 实施:G2。盘点口径已同步 W3(不得列为缺口,要单列为"设计稿有、产品已否决")。
- ⚠️ 衍生风险:去掉视口后长思考会把执行记录撑很长。若成立是**新的产品问题**,不许自行加 `max-height` 把滚动变相加回来。

### 2. 错误卡「从失败处重试」→「重试」:设计稿的改动其实已是现状

G4 全仓核实:「从失败处重试」在产品源码里**一次都没出现**,产品早就是「重试」。该字符串只存在于设计镜像 fixture 和注释里。
更要紧的结论:**这个产品里没有任何一个「重试」是从失败点恢复的** —— 约 33 种失败态点重试都是整轮重跑。真正从断点续的是「继续运行」,且对可恢复失败产品是故意用它**替换**重试(否则会既 resume 又重发原话,活干两遍)。
遗留:`amr-guidance.ts` 的 `primaryActionForFailure` 注释仍在重复设计稿那句不准确的说法,应改为"重新跑这一轮"。

## 用户实测发现(2026-09-02,本地 runtime :17573)

| 现象 | 归属 | 状态 |
|---|---|---|
| 选项描述文字冲出卡片右边界被裁 | G1(`composio.css` `.qf-chip-desc` 无任何换行/溢出处理) | 已派 |
| 「已确认」摘要块缺底色 | G1。**确认没对齐**:最新稿 `components.css:2107-2113` 有 `padding:12px` / `background: var(--bg-panel)` / `border-radius:16px`,产品 `composio.css:4222` 三条全缺 | 已派 |
| 「Add to chat」浮层跑到离选区很远的下方 | W6(`QuoteBar.tsx`)。怀疑用了整条消息的 rect 而非选区 Range 的 rect | 已派 |

## 本地预览运行时

```
web     http://127.0.0.1:17573
daemon  http://127.0.0.1:17456
namespace  chatpanel
OD_DATA_DIR  ~/.od-chatpanel-preview   (隔离,不碰日常数据)
desktop  idle(按用户要求不起 Electron)
```
停:`pnpm tools-dev stop --namespace chatpanel`

## W2 结论:重试 / 恢复语义(2026-09-02)

### 已坐实的三件事

1. **客户端与 daemon 判定不一致是真的**。客户端 `ChatPane.tsx:1888` 只看 `resumable && agentId 匹配`;CLI `cli.ts:7816` 更弱,只看 `status.resumable`;daemon `agent-session-resume.ts:139-152` 还要比 `storedModel` / `storedCwd` / cursor。红测实测「失败→换模型→点继续」确实让 daemon 判 `model_changed` 并开新 session。

2. **但 Web 客户端不受影响**。挡住它的是 `server.ts:2109-2118`:Web 每次同时寄 `message`(整份 transcript)和 `currentPrompt`(只有最新一轮),daemon 接上了用后者、没接上用前者,**两条分支都对**。Web 不需要改,改了反而会把原话塞两遍。

3. **真正在漏的是 `od run continue`(CLI)**。它只发 `message = RESUME_CONTINUE_PROMPT`,不带 transcript。红测抓到 stdin 全文 52652 字符里原始请求出现 **0 次**。受影响面是所有拿 `od` 当后端的外部 agent(hermes / openclaw / bot),不是 UI。

### 新发现:Retry 会往已恢复的 session 里重发原话

链路(纯读码确认):第 1 轮成功存 session S(cursor=A1)→ 第 2 轮恢复 S、发 U2、**非可恢复**地失败 → UI 因 `resumable=false` 显示「重试」→ 点击后 guard 仍通过(A2 被 `currentAssistantMessageId` 排除,cursor 仍等于 A1)→ **再次 `--resume S` 并重发 U2**。
即 `ChatPane.tsx:1877-1887` 注释描述的「恢复+重发=干两遍」,**在 UI 主动路由到「重试」的那条路上现在就在发生**。

### 修法

- **CLI 洞(可先做)**:`ChatRequest` 增可选字段 `resumeContinuation?: boolean`;daemon 在 `requiresFullTranscript && resumeContinuation && storedSessionId && storedLastMessageId` 时,用 `agent_sessions.lastMessageId` 精确锚点取回被拒 session 当时的原始请求并渲染进 body。纯增字段,**现存调用方输出逐字节不变**,Web 不动。⚠️ contracts 改完必须重建 dist。
- 顺带:`RESUME_CONTINUE_PROMPT` 有两份副本(`web/runtime/resume.ts` 与 `daemon/cli.ts:35-40`),字面漂移无人守护,建议收进 contracts。
- **Retry 那条待产品拍板,不要自己定**:两种用户意图(被截断想接着做 / 方向错了想推倒重来)修法互相排斥,选错比不修更糟。

### 交付物
- 新增红测 `apps/daemon/tests/resume-continue-prompt-context.test.ts`,当前 `1 failed | 1 passed`(第 2 条是对照组,证明 Web 那条路是好的)
- **源码零改动**。该测试文件**暂不提交**,等修法落地一起进,避免把 CI 弄红。

## 待产品/用户拍板清单(累积中,均已阻塞)

| # | 事项 | 阻塞了什么 |
|---|---|---|
| 1 | 是否单独往 main 提 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 修复 | 已发布版本里 Claude 的 Todo 卡全部画不出来 |
| 2 | OPEND-2416 是否与 2419 并单 | 两张单描述同一个 run 的同一件事 |
| 3 | OPEND-2414 的发问阈值:速度 vs 确定性 | `discovery.ts` RULE 1 现在写死选了速度 |
| 4 | 2419 暴露的盲区:要不要做「久无产物落地」提示 | `quietMs` 探测自 08-27 起无人消费;本案形态是"流很活跃但 28 分钟没产物" |
| 5 | 「重试」承诺什么?要不要拆「继续」/「重新来过」两颗按钮 | W2 的 Retry 重发缺陷 |
| 6 | 去掉滚动窗口后长思考无限撑长执行记录怎么办 | 真实数据 42,397 字符/轮;不许用 max-height 把滚动从侧门放回来 |
| 7 | 是否允许用用户 Chrome 捞那 18 份 Plane 附件 | OPEND-2558(Urgent)、2550、2552 描述为空或纯图,无原件不能下手 |
| 8 | OPEND-2417 需报告人补信息 | Plane 上无描述/评论/附件,G2 拒绝猜 |
