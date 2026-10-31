# Agent 绑定与对话读取验证

## 2026-10-31：Mac 前置链路

- 普通终端直连 Codex 服务超时；通过使用者提供的本机代理后服务可达。
- CLI 全局配置中的模型不支持当前 ChatGPT 登录，官方 `model/list` 返回了可用默认模型。只在验证子进程中选择可用模型，未修改全局配置。
- 清除继承的 Agent 身份变量后，由真实 `codex exec` 执行夸克 `resolve-agent` 成功。由同一真实工作入口执行 `scripts/cloud-probe.mjs`，隔离目录上传、枚举、下载及 SHA-256 校验全部通过。
- Claude Code 已安装但未登录；没有因此宣称其适配器通过验证。

## 桌面端会话格式兼容修复

本机终端 PATH 中的 Codex CLI 是 `0.144.6`，桌面端随附版本是 `0.166.0-alpha.5.1`。桌面端当前会话的 `history_mode` 是 `paginated`。旧 CLI 的 `thread/read` 返回 `-32601 / paginated_threads is not supported yet`，并非登录、代理或聊天文件损坏。

修复采用官方本地接口：优先发现兼容的桌面端可执行文件，以 `thread/read` 读取元数据，再用 `thread/items/list` 按游标读取全部页。不执行 `thread/resume` 或 `turn/start`，不改写原会话，不需要模型推理。旧格式通过兼容接口读取完整历史。接口不兼容时尝试下一已安装候选版本，不自动升级或替换全局 CLI。

导出器检查会话 ID 与项目目录，只选取公开 `userMessage` 和 `agentMessage`。内部推理、命令、工具输出、系统提示、环境包装等不进入导出。疑似认证材料整条排除；这不是对公开文字绝无敏感信息的保证，上传前仍可查看预览。读取失败、重复游标或超过上限时不生成“部分成功”的新文件。

本项目会话实际读取通过：8 页、102 条公开消息、排除 631 条其他记录，截至本次验证时。导出只写入版本控制忽略的 `.data/project-context/`，未上传云端。数量会随会话继续而变化。

## 自行验证其他设备

在项目目录运行，替换成该设备中明确选定的项目会话 UUID：

```sh
npm run context:export -- --thread <会话UUID>
```

可选 `--cli <Codex可执行文件绝对路径>`、`--cwd <项目目录>`、`--output <本地输出JSON>`。普通终端必须显式指定会话 ID；真正的 Codex 命令环境可以使用当前 `CODEX_THREAD_ID`。此命令不上传、不改动游戏存档、不登录其他账号。

成功结果包含消息数、实际接口路径、读取模式、分页数及 `uploaded: false`。不要把内部会话日志或整个 Agent 配置目录作为导出文件。

Windows 若 PATH 只有 npm 的 `.cmd` 启动垫片，请用 `--cli` 指向实际 `codex.exe`；当前未完成 Windows 实机验收。缺少支持分页的版本时，需要安装兼容 CLI 或使用桌面端随附的接口。

官方参考：[Codex App Server](https://developers.openai.com/codex/app-server)，其中 `thread/turns/list`、`thread/items/list` 用于分页历史，`thread/read includeTurns=true` 对分页历史已弃用。
