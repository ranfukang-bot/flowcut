# FlowCut 开发与接管

这是个人本机版。先阅读本文和 CHANGELOG.md；docs/legacy/ 只用于历史回溯，不能作为当前运行机制的依据。

## 项目结构

- `app/`、`lib/`、`worker/`：本机网页服务，使用 vinext 和本地 D1/R2；当前表结构以 `lib/storage.ts` 为准。
- `gemini-web-workbench/`：Electron 桌面程序，启动网页服务和本机执行器。
- `vendor/seedance-engine/`：Seedance 执行引擎。
- `vendor/publisher/`：TikTok 自动发布及发布管理页面。
- `gemini-web-workbench/integrations/fastmoss-picker/`：FastMoss 选品插件。

## 本机数据边界

数据根目录为 `%APPDATA%\FlowCut全自动AI视频工作台`：

- `site-runtime/data/`：本地 D1 业务数据和 R2 图片等媒体对象。
- `workbench-state.json`：桌面账号、设置、结果写回队列及密钥。
- `Partitions/`：平台登录会话；不能进入源码仓库或分发包。
- `seedance/`：Seedance 状态、提交记录与任务资料。
- `publisher/`：发布管理设置、账号和运行资料。
- `review-videos/`：审核前的成片。

成片审核通过后移动到任务保存的账号发布目录。本机资料不随程序包分发，个人版不依赖旧云端授权或自动更新服务。

## 安装、运行、打包和验证

使用 Windows 和 Node.js >=22.13.0，CI 使用 Node.js 22。完整验证和打包需要 PATH 中的 `ffmpeg`、`ffprobe`（或打包时设置 `FLOWCUT_FFMPEG_DIR`）；CI 会安装 FFmpeg。在仓库根目录执行：

```powershell
npm ci
npm ci --prefix gemini-web-workbench
npm install --prefix vendor/publisher
npm run dev
npm start --prefix gemini-web-workbench
npm run build:win --prefix gemini-web-workbench
```

`npm run dev` 仅启动网页开发服务；`npm start --prefix gemini-web-workbench` 构建并启动桌面开发版。完整开发环境需要 Electron 本体。仅安装单元测试依赖时可以设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。

一键完整验证命令：`npm run verify`。它依次执行以下检查，任一失败立即退出：

```powershell
npm run lint
npm test
npm run check --prefix gemini-web-workbench
npm test --prefix gemini-web-workbench
Push-Location vendor/publisher
node --test test/*.test.mjs
Pop-Location
```

发布管理浏览器测试需要 Chrome/Chromium，可通过 `CHROMIUM_PATH` 指定可执行文件。

## 长期规则

1. 不擅自改变 Gemini 模型选择、思考等级和 Gem 指令内容。专门修改模型设置的任务须明确限定范围，并在找不到目标或无法核对时停止发送。
2. 不削弱 Seedance 的提交防重复保证，包括 submission journal、submit intent 和提交前落盘。提交结果不确定时先按原账号、原提交时间、提示词和图片核对生成历史，约 1/3/10 分钟核对并持久保存进度；找回 Task ID 后继续追踪，不重发。仅在完整历史查询确认没有该次提交、用户明确点“恢复任务”、且发送前最后一次查询仍未找到时，允许重新提交一次。歧义、查询失败、历史不完整、缺少时间/提示词或备份恢复暂停均不授权重发。已知 Task ID 先查原任务。减少状态写入不能延迟任何关键提交记录。详见 docs/seedance-submission-history.md。
3. 不改变审核放行时的视频移动逻辑，不增加重复投放机会。
4. 不读取、不修改、不提交 `%APPDATA%\FlowCut全自动AI视频工作台` 下的真实数据。测试一律使用隔离的临时目录；启动 smoke 前必须确认数据路径已隔离。
5. 新增测试必须调用函数或接口并断言行为；禁止新增“读取源码文件再用正则匹配”的测试。
6. 不升级 Electron 大版本。依赖调整仅限当前任务明确授权的范围；本轮限 T3 列出的安全更新，不使用 `npm audit fix --force`。
7. 每次发版同步更新 `gemini-web-workbench/package.json`、对应锁文件、README 当前版本及 `CHANGELOG.md`。
8. 保留已有用户修改。普通代码、构建输出和临时测试资料分离，禁止提交凭据、Cookie、真实数据库、成片或日志。
9. 新增桌面 IPC 必须通过 `bindIpc` 中的 `handle` 注册。Gemini 结果必须匹配当前 pending job 的 webContents；导航、令牌和窗口来源边界见 `docs/desktop-security.md`。
10. 本机备份仅通过业务表导出事务和明确的本机文件清单收集数据，不复制运行中的 SQLite 或 Partitions。恢复先校验并备份当前数据，保留较新提交记录、暂停历史未完成任务；见 `docs/local-backups.md`。
11. 产品任务的 Gemini 回复按代码块拆分：一个代码块一条视频，整轮校验失败时不拆分、不提交。不要把读取失败的回复退回为整段提示词；拼接只在本机进行，参与拼接的视频先预留再合成。见 `docs/code-block-batches.md`。
