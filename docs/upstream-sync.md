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

临时手动同步时：

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

手动合并时，也要在同一个提交中把
`.github/openwiki-upstream-sync.json` 的 `lastSyncedCommit` 更新为
`upstream/main` 的提交；日常应优先使用下面的 Actions 工作流，它会自动维护此状态。

## 自动同步

`.github/workflows/sync-upstream.yml` 每天 02:17 UTC（北京时间 10:17）检查上游，
也支持手动触发。发现新提交时，它会创建或刷新
`automation/sync-upstream` 分支，并向 `main` 提交 PR；不会自动合并到主分支。

工作流将最后成功应用的上游提交记录在
`.github/openwiki-upstream-sync.json`。它以该提交作为显式三方合并基线，而不是
仅检查 `upstream/main` 是否是 `main` 的祖先。因此同步 PR 即使以 squash 或 rebase
方式合并，下一次同步也只会应用新增的上游改动，不会重新合并整段历史。

如果上游和个人化改动触及同一段代码，工作流会失败并在 Actions Job Summary 中列出
冲突文件、基线提交和当前上游提交。此时应在同步分支上人工解决冲突、运行检查，并将
`lastSyncedCommit` 更新为已合入的上游提交；不要把未经审阅的冲突标记提交到 `main`。
