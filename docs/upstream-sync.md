# 同步 OpenWiki 上游

HWJ Wiki 保留了 `langchain-ai/openwiki` 的完整 Git 历史，个人化能力集中在
`src/personalization/` 和少量 CLI 接线中。Agent Prompt、OKF、翻译、文档规划、
快照和写入沙盒仍由上游实现。

## 本地同步

首次克隆后添加上游：

```bash
git remote add upstream https://github.com/langchain-ai/openwiki.git
git fetch upstream
```

以后同步：

```bash
git switch main
git fetch upstream
git merge upstream/main
pnpm install
pnpm typecheck
pnpm test
```

如发生冲突，优先保留上游生成引擎的实现，再重新接入
`src/personalization/run.ts` 的外围调用。

## 自动同步

`.github/workflows/sync-upstream.yml` 每周检查一次上游，也支持手动触发。
发现新提交时，它会创建 `automation/sync-upstream` 分支并向 `main` 提交 PR，
不会自动合并到主分支。
