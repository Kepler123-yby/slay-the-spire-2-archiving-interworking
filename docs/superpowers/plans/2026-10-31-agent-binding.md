# Agent Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 普通终端启动后能使用真实绑定 Agent 同步本项目公开对话，保留离线存档管理。

**Architecture:** 先验证真实 Agent 的固定任务执行能力，再构建受限任务通道、白名单对话导出与不可变云端修订。绑定在本机，项目标识固定；运行任务与用户交流会话分离。

**Tech Stack:** Node.js >=22、Electron、Node 内置测试框架、现有夸克组件。

**Spec:** `docs/superpowers/specs/2026-10-31-agent-binding-design.md`（用户已于 2026-10-31 确认）。

## Global Constraints

- 项目标识 `spire-save-bridge`；各设备独立绑定真实 Agent，不伪造身份标识。
- 只导出明确绑定会话的公开用户消息和助手回复；运行会话、内部推理、工具、凭据排除。
- 单修订最大 8 MiB、最多 50000 条消息；60 秒本地变化检查；相同内容不重复上传。
- 云端当前保留不可变修订，不能声称单份覆盖；本机游戏存档两份限额不变。
- 启动或对话同步不自动更改真实游戏存档；失败不阻塞离线功能，不无限重试模型任务。
- 用户已授权按方案执行；当前会话直接实现，沿用现有工作目录。

## Review Focus

- 普通终端清理继承的宿主标识后仍须由真实 Agent 完成夸克检查；任务文字回复不能冒充结果（任务 1/2）。
- 中途取消、Agent 拒绝、网络失败与应用退出，不得误报成功或遗留无限进程（任务 2/5）。
- 历史导入/后台回复不得形成循环上传；截断、坏哈希和并发分支不能丢消息（任务 3/4）。
- 云端及会话中的任意命令、路径和凭据不能成为本机执行配置（任务 2/3）。
- 未安装、未绑定、未授权时本地备份仍可用，UI 状态与按钮说明应匹配真实能力（任务 5）。

### Task 1: 验证真实工作入口（前置门槛）

**Files:** `scripts/agent-runtime-probe.mjs`、`docs/agent-validation.md`。

**Interfaces:** 输入本机 CLI 路径；输出真实执行结果与通过/失败。清理继承的 Agent 身份环境，不新增任何身份变量。

- [ ] 从普通环境启动 `codex exec --ephemeral --json --sandbox read-only`，要求执行固定 `resolve-agent` 命令，限制总耗时并清理本工具启动的进程组。
- [ ] 仅实际工具输出成功才通过；随后隔离目录执行夸克上传/下载/哈希闭环。
- [ ] 若失败，记录准确错误并停止该适配器产品集成；保留已有功能，不伪造成功。可排查权限、网络、模型访问并重试合理的实际入口。

### Task 2: 本机绑定和有界真实任务执行

**Files:** `src/agent-binding.mjs`、`src/agent-runner.mjs`、`src/agent-worker.mjs`、`tests/agent-binding.test.mjs`、`tests/agent-runner.test.mjs`。

**Interfaces:** `BindingStore.read()/save(binding)/clear()`；`AgentRunner.run(task,{signal})` 返回由 worker 验证的类型化结果；`detectAgents()` 返回已安装适配器及可用性。Quark 可注入 `run(args)` 执行器。

- [ ] 测试未知适配器、非法路径、云端配置注入、错任务 ID、重复结果、超时及取消都失败；绑定原子持久化且仅本机。
- [ ] 实现参数数组启动固定入口，以本机一次性受限 IPC 交换任务和结果；worker 只接收允许的夸克命令及本机受限文件路径，结果有上限。
- [ ] 实测后台任务退出和异常时只清理自建进程；真实执行通过后将 Quark 接入该 runner。
- [ ] 运行 `node --test tests/agent-*.test.mjs` 并提交。

### Task 3: 白名单对话导出和合并

**Files:** `src/project-dialogue.mjs`、`src/codex-session.mjs`、`tests/project-dialogue.test.mjs`。

**Interfaces:** `exportDialogue(session)`、`mergeDialogues(archives)`、`validateDialogue(archive)`、`dialogueHash(archive)`；规范消息 `{id,source,role,time,text}`，项目标识固定。

- [ ] 测试混合公开消息/推理/工具/环境包装/认证字段，只保留允许内容；绑定 ID 不匹配时拒绝；超出 8 MiB/50000 条拒绝；截断不得覆盖完整历史。
- [ ] 使用 Codex 官方结构化会话读取，导出选定会话，稳定 ID 去重；合并保留不同来源及分支；运行会话与导入边界明确排除。
- [ ] 测试连续导入导出和后台任务均不新增对话；不读取认证目录，不自动执行聊天内容。
- [ ] 运行 `node --test tests/project-dialogue.test.mjs` 并提交。

### Task 4: 可校验的云端对话修订

**Files:** `src/context-sync.mjs`、`tests/context-sync.test.mjs`。

**Interfaces:** `ContextSync.status()/sync()/preview()`；使用现有 `Quark.mkdir/list/put/get`，固定目录 `STS2-SaveSync/project-context/spire-save-bridge/`。

- [ ] 用内存夸克测试无变化不上传、并发分支合并、坏哈希和缺完成标记排除、失败保留待办。
- [ ] 实现有界不可变修订及完成标记；上传回读通过才提交本地同步状态；限制清单/下载数量和字节，不按机器时钟丢弃分支。
- [ ] 隔离云端目录进行实际公开对话上传与恢复验证，凭据和本机绑定不进入文件。
- [ ] 运行 `node --test tests/context-sync.test.mjs` 并提交。

### Task 5: 界面、启动恢复、文档与验收

**Files:** `src/main.cjs`、`src/preload.cjs`、`ui/index.html`、`ui/app.js`、`ui/style.css`（以实际现有文件为准）、`scripts/ui-flow-test.cjs`、`README.md`、Windows 验证文档、`package.json`。

**Interfaces:** IPC `agentStatus/agentPreview/agentBind/contextSync/agentUnbind/contextContinue`，渲染器不能直接传入可执行命令；启动后台同步，60 秒仅检查本地变化。

- [ ] 增加绑定来源预览、CLI 状态、消息数、上次成功、待办、错误、重试、解绑与继续对话命令；启用前披露模型额度和云端修订限制。
- [ ] 保持现有本地功能可用；未验证适配器明确未支持；运行任务串行，关闭时取消并保留待办。
- [ ] UI 合成测试绑定/取消/失败/恢复状态与备份互不干扰；运行 `npm test`、`npm run test:ui`，清洁环境启动真实 Mac 构建验证。
- [ ] 更新通用 README 与可执行 Windows 验证步骤，构建 Mac 包和源代码包；提交并推送已授权 GitHub。

## 执行记录

任务 1 是硬前置：不能通过时，后续产品集成不开始。探针和诊断文档可以交付，但必须明确功能未完成及准确阻塞原因。
