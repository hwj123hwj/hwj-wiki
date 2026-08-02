# HWJ Wiki 个性化实现基线

## 目标

HWJ Wiki 是 OpenWiki 的个人工作流发行版。它保持上游 Wiki 生成引擎不变，
只在个性化适配层增加默认配置、个人数据采集、脱敏、增量游标、批处理编排和
确定性质量收尾。

## 不修改的核心

- Agent Prompt 与文档规划逻辑
- OKF Frontmatter、目录索引和 Mermaid 校验
- 翻译中间件
- Git 差异与内容快照
- Repository Mode 的 `openwiki/` 写入边界
- Checkpoint 与对话摘要机制

## 个性化适配层

### 默认模型入口

没有显式 OpenWiki Provider 配置时，CLI 使用现有 `openai-compatible` Provider：

```text
Endpoint: http://localhost:4001/v1
Model: coding
Key: OPENAI_COMPATIBLE_API_KEY > LITELLM_MASTER_KEY > built-in localhost-only key
```

显式的 `OPENWIKI_PROVIDER`、`OPENWIKI_MODEL_ID` 和兼容网关配置始终优先。
默认本地网关会在运行前检查 `/v1/models`，并区分连接失败与鉴权失败。

### 中文默认值

CLI Run Command 未传 `--language` 时使用 `zh-CN`。原版语言解析、翻译和
索引本地化逻辑继续负责实际生成，`--language en` 等显式值保持有效。

### 项目模式

```bash
openwiki code --update
```

运行前增量读取与当前 Git 仓库匹配的 Pi、Codex 和 Antigravity 会话，
脱敏后写入 `~/.openwiki/connectors/*/raw/`，再作为不可信证据交给原版
OpenWiki。生成引擎可将开发轨迹整理到：

```text
openwiki/journals/
openwiki/lessons/
```

`issues/**/*.md` 由确定性代码汇总为
`openwiki/issues/by-project.md`，源文件不会被修改。

### 个人模式

```bash
openwiki personal --update
```

增量读取全部 Pi、Codex、Antigravity 会话和
`~/Documents/doubao-export/`，整理目标为：

```text
~/.openwiki/wiki/projects/
~/.openwiki/wiki/doubao-knowledge/
~/.openwiki/wiki/lessons/
~/.openwiki/wiki/journals/
~/.openwiki/wiki/decisions/
~/.openwiki/wiki/commitments/
~/.openwiki/wiki/open-questions/
~/.openwiki/wiki/sources/
```

单次命令会持续运行到已发现和新扫描出的 backlog 全部清空；模型每次仍只处理
一个有界批次。四个来源使用持久化轮询游标，某个来源历史再多也不会长期饿死
其他来源。

生成分两阶段：

1. 个性化适配层把一个脱敏批次提取为结构化候选，记录 `stableKey`、类型、事实、
   决策、经验、标签、项目、时间、`sourceRefs`、可信度、易过期标记和
   `validAsOf`，并先写入私有 checkpoint。没有长期价值时允许返回空候选。
2. 原版 OpenWiki Agent 只接收小体积候选，按 stableKey、标题、标签和语义相似度
   合并现有页面。冲突事实按来源与时间并列保留；同义 stableKey 写入
   `stableKeyAliases`，不重复建页。

`agent-lessons` 不是必需 Schema。用户已有的经验 Markdown 可以作为可选
高置信数据源；自动知识仍主要来自 Agent 历史、豆包和项目 `issues/`。

## 安全和增量规则

- Code Mode 只接收 `cwd` 位于当前仓库或同一 Git Worktree 的会话。
- Personal Mode 和 Code Mode 使用相互独立的游标。
- JSONL 使用流式字节 Offset 和固定头部摘要判断追加、截断与重写；单次最多
  扫描 32MB，因此多 GB 会话文件不会再整体载入内存。
- Antigravity 的 `.system_generated/` 内部日志不进入知识整理。
- 每次候选提取最多处理约 100 条、80KB 的一个批次；一次命令自动连续处理多个
  批次，不会把全部历史塞给同一次模型调用。
- 每个批次先读取全部脱敏记录并写候选 checkpoint，再进入合并阶段；模型不会
  收到主机绝对路径。
- 批次只有在落盘、统一 finalize 和质量门全部通过后才写处理回执；失败、中断、
  断链、来源缺失或敏感信息命中都会保持待处理。
- 每批确认后立即保存 `partial` 进度和各来源计数；只有 backlog 为 0 且全局质量
  检查通过才写 `complete`。
- 原生 Agent 失败会先回滚本批半成品。安全降级只读取结构化候选，页面标记
  `fallbackGenerated: true`；经过同一 finalize 后，原始批次可以确认并继续，
  但候选 checkpoint 会进入独立复核队列，整体保持 `partial`。后续正常 Agent
  按有界批次复核并移除标记，复核队列清空后才允许 `complete`。
- 统一 finalize 负责 OKF、Mermaid、所有目录索引、quickstart 导航、相对链接、
  孤立页、重复 stableKey/相似主题、sourceRefs、中文元数据和敏感信息检查。
- 空知识批次可以安全确认，但不会为了通过校验制造垃圾知识页。
- 只采集用户/助手文本，不采集 System/Developer 指令。
- 私钥、Token、Key、密码、长 Base64 和用户主目录在写缓存前脱敏。
- 单条超大记录最多保留约 50KB 的头尾内容。
- Raw Cache 文件权限为 `0600`，目录权限为 `0700`，不会进入项目 Git。

## 上游兼容

- 原始 `langchain-ai/openwiki` 远程保留为 `upstream`。
- 旧连接器源码保留，避免扩大与上游的差异。
- 自动同步工作流只创建 PR，不自动合并。
- 具体操作见 [upstream-sync.md](./upstream-sync.md)。
