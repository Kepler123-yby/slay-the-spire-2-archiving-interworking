# 尖塔存档桥

《杀戮尖塔 2》Steam 同账号 Mac / Windows 的夸克存档互通验证版。桌面界面负责授权、上传、下载、校验、备份和恢复。

**Mac 与 Windows 都可直接上传，由使用者自行判断进度来源。** 工具不会按设备或首次同步状态锁定上传。Steam 云与夸克相互独立，不会自动将 Steam 云版本转存到夸克。

## 运行

需要 Node.js 22+。当前夸克官方组件要求受支持的 Agent 环境；本轮在 Codex 启动环境完成 Mac 实测。**普通终端或 Finder 独立启动尚不作为可用承诺**；没有识别到 Agent 时会拒绝操作，不通过伪造环境绕过校验。

在 Codex 为本项目启动的终端任务中执行：

```sh
npm ci
npm run setup:quark
npm test
npm start
```

夸克组件固定为官方 1.0.25，下载时检查固定 SHA-256，不执行官方全局安装脚本。首次登录会打开官方授权页，不需要提供密码或 Cookie。

## 首次切换

1. 自行选择这次作为来源的电脑，核对全部角色战绩、存档时间与 Mod 环境，再退出游戏。
2. 按 [Windows 验证流程](docs/windows-validation.md)测试官方接入，确认本机档位与 Mod 组。
3. 在来源电脑备份本机进度，再上传所选版本。
4. 在接收电脑刷新同账号、同档位、同同步组的版本，核对角色战绩、Mod 数量与时间后下载应用。
5. 启动游戏确认进度正确，再开始下一局。

首次云传输测试不需要改动 Steam 设置；**真正应用存档前**需要退出游戏、关闭两端本游戏的 Steam 云，并确认游戏版本与 Mod 环境一致。工具不修改 Steam 配置、不安装 Mod、不修补 Unified Save Path。

## 存档范围

每次快照包含所选 `saves` 目录内 `.save`、`.save.backup` 及 `history/` 文件，排除 `prefs.save` 及其备份；账号级 `profile.save`（当前档位指针）、显示设置、日志、缓存和 Mod 本体不传。应用后在游戏内选择对应档位。

支持游戏默认目录及 `<SteamID>/modded/profileN/saves` 候选目录的发现。默认目录可能被路径 Mod 共用，**“Mod 进度”只是云端分组，不能证明该目录就是 Windows 最新来源**，请先核对摘要或游戏日志。未知布局不自动猜测，文件类型不识别时停止操作。

每份快照使用不可变 ID、完整清单与 SHA-256；上传回读验证后发布完成标记。文件总量限制 64 MiB。下载应用前保存本地备份，多文件事务失败会回滚；下次启动可恢复未完成事务。两端分别推进会保留分支，需人工选择，不合并游戏字段。

## 验证与构建

```sh
npm test
npm run doctor
npm run probe:cloud
npm run probe:roundtrip
npm run pack:mac
npm run pack:windows
```

`doctor` 只读取本机存档摘要和游戏进程；云探针仅上传随机测试文本到 `STS2-SaveSync-Validation`，保留测试文件。程序存档位于开发模式 `.data/desktop`；打包后位于 Electron 的用户数据目录。授权由夸克官方组件管理，按 Agent 隔离，不打包用户凭据。

[Mac 实测记录](docs/mac-validation.md)与[Windows 验证文档](docs/windows-validation.md)分别列出证据和未验证项。打包产物尚未签名/公证。项目尚未完成 Windows 游戏实机验收，也没有自动修复现有路径 Mod。

## 档位摘要

本机显示全部角色的胜利、失败、胜率和最高进阶，另有总战绩、累计时长、存档更新时间。Mod 加载数、检测数和游戏版本来自上次游戏启动日志，界面标明来源与时间，不将日志缺失当作零个 Mod。新上传的云端版本保存同一份摘要；旧版本缺失的字段显示未记录。Mod 计数是上次启动的环境记录，不能证明当前或该档位的完整兼容性。
