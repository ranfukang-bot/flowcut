# 桌面窗口边界

主窗口只允许当前本机站点的 origin、本地 `boot.html`，以及发布管理的 iframe origin（正式运行 18776，隔离测试 18777）。发布管理不能替换主页面。新窗口一律拒绝；HTTPS 外部链接交给系统浏览器。

自动桌面令牌只附加到主窗口发往本机站点或发布管理的请求。其他窗口、其他端口、其他 origin 不附加；重定向携带的同名头会先移除。本机地址在探测、同步 Bridge Key 和设置保存之前验证，探测与同步不跟随重定向。

Gemini 弹窗只接纳 HTTPS、默认端口且不带用户信息的以下主机，并在原窗口内打开：`gemini.google.com`、`accounts.google.com`、`myaccount.google.com`、`consent.google.com`、`www.google.com`。主页面重定向同样受此限制；所有框架继续使用登录导航保护器拦截外部应用协议。真实 Google 登录如新增必要主机，应先核实再修改清单，不能放宽为所有 Google 子域名或所有 HTTPS。

业务 IPC 只接受当前主窗口的 webContents。Gemini IPC 只接受当前任务及上传监测器对应的执行窗口；结果还必须匹配该请求的 `contentsId`。新增 handler 通过 `bindIpc` 中的 `handle` 注册。

主窗口、Gemini 登录和执行窗口、保护构建测试窗口都设为 `sandbox:true`。Seedance 登录窗口和其 OAuth 子窗口保持 `sandbox:true`。本轮没有需要恢复为 false 的窗口。

验证命令：`npm run verify`，以及桌面目录下的 `test:gem-electron`、`test:quota-ui`、`test:review-ui`、`test:model-electron`、`test:security-electron`；账号和商品界面由 `scripts/test-gem-electron.cjs --account-ui`、`--product-ui` 验证。真实 Electron 用例检查沙箱 preload、跨窗口 IPC、主窗口导航、重定向和令牌范围；全部使用临时资料和匿名页面。

导航事件使用当前 Electron 版本的 details 字段，并兼容旧位置参数，参见 [Electron 导航事件说明](https://www.electronjs.org/docs/latest/api/web-contents#navigation-events)。真实 Gemini 登录和账号验证仍需在隔离资料实例中人工确认，步骤见 `gemini-model-settings.md`。
