# HWJ Wiki 个性化实现基线

## 目标

HWJ Wiki 是 OpenWiki 的个人工作流发行版。它保持上游 Wiki 生成引擎不变，
只在 CLI 外围增加默认配置、个人数据采集、脱敏、增量游标和确定性索引。

## 不修改的核心

- Agent Prompt 与文档规划逻辑
- OKF Frontmatter、目录索引和 Mermaid 校验
- 翻译中间件
- Git 差异、内容快照和更新元数据
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
~/.openwiki/wiki/doubao-knowledge/
~/.openwiki/wiki/lessons/
~/.openwiki/wiki/journals/
```

`agent-lessons` 不是必需 Schema。用户已有的经验 Markdown 可以作为可选
高置信数据源；自动知识仍主要来自 Agent 历史、豆包和项目 `issues/`。

## 安全和增量规则

- Code Mode 只接收 `cwd` 位于当前仓库或同一 Git Worktree 的会话。
- Personal Mode 和 Code Mode 使用相互独立的游标。
- JSONL 使用流式字节 Offset 和固定头部摘要判断追加、截断与重写；单次最多
  扫描 32MB，因此多 GB 会话文件不会再整体载入内存。
- Antigravity 的 `.system_generated/` 内部日志不进入知识整理。
- 每轮最多向 Agent 提供约 100 条或 100KB 的待处理证据，剩余批次后续继续。
- 若本地模型在完整 Agent 协议中没有实际执行工具，个人模式使用受限安全降级：
  直接读取已脱敏证据，限制输出目录并校验页面后再确认批次。
- Agent 只能通过受限的 `openwiki_read_personal_history_batch` 工具读取本轮批次，
  不会收到主机绝对路径。
- 批次只有在全部读取且生成了有效 Wiki 后才写入处理回执；失败会自动重试。
- Init/Update 必须产生有效 `quickstart.md` 和至少一个知识页面，否则标记为
  `interrupted`，不会再出现空 Wiki 的假成功。
- 只采集用户/助手文本，不采集 System/Developer 指令。
- 私钥、Token、Key、密码、长 Base64 和用户主目录在写缓存前脱敏。
- 单条超大记录最多保留约 50KB 的头尾内容。
- Raw Cache 文件权限为 `0600`，目录权限为 `0700`，不会进入项目 Git。

## 上游兼容

- 原始 `langchain-ai/openwiki` 远程保留为 `upstream`。
- 旧连接器源码保留，避免扩大与上游的差异。
- 自动同步工作流只创建 PR，不自动合并。
- 具体操作见 [upstream-sync.md](./upstream-sync.md)。
