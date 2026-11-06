# 打包、本地测试与发布

本文面向 `tabby-group-server-stats 1.7.3` 的维护者。源码目录为 `D:\tabby-group-server-stats`；功能与预设说明见 [中文 README](README.md) / [English README](README.en.md)。

1.7.3 统一 fork 作者和维护者为 lishuainan0209，加入预设重复添加保护，并完善中英文搜索元数据与安装说明；保留上游 MIT 版权与贡献声明，包含 1.7.2 的显示修正。

1.7.0 增加 GitHub 预设导入、内置项持久化排序、清晰分区与卡片边框、紧凑组分隔，并更新磁盘汇总、登录会话名单、双向网络速率及累计量和默认颜色阈值。版本号不表示已经推送或发布。

本版保留 1.6.1 的传输修复：此前大批量指标生成的超长 SSH 执行请求可能断开整个连接，现使用固定短命令和 8 KiB 标准输入分块，完整上传后再确认结果，失败仅清理统计通道。`npm test` 包含 `tests/transport.test.cjs`，覆盖大脚本、传输限制和同连接其他会话不受影响的回归。

下面的命令由维护者手动执行。构建和打包不会推送 GitHub、登录 npm 或自动发布插件。

## 开发环境

需要 Node.js、npm、Git 和 Tabby。Windows 使用 `npm.cmd`，可避免 PowerShell 对 `npm.ps1` 的执行策略限制。若刚安装后找不到命令，重新打开终端并检查：

```powershell
Set-Location -LiteralPath 'D:\tabby-group-server-stats'
node --version
npm.cmd --version
git --version
```

在仓库根目录使用现有锁文件和 `.npmrc` 的 `legacy-peer-deps=true`：

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:ui
npm.cmd run build
```

TypeScript、Angular 和 Webpack 使用项目内依赖，不需要全局安装。不要在功能发布前同时批量升级 Angular/Tabby 依赖。

- `npm test`：配置、范围、采集、显示、生命周期、传输、GitHub 导入、内置排序、登录用户、网络及预设回归测试。Windows 命令测试使用 Git for Windows 的 `sh.exe`，可用 `TEST_SH` 指定其他位置。
- `npm run test:ui`：用无界面 Edge 运行真实 Angular 组件和模拟会话数据，可设置 `TEST_BROWSER_CHANNEL=chrome`。这不等同于实际 Tabby 桌面验收。
- `npm run build`：生成 `dist/` 和 `typings/`。

远端命令使用 `timeout`，或 `gtimeout` / `setsid` 回退来限制运行时间；全部缺失时显示错误，不执行无时限命令。项目不要求远端安装 Python 或额外监控服务。具体预设仍需要相应工具，例如 GPU 显存查询需要 `nvidia-smi`。

## 生成发布包

先同步 `package.json` 与锁文件版本，再检查和生成包：

```powershell
npm.cmd pack --dry-run
npm.cmd pack
tar -tf .\tabby-group-server-stats-1.7.3.tgz
```

`prepack` 自动执行类型检查、普通测试和正式构建；任一失败会阻止打包。浏览器测试需另外运行。产物为 `tabby-group-server-stats-1.7.3.tgz`，后续本地验收与发布应使用同一份已检查的包。[npm pack 文档](https://docs.npmjs.com/cli/v11/commands/npm-pack/)

确认包内包含：

- `package.json`、`dist/index.js`、类型声明；
- 中文和英文 README、本文、`LICENSE`、`NOTICE`、`presets.json`；
- 构建生成的第三方许可证声明，例如 `dist/*.LICENSE.txt`。

离线预设会随构建打入插件，无需联网即可使用。用户点击“从 GitHub 导入”时才从当前 fork 的 `main/presets.json` 获取并合并预览，保留本地和此前导入的其他条目；远端内容以实际推送状态为准，不保证已包含本地新改动。检查包中没有 SSH 凭据、连接地址、用户配置、私有配置 ID 或开发用整个 `node_modules`。共享标签库也应只包含可公开的命令、说明和连接名称，不包含真实连接参数。

`LICENSE` 必须保留原 MIT 全文及 Copyright (c) 2023 Akkariin Meiko；`NOTICE` 保留来源、原作者与 fork 修改说明。`package.json` 的 `author` 标注本 fork 作者和维护者 lishuainan0209，`contributors` 保留上游作者 Akkariin。依赖许可证继续分别适用。

## 在独立便携版 Tabby 中安装

从 [Tabby 官方发布页](https://github.com/Eugeny/tabby/releases) 获取对应架构的 Windows 便携版，解压到新的测试目录。不要把日常用户数据复制到测试副本。

Tabby 1.0.238 在发现 `Tabby.exe` 同级的 `data` 目录时将用户数据放到其中，配置和插件均可与日常实例分开。[便携模式源码](https://github.com/Eugeny/tabby/blob/v1.0.238/app/lib/portable.ts)

以下示例在 `D:\tabby-group-server-stats` 运行，假设已经把便携版解压到仓库下的 `work\tabby-portable-test`：

```powershell
Set-Location -LiteralPath 'D:\tabby-group-server-stats'
$testRoot = Join-Path (Get-Location).Path 'work\tabby-portable-test'
$archive = (Resolve-Path -LiteralPath '.\tabby-group-server-stats-1.7.3.tgz').Path

if (-not (Test-Path -LiteralPath (Join-Path $testRoot 'Tabby.exe'))) {
    throw '请先将 Tabby 便携版解压到测试目录。'
}

$pluginRoot = Join-Path $testRoot 'data\plugins'
New-Item -ItemType Directory -Force -Path $pluginRoot | Out-Null
npm.cmd install --prefix "$pluginRoot" --omit=dev --legacy-peer-deps "$archive"
& (Join-Path $testRoot 'Tabby.exe') --debug
```

确认打开的是测试目录下的程序，使用新的配置，并在插件页确认包名。更新测试包时先完全退出这个测试副本，再重新执行安装命令并启动。

不要仅靠 `TABBY_CONFIG_DIRECTORY` 隔离：它改变配置文件位置，用户插件目录仍由 `userData` 决定。本指南不使用该版本未实现的 `--plugin`，或未经该版本验证的 `--user-data-dir` 作为隔离依据。[配置读取](https://github.com/Eugeny/tabby/blob/v1.0.238/app/lib/config.ts)、[插件目录](https://github.com/Eugeny/tabby/blob/v1.0.238/app/lib/app.ts)、[命令行参数](https://github.com/Eugeny/tabby/blob/v1.0.238/app/lib/cli.ts)

本 fork 沿用 `plugin.serverStats`。同一实例只启用原版或本 fork 之一；迁移日常配置前先备份，关闭原插件后再启用本 fork。

## 发布验收

分别记录自动测试、经授权的远端只读命令检查和实际 Tabby 界面验收。真实服务器的命令输出正确，不代表分屏、悬停或配置恢复已经验收；模拟界面通过，也不代表特定服务器已具备所需工具。记录验证类型和结论即可，不把真实地址、凭据或私有配置 ID 写入仓库。

建议覆盖以下场景：

1. **单标签编辑**：新建表单按需显示，默认文本类型与输出文本比较；命令顺序为校验、功能、扩展；保存、取消和展开编辑正确保留预期配置。
2. **对象校验**：通过、失败、超时、空校验四种情况；失败时不执行功能和扩展命令，旧成功值不残留。
3. **启用开关**：单标签、整个组、主标签和子标签分别禁用后不显示、不执行，重新启用后保留命令、颜色规则和范围。
4. **失败可见性**：默认保留失败提示；全局隐藏开关在单标签、静态、轮播和弹出框均生效，继续定时校验以发现恢复；仅轮播跳过时，其他视图仍保留提示。超时和执行错误始终可见。
5. **四种组展示**：概览、轮播、静态横排和竖排的悬停范围正确；组名只出现在弹出框，主标签和子标签层级明确，各列对齐，组间细线分隔紧凑。设置页四大区域和内部卡片的边框清晰。
6. **轮播边界**：连续多个失效项不占额外周期；全部被跳过、只剩一个候选项、主标签禁用和更长输出均正确。宽度固定、内容可换行，窄分屏无溢出。
7. **扩展信息**：空命令不执行；成功空输出保持空；错误独立显示；多个标签同时悬停、快速移入移出、持续悬停及断线重连不会混用旧会话数据。详情刷新遵循指标间隔，接收完成后释放通道。大批量脚本必须经过实际插件的传输路径验证，并保持同一 SSH 连接的交互通道可用；检查上传超时、写入失败及延迟确认均只清理统计通道。
8. **内置指标**：修改默认命令确实改变采集结果；恢复一个内置项不影响其他项目，顶层启用状态和排序不变。上下移动 CPU、内存、磁盘、网络后，底栏与悬浮窗真实显示顺序一致，重开后保持。网络主/子标签可独立启用。
9. **连接与混合布局**：`P1 / P2 / P1` 中按原始连接 ID 分别匹配；焦点变化不改变范围。同一连接多次打开，各自独立采集。选择布局与连接采用并集。
10. **范围生命周期**：重命名保持关联；删除后不转为全局，同名新连接不继承。指定范围为空仍不显示。仅针对整个布局绑定，未标记的旧布局或刚保存的新布局重开一次，再检查恢复、分屏和移动窗格。
11. **离线与 GitHub 库**：20 项（12 单标签、8 组）可离线搜索、加载和添加；GitHub 与 JSON 导入均只预览、点击添加才生效，保留当前及此前导入的条目并按同 ID 更新。检查 15 秒超时、2 MiB 上限、HTTP/JSON 错误时原列表不变。导出/导入保留类型、颜色规则、开关、来源与双语描述，不携带本地范围 ID。缺失或重名连接提示补选，保持指定范围为空而非全局。
12. **磁盘与 GPU**：所有磁盘组主标签为总余量、系统盘为第一子标签；只汇总可读有效文件系统，同一文件系统的绑定挂载不重复计数。P1 宿主模板只绑定 P1(ai)、仅系统盘；P1 容器模板绑定 P1(s_lsn)、包含 `/public`。P0/P2/P4 检查 `/data`，P3 检查 `/data` 和 `/lsn_disk1`。GPU 主值为显存占比，详情用 `memory.free / 1024` 的 GiB；无设备主标签提示、缺失子 GPU 隐藏。
13. **登录用户与网络**：登录用户主值包含正常 tty/pts/console 会话，悬停按用户名稳定汇总；空数据为 `0`/`-`，命令失败不冒充空数据。网络按默认路由网卡优先、无路由时回退非回环网卡；Linux/macOS 下载和上传分别验证原始速率 KiB/s、显示速率 MB/s（三位小数）、累计 GiB 与网卡名称，颜色判断保持使用原始速率。累计量自接口建立或计数器重置起算，不是本次 SSH 登录后的流量。
14. **阈值与双语**：红色规则先于橙色。逐一验证边界：单盘 20/40 GiB、总余量 50/100 GiB、GPU 显存 50/80%、RAM 60/80%、CPU 1min/5min 负载 100/150%；比较方向与包含边界应符合 README 表格。检查中英文切换、26 个图标搜索分类及自定义 SVG。
15. **预设重复添加**：同来源、同稳定 ID 的单标签或标签组只添加一次；改名和禁用后仍能识别。旧配置结合命令与显示范围匹配，不仅凭标题去重；不同范围的旧配置不能被误判。防止新增重复项与清理历史副本分别验收，清理本地副本前保留配置备份。

## 发布到 npm

维护者需要 npm 账号和目标包名的发布权限；GitHub fork 权限不会自动带来 npm 权限。先查询包名，再在个人终端登录：

```powershell
npm.cmd view tabby-group-server-stats name version maintainers --registry=https://registry.npmjs.org/
npm.cmd login --registry=https://registry.npmjs.org/ --auth-type=web
npm.cmd whoami --registry=https://registry.npmjs.org/
```

404 仅表示当前查不到公开包，不能保证名字一定可注册。若同名包属于他人，请换用其他非 scoped 的 `tabby-` 前缀包名并同步文档、锁文件。按 npm 的网页或终端提示完成登录及发布认证，不把令牌写入项目。[npm login](https://docs.npmjs.com/cli/v11/commands/npm-login/)、[npm 发布认证说明](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)

验收通过后，手动发布刚才测试的同一个包：

```powershell
npm.cmd publish .\tabby-group-server-stats-1.7.3.tgz --access public --registry=https://registry.npmjs.org/
npm.cmd view tabby-group-server-stats version dist.tarball --registry=https://registry.npmjs.org/
```

同一包名和版本不能重复覆盖，后续修改需提高版本号并重新测试、构建和打包。需要自动发布时再单独设置 Trusted Publishing；本仓库的这些步骤不会创建凭据或自动上传。[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)、[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)

## 在 Tabby 插件列表找到包

Tabby 1.0.238 的插件管理器通过 npm 的 `tabby-plugin` 关键词搜索，并过滤以 `tabby-` 开头的包名。本项目使用非 scoped 的 `tabby-group-server-stats`，且包含所需关键词。[插件管理器源码](https://github.com/Eugeny/tabby/blob/v1.0.238/tabby-plugin-manager/src/services/pluginManager.service.ts)

发布成功且 npm 搜索索引更新后，在 Tabby 设置 → 插件 → 可用中搜索 **`maintainer:lishuainan0209`**，选择 **`group-server-stats`** 安装并重启。也可搜索包名，但新包可能排在大量结果后面；Tabby 的显示名称省略了 `tabby-` 前缀。先用 `npm view` 确认公开版本和元数据，再刷新插件列表。推送 GitHub 或上传 GitHub Release 本身不会发布 npm 包。[Tabby 插件开发说明](https://github.com/Eugeny/tabby/blob/master/HACKING.md#plugins)

发布验收可以直接查询 Tabby 使用的搜索接口，确认结果包含目标版本：

```powershell
$searchUrl = 'https://registry.npmjs.com/-/v1/search?text=keywords%3Atabby-plugin%20maintainer%3Alishuainan0209&size=250'
(Invoke-RestMethod -Uri $searchUrl).objects.package | Select-Object name, version
```

`description` 和 `keywords` 只填写项目实际功能；本项目覆盖 Tabby、SSH 服务器监控、CPU、内存、GPU 显存、磁盘、网络、自定义指标和多标签组。npm 根据包名、描述、README 和关键词进行匹配，排序由 npm 决定。维护相关元数据有助于表达用途，但不能保证名次或索引更新时间；不要把下载量、GitHub 星标或重复发布写成必然提升排名的方法。[npm 搜索说明](https://docs.npmjs.com/searching-for-and-choosing-packages-to-download/)
