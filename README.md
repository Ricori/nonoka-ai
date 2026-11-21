# NonokaChan AI Bot

![license](https://img.shields.io/badge/license-GPL--3.0-blue)
![lang](https://img.shields.io/badge/TypeScript-ESM-3178c6)
![protocol](https://img.shields.io/badge/protocol-OneBot%20v11-lightgrey)
![pm](https://img.shields.io/badge/package%20manager-yarn-2c8ebb)

一个住在 QQ 群里的 AI。她会自己决定什么时候插话，记得群友半年前说过什么，还会自己画画。

架构以 **AI 回复主链路** 为核心：OneBot 正向 WebSocket 收到群聊 / 私聊消息后直接进入回复编排层，负责上下文格式化、主动插话决策、工具调用循环、本地 SQLite 记忆维护与语音/分段发送。

> 本仓库仅专注 AI 对话与记忆系统；定时推送、搜图、图库、涩图、复读机、群命令等工具/功能类模块已拆分至独立的 QQ 机器人仓库：[nonoka-assistant-bot](https://github.com/Ricori/nonoka-assistant-bot)。

## 她都会些什么

**🎲 会看气氛插话。** 不是每条消息都回。基础插话概率很低，但你 @ 过她之后的一定时间内会暴涨，聊到她感兴趣的关键词也会增加她插话概率，然后按周期指数衰减。所以她的表现是"被戳一下就活跃一阵，没人理就慢慢安静"。每个群还有单独倍率设定。

**🧠 记得住事。** 群聊记录全量落盘，定期抽取结构化记忆（性格 / 事件 / 关系 / 别名）。检索时字面匹配（FTS5 + BM25）和语义匹配（向量余弦）双路召回，RRF 融合排序。每人记忆数量有限，超了就按 `confidence × exp(-天数/30) × log(1+hits)` 淘汰最弱的。记忆会自然遗忘，但被反复提起的会留下来。

**🎨 自然语言生图。** 自然语言调起画图工具，生图期间依旧可以自然回复，并知道自己的画画状态。`drawing → done/failed/blocked` 的状态机结果会注入下一轮 prompt。

**🗣️ 知道你们在说谁。** 群友互相叫外号，模型是分不清的。`nameMatch` 做归一化模糊匹配（去 emoji、零宽字符、尾部语气词，还对拉丁字符做边界检查，免得 `azu` 命中 `azusa` 内部），`aliasIndex` 扫历史昵称建索引，`mention` 会把对话里顺带提到的人的档案也塞给模型。

**🗣️ 语音与单页管理面板。** 支持 TTS 语音回复，内嵌单页管理面板统一完成 AI 回复配置热更新、会话缓存清理、群档案维护、人物记忆/原话证据管理与巩固状态查看。

## 快速开始

需要一个 OneBot v11 实现（正向 WebSocket）在跑。

```bash
yarn install
```

复制 `config_demo.json` 为 `config.json`，填这三个：

- `wsConfig` —— OneBot 正向 WS 的 host / port
- `botConfig.nonokaService` —— Nonoka 服务地址与 apiKey
- `botConfig.apiKeys.imageGen` —— 生图服务的上游地址与密钥

然后：

```bash
yarn dev
```

想看详细日志用 `yarn debug`。其余 AI 回复开关、黑名单、主动发言群、语音群、群档案和人物记忆都可在启动后通过内嵌管理面板热改，无需重启。

## 架构总览

```
   OneBot 实现
        │
        │  正向 WebSocket（api 连接 + event 连接）
        ▼
   src/bot/（ws.ts + 精简收发客户端）
        │
        │  onPrivateMessage / onGroupMessage
        ▼
   src/chat/（group.ts / private.ts / generateReply.ts / trigger.ts）
        │                              │
        ▼                              ▼
 src/service/*（HTTP 封装）     src/memory/* + src/tools/*
 LLM / 生图 / 搜网 / TTS        SQLite 记忆库（FTS5 + 向量）/ 身份消解 / 工具集
```

```
src/index.ts        启动入口：记忆增量导入 → 定时任务 → 单页管理面板 → 连接 OneBot WS
src/config.ts       全局配置加载、校验、热更新与原子落盘（单一真相源）
src/bot/            OneBot 正向 WS 与精简收发 API（sendGroupMsg / sendPrivateMsg / getMessageFromId）
src/chat/           AI 回复核心编排：群聊/私聊处理、防抖与并发锁、主动插话、格式化、分段发送、会话缓存与群档案
src/memory/         SQLite 记忆系统（ingest / segment / extract / store / vector / retrieve / consolidate）与身份消解（identity/）
src/tools/          非记忆类 LLM 工具：画图（imageGen.ts）、联网搜索（search.ts）
src/service/        外部 HTTP 服务封装：LLM、生图、搜网、TTS
src/tasks/          定时调度器（scheduler.ts）与定时任务：会话缓存清理、记忆巩固
src/panel/          单页 Web 管理面板（page.html + /api/config + /api/status + /api/chat/clean + /api/memory/*）
src/types/          TypeScript 类型定义
src/utils/          零业务依赖工具函数
scripts/            独立脚本：记忆巩固、召回评测/探测、日志网页服务
data/               运行期数据：SQLite 记忆库、聊天备份、表情素材
```

## 记忆系统是怎么跑的

全仓库最复杂的一块，基于 `better-sqlite3`，单文件库 `data/memory/nonoka.db`。代码在 [src/memory](src/memory)。

从一条群消息到"她记得这件事"，中间有九步：

1. **落盘** —— 群消息实时追加写进 `data/memory/chat/{groupId}_{yyyymmdd}.txt` 纯文本，这是记忆系统唯一的事实来源。
2. **增量导入**（[ingest.ts](src/memory/ingest.ts)）—— 仅把近 45 天的备份解析进 `chat_line`/`chat_fts`，按 group/day 记水位线，幂等；旧备份保留为冷历史，不重新导入。
3. **分词**（[segment.ts](src/memory/segment.ts)）—— jieba + 群内人名/黑话自定义词典（不然专有名词会被拆成单字），TF-IDF 提关键词。
4. **抽取**（[extract.ts](src/memory/extract.ts)）—— 每人跨群攒够 10 条本人陈述调一次 LLM，产出 ADD/UPDATE/DELETE 操作。用户档案按 QQ 号全局共享；单群批次记录来源群，跨群混合批次不强行归到某个群。只跟踪 @ 过 bot 的用户。抽取要花钱，触发上有三道闸：`[表情]`/复读/太短/≥3 人说过的同一句（群梗）不计数、连续几轮学不到新东西就把阈值翻倍（最多 8 倍）、同一个人两次抽取之间有冷却（默认 4h，见 `aiReply.memory.extractThreshold` / `extractCooldownMin`）。
5. **存储**（[store.ts](src/memory/store.ts)）—— 非置顶可用记忆每人最多 14 条：6 条 trait、4 条 episode、各 2 条已确认 alias/relation。自动记忆 45 天未印证即失效；人工确认的内容不按时间失效，但非置顶仍受配额限制。置顶条目保留且不占自动配额。回复默认最多注入 4 条印象。
6. **向量化**（[vector.ts](src/memory/vector.ts)）—— 单位化 Float32 向量，暴力余弦 Top-K（量级在千级，不值得上索引）；`embedQueue` 攒 20 条或 15 秒触发一次，不阻塞回复主链路。
7. **检索**（[retrieve.ts](src/memory/retrieve.ts)）—— BM25 与向量余弦双路召回，RRF（k=60）融合。相似度下限人物档案 0.55、聊天窗口 0.50（一个窗口混着多个话题，整体相似度被稀释），都过不了时再放行排名最前的 5 个弱候选。默认及最大聊天范围均为 45 天；人物范围和有效性在 Top-K 前过滤。同一个 `chat_window` 最多占 3 个名额（窗口有重叠，一行只算进它所在的第一个窗口）；命中附同群同日的相邻上下文并标注说话人。具体事实查不到就返回空，仅人物概览允许档案兜底。
8. **巩固**（[consolidate.ts](src/memory/consolidate.ts)，每天四轮）—— 清理 → 导入 → 本地过滤纯占位符、附和和同一人的短距离复读 → 把每天的日志按 12 行一窗、步长 8 切成重叠的 `chat_window`（直接拿原文向量化，不调 chat 模型）→ 补齐缺失向量 → 全用户跑一次淘汰。过去的日子切完就推水位不再重读；今天只切满员窗口，每轮重扫一遍。**`chat_window` 只在这一步产生。**
9. **工具化**（[tools.ts](src/memory/tools.ts)）—— 包装成 `recall_memory` / `recall_chat` 两个 LLM 工具，模型给的"关于谁"经 `aliasIndex.resolve()` 消解成 userId，任何异常都不抛出（保证工具调用链不断）。

<details>
<summary>数据模型（点击展开）</summary>

| 表 | 用途 |
| --- | --- |
| `chat_line` + `chat_fts`（FTS5） | 原始逐行聊天记录，按 `group_id+date_key+seq` 去重；`chat_fts` 是分词后的全文检索镜像 |
| `memory` + `memory_fts` | 跨群共享的结构化用户档案：`scope`/`owner_id`/`kind`（trait / episode / relation / alias）/ `confidence` / `hits` / `pinned` / `verified`；`group_id` 只记录来源群，软删除走 `superseded_by`，未确认的身份条目保留但隔离 |
| `memory_evidence_batch` + `memory_evidence` | 一次抽取送进 LLM 的原始消息（`messages` / `message_ids` / `group_ids` 都是 JSON 数组）与它产出的记忆之间的多对多链接，只追加不修改，供档案溯源；记忆被物理删除时链接一并删，不再被任何记忆引用的批次也跟着删 |
| `chat_window` | 按 12 行一窗、步长 8 切出的重叠原文片段，覆盖一段 `chat_line` 范围（`line_from`–`line_to`），是语义检索的最小单元；`text` 是剥掉昵称、每行截 100 字的正文 |
| `embedding` | `memory` / `chat_window` 行对应的向量（`ref_kind` 为 `memory` / `window`，Float32Array BLOB） |
| `group_user_profile` | `(group_id, user_id)` 对应的当前群名片，回复时优先使用当前群的称呼 |
| `consolidation_run` | 每轮定时巩固的起止时间、状态和前后积压（`pending_*` 是缺向量的窗口 + 记忆数，`oldest_pending_date` 是最早一个缺向量窗口的日期），只给管理面板看 |
| `meta` | schema 版本、增量导入水位线、词典签名等 |

</details>

> 改记忆相关 prompt 或检索逻辑后，先用真实语料本地跑 `yarn memory:probe` / `yarn memory:eval` 验证，不要凭感觉改。

手动巩固：`DRY=1 yarn memory:consolidate` 只读预览积压，不加 `DRY` 才真正导入、切窗口、补向量。这一步不调 chat 模型，只花 embedding。

**人物归属与历史分层：** 自动抽取只发送明确的第一人称本人陈述，不附带别人的引文；问句、转述和第三人称主体不用于建立档案，非删除操作置信度至少 0.7。`alias` / `relation` 只允许人工维护，模型不能增删改，也不能通过把类型改成 trait 绕过。昵称识别仍直接使用近 45 天消息绑定的账号和昵称。工具遇到歧义称呼时不混合多人的档案。

启动和定时巩固会清理超过 45 天的 `chat_line`、FTS、`chat_window` 及其向量，并删掉指向已消失行的孤儿向量；热向量缓存也只装载可用数据，补齐任务不会复活冷历史。冷层使用原有 `data/memory/chat/*.txt` 备份。`yarn memory:maintain` 只读预览；加 `--apply` 会先在 `data/memory/backups/` 保存 SQLite 一致性备份，再执行迁移、清理、FTS 合并和 VACUUM。

`yarn test` 用临时库验证老库拒开、备份导入、跨群隔离、向量失效、身份防伪和重排回退，不调用模型。

## 部署

生产用 PM2（见 [ecosystem_demo.config.cjs](ecosystem_demo.config.cjs)），同时拉起 bot 主进程和一个 tail 日志的网页服务：

```bash
pm2 start ecosystem.config.cjs
```

常用脚本：

```bash
yarn lint                 # eslint 检查 src/
yarn lint-fix             # 自动修复
yarn memory:consolidate   # 手动触发记忆巩固
yarn memory:probe         # 记忆召回探测
yarn memory:eval          # 记忆召回评测（真实语料，非合成数据）
yarn test                 # 关键用例：记忆（test/memory.ts）+ 回复（test/reply.ts）
```

## 参考

<details>
<summary><b>模块细节</b>：AI 回复、格式化、工具调用、身份消解</summary>

### AI 回复（[src/chat](src/chat)）

- **群聊**（[group.ts](src/chat/group.ts)）：每条消息先入库（`messageStorage` + `aliasIndex`），再决定是否回复——被 `@` 必回，否则交给 `trigger.ts` 按每小时插话预算和时机分决策。同群回复做 3.5s 防抖 + 并发锁避免刷屏连续触发。`generateReply.ts` 组装历史 + 记忆上下文 + 群档案，按场景裁剪工具集，控制工具调用轮数（被 `@` 1 轮，主动插话 0 轮）。开启语音回复的群优先走 TTS。
- **私聊**（[private.ts](src/chat/private.ts)）：无防抖、无触发概率、无工具循环，收到即格式化 → 追加历史 → `getLLMReply` → 分段发送。

### 格式化与发送

- [format.ts](src/chat/format.ts)：CQ 码 → LLM 可读文本（表情/视频/卡片 JSON 翻译）、@ 提及与 bot 别名识别、按尺寸和子类型区分"真实照片"和"表情包"。
- [replySender.ts](src/chat/replySender.ts)：按 `||` 切分成多个气泡，模拟逐段打字延迟顺序发送。
- [stickerMap.ts](src/chat/stickerMap.ts)：把模型输出的 `[表情: 关键词]` 替换成本地表情包 CQ 码，概率丢弃以显得更自然。
- [storage/groupProfile.ts](src/chat/storage/groupProfile.ts)：`data/memory/group/{groupId}.json` 存 `chanceScale`（插话概率倍率）和 `profileText`（群人设），mtime/size 变化即失效缓存，面板改完立即生效。

### 工具调用（[src/tools](src/tools)）

- **生图**（[imageGen.ts](src/tools/imageGen.ts)）：`draw_image` / `edit_image`，异步非阻塞 + 状态机注入，按群维护每日配额和冷却时间。
- **搜索**（[search.ts](src/tools/search.ts)）：`web_search` 转发到 `service/search.ts`，按群维护每日配额，摘要截断 140 字。

### 身份 / 提及消解（[src/memory/identity](src/memory/identity)）

- `nameMatch.ts`：归一化文本与别名后，取最长公共子串重叠度打分，对拉丁字符子串做边界检查。
- `aliasIndex.ts`：扫近 45 天 `chat_line` 的历史昵称 + `memory` 表里 `kind=alias` 的人工别名，建 `userId → {aliases, groups}` 索引。
- `mention.ts`：扫最近 5 轮用户发言，解析出的别名若不是当前回复目标，额外注入最多 2 人的完整档案。

</details>

<details>
<summary><b>服务封装</b>（src/service）</summary>

| 文件 | 作用 |
| --- | --- |
| `llm/index.ts` | 把消息 / 工具调用循环转发给外部 `nonokaService`，服务端跑推理，bot 端无状态地重建对话 |
| `imageGen/index.ts` | 直连 OpenAI 兼容生图接口（绕开代理避免超时），重试仅针对 5xx，正则识别内容审核拒绝，超大图先用 `sharp` 压缩再编辑 |
| `search.ts` | 联网搜索转发给 `nonokaService` |
| `tts/index.ts` | 转发到 `nonokaService` 的 `/v1/audio/speech`，返回 base64 音频 |

</details>

<details>
<summary><b>定时任务</b>（src/tasks）</summary>

基于 `toad-scheduler`，在 [src/index.ts](src/index.ts) 通过 [scheduler.ts](src/tasks/scheduler.ts) 统一注册：

- `clean.ts`：每 3 天清空内存中的会话历史缓存（不影响持久化的 SQLite 记忆库）。
- `memoryConsolidate.ts`：每天 0/6/12/18 点（Asia/Shanghai）对所有 `initiativeList` 群跑记忆巩固（`preventOverrun` 防重入）。

</details>

<details>
<summary><b>单页管理面板</b>（src/panel）</summary>

独立的裸 `http.Server`（默认 `127.0.0.1:9616`，环境变量 `ADMIN_HOST`/`ADMIN_PORT`/`ADMIN_TOKEN` 可覆盖），无前端构建依赖，单页 HTML 位于 [page.html](src/panel/page.html)；`?token=` 或 `x-admin-token` 头鉴权，绑定非本地地址时若未显式设置 `ADMIN_TOKEN` 直接拒绝启动。

- `GET /`：合并后的单页管理界面（`/memory` 自动 302 跳转至对应区块兼容旧书签）。
- `routes/config.ts`：`GET /api/status` 返回 WS 连接状态；`GET/POST /api/config` 热更新 AI 回复配置（显式拒绝暴露/修改 `wsConfig`/`nonokaService`/`apiKeys`）；`POST /api/chat/clean` 手动清理内存短期会话缓存。
- `routes/memory.ts`：`/api/memory/*` 维护群档案、人物记忆（含原话证据溯源）、记忆黑名单与巩固运行记录；所有配置写入统一经 [src/config.ts](src/config.ts) 原子落盘，所有记忆写入经 `MemoryStore` 保持 FTS/向量同步。

</details>

<details>
<summary><b>代码规范与提交约定</b></summary>

ESLint 基于 `airbnb-base` + `airbnb-typescript`，并通过 `import/no-restricted-paths` 强制单向依赖（见 [.eslintrc.json](.eslintrc.json)）：

```
utils  ←  config / bot  ←  service  ←  memory / tools  ←  chat  ←  tasks / panel  ←  index.ts
```

- `utils` 必须零业务依赖
- `config` / `bot` 不反向依赖上层服务或业务
- `service` 只从 `@/config` 取配置，不依赖 `bot` 或业务层
- `memory` / `tools` 不依赖 `chat` / `tasks` / `panel`
- `chat` 不依赖 `tasks` / `panel`

违反这些规则 `yarn lint` 会直接报错。路径别名 `@/*` 映射到 `src/*`。

提交信息用约定式写法，`type` 常用 `feat` / `fix` / `refactor`，遵循 [Conventional Commits](https://www.conventionalcommits.org/) 惯例。

</details>

## License

[GPL-3.0](LICENSE)
