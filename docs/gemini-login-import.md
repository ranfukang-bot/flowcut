# Gemini 账号通过 Firefox 登录（1.4.49）

新增账号和用户主动选择的“重新登录”统一使用本机 Firefox。Chrome 登录与 CDP Cookie 导入实验已移除，不退回 Electron 内嵌登录。未安装 Firefox 时，界面提示安装并提供 [Mozilla 官方下载页](https://www.mozilla.org/firefox/new/)。不会自动安装浏览器。

1.4.50 恢复独立的“打开 Gemini”：它只使用该账号已有的会话查看网页，与重新登录分开。任务运行中显示同一个执行窗口，不刷新、不重发；关闭窗口只隐藏，当前任务继续。任务完成后保留用户正在查看的页面，下一条任务仍创建新页面并延续查看状态。查看页面不清理或覆盖登录，不打开 Firefox。

## 使用方法

1. 在“账号与设置”输入名称并点“添加 Gemini 账号”，或在已有账号上点“重新登录”。
2. 在说明对话框点“打开 Firefox 登录窗口”。Firefox 使用一次性独立资料，和日常 Firefox 分开。
3. 用户手动登录 Google，确认能够进入 Gemini 后，回到 FlowCut 点“我已登录”。密码只在 Firefox 中输入。
4. 重新登录在导入前额外确认是否覆盖该账号登录。用户取消确认时清理本次临时资料，原登录保留。
5. 程序关闭这次 Firefox 窗口，等待退出，再读取 cookies.sqlite；资料导入新的候选会话，自动检查登录并读取模型目录。成功后账号才可接单；失败保留重试和取消入口。

新增账号在验证成功前不会加入正式账号列表。重新登录期间仅该账号暂不领取新任务；若它还有当前任务，要求等待收尾，其他账号可以继续运行。既有登录不会自动重登；执行器遇到登录失效只提示用户主动处理。

## 登录与资料保护

候选会话使用新的持久 partition；原账号的 partition、Cookie、启用状态、模型偏好和 Gem 绑定在候选验证前均不修改。成功后仅切换这个账号的会话引用，保留原 partition 的磁盘资料；失败或取消清理候选会话，原引用保持。配置保存失败会恢复原账号列表和默认账号引用。全局模型、思考等级与 Gem 指令不改动。

Firefox 临时目录在 userData/login-temp/login-UUID 下。成功、失败、取消或程序正常退出时清理本次浏览器并删除临时资料；关闭进程只匹配本次随机资料目录及其子进程，不能按 Firefox 名称批量关闭。递归删除前验证绝对路径、父目录、随机名称及链接。异常清理失败会明确显示并保留取消清理入口，不误报完成。

Firefox 关闭父进程时子进程可能同时退出，Windows 的关闭调用因此可能报错。程序会重新查询本次资料的进程，确认全部退出后才读取 Cookie；查询失败或仍在运行时不读取、不提交账号。关闭过程的原始系统异常不会写入账号提示或 Cookie 日志。

失败提示和 FlowCut 日志使用固定原因及错误编号，区分关闭确认、资料读取/写入、登录检查和配置保存；不转发原始系统异常、Cookie 值或浏览器命令行。关闭竞态及进程仍在、查询失败的保护均有行为测试。

Cookie 通过进程内对象传给 Electron API，不另存明文导出文件，不写日志、报告或 Git。浏览器自身的一次性 cookies.sqlite 用完即删除。仅导入 google.com、youtube.com 及其子域，拒绝相似后缀域；保留 host-only、domain、path、secure、httpOnly、SameSite 与有效期，跳过过期值。不能保持原作用域的分区或容器 Cookie 明确拒绝，不能扩展为普通 Cookie。

Firefox schema 16 起 expiry 为毫秒，按数据库 user_version 转成 Electron 所需的秒；兼容旧 rawSameSite 和新 SAMESITE_UNSET=256。读取错误对用户只返回固定错误类别，不透传原 Cookie 或数据库内容。

模块分工：src/gemini-browser-login.js 管 Firefox 发现、临时进程和清理；src/gemini-login-import.js 管 SQLite 读取和 Cookie 转换；src/gemini-login-flow.js 管候选验证、确认与提交；app/gemini-login.tsx 提供界面。新 IPC 通过 main.js 的 bindIpc/handle 注册并校验调用窗口。

## 已完成实验与继续观察

| 方案 | 即时结果 | 2 小时 | 24 小时 |
| --- | --- | --- | --- |
| 原 Chrome 实验 | 手动登录被 Google 拒绝，未导入，相关实现已移除 | 不适用 | 不适用 |
| Firefox | 2026-10-21 北京时间 10:49:44 导入成功，可读取 4 个模型；10:52:14 完整 FlowCut 隔离实例重启后再次通过 | 2026-10-21 12:50 继续观察 | 2026-10-22 10:50 继续观察 |

用户明确要求直接发布 1.4.49，保持性复核只观察，不是发布前置条件。跟进结果另行回报；掉线时记录时间、页面登录与模型读取情况，并区分网络错误，不自动重登。Google 仍可能因设备绑定或平台风控使导入会话失效，本次即时成功不等于已证明长期稳定。

行为测试覆盖真实 SQLite 夹具、属性和域名转换、临时资料生命周期、新增账号、重新登录确认、候选失败、配置保存失败、原账号不变及界面按钮。完整验证使用 npm run verify，测试资料与真实用户资料隔离。

## 参考

- [Google 支持的浏览器](https://support.google.com/accounts/answer/7675428)
- [Firefox 官方下载](https://www.mozilla.org/firefox/new/)
- [Electron Cookie API](https://www.electronjs.org/docs/latest/api/cookies)
- [Mozilla Cookie 常量](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/nsICookie.idl)
- [Mozilla Cookie 持久化及 schema 升级](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/CookiePersistentStorage.cpp)
