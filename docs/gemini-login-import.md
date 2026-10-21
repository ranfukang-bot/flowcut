# Gemini 真实浏览器登录导入实验（拟用于 1.4.49）

当前是实验分支，正式版本仍为 1.4.48。尚未完成即时、2 小时和 24 小时真实账号验证，不提供稳定性承诺，不发布正式新增账号或重新登录入口，也不更新用户的正式安装。

## 实验边界

实验脚本为 `gemini-web-workbench/scripts/gemini-login-experiment.cjs`。必须显式指定独立的 `--experiment-root`；脚本拒绝真实 FlowCut 资料路径。实验账号使用独立资料中的新 partition，保持暂停，不领取任务。现有 Gemini、Seedance、Gem、模型设置及提交记录不参与实验。

在真实安装的 Chrome 中，使用一次性 `login-temp/login-UUID` 资料目录和任务单指定的启动参数。用户登录期间不连接调试端口；用户主动点“我已登录”后，才读取 DevToolsActivePort 并调用 Storage.getCookies。Firefox 使用一次性独立 profile，手动登录后先关闭并等待进程退出，再只读查询 cookies.sqlite。临时资料仅由浏览器自身保存；脚本不另存明文 Cookie。Cookie 值只在进程内传递，不写日志、实验报告或源码。

Firefox 方案安装已获用户明确授权。本次通过 winget 的 Mozilla.Firefox 官方包安装并完成安装包哈希校验。

## 导入模块

`src/gemini-login-import.js` 负责读取和转换。只允许 google.com、youtube.com 及其子域，不接受相似后缀域。保留名称、值、路径、secure、httpOnly、SameSite、有效期；host-only Cookie 不传 domain。过期 Cookie 不导入，session Cookie 不增加持久有效期。

Firefox Cookie 数据库 schema 16 起 expiry 改为毫秒；模块根据 PRAGMA user_version 转换为 Electron 所需的秒。兼容旧 rawSameSite 与新 SAMESITE_UNSET=256。分区或容器 Cookie 当前无法按原作用域写入普通 Electron Cookie API 时，实验明确失败，不将其扩大为普通 Cookie。

新账号导入只允许目标没有 Google 登录 Cookie。发现已有资料即拒绝覆盖；导入失败回滚本次新写入资料。正式“重新登录”需在实验通过后另加明确覆盖确认和暂存验证流程，实验模块不具备直接覆盖原账号的入口。

`src/gemini-browser-login.js` 管理临时浏览器生命周期。关闭进程只匹配本次随机 profile 及其子进程，不按浏览器可执行名称批量结束；递归删除前核对绝对路径、直接父目录、随机名称及链接。成功、读取失败、写入失败和取消均清理临时 profile。若浏览器仍在运行则保留清理错误，不删除正在使用的资料，也不修改目标登录。

## 当前真实结果（2026-10-21）

| 方案 | 登录 / 即时检查 | 2 小时 | 24 小时 / 普通商品提示词 |
| --- | --- | --- | --- |
| A：Chrome | 用户实测登录页提示“此浏览器或应用可能不安全”，未导入 | 不适用 | 不适用 |
| B：Firefox | 等待用户登录验证 | 未开始 | 未开始 |

Chrome 的失败发生在手动登录阶段，不能归因于导入后 DBSC 失效。没有调整浏览器标识、禁用 Google 安全能力或尝试其他绕过参数。

即时检查复用 FlowCut 的登录检测及模型目录读取函数，确认页面已登录且模型列表可读；仅有 SID Cookie 或仅能打开网页不算通过。后续在同一导入 partition 复查，需额外在完整 FlowCut 执行一次仅提示词任务。不能以单元测试或即时成功代替等待实际满 2/24 小时。只有真实验证完成才选择最终方案、做正式 UI、同步 1.4.49 版本信息并走 CI、快进合并及备份更新。若两种方案均失效，停止并回报，不增加其他绕过尝试。

## 依据

- [Google：受支持的浏览器及内嵌/自动化浏览器限制](https://support.google.com/accounts/answer/7675428)
- [Chrome：调试必须使用独立的非默认资料目录](https://developer.chrome.com/blog/remote-debugging-port)
- [Electron Cookie API](https://www.electronjs.org/docs/latest/api/cookies)
- [Mozilla Cookie 常量](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/nsICookie.idl)
- [Mozilla Cookie 持久化及 schema 升级](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/CookiePersistentStorage.cpp)
