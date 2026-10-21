# FlowCut 全自动 AI 视频工作台

当前桌面版本：`1.4.50`（个人本机版）。版本历史见 [CHANGELOG.md](CHANGELOG.md)，开发交接入口为 [AGENTS.md](AGENTS.md)。

Gemini 账号旁的“打开 Gemini”直接查看已有登录和当前任务页面，关闭只隐藏窗口；新增账号和“重新登录”仍通过 Firefox 完成，详见 [登录说明](docs/gemini-login-import.md)。

“多品裂变”可让 2–10 个商品共用一份母版，每个商品各生成一条提示词和视频，独立保存商品 ID、图片与归档账号。使用和恢复规则见 [多品裂变](docs/multi-product-fission.md)。

新增和重新登录 Gemini 账号统一使用本机 Firefox 临时窗口，登录后在 FlowCut 点“我已登录”导入并检查；未安装时提供官网下载入口。已有账号的登录、模型设置和 Gem 保留。详见 [Firefox 登录说明](docs/gemini-login-import.md)。

FlowCut 在本机整合商品图片、用户自建 Gem、Gemini 网页/API、Seedance 视频生成、任务队列、成片审核与 TikTok 发布管理。支持商品制作、爆款复刻和剧本提示词流水线。

## 安装、运行与打包

Windows 开发环境需要 Node.js >=22.13.0、Chrome 和 Electron；完整测试与打包还需要 PATH 中的 FFmpeg/FFprobe。仓库包含源码；GitHub Download ZIP 不是可双击运行的程序。

在仓库根目录安装依赖：

```powershell
npm ci
npm ci --prefix gemini-web-workbench
npm install --prefix vendor/publisher
```

启动网页开发服务：`npm run dev`。启动桌面开发版：`npm start --prefix gemini-web-workbench`。

构建 Windows 安装版与免安装版：

```powershell
npm run build:win --prefix gemini-web-workbench
```

打包后可运行 `npm run smoke:packaged`，它会创建隔离的临时配置并验证个人版启动、沙箱、页面执行器和 ZIP 备份。

人工验证运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-isolated-test.ps1`。它会新建临时资料并显示主窗口，使用 4198/18777 测试端口；不会清空任务或自动退出。程序路径含空格时可通过脚本的 `-Executable` 参数指定。

更新程序前退出旧程序，并保留该电脑自己的本机资料。源码以 `origin/main` 为准；不要覆盖未提交修改。仓库保留 MPL-2.0 LICENSE，第三方依赖按各自许可证使用。

## 数据边界

本机账号、Gem、商品、图片、任务、登录态和运行资料位于 `%APPDATA%\FlowCut全自动AI视频工作台`，成片按任务进入审核区并在放行后移动到账号保存目录。程序包和仓库不包含真实本机资料。不要把 AppData、插件 `bridge-config.json`、账号配置或凭据提交到 Git，也不要用另一台电脑的资料覆盖本机数据。

个人版不连接历史云端授权与自动更新服务。生成时按功能需要向 Gemini 和 Seedance 发送图片和提示词；平台登录、网络与配额仍需可用。历史商业版文档归档于 `docs/legacy/`。

## 开发验证

测试必须使用临时目录。一键验证为 `npm run verify`，依次包含以下检查；发布管理测试可用 `CHROMIUM_PATH` 指定 Chrome/Chromium。

```powershell
npm run lint
npm test
npm run check --prefix gemini-web-workbench
npm test --prefix gemini-web-workbench
Push-Location vendor/publisher
node --test test/*.test.mjs
Pop-Location
```

桌面行为验证：`npm run test:gem-electron --prefix gemini-web-workbench`、`npm run test:quota-ui --prefix gemini-web-workbench`、`npm run test:review-ui --prefix gemini-web-workbench`。启动测试前须确认其资料目录隔离。
