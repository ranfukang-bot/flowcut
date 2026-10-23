# Gemini 全局生成模型验证（1.4.43）

设置位于「账号与设置 → Gemini 生成模型」，覆盖商品提示词、爆款复刻、剧本流水线及其重试。应用默认仍为“不指定 / 不改动”，保留用户已保存设置。本轮用户明确要求将本机保存为“自动：最新 Flash（不含 Lite） / 中等”；其他安装不自动覆盖设置。

## 真实页面结构已核实

2026-10-19 复用本机已登录账号执行“读取模型列表”，再核对真实菜单结构；仅检查模型控件，不记录会话、Cookie 或网址。

| 控件 | 实际结构 |
| --- | --- |
| 模型按钮 | 宽窗口为 button[data-test-id="bard-mode-menu-button"]，aria-haspopup="true"，role/aria-checked 未设置；窄窗口为带相同 test-id 的 gem-button 包含 button |
| 按钮内容 | Flash 与 中等 分列在 .picker-primary-text/.picker-secondary-text，文本可能换行；图标为 mat-icon[data-mat-icon-name="keyboard_arrow_down"] |
| 模型菜单 | gem-menu[role="menu"]；gem-menu-item[role="menuitem"][aria-haspopup="false"]，名称 .label，下一行 .sublabel 是说明 |
| 模型选中 | 无 aria-checked；行含 selected 类，内部 gem-icon[aria-label="已选中"] 包含 mat-icon[data-mat-icon-name="check"]。图标可无布局框，不能靠其矩形判断选中 |
| 思考入口 | gem-menu-item[value="thinking_level"]，宽窗口 aria-haspopup="true"、arrow_right 图标，展开后嵌套另一个 gem-menu；窄窗口 expandable 类、aria-haspopup="false"，aria-expanded 切换，在 .expand-content 行内展开 |
| 思考选项 | 低点 / 中等 / 高点；同样是 gem-menu-item、role=menuitem，首行 .label、次行说明。selected/check 表示选中，未设置 aria-checked |

实际目录：3.5 Flash-Lite、3.8 Flash、3.1 Pro、4 Argon；思考等级：低点、中等、高点。读取目录不改变选项。目录按账号保存，列表改变须重新读取。

2026-10-20 起网页思考等级改名为「低、中、高」。思考等级按档位比较：「低/低点/Low」「中/中等/Medium」「高/高点/High」视为同一档，已保存的设置无需修改；同一档位出现两个选项时停止，不猜选。

## 选择和发送边界

用目录思考选项拆分按钮完整文字，忽略图标文字和说明。模型简称必须唯一对应目标，思考等级也须一致，才能零点击通过；按按钮结果记录“已核对”，取消每小时开菜单。真实页面单次 DOM 检查约 0.5ms；产品任务主进程耗时另以日志为准。

不能直接证明时打开菜单，必要时先选模型，再设思考等级（切换模型可能重置它），用唯一勾选核对，再关闭菜单核对组合按钮。只取菜单首行名称。没有请求思考等级时不主动改动；完全“不指定 / 不改动”保持零菜单行为。

缺失目标、目录重名、勾选或最终按钮不一致时，在上传发送前停止，不降级、不换其他模型、不改 Gem。确定性 MODEL_SELECTION_FAILED 退回任务，该账号停止领取相同设置；临时 MODEL_SELECTION_RETRYABLE 走原退避，连续三次才暂停，成功清零。

2026-10-23 起（1.4.60）：隐藏的任务窗口里 Gemini 可能不渲染模型按钮（同一 Gem 页在前台时按钮正常，诊断显示后台窗口只缺模型按钮和侧栏懒加载部分）。任务检查先用 buttonReady 即时探测，不等待；按钮在则照旧后台零点击核对，菜单步骤再提到前台；按钮不在则把整次检查（inspect + 必要的菜单操作）放进同一次 runWithActivatedGeminiWorker，与读取模型列表一致。「不指定 / 不改动」不探测、不激活。

inspect / readCatalog 最多先等按钮十秒；菜单另有八秒预算。等待超时显示按钮 data-test-id、aria-label、aria-haspopup、前三个 class、最多三十字文字；屏蔽会话区域、Cookie、网址参数。

## 验证

npm run verify 包含浏览器行为夹具：嵌套菜单、行内展开、两行文字、无 aria-checked 的勾选、组合按钮、零点击、仅改思考等级、先改模型再恢复思考等级、缺失目标时零上传零发送，以及三个执行入口的发送边界。

npm run test:model-electron --prefix gemini-web-workbench 验证实际隐藏 Electron 激活与调用边界。自动测试使用隔离目录和假网页；用户授权的本机真实验证复用原登录会话，不重新登录、不删除账号、不修改 Gem，结束恢复原队列状态。
