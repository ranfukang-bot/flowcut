# 提示词生成（1.4.63）

用于准备在其他地方的 Seedance 2.5 中使用的提示词。上传 1–12 张产品图片、选 Gem 和地区、写一句描述、选择 1–20 条，每条单独调用 Gemini 网页 Gem。生成后在本页逐条查看、复制、重试或删除。无需 TK 账号，不提交 Seedance，不出现在视频任务队列。

## 发给 Gem 的文字

默认地区「印尼」、描述「iPhone实拍质感」、条数 5。预览与服务端都使用 `promptBatchRequest`，其内容严格为：

`buildGemRequest(`${地区}，${描述}`, { region: 地区, duration: 30, shooting_style: '', spoken_language: 'auto' })`

即「地区，描述」加口播语言及「不要提问，直接按以上信息输出提示词」两行。30 秒仅作记录，不附加时长要求或代码块要求。Gem 指令、模型与思考等级均沿用现有设置。Gem、地区、描述和条数记在浏览器本地，存储不可用时仍可使用。

## 数据和执行

- 复用 `tasks`，新增可空文本列 `prompt_batch_id`、`prompt_copied_at`，批次 ID 有索引。`task_role='prompt_item'`，一条一行，条目和批次排序用已有 `batch_index`、`batch_size` 和创建时间；N 行在同一 D1 batch 插入。
- 商品用 `saveLibraryProduct` 按商品 ID 复用。每条冻结本次图片键、商品 ID、Gem 内容和发送文字，`provider='gemini-web'`、`auto_queue=0`、无 Gemini 绑定账号、无 TK 账号或归档目录。
- `/api/prompt-batches`：POST 接受 multipart；网页模式以外返回 409。GET 按游标每次返回 20 批及完整提示词，返回全页任务的 `hasActive` 供五秒轮询使用。PATCH 提供 retry、copied、delete-item 和 delete-batch。
- 标准 Gemini 领取链路仍负责账号调度。`prompt_item` 最先选 `blockMode='single'`，优先于 duration=30 的 raw 分支。回复全文至少 300 字即保存为一条 `prompt_ready`；即使含多个代码块也不拆分、不走变体或双段任务。写回要求当前 `prompt_generating` 和当前领取执行器；同一结果重复回报幂等，过期执行器的结果忽略。
- 重试只允许 failed，清空旧提示词、复制标记、错误和领取信息后重新排队。复制只要有文本就可用，成功后记录时间。创建或重试会请求桌面启动 Gemini 队列，不启动 Seedance。
- 生成中的条目不能删除，整批含生成中条目也不能删除；DELETE SQL 再校验状态，防止与领取竞争。删除后只有未被任何商品、任务快照或旧复刻素材行引用的 R2 对象才会被清理；当前商品库仍引用的图片保留。

## 隔离与恢复

视频任务列表、全部计数、创作中心概况/最近任务、日历和发布接口所读的 workspace、审核列表、视频提交与审核统计均排除 prompt_item。任务详情抽屉不承接这些条目。普通视频队列的「清除全部」保留提示词批次；商品仍被批次使用时提示先删批次，避免商品删除暗中损坏结果。

通用任务 PATCH、重做、排期和审核/拼接入口拒绝 prompt_item（409）；提示词仅由专用接口管理。备份仍导出 tasks 全表，恢复时 prompt_item 的 prompt_ready 和复制时间原样保留；排队、生成中的条目标记失败，须在本页手动重试，不自动重发。

## 验证

`prompt-batches-api.test.js` 使用真实路由、真实 storage 建表逻辑、内存 SQLite 和内存对象存储，覆盖五条创建及原子失败、快照、发送文字、商品 ID 复用、标准领取 single 模式、多代码块全文写回、重复/过期写回、列表/计数/日历/审核隔离、防误用、复制/重试/删除及共享图片清理、分页和备份恢复。

`prompt-batches-ui.test.js` 在隔离 Chromium 中操作实际 StudioApp，通过本地模拟接口拖入图片、识别/修改 ID、选 Gem、设条数、创建、查看和复制，检查设置记忆、加载更多、五秒刷新停止及手机布局。不连接真实 Gemini，也不读写真实 AppData。

发布前运行 `npm run verify`、`npx tsc --noEmit -p tsconfig.json` 和隔离桌面启动自检；推送后检查 GitHub Actions verify 与 desktop-smoke。
