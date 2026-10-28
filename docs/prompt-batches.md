# 提示词生成（1.4.66）

用于准备在其他地方的 Seedance 2.5 中使用的提示词。上传 1–12 张产品图片、选 Gem 和地区、写一句描述、选择 1–20 条，每条单独调用 Gemini 网页 Gem。生成后在本页逐条查看、复制、重试或删除。无需 TK 账号，不提交 Seedance，不出现在视频任务队列。

## 发给 Gem 的文字

默认地区「印尼」、描述「iPhone实拍质感」、条数 5。未自定义时，发送文字使用 `promptBatchRequest` 生成：

`buildGemRequest(`${地区}，${描述}`, { region: 地区, duration: 30, shooting_style: '', spoken_language: 'auto' })`

即「地区，描述」加口播语言及「不要提问，直接按以上信息输出提示词」两行。这只是可编辑的默认内容：展开「发送给 Gem 的文字」可修改全文、增删任何一句，点击「恢复默认文字」才重新跟随地区和描述。自定义后修改地区、描述不会覆盖你的文字。

自定义内容与其他设置一并记在浏览器本地；创建时通过 `geminiRequestText` 提交，接口验证非空且不超过 12000 字后原样存为快照。提示词条目领取时直接使用快照，不经过 `buildGemRequest` 再处理，因此删除的口播语言或「不要提问」不会被补回，自己输入的占位符也按原文发送。未提供此字段的旧调用继续使用默认内容。重试沿用该条创建时的快照。

30 秒仅作记录。Gem 指令、模型与思考等级均沿用现有设置；其他生成模块的文字处理不变。存储不可用时仍可使用。

## 数据和执行

- 复用 `tasks`，新增可空文本列 `prompt_batch_id`、`prompt_copied_at`，批次 ID 有索引。`task_role='prompt_item'`，一条一行，条目和批次排序用已有 `batch_index`、`batch_size` 和创建时间；N 行在同一 D1 batch 插入。
- 商品用 `saveLibraryProduct` 按商品 ID 复用。每条冻结本次图片键、商品 ID、Gem 内容和发送文字，`provider='gemini-web'`、`auto_queue=0`、无 Gemini 绑定账号、无 TK 账号或归档目录。
- `/api/prompt-batches`：POST 接受 multipart；网页模式以外返回 409。GET 按游标每次返回 20 批及完整提示词，返回全页任务的 `hasActive` 供五秒轮询使用。PATCH 提供 retry、copied、delete-item 和 delete-batch。
- 标准 Gemini 领取链路仍负责账号调度。`prompt_item` 最先选 `blockMode='single'`，优先于 duration=30 的 raw 分支。回复全文至少 300 字即保存为一条 `prompt_ready`；即使含多个代码块也不拆分、不走变体或双段任务。写回要求当前 `prompt_generating` 和当前领取执行器；同一结果重复回报幂等，过期执行器的结果忽略。
- 重试只允许 failed，清空旧提示词、复制标记、错误和领取信息后重新排队。复制只要有文本就可用，成功后记录时间。创建或重试会请求桌面启动 Gemini 队列，不启动 Seedance。
- 生成中的条目不能删除，整批含生成中条目也不能删除；DELETE SQL 再校验状态，防止与领取竞争。删除后只有未被任何商品、任务快照或旧复刻素材行引用的 R2 对象才会被清理；当前商品库仍引用的图片保留。

## 隔离与恢复

凡 `prompt_batch_id` 非空的行都是提示词页的行，不论角色是 `prompt_item`、`fission` 或 `fission_child`。视频任务列表、全部计数、创作中心概况/最近任务、日历和发布接口所读的 workspace、审核列表、视频提交与审核统计、多品裂变视频页均排除这些行。任务详情抽屉不承接这些条目。普通视频队列的「清除全部」和「清除已完成」保留提示词批次；任何商品仍被批次使用时都拒绝删除商品，避免暗中损坏结果。

通用任务 PATCH、DELETE、重做、排期和审核/拼接入口按 `prompt_batch_id` 拒绝（409）；提示词仅由专用接口管理。备份仍导出 tasks 全表，恢复时提示词页的 `prompt_ready`、复制时间，以及有至少 300 字母版的 `fission_ready` 母版原样保留；其余未完成行标记失败，须在本页手动重试，不自动重发。普通视频裂变的恢复规则不变。

## 多品裂变模式

顶部可切换单个商品 / 多品裂变，选择会记住。放入 2–10 个商品，图片按文件名或文件夹中的商品 ID 分组；可给卡片补图、修改 ID、移除、★ 设为母版。两页共同使用 `fission-product-cards.tsx` 的图片读取、分组、缩略图和卡片；提示词页不提供商品库选择，也不需要 TK 账号。

母版来源为「用 ★ 商品生成」或「粘贴现成母版」（300–60000 字）。母版 Gem、变体 Gem、来源和自定义第二轮文字会记住。地区、描述、第一轮文字与单个商品共用，保留 1.4.65 的原文编辑与存储。粘贴时隐藏第一轮。第二轮默认是 `buildGemRequest(DEFAULT_FISSION_REQUEST, {region,duration:30,shooting_style:'',spoken_language:'auto'})`，可编辑、恢复默认；自定义后换地区不覆盖，必须保留 `{母版提示词}`。

页面逐个通过 `/api/products` 上传商品，缓存本次上传结果，再向 `/api/prompt-batches` 提交 JSON：`mode='fission'`、UUID `requestId`、`products: [{productId,imageKeys}]`、`motherSource`、`motherProductId`、`motherGemId`、`motherPrompt`、`variantGemId`、`region`、`firstText`、`secondText`。失败重试复用 UUID 和已上传商品；编辑输入后才换请求 ID。接口校验商品 ID、不重复、商品图片所属路径与对象存在、Gem 内容、地区和两轮文字，UUID 重复返回原批次。

母版和全部子行一次 D1 batch 插入。沿用现有 `fission` / `fission_child`、图片和 Gem 快照、`batch_parent_id`，每行另写同一个 `prompt_batch_id`，`auto_queue=0`，无 TK 账号、归档目录和绑定 Gemini 账号，`duration=30` 仅作记录。生成模式母版 `prompt_queued`、子行 `fission_wait`；粘贴模式母版 `fission_ready`、子行直接 `variant_queued`。

领取母版为 standard/single，发送 `gemini_request_text` 原文；领取子行为 variant/single，发送 `renderVariantRequest(variant_request_text,母版)`，只代入母版，不经过 `buildGemRequest`，其他占位符保持用户原文。口播语言元数据从对应轮的原文读取。母版写回和放出等待子行沿用现有原子屏障；两轮全文至少 300 字，即使多个代码块也只保存一条。子行停在 `prompt_ready`、进度 100，不拆 clip，不进 Seedance。失败、延后、短回复补充和过期执行器守卫继续共用原流程。

GET 每批附 `kind: single|fission`，裂变批返回母版及各商品的页面字段、完整提示词、错误、Gem 名和复制时间，不返回 Gem 快照或原始回复。任意提示词页行在 prompt/variant 排队或生成时 `hasActive=true`；等待母版且母版未失败时也为 true。全结束或只剩失败母版与等待子行时停止五秒轮询。

retry 只处理失败行：单条和裂变母版回 `prompt_queued`；失败子行在母版 `fission_ready` 且有至少 300 字母版时回 `variant_queued`，否则回 `fission_wait`。都清错误、领取信息、账号和旧结果，保留创建快照。母版重试不改变等待子行，成功后统一放出。复制支持任何有提示词的行，包括母版；裂变行不能单独删除，须删除整批。批内任何 prompt/variant 生成中的行都阻止整批删除，DELETE 再次检查状态防领取竞争；图片仍按所有引用检查清理。

## 验证

`prompt-batches-api.test.js` 使用真实路由、真实 storage 建表逻辑、内存 SQLite 和内存对象存储，覆盖五条创建及原子失败、快照、发送文字、商品 ID 复用、标准领取 single 模式、多代码块全文写回、重复/过期写回、列表/计数/日历/审核隔离、防误用、复制/重试/删除及共享图片清理、分页和备份恢复。

`prompt-batches-ui.test.js` 在隔离 Chromium 中操作实际 StudioApp，通过本地模拟接口拖入图片、识别/修改 ID、选 Gem、设条数、创建、查看和复制，检查设置记忆、加载更多、五秒刷新停止及手机布局。不连接真实 Gemini，也不读写真实 AppData。

发布前运行 `npm run verify`、`npx tsc --noEmit -p tsconfig.json` 和隔离桌面启动自检；推送后检查 GitHub Actions verify 与 desktop-smoke。

`prompt-fission-api.test.js` 覆盖三商品创建、原子回滚、UUID 幂等、快照、两轮原文领取、母版屏障、多代码块 single 写回、过期和重复结果、重试两种去向、视频入口与列表隔离、商品删除保护、列表投影、复制和生成中整批删除保护、备份恢复。`prompt-fission-ui.test.js` 用隔离浏览器验证两组拖图、选择母版和 Gem、编辑两轮、缺占位符提示、回包失败重试 UUID、复制母版与商品、记住设置和手机布局。原多品裂变及单商品提示词测试一并回归；不连接真实 Gemini、不读真实资料目录。
