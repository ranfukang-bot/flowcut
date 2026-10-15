# Gemini 全局生成模型验证

设置位于「账号与设置 → Gemini 生成模型」，覆盖商品提示词、爆款复刻和剧本流水线，包括重试和重新生成。默认自动选择菜单中版本号最大的非 Lite Flash。指定名称不存在、已识别菜单的列表为空/重名或勾选核对失败时，在上传和发送前返回 `MODEL_SELECTION_FAILED`，原任务退回队列，该账号在相同设置下停止领取。尚未加载、超时和页面异常先走退避，连续三次才暂停。

思考等级支持不改动或使用读取到的选项。切换模型后重新检查；同一账号在本次启动的第一个任务、设置变化后以及距上次检查满一小时后检查。相同模型且不需要检查思考等级时只读按钮，不打开菜单。不指定模型且不改动思考等级时完全保留原行为，不打开菜单；因此任务详情会如实标记未读取的思考等级。

## 自动验证与当前边界

```powershell
npm run verify
npm run test:model-electron --prefix gemini-web-workbench
```

行为夹具将 `3.5 Flash-Lite` 放在首位，包含 `3.8 Flash`、`3.1 Pro`、`4 Argon` 和「低」「高」思考等级；另测 `3.9 Flash`、`3.10 Flash`、仅 Lite、缺失目标、切换后思考重置及核对不一致。普通 `/app` 和保存的 `/gem/…` 页面通过路由夹具验证。

实际 Windows Electron 隐藏窗口的夹具测量：匹配模型路径约 1.62ms，复用隐藏激活机制的模型切换及思考等级设置约 520.06ms。它们验证本机执行开销，不能代表 Google 网页的网络和渲染耗时。

尚未使用真实 Gemini 账号读取菜单或验证保存的 Gem 页面。当前选择器是候选实现，已通过夹具测试，仍需按下文核实：

- 模型按钮：`[data-test-id="bard-mode-menu-button"]`、`[data-test-id="model-selector-button"]`，或带 `aria-haspopup="menu"` 且模型标签明确的按钮。
- 菜单容器：`[role="menu"]`、`.mat-mdc-menu-panel`、`[role="listbox"]`。
- 菜单项：`[role="menuitem"]`、`[role="menuitemradio"]`、`[role="option"]`、`[data-test-id="model-option"]`。
- 名称优先读取 `data-model-name` 或菜单内的 `[data-test-id="model-name"]`、`.mode-title`、`.model-name`、`.model-title`，否则使用首行文本。
- 思考等级入口按菜单项的 `aria-haspopup="menu"` 识别，选中状态按 `aria-checked`、`aria-selected` 或勾选图标识别。任何歧义都停止执行，不猜选其他模型。

## 真实账号人工验证

确定性失败（目标缺失、名称/列表不明确、菜单勾选或思考核对不一致）立即暂停。模型脚本异常、超时、崩溃、导航中断和窗口销毁使用 MODEL_SELECTION_RETRYABLE，走原有 defer 退避；同一账号、同一设置连续三次才暂停，成功核对或成功重新读取后清零。计数和暂停随账号持久保存。菜单 session 期限为八秒，仍以匹配路径低于 500ms、切换路径低于五秒为耗时目标。两类失败都不上传、不发送、不降级模型。

先从仓库打包，再在一个新的 PowerShell 窗口中启动独立资料实例：

```powershell
$env:FLOWCUT_SMOKE_USER_DATA = Join-Path $env:TEMP ('FlowCut-model-check-' + [guid]::NewGuid().ToString('N'))
& '.\gemini-web-workbench\release\win-unpacked\FlowCut全自动AI视频工作台.exe'
```

该变量会隔离 userData 和 appData、停用旧资料迁入，并使用测试端口；主窗口正常显示。也可直接运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-isolated-test.ps1`。只有同时设置 `FLOWCUT_DESKTOP_SMOKE_FILE` 才隐藏窗口、执行自动 smoke 并退出；单独的报告路径不会启用 smoke。普通启动不设置这两个变量，仍使用原本的资料目录。

1. 在隔离实例中新加测试用 Gemini 账号并登录；不要复制原程序的 Partitions、状态文件或数据库。保持 Gemini 队列暂停，点击「读取模型列表」。逐个核对账号可选模型、思考等级和读取时间；列表变化时记录当前页面的实际选择器。
2. 设置自动 Flash 和「高」（以实际列表名称为准），保存。创建测试商品、Gem 和一条商品提示词任务。确认保存的 `/gem/…` 页面上先确认模型、再上传图片和发送；详情与日志应显示所用完整模型、思考等级和检查耗时。
3. 分别创建一条爆款复刻和剧本流水线测试，确认普通对话及后续新对话使用相同设置。切换前把测试账号网页模型改为 Pro 或 Lite，确认恢复目标 Flash 后才上传；核对切换后的思考等级。
4. 连续执行模型已匹配的任务，记录日志中的耗时；无需思考检查时应小于 500ms。切换路径应小于 5 秒。重启隔离实例后，第一个任务应重新核对思考等级；间隔超过一小时后再做一次核对。
5. 设置「不指定」和「不改动」，把网页切到一个可用模型。执行后应保持该模型和思考等级，且不打开模型菜单；记录中未知的思考等级应显示为未读取。
6. 指定只有部分账号提供的模型，检查不具备该模型的账号：任务应退回队列、显示 `MODEL_SELECTION_FAILED`，不上传或发送，该账号停止领取，其他可用账号继续。重新读取成功或更改设置后可恢复领取。
7. 指定 Pro 并核对确实选中 Pro。改变全局设置后重试或重新生成，确认使用新设置。若真实页面结构不匹配，保留错误，停止该账号测试，反馈实际菜单 DOM；不要放宽核对或增加降级模型。
