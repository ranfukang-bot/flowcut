// FlowCut 的任务状态只在这里定义：每个状态的中文名，以及程序里反复判断的几组状态。
// 新增状态时，先在这里补中文名并放进对应分组，再去改用到它的流程。
// 只用普通 TypeScript 写法，桌面程序也直接 require 这个文件。

// tasks.status 的中文名。
export const TASK_STATUS_LABELS: Record<string, string> = {
  prompt_queued: "等待 Gemini",
  prompt_generating: "Gemini 识别中",
  prompt_ready: "提示词就绪",
  seedance_blocked: "Seedance 未提交",
  video_queued: "等待 Seedance",
  video_generating: "视频生成中",
  video_ready: "成片已就绪",
  scheduled: "已排期",
  failed: "执行失败",
  reference_queued: "等待拆解",
  reference_analyzing: "拆解对标视频",
  product_adapting: "同对话换产品",
  rewrite_queued: "等待剧本改写",
  rewriting: "正在改写剧本",
  extracting: "提取角色场景",
  storyboarding: "拆解完整分镜",
  grouping: "合并视频段落",
  optimization_queued: "等待 Gem 优化",
  optimizing: "Gem 优化提示词",
  completed: "提示词已完成",
  variant_queued: "等待变体 Gem",
  variant_generating: "变体 Gem 生成中",
  split_done: "已按代码块拆分",
  concat_running: "正在拼接",
  fission_wait: "等待母版",
  fission_ready: "母版就绪",
  remix_queued: "等待分段拆解",
  remix_analyzing: "正在分段拆解",
  remix_adapting: "正在分段换品",
  remix_segmented: "分段等待检查",
  remix_done: "复刻成片已放行",
  remix_finishing: "正在拼接放行",
  remix_deleting: "正在删除复刻组",
  remix_rewrite_queued: "等待重写分段",
  remix_rewriting: "正在重写分段",
};

// status：成片已经生成。是否待检查、已通过，再看 review_status。
export const VIDEO_DONE_STATUSES: readonly string[] = ["video_ready", "scheduled"];
// status：需要人处理（执行失败，或提示词已出但 Seedance 没提交）。
export const VIDEO_FAILED_STATUSES: readonly string[] = ["failed", "seedance_blocked"];
// status：Seedance 排队中或生成中。
export const VIDEO_RUNNING_STATUSES: readonly string[] = ["video_queued", "video_generating"];
// status：提示词已出，视频还没提交（手动提交或补交）。
export const PROMPT_ONLY_STATUSES: readonly string[] = ["prompt_ready", "seedance_blocked"];
// status：Gemini 第一轮（普通提示词、母版）。
export const PROMPT_ROUND_STATUSES: readonly string[] = ["prompt_queued", "prompt_generating"];
// status：变体 Gem 第二轮。
export const VARIANT_ROUND_STATUSES: readonly string[] = ["variant_queued", "variant_generating"];
// status：还在等 Gemini 的全部状态。
export const REMIX_GEMINI_STATUSES: readonly string[] = ['remix_queued', 'remix_analyzing', 'remix_adapting', 'remix_rewrite_queued', 'remix_rewriting'];
export const GEMINI_STATUSES: readonly string[] = [...PROMPT_ROUND_STATUSES, ...VARIANT_ROUND_STATUSES, ...REMIX_GEMINI_STATUSES];
// status：任务组本身已完成分发，之后看组里的每条视频。
export const GROUP_DONE_STATUSES: readonly string[] = ["split_done", "fission_ready", "remix_segmented", "remix_done"];

// review_status：已放行（通过，或已被重做的新视频替换）。
export const APPROVED_REVIEW_STATUSES: readonly string[] = ["approved", "replaced"];
// review_status：被选去拼接，不再单独待检查。
export const CONCAT_REVIEW_STATUSES: readonly string[] = ["merging", "merged"];

// task_role：任务组（代码块分条、多品裂变批次）。
export const GROUP_ROLES: readonly string[] = ["group", "fission", "remix"];
// task_role：组里的单条视频。
export const CHILD_ROLES: readonly string[] = ["clip", "fission_child"];

// 把一组状态写进 SQL 的 IN (...)。只用于上面这些固定常量。
export function sqlList(values: readonly string[]) {
  return values.map(value => `'${value}'`).join(",");
}
