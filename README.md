# NonokaChan AI Bot

![license](https://img.shields.io/badge/license-GPL--3.0-blue)
![lang](https://img.shields.io/badge/TypeScript-ESM-3178c6)
![protocol](https://img.shields.io/badge/protocol-OneBot%20v11-lightgrey)
![pm](https://img.shields.io/badge/package%20manager-yarn-2c8ebb)

一个住在 QQ 群里的 AI。她会自己决定什么时候插话，记得群友半年前说过什么，还会自己画画。

底层是一条轻量的**模块调用链**：消息进来，按注册顺序一个个模块问"这条归我管吗"，谁接住谁处理。这个仓库负责编排消息、执行工具调用、维护本地记忆。

## 她都会些什么

**🎲 会看气氛插话。** 不是每条消息都回。基础插话概率很低，但你 @ 过她之后的一定时间内会暴涨，聊到她感兴趣的关键词也会增加她插话概率，然后按周期指数衰减。所以她的表现是"被戳一下就活跃一阵，没人理就慢慢安静"。每个群还有单独倍率设定。

**🧠 记得住事。** 群聊记录全量落盘，定期抽取结构化记忆（性格 / 事件 / 关系 / 别名）。检索时字面匹配（FTS5 + BM25）和语义匹配（向量余弦）双路召回，RRF 融合排序。每人记忆数量有限，超了就按 `confidence × exp(-天数/30) × log(1+hits)` 淘汰最弱的。记忆会自然遗忘，但被反复提起的会留下来。

**🎨 自然语言生图。** 自然语言调起画图工具，生图期间依旧可以自然回复，并知道自己的画画状态。`drawing → done/failed/blocked` 的状态机结果会注入下一轮 prompt。

**🗣️ 知道你们在说谁。** 群友互相叫外号，模型是分不清的。`nameMatch` 做归一化模糊匹配（去 emoji、零宽字符、尾部语气词，还对拉丁字符做边界检查，免得 `azu` 命中 `azusa` 内部），`aliasIndex` 扫 180 天历史昵称建索引，`mention` 会把对话里顺带提到的人的档案也塞给模型。

**🔁 还有个复读机。** 连续相同消息达到随机阈值会自动复读。

**📡 还会一堆杂活。** 以图搜源（SauceNAO，动画会补查 WhatAnime 拿集数和时间点）、关键词图库（`/加图` 存图，之后说关键词随机发一张）、B站动态 / Twitter / YouTube 开播推送、TTS 语音回复、内嵌管理面板热改配置。

## 快速开始

需要一个 OneBot v11 实现（正向 WebSocket）在跑。

```bash
yarn install
```

复制 `config_demo.json` 为 `config.json`，填这四个：

- `wsConfig` —— OneBot 正向 WS 的 host / port
- `botConfig.admin` —— 管理员 QQ 号列表，管理员私聊能发控制命令
- `botConfig.nonokaService` —— Nonoka 服务地址与 apiKey
- `botConfig.apiKeys` —— saucenao / lolicon / 生图服务的密钥

然后：

```bash
yarn dev
```

想看详细日志用 `yarn debug`。剩下的配置项（插话开关、黑名单、各功能白名单、推送订阅）都能在跑起来之后从管理面板改，不用重启。

## 开发指南：两分钟塞一个新功能进去

模块调用链的好处是加功能几乎没有仪式感——写一个 `match` 判断"这条消息归我吗"，写一个 `run` 干活，注册一行，完事。

**第一步，想清楚你要拦哪种消息。** `request`（好友请求）/ `private`（私聊）/ `group`（群聊）。群聊还能再精确一层：`group:at`（被 @ 了）和 `group:plain`（没被 @）。

**第二步，在对应目录建个文件：**

```ts
import {
  EventKind, FlowResult, ModuleContext, NonokaModule,
} from '@/core/nnkModule';
import { GroupMessageData } from '@/types/event';

class MyModule extends NonokaModule<GroupMessageData> {
  readonly name = 'MyModule';

  readonly events: EventKind[] = ['group:plain'];

  // 只做判断，不产生副作用；命中数据通过返回值传给 run
  match(ctx: ModuleContext<GroupMessageData>) {
    return /触发词/.test(`${ctx.data.message}`);
  }

  // 真正的副作用（发消息、写状态）都放这里
  run(ctx: ModuleContext<GroupMessageData>): FlowResult {
    ctx.reply('收到～');
    return 'stop'; // 或 'continue' 继续传给链上后面的模块
  }
}

export default new MyModule();
```

**第三步，去 [src/index.ts](src/index.ts) 的 `loadModules([...])` 里加一行。** 数组顺序就是优先级：越靠前越先拿到消息，`run` 不返回 `'continue'` 的话，后面的模块这辈子都见不到这条消息。所以别把万能匹配的模块放前面。

**两个容易踩的坑：**

- 模块是**单例**（`export default new MyModule()`），实例在所有消息之间共享。别拿实例字段存单条消息的状态，并发一来就串了——命中阶段算出来的东西通过 `match` 的返回值传给 `run`。
- 要调外部 API 的话，封装到 `src/service/` 里，别在 `modules/` 里直接发 HTTP。ESLint 会拦你（见下面的分层规则）。

**还需要别的：**

- **定时任务** → 在 [src/tasks](src/tasks) 实现，`nnkSchedule.loadJob([...])` 注册，抄现有任务的 `preventOverrun` / 失败退避写法。
- **新配置字段** → [src/types/config.ts](src/types/config.ts) 加类型，`config_demo.json` 补默认值；想让管理面板能改就往 [src/core/admin/config.ts](src/core/admin/config.ts) 的白名单里加（密钥类字段不要加）。

提交前跑 `yarn lint`。**动了记忆检索或 prompt 的话，跑 `yarn memory:probe` / `yarn memory:eval` 用真实语料实测**，每组建议 ≥30 条——这块凭感觉改反复被数据打脸过。

## 架构总览

```
   OneBot 实现
        │
        │  正向 WebSocket（api 连接 + event 连接）
        ▼
   src/core/nnkWS.ts
        │
        │  friend / private / group
        ▼
   src/core/nnkCore.ts  NonokaCore.flow()
        │
        │  派生 group:at / group:plain，构造 ModuleContext
        ▼
┌───────────────────────────────────────────────┐
│  moduleList（按 src/index.ts 注册顺序遍历）     │
│  好友请求 → 管理员命令 → 群命令 → 搜图 → 图库    │
│  → 涩图 → 复读机 → 私聊 AI → 群聊 AI            │
│  每个模块：match(ctx) 命中判定 → run(ctx, hit)  │
│  run 返回 'continue' 才继续往下传，否则链路终止  │
└───────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
 src/service/*（API 封装）      src/modules/aiReply/memory/*
 LLM / 生图 / 搜图 / 推送源      SQLite 记忆库（FTS5 + 向量）
```

```
src/index.ts              启动入口：注册模块 / 定时任务，跑一次记忆导入，启动管理面板，连接 WS
src/core/                 WS 客户端、模块基类、调用链、配置、定时器、管理面板
src/modules/              功能模块（aiReply / group / common / request / admin）
src/service/              外部服务封装：LLM、生图、搜图、B站/Twitter/YouTube、TTS、CDN
src/tasks/                定时任务：清理、记忆巩固、各平台推送
src/utils/                零业务依赖的工具函数
scripts/                  独立脚本：记忆巩固、召回评测/探测、日志网页服务
data/                     运行期数据：SQLite 记忆库、聊天备份、图片/表情素材
```

## 记忆系统是怎么跑的

全仓库最复杂的一块，基于 `better-sqlite3`，单文件库 `data/memory/nonoka.db`。代码在 [src/modules/aiReply/memory](src/modules/aiReply/memory)。

从一条群消息到"她记得这件事"，中间有九步：

1. **落盘** —— 群消息实时追加写进 `data/memory/chat/{groupId}_{yyyymmdd}.txt` 纯文本，这是记忆系统唯一的事实来源。
2. **增量导入**（[ingest.ts](src/modules/aiReply/memory/ingest.ts)）—— 仅把近 45 天的备份解析进 `chat_line`/`chat_fts`，按 group/day 记水位线，幂等；旧备份保留为冷历史，不重新导入。
3. **分词**（[segment.ts](src/modules/aiReply/memory/segment.ts)）—— jieba + 群内人名/黑话自定义词典（不然专有名词会被拆成单字），TF-IDF 提关键词。
4. **抽取**（[extract.ts](src/modules/aiReply/memory/extract.ts)）—— 每人跨群攒够 30 条消息调一次 LLM，产出 ADD/UPDATE/DELETE 操作。用户档案按 QQ 号全局共享；单群批次记录来源群，跨群混合批次不强行归到某个群。只跟踪 @ 过 bot 的用户。抽取要花钱，触发上有三道闸：`[表情]`/复读/太短的消息不计数、连续几轮学不到新东西就把阈值翻倍（最多 8 倍）、同一个人两次抽取之间有冷却（默认 4h，见 `aiReply.memory.extractThreshold` / `extractCooldownMin`）。
5. **存储**（[store.ts](src/modules/aiReply/memory/store.ts)）—— 非置顶可用记忆每人最多 14 条：6 条 trait、4 条 episode、各 2 条已确认 alias/relation。自动记忆 45 天未印证即失效；人工确认的内容不按时间失效，但非置顶仍受配额限制。置顶条目保留且不占自动配额。回复默认最多注入 4 条印象。
6. **向量化**（[vector.ts](src/modules/aiReply/memory/vector.ts)）—— 单位化 Float32 向量，暴力余弦 Top-K（量级在千级，不值得上索引）；`embedQueue` 攒 20 条或 15 秒触发一次，不阻塞回复主链路。
7. **检索**（[retrieve.ts](src/modules/aiReply/memory/retrieve.ts)）—— BM25 与向量余弦（相似度硬阈值 0.40）双路召回，RRF（k=60）融合。默认及最大聊天窗口均为 45 天；人物范围和有效性在 Top-K 前过滤。话题按完整词优先选证据，每话题最多 3 条；命中附同群同日的相邻上下文并标注说话人。具体事实查不到就返回空，仅人物概览允许档案兜底。
8. **巩固**（[consolidate.ts](src/modules/aiReply/memory/consolidate.ts)，每天四轮）—— 导入 → 本地过滤纯占位符、附和和同一人的短距离复读 → LLM 生成 `topic` 摘要（每次最多 100 行、3 路并发）→ 补齐缺失向量 → 全用户跑一次淘汰。成功段独立落库，其他段失败或重启不再重切成功段。**`topic` 只在这一步产生。**
9. **工具化**（[tools.ts](src/modules/aiReply/memory/tools.ts)）—— 包装成 `recall_memory` / `recall_chat` 两个 LLM 工具，模型给的"关于谁"经 `aliasIndex.resolve()` 消解成 userId，任何异常都不抛出（保证工具调用链不断）。

<details>
<summary>数据模型（点击展开）</summary>

| 表 | 用途 |
| --- | --- |
| `chat_line` + `chat_fts`（FTS5） | 原始逐行聊天记录，按 `group_id+date_key+seq` 去重；`chat_fts` 是分词后的全文检索镜像 |
| `memory` + `memory_fts` | 跨群共享的结构化用户档案：`scope`/`owner_id`/`kind`（trait / episode / relation / alias）/ `confidence` / `hits` / `pinned` / `verified`；`group_id` 只记录来源群，软删除走 `superseded_by`，未确认的身份条目保留但隔离 |
| `topic` | LLM 生成的一句话摘要，覆盖一段 `chat_line` 范围（`line_from`–`line_to`），是语义检索的最小单元 |
| `embedding` | `memory` / `topic` 行对应的向量（Float32Array BLOB） |
| `group_user_profile` | `(group_id, user_id)` 对应的当前群名片，回复时优先使用当前群的称呼 |
| `meta` | schema 版本、增量导入水位线、词典签名等 |

</details>

> 改记忆相关 prompt 或检索逻辑后，先用真实语料本地跑 `yarn memory:probe` / `yarn memory:eval` 验证，不要凭感觉改。

切话题费用由 `botConfig.aiReply.memory` 下两个可选配置控制：

- `topicDailyLimit`：默认 **40**，所有群、定时任务和手动脚本共用每天的请求上限，按 UTC 日期重置；失败请求也扣额度，重启不重置，`0` 关闭切话题。这是调用次数预算，不是货币或 token 预算。
- `topicLookbackDays`：默认 **45**，只给热窗口内尚未处理的聊天生成新话题；可缩短，`0` 或大于 45 都不会突破热历史边界。处理近期日期后水位会前移，更早且未处理的日期不会自动补切。

请求失败不立即重试，留待下一轮；并发的成功段照常保存。未完成的一天将分段原文 ID 和完成状态保存到 `meta`，兼容旧 v2 断点；短期租约防止手动与定时任务同时处理同一段，进程异常退出后最多等待 10 分钟即可接手。请求已发出但结果尚未持久化时崩溃，仍可能需要重调；服务端未提供幂等键，不能保证这类情况零重复计费。

`yarn memory:topic-cost` 用只读连接对近 45 天真实语料比较新旧过滤的请求数和正文字符数，不调用模型；`DAYS` 可缩短范围。它不评估摘要质量，字符数也不是计费 token 数。`yarn test:topic` 用临时库验证预算、并发失败、旧断点迁移和重启续跑，不调用模型。

手动巩固默认同样遵守上述预算。可通过 `DAYS`、`DAILY_LIMIT`、`CONCURRENCY` 覆盖本次范围、当天总上限和并发；`DRY=1 yarn memory:consolidate` 是只读预览，不再修改水位。耗尽预算、遇到失败或无进展时脚本停止，避免一轮轮立即重试。以上额度仅针对 `/llm/topic`，不包含独立的 embedding 和人物记忆抽取费用。

**人物归属与历史分层：** 自动抽取只发送明确的第一人称本人陈述，不附带别人的引文；问句、转述和第三人称主体不用于建立档案，非删除操作置信度至少 0.7。`alias` / `relation` 只允许人工维护，模型不能增删改，也不能通过把类型改成 trait 绕过。昵称识别仍直接使用近 45 天消息绑定的账号和昵称。工具遇到歧义称呼时不混合多人的档案。

v8 迁移把历史未知来源的 alias/relation 隔离，置顶和明确标记“管理面板”的来源视为已确认。管理页显示“未确认，已隔离”，核对原话后点“确认并保存”恢复；改名或删除会立即重建别名缓存。旧人物向量无法验证对应的文本版本，迁移时一次性失效；只为收紧后仍可用的条目分批补齐（每轮最多 100 条）。期间文字检索和档案注入可用。以后文本更新立即摘掉旧向量，异步返回时再次比较原文，避免旧结果写回。

启动和定时巩固会清理超过 45 天的 `chat_line`、FTS、topic、topic 向量及旧的未完成话题计划；热向量缓存也只装载可用数据，补齐任务不会复活冷历史。冷层使用原有 `data/memory/chat/*.txt` 备份。`yarn memory:maintain` 只读预览；加 `--apply` 会先在 `data/memory/backups/` 保存 SQLite 一致性备份，再执行迁移、清理、FTS 合并和 VACUUM。备份另占磁盘空间，热库缩小不代表备份总量也缩小。

`yarn test:memory-policy` 验证 14 条配额、身份隔离/确认、向量失效和历史不复活。`yarn memory:eval -- 0 --stored-topics` 从真实热历史抽样 30 个话题，用已有向量离线检查来源原文能否回溯及群/时间边界，不发模型请求；这是已存话题回放，不替代独立标注的相关性评测。

## 部署

生产用 PM2（见 [ecosystem.config.cjs](ecosystem.config.cjs)），同时拉起 bot 主进程和一个 tail 日志的网页服务：

```bash
pm2 start ecosystem.config.cjs
```

其他脚本：

```bash
yarn lint                 # eslint 检查 src/
yarn lint-fix             # 自动修复
yarn memory:consolidate   # 手动触发记忆巩固
yarn memory:probe         # 记忆召回探测
yarn memory:eval          # 记忆召回评测（真实语料，非合成数据）
yarn test                 # 跑 test/ 下的测试脚本
```

## 参考

<details>
<summary><b>模块细节</b>：AI 回复、群功能、公共模块、管理命令</summary>

### AI 回复

- **群聊**（[src/modules/aiReply/group](src/modules/aiReply/group)，事件 `group`）：每条消息先入库（`messageStorage` + `aliasIndex`），再决定是否回复——被 `@` 必回，否则交给 `trigger.ts` 的概率状态机。同群回复做了 3.5s 防抖（`sessionTimers`）+ 并发锁（`processingLocks`）避免刷屏时连续触发。`generateReply.ts` 组装历史 + 记忆上下文 + 系统提示，按场景裁剪工具集（记忆工具常驻，生图/搜图按开关启用），控制工具调用轮数：被 `@` 1 轮，插话 0 轮（插话不该拖慢群里的节奏）。`voiceState.ts` 是按群维护的 TTS 开关。
- **私聊**（[src/modules/aiReply/private](src/modules/aiReply/private)，事件 `private`）：无防抖、无触发概率、无工具循环，收到即格式化 → 追加历史 → `getLLMReply` → 分段发送，是群聊流程的简化版。

### 格式化与发送

- [format.ts](src/modules/aiReply/format.ts)：CQ 码 → LLM 可读文本（表情/视频/卡片 JSON 的翻译）、@ 提及与 bot 别名识别、按尺寸和子类型区分"真实照片"和"表情包"。
- [replySender.ts](src/modules/aiReply/replySender.ts)：按 `||` 切分成多个"气泡"，模拟逐段打字延迟顺序发送。
- [stickerMap.ts](src/modules/aiReply/stickerMap.ts)：把模型输出的 `[表情: 关键词]` 替换成本地表情包 CQ 码，概率丢弃以显得更自然。
- [storage/groupProfile.ts](src/modules/aiReply/storage/groupProfile.ts)：`data/memory/group/{groupId}.json` 存 `chanceScale`（插话概率倍率）和 `profileText`（群人设），mtime/size 变化即失效缓存，面板改完立即生效。

### 工具调用

- **生图**（[imageGen/tools.ts](src/modules/aiReply/imageGen/tools.ts)）：`draw_image` / `edit_image`，异步非阻塞 + 状态机注入，按群维护每日配额和冷却时间，并发防抖避免重复请求。
- **搜索**（[search/tools.ts](src/modules/aiReply/search/tools.ts)）：`web_search` 转发到 `service/search.ts`。按群每日配额（默认 20 次），摘要截断 140 字，并显式要求模型不要罗列 URL、不要说"我搜索了"。

### 别名 / 提及消解（[src/modules/aiReply/history](src/modules/aiReply/history)）

- `nameMatch.ts`：归一化文本与别名后，取最长公共子串重叠度打分，对拉丁字符子串做边界检查。
- `aliasIndex.ts`：扫 180 天内 `chat_line` 的历史昵称 + `memory` 表里 `kind=alias` 的人工别名，建 `userId → {aliases, groups}` 索引；`resolve(groupId, text)` 返回按分数排序、限定在该群出现过的候选。
- `mention.ts`：扫最近 5 轮用户发言，解析出的别名若不是当前回复目标，额外注入最多 2 人的完整档案。

### 群功能（[src/modules/group](src/modules/group)）

- `command.ts`：斜杠命令分发——`/initiative on|off`、`/voice on|off`、`/p <推文>`、`/tts <文本>`。
- `repeater.ts`：复读机，按群统计连续相同消息数，超随机阈值（2 或 3）延迟复读一次并标记本轮完成。
- `localPic/`：关键词图库，`/加图 <关键词>` 存进 `data/picture/{关键词}/`，之后精确匹配关键词随机发一张。

### 公共模块与管理

- `common/hPic.ts`：匹配"来点涩图"类口语，按配置返回 SFW/R18，白名单群门控。
- `common/imageSearch.ts`：识别"搜图"/"来源"关键词（附带或引用图片），提取 URL 转给 `service/searchImg`。
- `request/requestFriend.ts`：`autoAddFriend` 开启或请求者在预批准名单中则自动通过，否则拒绝，通过后通知管理员。
- `admin/index.ts`：管理员私聊控制台（白名单鉴权），`/help`、`/clean-memory`、`/task <twitter|bilibili> <on|off>`、`/p <groupId> <推文>`。

</details>

<details>
<summary><b>服务封装</b>（src/service）</summary>

| 文件 | 作用 |
| --- | --- |
| `llm/index.ts` | 把消息 / 工具调用循环转发给外部 `nonokaService`，服务端跑推理，bot 端无状态地重建对话 |
| `imageGen/index.ts` | 直连 OpenAI 兼容生图接口（绕开代理避免超时），重试仅针对 5xx，正则识别内容审核拒绝，超大图先用 `sharp` 压缩再编辑 |
| `searchImg/*` | 以图搜源：优先 SauceNAO，识别为动画再补查 WhatAnime 拿集数/时间点，ascii2d 目前代码内禁用 |
| `search.ts` | 联网搜索转发给 `nonokaService` |
| `tts/index.ts` | 转发到 `nonokaService` 的 `/v1/audio/speech`，返回 base64 音频 |
| `bilibili/dynamic.ts` | 抓取 B 站动态接口（cookie 鉴权），解析多种动态卡片类型 |
| `twitter/*` | 拉取推文缓存、渲染推文截图、拼装含图片/视频的 QQ 消息 |
| `youtube/live.ts` | 查询 YouTube 直播状态接口 |
| `cdn.ts` | 把被墙的 Twitter/YouTube 媒体域名重写成 [Nonoka CDN](https://cdn.nonoka.online/) 的反代路径 |

</details>

<details>
<summary><b>定时任务</b>（src/tasks）</summary>

基于 `toad-scheduler`，在 [src/index.ts](src/index.ts) 统一注册：

- `bilibili.ts`：每 180s 轮询配置的 UP 主最新动态（错峰 2s 一个避免限流），有更新则推送到映射的群。
- `clean.ts`：每 3 天清空内存中的会话历史缓存（不影响持久化的 SQLite 记忆库）。
- `memoryConsolidate.ts`：每天 0/6/12/18 点（Asia/Shanghai）对所有 `initiativeList` 群跑记忆巩固（`preventOverrun` 防重入），四轮共用每日 topic 预算。
- `twitter.ts`：10s 一次 tick，按服务端算出的 `nextRunAt` 窗口实际拉取；单用户连续失败则跳过，累计失败一定次数则自动关闭任务并通知管理员。
- `youtube.ts`：每 120s 检查直播状态，每个频道首次检查不推送（避免启动时误报已在直播的场次），按 `videoId` 去重。

</details>

<details>
<summary><b>管理面板</b>（src/core/admin）</summary>

一个独立的裸 `http.Server`（默认 `127.0.0.1:9616`，环境变量 `ADMIN_HOST`/`ADMIN_PORT`/`ADMIN_TOKEN` 可覆盖），无框架、内联 HTML/JS 页面；`?token=` 或 `x-admin-token` 头鉴权，绑定非本地地址时若未显式设置 `ADMIN_TOKEN` 直接拒绝启动。

- `config.ts`：`GET/POST /api/config` 读写 `config.json`（白名单校验），**显式拒绝暴露/修改 `wsConfig`/`nonokaService`/`apiKeys` 等密钥字段**（需手动改文件）；写入原子化（先写 `.tmp` 再 rename），保存后热更新到运行中的 `bot.config`。
- `memory.ts`：`/memory` 页面 + `GET /api/memory/users|groups|items`、`POST /api/memory/group|add|update|delete`。编辑/置顶/删除都走 `MemoryStore` 以保持 FTS/向量同步（不要绕过它直接改库），改动的文本会重新入队向量化，新别名实时推入 `aliasIndex`（该用户从未在日志中出现过时需重启才生效）。

</details>

<details>
<summary><b>代码规范与提交约定</b></summary>

ESLint 基于 `airbnb-base` + `airbnb-typescript`，并通过 `import/no-restricted-paths` 强制单向依赖（见 [.eslintrc.json](.eslintrc.json)）：

```
utils  ←  core  ←  service  ←  modules  ←  tasks
```

- `utils` 必须零业务依赖
- `service` 不依赖 `nnkBot` 单例（配置从 `@/core/nnkConfig` 取）、不依赖 `modules`、不依赖 `tasks`
- `modules` 不依赖 `tasks`；公共逻辑下沉到 `service`
- `core` 不依赖 `tasks`、不依赖 `service`

违反这些规则 `yarn lint` 会直接报错。路径别名 `@/*` 映射到 `src/*`。

提交信息用约定式写法，`type` 常用 `feat` / `fix`，其余按 [Conventional Commits](https://www.conventionalcommits.org/) 惯例：

```
feat: 记忆巩固支持按天断点续跑
fix(imageGen): 让模型知道图交了没有，发图时配一句话
```

**PR 自检清单**：

- `yarn lint` 通过（分层依赖规则、命名规范都靠它拦）
- 新增模块已在 `src/index.ts` 正确的位置注册，顺序符合命中优先级预期
- 涉及记忆检索 / 分段 / prompt 的改动，跑过 `yarn memory:probe` 或 `yarn memory:eval`（真实语料，每组建议 ≥30 条），而不是凭感觉改
- 新配置字段已同步：`src/types/config.ts` 类型、`config_demo.json` 默认值，需要面板可编辑的话同步 `src/core/admin/config.ts` 白名单
- 没有把 `config.json`、`config_github.json`、`data/` 下的真实密钥或群聊数据带进 diff
- 注释只写非显然的约束/原因，1–2 行为宜，不写大段设计文档式注释

</details>

## License

[GPL-3.0](LICENSE)
