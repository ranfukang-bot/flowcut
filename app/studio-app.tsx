"use client";

import {
  DragEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_SHOOTING_STYLE,
  DEFAULT_TASK_DURATION,
  DEFAULT_TASK_REGION,
  SHOOTING_STYLES,
  TASK_DURATIONS,
  TASK_REGIONS,
} from "../lib/task-config";

import { confirmAction } from "./confirm-action";
import { useImageProductId } from "./use-image-product-id";

type Gem = {
  id: string;
  name: string;
  description: string;
  content: string;
  is_default: number;
  updated_at: string;
};

type Product = {
  id: string;
  external_id: string;
  name: string;
  features: string;
  image_key?: string | null;
  image_name?: string | null;
  images: Array<{
    id: string;
    object_key: string;
    file_name: string;
    content_type: string;
    sort_order: number;
  }>;
  created_at: string;
};

type Task = {
  id: string;
  product_id: string;
  product_external_id?: string;
  gem_id: string;
  title: string;
  status: string;
  prompt: string;
  provider: string;
  duration: number;
  region: string;
  shooting_style: string;
  provider_job_id?: string | null;
  progress: number;
  output_url?: string | null;
  provider_status_url?: string | null;
  error?: string | null;
  product_name?: string;
  gem_name?: string;
  image_count?: number;
  gemini_account_id?: string | null;
  tiktok_account_name: string;
  archive_directory?: string;
  download_path?: string | null;
  download_error?: string | null;
  created_at: string;
};

type TikTokAccount = {
  archive_directory?: string;
  id: string;
  name: string;
  created_at: string;
};

type Schedule = {
  id: string;
  task_id: string;
  account_name: string;
  scheduled_at: string;
  caption: string;
  status: string;
  task_title?: string;
};

type ReferenceRemixAsset = {
  id: string;
  kind: "reference_video" | "product_image";
  object_key: string;
  file_name: string;
  content_type: string;
  file_size: number;
  sort_order: number;
};

type ReferenceRemixTask = {
  id: string;
  title: string;
  status: string;
  progress: number;
  duration: number;
  region: string;
  product_name: string;
  product_external_id: string;
  save_to_library: number;
  product_id?: string | null;
  gemini_account_id?: string | null;
  tiktok_account_name: string;
  auto_queue: number;
  reference_analysis: string;
  prompt: string;
  provider: string;
  output_url?: string | null;
  archive_directory?: string;
  download_path?: string | null;
  download_error?: string | null;
  error?: string | null;
  created_at: string;
  assets: ReferenceRemixAsset[];
};

type ScriptPromptGroup = {
  index: number;
  rawDuration: number;
  targetDuration: number;
  shotNumbers: number[];
  rawPrompt: string;
  optimizedPrompt?: string;
};

type ScriptPipelineTask = {
  id: string;
  title: string;
  status: string;
  progress: number;
  source_script: string;
  project_context: string;
  rewritten_script: string;
  extraction_json: string;
  storyboard_json: string;
  raw_groups_json: string;
  optimized_groups_json: string;
  gemini_account_id?: string | null;
  error?: string | null;
  created_at: string;
};

type Workspace = {
  gems: Gem[];
  products: Product[];
  tasks: Task[];
  schedules: Schedule[];
  tiktokAccounts: TikTokAccount[];
  referenceRemixTasks: ReferenceRemixTask[];
  referenceRemixSettings: { duration: number; region: string };
  scriptPipelineTasks: ScriptPipelineTask[];
  integrations: {
    gemini: boolean;
    geminiMode?: "web" | "api";
    geminiRuntime?: {
      online: boolean;
      authenticated?: boolean;
      queueRunning?: boolean;
      maxConcurrent?: number;
      activeCount?: number;
      activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string }>;
      workerId?: string;
      version?: string;
      updatedAt?: string;
      defaultAccountId?: string;
      accounts?: Array<{
        id: string;
        name: string;
        authenticated: boolean;
        busy?: boolean;
      }>;
    };
    seedance: boolean;
    seedanceMode?: "local-api" | "webhook" | "async-api";
    seedanceRuntime?: {
      online: boolean;
      authenticated?: boolean;
      queueRunning?: boolean;
      maxConcurrent?: number;
      activeCount?: number;
      activeJobs?: Array<{ taskId: string; accountName?: string; stage?: string; startedAt?: string }>;
      workerId?: string;
      version?: string;
      updatedAt?: string;
      downloadDirectory?: string;
    };
    tiktok: boolean;
  };
};

type Page = "dashboard" | "scripts" | "remix" | "products" | "gems" | "tasks" | "calendar" | "settings" | "publisher";

const nav: Array<{ id: Page; label: string; icon: string }> = [
  { id: "dashboard", label: "创作中心", icon: "✦" },
  { id: "scripts", label: "剧本提示词", icon: "文" },
  { id: "remix", label: "爆款复刻", icon: "◎" },
  { id: "products", label: "商品库", icon: "▣" },
  { id: "gems", label: "Gem 模板", icon: "◇" },
  { id: "tasks", label: "任务队列", icon: "↗" },
  { id: "publisher", label: "发布管理", icon: "▷" },
  { id: "calendar", label: "发布日历", icon: "◫" },
  { id: "settings", label: "账号与设置", icon: "⚙" },
];

const statusLabels: Record<string, string> = {
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
};

type SeedanceRuntime = {
  status: "checking" | "ready" | "missing-key" | "offline" | "blocked";
  label: string;
  detail: string;
};

type TaskStage = {
  number: string;
  label: string;
  detail: string;
  state: "done" | "active" | "waiting" | "blocked";
};

function taskStages(task: Task): TaskStage[] {
  const isDemo = task.provider === "demo-engine";
  const hasRealPrompt = Boolean(task.prompt?.trim()) && !isDemo;
  const seedanceStarted = [
    "video_queued",
    "video_generating",
    "video_ready",
    "scheduled",
  ].includes(task.status);
  const seedanceFailed =
    task.status === "seedance_blocked" ||
    (task.status === "failed" && Boolean(task.provider_job_id));
  const geminiFailed =
    isDemo ||
    (task.status === "failed" && !task.provider_job_id && !hasRealPrompt);

  return [
    {
      number: "1",
      label: "商品图片",
      detail: `${Math.max(Number(task.image_count || 0), 1)} 张参考图已保存`,
      state: "done",
    },
    {
      number: "2",
      label: "Gemini 识别与提示词",
      detail: isDemo
        ? "旧版演示结果，未识别商品图"
        : hasRealPrompt
          ? "真实 Gemini 结果已生成"
          : geminiFailed
            ? "Gemini 调用失败"
            : "等待 Gemini",
      state: isDemo || geminiFailed ? "blocked" : hasRealPrompt ? "done" : "active",
    },
    {
      number: "3",
      label: "Seedance 2.0",
      detail: seedanceFailed
        ? "提交失败，可在此重试"
        : seedanceStarted
          ? task.status === "video_ready" || task.status === "scheduled"
            ? "Seedance 已完成"
            : task.status === "video_queued"
              ? "已进入本机队列"
              : "正在生成视频"
          : hasRealPrompt
            ? "等待提交"
            : "等待上一步",
      state: seedanceFailed
        ? "blocked"
        : seedanceStarted
          ? task.status === "video_ready" || task.status === "scheduled"
            ? "done"
            : "active"
          : "waiting",
    },
    {
      number: "4",
      label: "成片",
      detail:
        task.status === "video_ready" || task.status === "scheduled"
          ? "视频已生成"
          : task.status === "failed" && Boolean(task.provider_job_id)
            ? "生成失败"
            : "等待 Seedance 完成",
      state:
        task.status === "video_ready" || task.status === "scheduled"
          ? "done"
          : task.status === "failed" && Boolean(task.provider_job_id)
            ? "blocked"
            : "waiting",
    },
  ];
}

function TaskChain({ task, compact = false }: { task: Task; compact?: boolean }) {
  return (
    <div className={compact ? "task-chain compact" : "task-chain"}>
      {taskStages(task).map((stage) => (
        <div className={`task-stage ${stage.state}`} key={stage.number}>
          <span>{stage.state === "done" ? "✓" : stage.number}</span>
          <div>
            <b>{stage.label}</b>
            {!compact && <small>{stage.detail}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

type UpdateState = {
  status:
    | "local"
    | "idle"
    | "development"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "downloaded"
    | "error";
  currentVersion: string;
  availableVersion: string;
  percent: number;
  message: string;
  checkedAt?: string | null;
};


function taskStatusLabel(task: Task) {
  if (task.provider === "demo-engine") return "需重新用 Gemini 识别";
  return statusLabels[task.status] || task.status;
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

type FlowCutDesktopBridge = {
  seedanceSetPreferredModel?: (id: string, model: string) => Promise<SeedanceDesktopState>;
  seedanceDecideFastFallback?: (id: string, choice: string, date: string) => Promise<SeedanceDesktopState>;
  seedanceReconnectLogin?: (id: string) => Promise<SeedanceDesktopState>;
  getState?: () => Promise<{ update?: UpdateState }>;
  updateState?: () => Promise<UpdateState>;
  chooseArchiveDirectory?: () => Promise<string | null>;
  setQueueRunning?: (running: boolean) => Promise<unknown>;
  clearAllTasks?: () => Promise<{ deleted: number }>;
  publisherStart?: () => Promise<{ origin: string }>;
  publisherOpenExtension?: () => Promise<boolean>;
  publisherImport?: (rows: unknown[]) => Promise<{ total: number; added: number; results: Array<{ warning?: string }> }>;
  publisherRelease?: (taskId: string, confirmed: boolean) => Promise<{ alreadyReleased?: boolean; file: string }>;
  updateCheck?: () => Promise<UpdateState>;
  updateInstall?: () => Promise<unknown>;
  onState?: (
    callback: (state: { update?: UpdateState; seedance?: SeedanceDesktopState }) => void
  ) => (() => void);
  addAccount: (name: string) => Promise<unknown>;
  openLogin: (id: string) => Promise<unknown>;
  hideLogin: (id: string) => Promise<unknown>;
  checkAccount: (id: string) => Promise<unknown>;
  removeAccount: (id: string) => Promise<unknown>;
  setDefaultAccount: (id: string) => Promise<unknown>;
  seedanceState: () => Promise<SeedanceDesktopState | null>;
  seedanceAddAccount: (name: string) => Promise<SeedanceDesktopState>;
  seedanceOpenLogin: (id: string) => Promise<unknown>;
  seedanceSaveLogin: (id: string) => Promise<SeedanceDesktopState>;
  seedanceRemoveAccount: (id: string) => Promise<SeedanceDesktopState>;
  seedanceSetRunning: (running: boolean) => Promise<SeedanceDesktopState>;
  seedanceChooseDownloadDirectory: () => Promise<SeedanceDesktopState>;
  seedanceOpenDownloadDirectory: () => Promise<unknown>;
};

type SeedanceDesktopState = {
  ready: boolean;
  authenticated: boolean;
  settings: {
    running: boolean;
    downloadDirectory: string;
  };
  accountState: {
    activeAccountId: string;
    items: Array<{
      id: string;
      name: string;
      enabled: boolean;
      authenticated: boolean;
      exhaustedToday: boolean;
      error?: string;
      maxConcurrent?: number;
      generatingCount?: number;
      active?: boolean;
      preferredModel?: string;
      effectiveModel?: string;
      fastExhaustedToday?: boolean;
      standardExhaustedToday?: boolean;
      quotaDate?: string;
      quotaReason?: string;
      needsModelDecision?: boolean;
      fallbackDecision?: string;
      loginNetworkError?: string;
    }>;
  };
  tasks: Array<{ id: string; status: string }>;
  bridge?: { online?: boolean; error?: string };
};

function desktopBridge() {
  if (typeof window === "undefined") return undefined;
  return (
    window as unknown as {
      flowcutDesktop?: FlowCutDesktopBridge;
    }
  ).flowcutDesktop;
}

export function StudioApp() {
  const [seedanceStatus, setSeedanceStatus] = useState<SeedanceDesktopState | null>(null);
  const [page, setPage] = useState<Page>("dashboard");
  const [moreTools, setMoreTools] = useState(false);
  const [data, setData] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [gemOpen, setGemOpen] = useState(false);
  const [tiktokAccountOpen, setTikTokAccountOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingGem, setEditingGem] = useState<Gem | null>(null);
  const [previewTask, setPreviewTask] = useState<Task | null>(null);
  const [selectedProduct, setSelectedProduct] = useState("");
  const [selectedGem, setSelectedGem] = useState("");
  const [selectedGeminiAccount, setSelectedGeminiAccount] = useState("");
  const [selectedTikTokAccount, setSelectedTikTokAccount] = useState("");
  const [selectedDuration, setSelectedDuration] = useState(DEFAULT_TASK_DURATION);
  const [selectedRegion, setSelectedRegion] = useState(DEFAULT_TASK_REGION);
  const [selectedShootingStyle, setSelectedShootingStyle] = useState(
    DEFAULT_SHOOTING_STYLE
  );
  const [autoQueue, setAutoQueue] = useState(true);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [seedanceRuntime, setSeedanceRuntime] = useState<SeedanceRuntime>({
    status: "checking",
    label: "正在检测本机",
    detail: "正在检查 FlowCut 内置 Seedance 执行器。",
  });

  const reload = useCallback(async () => {
    try {
      const result = (await api("/api/workspace")) as unknown as Workspace;
      setData(result);
      const runtime = result.integrations.seedanceRuntime;
      setSeedanceRuntime(
        runtime?.online && runtime.authenticated && runtime.queueRunning
          ? {
              status: "ready",
              label: "本机执行器在线",
              detail: `内置执行器已连接，并发上限 ${runtime.maxConcurrent || "—"}`,
            }
          : runtime?.online && !runtime.authenticated
            ? {
                status: "blocked",
                label: "TikTok 未登录",
                detail: "内置 Seedance 已启动，但 TikTok 尚未登录。",
              }
            : runtime?.online && !runtime.queueRunning
              ? {
                  status: "blocked",
                  label: "队列未启动",
                  detail: "内置 Seedance 已启动，但任务队列尚未启动。",
                }
              : {
                  status: "offline",
                  label: "等待工作台连接",
                  detail: "内置 Seedance 正在启动，请稍后刷新。",
                }
      );
      setSelectedProduct((current) => current || result.products[0]?.id || "");
      setSelectedGem((current) =>
        result.gems.some((gem) => gem.id === current)
          ? current
          : result.gems[0]?.id || ""
      );
      setSelectedGeminiAccount((current) => {
        if (current) return current;
        return (
          result.integrations.geminiRuntime?.defaultAccountId ||
          result.integrations.geminiRuntime?.accounts?.find(
            (account) => account.authenticated
          )?.id || ""
        );
      });
      setSelectedTikTokAccount((current) =>
        result.tiktokAccounts.some((account) => account.name === current)
          ? current
          : result.tiktokAccounts[0]?.name || ""
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    const desktop = desktopBridge();
    if (!desktop) return;
    let mounted = true;
    void desktop.seedanceState?.().then(state => { if (mounted) setSeedanceStatus(state); }).catch(() => {});
    void desktop
      .updateState?.()
      .then((state) => {
        if (mounted) setUpdateState(state);
      })
      .catch(() => {});
    const unsubscribe = desktop.onState?.((state) => {
      if (mounted && state.update) setUpdateState(state.update);
      if (mounted && state.seedance) setSeedanceStatus(state.seedance);
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const queued =
      data?.tasks
        .filter(
          (task) =>
            task.status === "prompt_queued" && task.provider !== "gemini-web"
        )
        .slice(0, 4) ||
      [];
    if (!queued.length) return;
    const timer = window.setTimeout(async () => {
      await Promise.allSettled(
        queued.map((task) =>
          api("/api/tasks", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: task.id, action: "process" }),
          })
        )
      );
      await reload();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [data?.tasks, reload]);

  useEffect(() => {
    const active =
      data?.tasks.some((task) =>
        [
          "prompt_queued",
          "prompt_generating",
          "video_queued",
          "video_generating",
        ].includes(task.status)
      ) || data?.referenceRemixTasks.some((task) =>
        [
          "reference_queued",
          "reference_analyzing",
          "product_adapting",
          "video_queued",
          "video_generating",
        ].includes(task.status)
      ) || data?.scriptPipelineTasks.some((task) =>
        ["rewrite_queued", "rewriting", "extracting", "storyboarding", "grouping", "optimization_queued", "optimizing"].includes(task.status)
      ) || false;
    if (!active) return;
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [data?.tasks, data?.referenceRemixTasks, data?.scriptPipelineTasks, reload]);

  useEffect(() => {
    const refreshVisiblePage = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", refreshVisiblePage);
    document.addEventListener("visibilitychange", refreshVisiblePage);
    return () => {
      window.removeEventListener("focus", refreshVisiblePage);
      document.removeEventListener("visibilitychange", refreshVisiblePage);
    };
  }, [reload]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const pollable =
      data?.tasks.filter(
        (task) =>
          task.provider !== "seedance-local" &&
          Boolean(task.provider_status_url) &&
          ["video_queued", "video_generating"].includes(task.status)
      ) || [];
    if (!pollable.length) return;
    const timer = window.setInterval(async () => {
      await Promise.allSettled(
        pollable.map((task) =>
          api("/api/tasks", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: task.id, action: "check" }),
          })
        )
      );
      await reload();
    }, 12000);
    return () => window.clearInterval(timer);
  }, [data?.tasks, reload]);

  const readyTasks = useMemo(
    () => data?.tasks.filter((task) => task.status === "video_ready") || [],
    [data]
  );

  async function runTask(input: {
    mode: "new" | "library";
    files: File[];
    productName: string;
    externalId: string;
  }) {
    if (
      (input.mode === "new" ? !input.files.length : !selectedProduct) ||
      !selectedGem ||
      !selectedTikTokAccount
    ) {
      setNotice("请先选择商品、Gem 和 TK 归档账号");
      return false;
    }
    if (!data?.integrations.gemini) {
      setNotice(
        data?.integrations.geminiMode === "web"
          ? data.integrations.geminiRuntime?.online
            ? "Gemini 执行器已连接，但尚未检测到已登录账号，请在账号与设置中检查账号"
            : "Gemini 本机执行器未连接，请在账号与设置中检查连接"
          : "Gemini API 未配置，请先在接口设置中保存并测试 API Key"
      );
      setPage("settings");
      return false;
    }
    setBusy(true);
    try {
      const productId = input.mode === "new"
        ? await quickUploadProduct(
            input.files,
            input.productName,
            input.externalId
          )
        : selectedProduct;
      if (!productId) throw new Error("没有可用于创作的商品");
      setSelectedProduct(productId);
      await api("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId,
          gemId: selectedGem,
          autoQueue,
          geminiAccountId:
            data.integrations.geminiMode === "web"
              ? selectedGeminiAccount || undefined
              : undefined,
          tiktokAccountName: selectedTikTokAccount,
          duration: selectedDuration,
          region: selectedRegion,
          shootingStyle: selectedShootingStyle,
        }),
      });
      let queueNotice = "任务已创建，将按所选模板生成并保存到归档文件夹";
      const desktop = desktopBridge();
      try {
        if (data.integrations.geminiMode === "web") await desktop?.setQueueRunning?.(true);
        if (autoQueue) await desktop?.seedanceSetRunning?.(true);
      } catch (queueError) {
        queueNotice = `任务已保存，自动启动未成功，请在账号与设置中启动队列：${queueError instanceof Error ? queueError.message : "执行器暂不可用"}`;
      }
      setNotice(queueNotice);
      await reload();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "创建任务失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addTikTokAccount(name: string, archiveDirectory: string) {
    const account = (await api("/api/tiktok-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), archiveDirectory }),
    })) as TikTokAccount;
    setSelectedTikTokAccount(account.name);
    setTikTokAccountOpen(false);
    setNotice(`已添加 TK 账号：${account.name}`);
    await reload();
  }

  async function chooseSelectedArchiveDirectory() {
    const account = data?.tiktokAccounts.find(item => item.name === selectedTikTokAccount);
    if (!account) { setTikTokAccountOpen(true); return; }
    try {
      const desktop = desktopBridge();
      if (!desktop?.chooseArchiveDirectory) throw new Error("请在 FlowCut 桌面应用中选择文件夹");
      const directory = await desktop.chooseArchiveDirectory();
      if (!directory) return;
      await api("/api/tiktok-accounts", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: account.id, archiveDirectory: directory }) });
      await reload(); setNotice("保存文件夹已更新，之后创建的任务会使用新位置");
    } catch (error) { setNotice(error instanceof Error ? error.message : "选择文件夹失败"); }
  }

  async function quickUploadProduct(
    files: File[],
    productName: string,
    externalId: string
  ) {
    const form = new FormData();
    files.forEach((file) => form.append("images", file, file.name));
    form.set("name", productName.trim());
    form.set("externalId", externalId.trim());
    try {
      const result = (await api("/api/products", {
        method: "POST",
        body: form,
      })) as { id: string };
      return result.id;
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message !== "Failed to fetch"
          ? error.message
          : "商品图片上传未完成，请检查网络后重试"
      );
    }
  }

  async function deleteRecord(path: string, id: string, message: string) {
    if (!await confirmAction(message)) return;
    try {
      await api(path, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setNotice("已删除");
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    }
  }

  async function clearAllTasks() {
    if (!await confirmAction("清除全部制作任务（包括当前未显示的旧任务）并暂停队列？商品、模板和已下载视频会保留。已提交到 TikTok 的远端生成无法撤销。")) return;
    try {
      const desktop = desktopBridge();
      if (!desktop?.clearAllTasks) throw new Error("请在 FlowCut 桌面应用中清除全部任务");
      const result = await desktop.clearAllTasks();
      setNotice(`已清除 ${result.deleted} 条任务，队列已暂停`);
      await reload();
    } catch (error) { setNotice(error instanceof Error ? error.message : "清除任务失败"); }
  }

  async function clearCompletedTasks() {
    if (!await confirmAction("确认清除全部已完成任务？商品资料和已下载的成片文件不会被删除。")) {
      return;
    }
    try {
      const result = (await api("/api/tasks?completed=1", {
        method: "DELETE",
      })) as { deleted?: number };
      const deleted = Number(result.deleted || 0);
      setNotice(deleted ? `已清除 ${deleted} 条已完成任务` : "当前没有可清除的已完成任务");
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "清除已完成任务失败");
    }
  }

  if (loading || !data) {
    return (
      <main className="boot-screen">
        <div className="boot-mark">F</div>
        <div>
          <strong>FlowCut AI</strong>
          <span>正在装载你的自动化工作台…</span>
        </div>
      </main>
    );
  }


  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage("dashboard")}>
          <span className="brand-mark">F</span>
          <span>
            <b>FlowCut</b>
            <small>AI VIDEO STUDIO</small>
          </span>
        </button>

        <nav className="nav-list" aria-label="主导航">
          <p>工作台</p>
          {(["dashboard", "tasks", "products", "publisher", "gems", "settings"] as Page[]).map((id) => nav.find((item) => item.id === id)!).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
            >
              <span>{item.icon}</span>
              {item.label}
              {item.id === "tasks" && data.tasks.length > 0 && (
                <em>{data.tasks.length}</em>
              )}
            </button>
          ))}
          <button className="more-tools-toggle" aria-expanded={moreTools} onClick={() => setMoreTools(!moreTools)}>
            <span>{moreTools ? "−" : "+"}</span>更多工具
          </button>
          {moreTools && nav.filter((item) => ["scripts", "remix", "calendar"].includes(item.id)).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
            >
              <span>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div>
            <b>图片 → 提示词 → 视频</b>
            <small>成片按 TK 账号自动归档</small>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">AI VIDEO OPERATIONS</span>
            <h1>{nav.find((item) => item.id === page)?.label}</h1>
          </div>
          <div className="top-actions">
            {updateState?.currentVersion && (
              <div
                className="version-badge"
                title={`当前安装版本：FlowCut ${updateState.currentVersion}`}
              >
                v{updateState.currentVersion}
              </div>
            )}
            <div className="health">
              <i className={data.integrations.gemini ? "online" : ""} />
              {data.integrations.gemini
                ? data.integrations.geminiMode === "web"
                  ? data.integrations.geminiRuntime?.queueRunning
                    ? "Gemini 已登录 · 队列运行中"
                    : "Gemini 已登录 · 队列已暂停"
                  : "Gemini API 已配置"
                : data.integrations.geminiMode === "web"
                  ? data.integrations.geminiRuntime?.online
                    ? "Gemini 账号未登录"
                    : "Gemini 本机执行器未连接"
                  : "Gemini API 未配置"}
            </div>
            <div className="version-badge" title="本机使用，无授权到期限制">个人本机版</div>
            <div className="avatar">FC</div>
          </div>
        </header>

        {(seedanceStatus?.accountState.items || []).filter(account => account.needsModelDecision).map(account => (
          <SeedanceQuotaChoice key={account.id} account={account} onUpdated={setSeedanceStatus} onError={setNotice} />
        ))}

        {page === "dashboard" && (
          <Dashboard
            data={data}
            selectedProduct={selectedProduct}
            selectedGem={selectedGem}
            selectedGeminiAccount={selectedGeminiAccount}
            selectedTikTokAccount={selectedTikTokAccount}
            selectedDuration={selectedDuration}
            selectedRegion={selectedRegion}
            selectedShootingStyle={selectedShootingStyle}
            autoQueue={autoQueue}
            busy={busy}
            onProduct={setSelectedProduct}
            onGem={setSelectedGem}
            onGeminiAccount={setSelectedGeminiAccount}
            onTikTokAccount={setSelectedTikTokAccount}
            onDuration={setSelectedDuration}
            onRegion={setSelectedRegion}
            onShootingStyle={setSelectedShootingStyle}
            onAddTikTokAccount={() => setTikTokAccountOpen(true)}
            onChooseArchiveDirectory={chooseSelectedArchiveDirectory}
            onAutoQueue={setAutoQueue}
            onRun={runTask}
            onAddProduct={() => setProductOpen(true)}
            onAddGem={() => {
              setEditingGem(null);
              setGemOpen(true);
            }}
            onPreview={setPreviewTask}
            onNavigate={setPage}
            seedanceRuntime={seedanceRuntime}
          />
        )}
        {page === "scripts" && (
          <ScriptPipelinePage
            tasks={data.scriptPipelineTasks}
            geminiAccounts={data.integrations.geminiRuntime?.accounts || []}
            defaultGeminiAccountId={data.integrations.geminiRuntime?.defaultAccountId || ""}
            integrations={data.integrations}
            onReload={reload}
            onNotice={setNotice}
          />
        )}
        {page === "remix" && (
          <ReferenceRemixPage
            tasks={data.referenceRemixTasks}
            settings={data.referenceRemixSettings}
            geminiAccounts={data.integrations.geminiRuntime?.accounts || []}
            defaultGeminiAccountId={
              data.integrations.geminiRuntime?.defaultAccountId || ""
            }
            tiktokAccounts={data.tiktokAccounts}
            integrations={data.integrations}
            onReload={reload}
            onNotice={setNotice}
          />
        )}
        {page === "products" && (
          <ProductsPage
            products={data.products}
            onImported={reload}
            onAdd={() => setProductOpen(true)}
            onEdit={setEditingProduct}
            onDelete={(id) => deleteRecord("/api/products", id, "删除该商品及关联任务？")}
          />
        )}
        {page === "gems" && (
          <GemsPage
            gems={data.gems}
            onAdd={() => {
              setEditingGem(null);
              setGemOpen(true);
            }}
            onEdit={(gem) => {
              setEditingGem(gem);
              setGemOpen(true);
            }}
            onDelete={(id) => deleteRecord("/api/gems", id, "确认删除这个 Gem？")}
          />
        )}
        {page === "tasks" && (
          <TasksPage
            tasks={data.tasks}
            geminiRuntime={data.integrations.geminiRuntime}
            onPreview={setPreviewTask}
            onDelete={(id) => deleteRecord("/api/tasks", id, "确认删除这个任务？")}
            onClearCompleted={clearCompletedTasks}
            onClearAll={clearAllTasks}
          />
        )}
        {page === "calendar" && (
          <CalendarPage
            schedules={data.schedules}
            tasks={readyTasks.length ? readyTasks : data.tasks}
            onSaved={async () => {
              setNotice("发布计划已保存");
              await reload();
            }}
            onDelete={(id) => deleteRecord("/api/schedules", id, "取消该发布计划？")}
          />
        )}
        {page === "publisher" && <PublisherPage />}
        {page === "settings" && (
          <SettingsPage
            integrations={data.integrations}
            onUpdated={async () => {
              await reload();
            }}
            onNotice={setNotice}
          />
        )}
      </main>

      {productOpen && (
        <ProductModal
          onClose={() => setProductOpen(false)}
          onSaved={async () => {
            setProductOpen(false);
            setNotice("商品已加入商品库");
            await reload();
          }}
        />
      )}
      {editingProduct && (
        <ProductEditModal
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={async () => {
            setEditingProduct(null);
            setNotice("商品资料已更新");
            await reload();
          }}
        />
      )}
      {gemOpen && (
        <GemModal
          gem={editingGem}
          onClose={() => setGemOpen(false)}
          onSaved={async () => {
            setGemOpen(false);
            setNotice(editingGem ? "Gem 已更新" : "新 Gem 已创建");
            await reload();
          }}
        />
      )}
      {tiktokAccountOpen && (
        <TikTokAccountModal
          onClose={() => setTikTokAccountOpen(false)}
          onSave={addTikTokAccount}
        />
      )}
      {previewTask && (
        <PromptDrawer
          task={previewTask}
          onClose={() => setPreviewTask(null)}
          onUpdated={async (message) => {
            setNotice(message);
            setPreviewTask(null);
            await reload();
          }}
        />
      )}
      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

function SeedanceQuotaChoice({ account, onUpdated, onError }: {
  account: SeedanceDesktopState["accountState"]["items"][number];
  onUpdated: (state: SeedanceDesktopState) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function choose(choice: "standard" | "wait") {
    if (choice === "standard" && !await confirmAction(`“${account.name}”的 Fast 额度已不足。今天是否改用消耗更高的 Seedance 2.0 继续排队任务？首选模型不变，跨天会重新尝试 Fast。`)) return;
    setBusy(true);
    try {
      const desktop = desktopBridge();
      if (!desktop?.seedanceDecideFastFallback) throw new Error("请更新 FlowCut 桌面程序");
      onUpdated(await desktop.seedanceDecideFastFallback(account.id, choice, account.quotaDate || ""));
    } catch (error) { onError(error instanceof Error ? error.message : "保存模型选择失败"); }
    finally { setBusy(false); }
  }
  return <section className="seedance-quota-notice" role="status" aria-label={`${account.name} Fast 额度提醒`}>
    <div><b>{account.name}：Fast 额度不足</b><p>该账号等待你的选择，尚未切换成 2.0。{account.quotaReason}</p></div>
    <button type="button" disabled={busy || account.standardExhaustedToday} onClick={() => choose("standard")}>今天改用 2.0（消耗更高）</button>
    <button type="button" disabled={busy} onClick={() => choose("wait")}>等待 Fast 恢复</button>
  </section>;
}

function TikTokAccountModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, archiveDirectory: string) => Promise<void>;
}) {
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    if (!name) {
      setError("请输入 TK 账号名");
      return;
    }
    if (!directory) { setError("请选择视频保存文件夹"); return; }
    setBusy(true);
    setError("");
    try {
      await onSave(name, directory);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "添加 TK 账号失败"
      );
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        !busy && event.target === event.currentTarget && onClose()
      }
    >
      <form className="modal small-modal" onSubmit={submit}>
        <ModalHead
          title="添加 TK 归档账号"
          text="为这个归档名称选择实际保存文件夹，成片会直接下载到所选位置。"
          onClose={onClose}
        />
        <div className="form-body">
          <label>
            归档名称（例如对应的 TK 账号）
            <input
              name="name"
              autoFocus
              maxLength={80}
              placeholder="例如：印尼店铺01"
              disabled={busy}
            />
          </label>
          <label>视频保存文件夹<input value={directory} readOnly placeholder="点击下方按钮选择文件夹" /></label>
          <button type="button" className="secondary" disabled={busy} onClick={async () => {
            try {
              const desktop = desktopBridge();
              if (!desktop?.chooseArchiveDirectory) throw new Error("请在 FlowCut 桌面应用中选择文件夹");
              const folder = await desktop.chooseArchiveDirectory();
              if (folder) { setDirectory(folder); setError(""); }
            } catch (reason) { setError(reason instanceof Error ? reason.message : "选择文件夹失败"); }
          }}>选择保存文件夹</button>
          <p className="account-folder-preview">直接保存到这个文件夹，不再额外添加账号子文件夹。</p>
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "添加中…" : "添加并选择"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Dashboard({
  data,
  selectedProduct,
  selectedGem,
  selectedGeminiAccount,
  selectedTikTokAccount,
  selectedDuration,
  selectedRegion,
  selectedShootingStyle,
  autoQueue,
  busy,
  onProduct,
  onGem,
  onGeminiAccount,
  onTikTokAccount,
  onDuration,
  onRegion,
  onShootingStyle,
  onAddTikTokAccount,
  onChooseArchiveDirectory,
  onAutoQueue,
  onRun,
  onAddProduct,
  onAddGem,
  onPreview,
  onNavigate,
  seedanceRuntime,
}: {
  data: Workspace;
  selectedProduct: string;
  selectedGem: string;
  selectedGeminiAccount: string;
  selectedTikTokAccount: string;
  selectedDuration: number;
  selectedRegion: string;
  selectedShootingStyle: string;
  autoQueue: boolean;
  busy: boolean;
  onProduct: (value: string) => void;
  onGem: (value: string) => void;
  onGeminiAccount: (value: string) => void;
  onTikTokAccount: (value: string) => void;
  onDuration: (value: number) => void;
  onRegion: (value: string) => void;
  onShootingStyle: (value: string) => void;
  onAddTikTokAccount: () => void;
  onChooseArchiveDirectory: () => void;
  onAutoQueue: (value: boolean) => void;
  onRun: (input: {
    mode: "new" | "library";
    files: File[];
    productName: string;
    externalId: string;
  }) => Promise<boolean>;
  onAddProduct: () => void;
  onAddGem: () => void;
  onPreview: (task: Task) => void;
  onNavigate: (page: Page) => void;
  seedanceRuntime: SeedanceRuntime;
}) {
  const [quickFiles, setQuickFiles] = useState<File[]>([]);
  const [productMode, setProductMode] = useState<"new" | "library">("new");
  const [quickDragging, setQuickDragging] = useState(false);
  const [quickError, setQuickError] = useState("");
  const [quickProductName, setQuickProductName] = useState("");
  const [quickExternalId, setQuickExternalId] = useImageProductId(quickFiles);
  const quickPreviews = useMemo(
    () => quickFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [quickFiles]
  );
  const archiveProductId =
    productMode === "new"
      ? quickExternalId.trim()
      : data.products
          .find((product) => product.id === selectedProduct)
          ?.external_id?.trim() || "";

  useEffect(
    () => () => quickPreviews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [quickPreviews]
  );

  function receiveQuickFiles(incoming: File[]) {
    setQuickError("");
    const images = incoming.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setQuickError("请选择商品图片");
      return;
    }
    const oversized = images.find((file) => file.size > 12 * 1024 * 1024);
    if (oversized) {
      setQuickError(`${oversized.name} 超过 12MB`);
      return;
    }
    setQuickFiles((current) => {
      const next = [...current];
      for (const file of images) {
        const duplicate = next.some(
          (item) =>
            item.name === file.name &&
            item.size === file.size &&
            item.lastModified === file.lastModified
        );
        if (!duplicate) next.push(file);
      }
      if (next.length > 12) {
        setQuickError("一个商品最多上传 12 张参考图");
        return current;
      }
      if (next.reduce((total, file) => total + file.size, 0) > 48 * 1024 * 1024) {
        setQuickError("图片总大小不能超过 48MB");
        return current;
      }
      return next;
    });
  }

  return (
    <div className="page-body">
      <section className="hero-grid">
        <div className="composer">
          <div className="composer-head">
            <div>
              <span className="step-kicker">QUICK CREATE</span>
              <h2>把商品图拖进来，直接生成成交视频</h2>
              <p>图片可分多次拖入；点击开始后一次性上传、识别并进入 Gemini → Seedance 流程。</p>
            </div>
            <span className="spark">✦</span>
          </div>
          <div className="quick-product-block">
            <div className="quick-step-title">
              <span><b>01</b> 选择商品来源</span>
              <div>
                <small>上传新商品与选择商品库二选一</small>
                {productMode === "new" && quickFiles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuickFiles([]);
                      setQuickError("");
                    }}
                  >
                    清空图片
                  </button>
                )}
              </div>
            </div>
            <div className="product-source-switch" role="radiogroup" aria-label="商品来源">
              <button
                type="button"
                className={productMode === "new" ? "active" : ""}
                role="radio"
                aria-checked={productMode === "new"}
                onClick={() => setProductMode("new")}
              >
                <b>上传新商品</b>
                <small>图片会自动保存到商品库</small>
              </button>
              <button
                type="button"
                className={productMode === "library" ? "active" : ""}
                role="radio"
                aria-checked={productMode === "library"}
                onClick={() => {
                  setProductMode("library");
                  setQuickError("");
                }}
                disabled={!data.products.length}
              >
                <b>选择已有商品</b>
                <small>{data.products.length ? `商品库共 ${data.products.length} 个` : "商品库暂无商品"}</small>
              </button>
            </div>
            {productMode === "new" ? (
              <div className="quick-product-grid">
                <label
                  className={`quick-upload-zone ${quickDragging ? "dragging" : ""} ${quickFiles.length ? "has-files" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setQuickDragging(true);
                  }}
                  onDragLeave={() => setQuickDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setQuickDragging(false);
                    receiveQuickFiles(Array.from(event.dataTransfer.files));
                  }}
                >
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={busy}
                    onChange={(event) => {
                      receiveQuickFiles(Array.from(event.currentTarget.files || []));
                      event.currentTarget.value = "";
                    }}
                  />
                  {quickPreviews.length ? (
                    <div className="quick-preview-strip">
                      {quickPreviews.slice(0, 5).map((preview, index) => (
                        <span key={`${preview.file.name}-${index}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={preview.url} alt="" />
                          <button
                            type="button"
                            aria-label={`移除 ${preview.file.name}`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setQuickFiles((current) =>
                                current.filter((_, fileIndex) => fileIndex !== index)
                              );
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {quickPreviews.length > 5 && <em>+{quickPreviews.length - 5}</em>}
                    </div>
                  ) : (
                    <span className="quick-upload-icon">＋</span>
                  )}
                  <div>
                    <b>
                      {busy && quickFiles.length
                        ? `正在上传 ${quickFiles.length} 张并创建任务…`
                        : quickFiles.length
                          ? `已暂存 ${quickFiles.length} 张，可继续拖入追加`
                          : "拖拽商品图到这里，或点击批量选择"}
                    </b>
                    <small>
                      {quickFiles.length
                        ? "开始后会保存为一个新商品，并立即出现在商品库"
                        : "JPG / PNG / WebP · 最多 12 张 · 单张不超过 12MB"}
                    </small>
                  </div>
                </label>
                <div className="quick-product-options">
                  <label>
                    <span>商品名称 <small>选填</small></span>
                    <input
                      value={quickProductName}
                      onChange={(event) => setQuickProductName(event.target.value)}
                      placeholder="可留空，由 Gemini 根据图片识别"
                      disabled={busy}
                    />
                  </label>
                  <label>
                    <span>TikTok 商品 ID <small>选填</small></span>
                    <input
                      value={quickExternalId}
                      onChange={(event) => setQuickExternalId(event.target.value)}
                      placeholder="自动识别首张图片文件名中的 ID，可修改"
                      title="仅识别第一张图片；后续追加不会覆盖。清空图片后可识别下一组。"
                      disabled={busy}
                    />
                  </label>
                  <div className="source-explainer">
                    <b>新商品会自动入库</b>
                    <span>Gemini 会根据全部参考图识别品类、外观与可验证卖点。</span>
                  </div>
                </div>
              </div>
            ) : (
              <label className="library-product-picker">
                <span>从商品库选择</span>
                <select value={selectedProduct} onChange={(event) => onProduct(event.target.value)}>
                  {data.products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name?.trim() || "未命名商品"}
                      {product.external_id?.trim()
                        ? ` · ID ${product.external_id.trim()}`
                        : ""}
                      {` · ${product.images.length} 张图`}
                    </option>
                  ))}
                </select>
                {selectedProduct && (
                  <small>
                    {(() => {
                      const product = data.products.find(
                        (item) => item.id === selectedProduct
                      );
                      return `已选择：${product?.name?.trim() || "未命名商品"} · ${
                        product?.images.length || 0
                      } 张商品图`;
                    })()}
                  </small>
                )}
              </label>
            )}
            {quickError && <div className="quick-upload-error">{quickError}</div>}
          </div>
          <div className="creative-config-block">
            <div className="quick-step-title">
              <span><b>02</b> 设置本次视频</span>
              <small>参数只属于当前任务，不会修改 Gem</small>
            </div>
            <div className="creative-settings-grid">
              <label>
                <span>视频秒数</span>
                <select
                  value={selectedDuration}
                  onChange={(event) => onDuration(Number(event.target.value))}
                >
                  {TASK_DURATIONS.map((duration) => (
                    <option key={duration} value={duration}>
                      {duration} 秒{duration === 15 ? "（常用）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>投放地区</span>
                <select
                  value={selectedRegion}
                  onChange={(event) => onRegion(event.target.value)}
                >
                  {TASK_REGIONS.map((region) => (
                    <option key={region} value={region}>{region}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>拍摄风格</span>
                <select
                  value={selectedShootingStyle}
                  onChange={(event) => onShootingStyle(event.target.value)}
                >
                  {SHOOTING_STYLES.map((style) => (
                    <option key={style} value={style}>{style}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="task-config-grid">
            <label>
              <span><b>03</b> 选择 Gem</span>
              <select value={selectedGem} onChange={(event) => onGem(event.target.value)}>
                {!data.gems.length && <option value="">请先创建 Gem</option>}
                {data.gems.map((gem) => (
                  <option key={gem.id} value={gem.id}>{gem.name}</option>
                ))}
              </select>
            </label>
            {data.integrations.geminiMode === "web" && (
                <label>
                  <span><b>04</b> Gemini 账号</span>
                  <select
                    value={selectedGeminiAccount}
                    onChange={(event) => onGeminiAccount(event.target.value)}
                  >
                    <option value="">自动分配空闲账号</option>
                    {(data.integrations.geminiRuntime?.accounts || [])
                      .filter((account) => account.authenticated)
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}{account.busy ? " · 忙碌" : ""}
                        </option>
                      ))}
                  </select>
                </label>
            )}
            <label>
              <span>
                <b>{data.integrations.geminiMode === "web" ? "05" : "04"}</b>{" "}
                归档账号 / 保存文件夹
              </span>
              <div className="tk-account-picker">
                <select
                  value={selectedTikTokAccount}
                  onChange={(event) => onTikTokAccount(event.target.value)}
                >
                  <option value="">
                    {data.tiktokAccounts.length
                      ? "请选择 TK 账号"
                      : "请先添加 TK 账号"}
                  </option>
                  {data.tiktokAccounts.map((account) => (
                    <option key={account.id} value={account.name}>
                      {account.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary"
                  onClick={onAddTikTokAccount}
                >
                  ＋ 添加
                </button>
              </div>
              <button type="button" className="secondary archive-folder-button" onClick={onChooseArchiveDirectory}>选择 / 更改保存文件夹</button>
              <small className="download-destination">
                成片自动保存到：{data.tiktokAccounts.find(account => account.name === selectedTikTokAccount)?.archive_directory || `${data.integrations.seedanceRuntime?.downloadDirectory || "视频下载目录"}\\${selectedTikTokAccount || "账号名"}`}
                \{archiveProductId ? `${archiveProductId}.mp4` : "原视频文件名"}
              </small>
            </label>
            <label>
              <span>
                <b>{data.integrations.geminiMode === "web" ? "06" : "05"}</b>{" "}
                生成方式
              </span>
              <select value={autoQueue ? "auto" : "prompt"} onChange={(event) => onAutoQueue(event.target.value === "auto")}>
                <option value="auto">提示词 + 自动进 Seedance</option>
                <option value="prompt">仅生成提示词</option>
              </select>
            </label>
          </div>
          <div className="composer-foot">
            <div className="chips">
              <span>{selectedDuration} 秒</span>
              <span>9:16</span>
              <span>{selectedShootingStyle}</span>
              <span>{selectedRegion}</span>
            </div>
            <button
              className="primary"
              onClick={async () => {
                const accepted = await onRun({
                    mode: productMode,
                    files: quickFiles,
                    productName: quickProductName,
                    externalId: quickExternalId,
                  });
                  if (accepted && productMode === "new") {
                    setQuickFiles([]);
                    setQuickProductName("");
                    setQuickExternalId("");
                    setQuickError("");
                }
              }}
              disabled={
                busy ||
                (productMode === "new" ? !quickFiles.length : !selectedProduct) ||
                !selectedGem ||
                !selectedTikTokAccount
              }
            >
              {busy ? <><i className="spinner" /> 正在提交…</> : <>加入并发任务 <b>↗</b></>}
            </button>
          </div>
        </div>

        <div className="pipeline-card">
          <span className="step-kicker">PIPELINE</span>
          <h3>自动化链路</h3>
          {[
            [
              "1",
              "Gemini 视觉理解",
              data.integrations.geminiMode === "web"
                ? data.integrations.gemini
                  ? `${data.integrations.geminiRuntime?.accounts?.filter((account) => account.authenticated).length || 0} 个 Gemini 网页账号在线`
                  : data.integrations.geminiRuntime?.online
                    ? "等待登录 Gemini 账号"
                    : "本机网页执行器未连接"
                : data.integrations.gemini
                  ? "API 已配置"
                  : "API 未配置 · 禁止生成",
            ],
            [
              "2",
              "脚本与提示词",
              data.integrations.gemini ? "使用所选 Gem 自动生成" : "等待 Gemini",
            ],
            ["3", "Seedance 2.0", seedanceRuntime.label],
            ["4", "自动下载归档", "所选文件夹 / 商品 ID 或原文件名"],
          ].map((item, index) => (
            <div
              className={`pipeline-step ${
                index === 0 && !data.integrations.gemini
                  ? "blocked"
                  : index === 2 && seedanceRuntime.status !== "ready"
                    ? "blocked"
                    : ""
              }`}
              key={item[1]}
            >
              <span>{item[0]}</span>
              <div><b>{item[1]}</b><small>{item[2]}</small></div>
              {index < 3 && <i />}
            </div>
          ))}
        </div>
      </section>

      <section className="workflow-summary" aria-label="任务概况">
        <span>共 <b>{data.tasks.length}</b> 条任务</span>
        <span>处理中 <b>{data.tasks.filter((task) => !["video_ready", "scheduled", "failed", "seedance_blocked"].includes(task.status)).length}</b></span>
        <span>已完成 <b>{data.tasks.filter((task) => ["video_ready", "scheduled"].includes(task.status)).length}</b></span>
        <button onClick={() => onNavigate("tasks")}>需处理 <b>{data.tasks.filter((task) => ["failed", "seedance_blocked"].includes(task.status)).length}</b> →</button>
      </section>

      <section className="content-grid">
        <div className="panel">
          <div className="panel-head">
            <div><span className="step-kicker">RECENT RUNS</span><h3>最近任务</h3></div>
            <button className="text-button" onClick={() => onNavigate("tasks")}>查看全部 →</button>
          </div>
          {data.tasks.length ? (
            <div className="task-list">
              {data.tasks.slice(0, 5).map((task) => (
                <button className="task-row" key={task.id} onClick={() => onPreview(task)}>
                  <div className="task-thumb">▶</div>
                  <div className="task-copy"><b>{task.product_name || task.title}</b><span>{task.gem_name}</span></div>
                  <div className="task-progress"><span style={{ width: `${Math.max(task.progress, 8)}%` }} /></div>
                  <span className={`status ${task.status}`}>{taskStatusLabel(task)}</span>
                  <time>{formatTime(task.created_at)}</time>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState icon="↗" title="还没有创作任务" text="添加商品后，从上方快速创建开始。" />
          )}
        </div>

        <div className="panel quick-panel">
          <div className="panel-head"><div><span className="step-kicker">LIBRARY</span><h3>快速管理</h3></div></div>
          <button onClick={onAddProduct}><span>▣</span><div><b>添加商品</b><small>上传产品图与卖点</small></div><em>＋</em></button>
          <button onClick={onAddGem}><span>◇</span><div><b>新建 Gem</b><small>定义身份和输出框架</small></div><em>＋</em></button>
          <button onClick={() => onNavigate("settings")}><span>⚙</span><div><b>账号与下载位置</b><small>管理登录和成片保存目录</small></div><em>→</em></button>
        </div>
      </section>
    </div>
  );
}

function parsePromptGroups(value: string): ScriptPromptGroup[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ScriptPipelinePage({
  tasks,
  geminiAccounts,
  defaultGeminiAccountId,
  integrations,
  onReload,
  onNotice,
}: {
  tasks: ScriptPipelineTask[];
  geminiAccounts: Array<{ id: string; name: string; authenticated: boolean; busy?: boolean }>;
  defaultGeminiAccountId: string;
  integrations: Workspace["integrations"];
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [sourceScript, setSourceScript] = useState("");
  const [projectContext, setProjectContext] = useState(() =>
    typeof window === "undefined"
      ? ""
      : window.localStorage.getItem("flowcut-script-project-context") || ""
  );
  const [geminiAccountId, setGeminiAccountId] = useState(
    defaultGeminiAccountId || geminiAccounts.find((account) => account.authenticated)?.id || ""
  );
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string>("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sourceScript.trim().length < 30) return onNotice("请先粘贴完整剧本");
    if (!geminiAccountId) return onNotice("请选择一个已登录的 Gemini 网页账号");
    if (!integrations.gemini || integrations.geminiMode !== "web") {
      return onNotice("剧本提示词流水线需要在线的 Gemini 网页 Pro 执行器");
    }
    setBusy(true);
    try {
      window.localStorage.setItem("flowcut-script-project-context", projectContext);
      await api("/api/script-pipeline", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, sourceScript, projectContext, geminiAccountId }),
      });
      setTitle("");
      setSourceScript("");
      onNotice("剧本已加入流水线，Gemini 将自动完成改写、提取、分镜、合并和优化");
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建剧本任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(message);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      onNotice(message);
    }
  }

  function combinedPromptText(groups: ScriptPromptGroup[]) {
    return groups
      .map((group) => `【视频 ${group.index}｜${group.targetDuration}秒】\n${group.optimizedPrompt || group.rawPrompt}`)
      .join("\n\n====================\n\n");
  }

  function downloadPrompts(task: ScriptPipelineTask, groups: ScriptPromptGroup[]) {
    const blob = new Blob([combinedPromptText(groups)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${task.title.replace(/[\\/:*?"<>|]/g, "-") || "视频提示词"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice("全部提示词已下载为 TXT");
  }

  async function action(id: string, requestedAction: "retry" | "retry_optimization" | "delete") {
    try {
      let actionResult: { alreadyRunning?: boolean; alreadyCompleted?: boolean } | null = null;
      if (requestedAction === "delete") {
        if (!await confirmAction("确认删除这条剧本任务及全部中间结果？")) return;
        await api("/api/script-pipeline", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } else {
        actionResult = await api("/api/script-pipeline", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action: requestedAction }),
        }) as { alreadyRunning?: boolean; alreadyCompleted?: boolean };
      }
      onNotice(
        actionResult?.alreadyCompleted
          ? "任务已经完成，正在刷新成品提示词"
          : actionResult?.alreadyRunning
            ? "Gem 优化已在后台自动运行，无需重复点击"
            : requestedAction === "retry"
          ? "已保留成功结果，从失败步骤继续"
          : requestedAction === "retry_optimization"
            ? "已保留前四步，只重新执行 Gem 优化"
            : "剧本任务已删除"
      );
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <div className="page-body script-page">
      <PageIntro
        title="全自动剧本提示词"
        text="粘贴一集剧本，自动完成格式化改写、角色场景提取、完整分镜、25秒内组合，再按 Seedance 2.5 官方写法优化为可复制提示词。"
      />
      <form className="script-builder" onSubmit={submit}>
        <div className="script-builder-head">
          <div><span className="step-kicker">SCRIPT TO PROMPT</span><h3>把剧本直接变成视频提示词</h3><p>只生成提示词；生图和生视频仍由你手动完成。</p></div>
          <div className="locked-gem-card"><span>内置 Gem · 已锁定</span><b>Seedance 2.5｜官方写法视频提示词工程师</b><small>单组原始分镜≤25秒，超过20秒自动压到20秒且不拆段</small></div>
        </div>
        <div className="script-input-grid">
          <label className="script-source"><span>本集原始剧本</span><textarea value={sourceScript} onChange={(event) => setSourceScript(event.target.value)} placeholder="在这里粘贴小说原文、短剧剧本或广告脚本……" /></label>
          <div className="script-side-fields">
            <label><span>任务名称 <small>选填</small></span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="默认取剧本第一行" /></label>
            <label><span>Gemini 网页账号</span><select value={geminiAccountId} onChange={(event) => setGeminiAccountId(event.target.value)}><option value="">请选择已登录账号</option>{geminiAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.authenticated}>{account.name}{account.authenticated ? account.busy ? "（忙碌）" : "" : "（未登录）"}</option>)}</select></label>
            <label className="project-context"><span>项目已有角色 / 场景 <small>选填，会在本机记住</small></span><textarea value={projectContext} onChange={(event) => setProjectContext(event.target.value)} placeholder="例如：已有角色零一、零二；已有场景房间@日间……用于跨集去重。" /></label>
          </div>
        </div>
        <div className="script-pipeline-preview">
          {["剧本改写", "角色场景", "完整分镜", "≤25秒组合", "Gem优化"].map((label, index) => <div key={label}><span>{index + 1}</span><b>{label}</b></div>)}
          <button className="primary" type="submit" disabled={busy}>{busy ? "正在加入队列…" : "开始全自动生成 ↗"}</button>
        </div>
      </form>

      <section className="script-task-section">
        <div className="section-title"><div><span className="eyebrow">SCRIPT RUNS</span><h3>剧本任务</h3></div><span>{tasks.length} 条</span></div>
        {!tasks.length ? (
          <EmptyState icon="文" title="还没有剧本任务" text="粘贴一集剧本，系统会把最终可复制的视频提示词送到这里。" />
        ) : tasks.map((task) => {
          const isExpanded = expanded === task.id;
          const optimizedGroups = parsePromptGroups(task.optimized_groups_json);
          const rawGroups = parsePromptGroups(task.raw_groups_json);
          const hasFinalPrompts = optimizedGroups.length > 0;
          const stages = [
            { label: "剧本改写", statuses: ["rewriting"] },
            { label: "角色场景", statuses: ["extracting"] },
            { label: "完整分镜", statuses: ["storyboarding"] },
            { label: "组合", statuses: ["grouping"] },
            { label: "Gem优化", statuses: ["optimization_queued", "optimizing"] },
          ];
          const activeIndex = task.status === "rewrite_queued" ? -1 : task.status === "completed" ? stages.length : stages.findIndex((stage) => stage.statuses.includes(task.status));
          return (
            <article className="script-task-card" key={task.id}>
              <button type="button" className="script-task-summary" onClick={() => setExpanded(isExpanded ? "" : task.id)}>
                <div><b>{task.title}</b><span>{formatTime(task.created_at)} · {hasFinalPrompts ? `${optimizedGroups.length} 条最终提示词` : statusLabels[task.status] || task.status}</span></div>
                <div className="remix-progress"><i style={{ width: `${task.progress}%` }} /></div>
                <span className={`status ${task.status}`}>{statusLabels[task.status] || task.status}</span><em>{isExpanded ? "收起" : "详情"}</em>
              </button>
              <div className="script-stage-chain">
                {stages.map((stage, index) => <div className={activeIndex > index ? "done" : activeIndex === index ? "active" : "waiting"} key={stage.label}><span>{activeIndex > index ? "✓" : index + 1}</span><b>{stage.label}</b></div>)}
              </div>
              {task.error && <div className="warning-box">{task.error}</div>}
              {!hasFinalPrompts && rawGroups.length > 0 && ["optimization_queued", "optimizing"].includes(task.status) && (
                <div className="optimization-resume">
                  <span>前四步已保存，Gem 正在后台自动优化；完成后本页会自动显示并提供复制按钮。</span>
                  <b>{task.status === "optimization_queued" ? "自动排队中" : `处理中 ${task.progress}%`}</b>
                </div>
              )}
              {hasFinalPrompts && (
                <div className="final-prompt-list featured">
                  <div className="final-prompt-toolbar">
                    <div><span>READY TO COPY</span><h4>最终可复制提示词 · {optimizedGroups.length} 条</h4></div>
                    <div>
                      <button type="button" onClick={() => downloadPrompts(task, optimizedGroups)}>下载 TXT</button>
                      <button className="copy-primary" type="button" onClick={() => copyText(combinedPromptText(optimizedGroups), "全部提示词已复制")}>复制全部</button>
                    </div>
                  </div>
                  {optimizedGroups.map((group) => (
                    <article key={group.index}>
                      <div>
                        <b>视频 {group.index}</b>
                        <span>分镜 {group.shotNumbers?.join("、") || "—"} · 原始 {group.rawDuration}秒 → 输出 {group.targetDuration}秒</span>
                        <button className="copy-primary" type="button" onClick={() => copyText(group.optimizedPrompt || group.rawPrompt, `视频 ${group.index} 提示词已复制`)}>复制本条</button>
                      </div>
                      <textarea readOnly value={group.optimizedPrompt || group.rawPrompt} onFocus={(event) => event.currentTarget.select()} aria-label={`视频 ${group.index} 最终提示词`} />
                    </article>
                  ))}
                </div>
              )}
              {isExpanded && (
                <div className="script-task-detail">
                  <details><summary>① 格式化剧本</summary><pre>{task.rewritten_script || "等待 Gemini 改写……"}</pre></details>
                  <details><summary>② 角色与场景 JSON</summary><pre>{task.extraction_json || "等待提取……"}</pre></details>
                  <details><summary>③ 完整分镜 JSON</summary><pre>{task.storyboard_json || "等待拆分镜……"}</pre></details>
                  <details><summary>④ 自动组合的未优化提示词</summary><pre>{task.raw_groups_json || "等待按时长组合……"}</pre></details>
                  <div className="row-actions">{rawGroups.length > 0 && !hasFinalPrompts && task.status === "failed" ? <button type="button" onClick={() => action(task.id, "retry_optimization")}>继续 Gem 优化</button> : task.status === "failed" ? <button type="button" onClick={() => action(task.id, "retry")}>从失败步骤继续</button> : null}<button className="danger-text" type="button" onClick={() => action(task.id, "delete")}>删除</button></div>
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function ReferenceRemixPage({
  tasks,
  settings,
  geminiAccounts,
  defaultGeminiAccountId,
  tiktokAccounts,
  integrations,
  onReload,
  onNotice,
}: {
  tasks: ReferenceRemixTask[];
  settings: { duration: number; region: string };
  geminiAccounts: Array<{ id: string; name: string; authenticated: boolean; busy?: boolean }>;
  defaultGeminiAccountId: string;
  tiktokAccounts: TikTokAccount[];
  integrations: Workspace["integrations"];
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [video, setVideo] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [images, setImages] = useState<File[]>([]);
  const [region, setRegion] = useState(settings.region || "马来西亚");
  const [duration, setDuration] = useState(Number(settings.duration || 15));
  const [productName, setProductName] = useState("");
  const [externalId, setExternalId] = useImageProductId(images);
  const [saveToLibrary, setSaveToLibrary] = useState(false);
  const [autoQueue, setAutoQueue] = useState(true);
  const [geminiAccountId, setGeminiAccountId] = useState(
    defaultGeminiAccountId || geminiAccounts.find((account) => account.authenticated)?.id || ""
  );
  const [tiktokAccountName, setTikTokAccountName] = useState(tiktokAccounts[0]?.name || "");
  const [busy, setBusy] = useState(false);
  const [dragTarget, setDragTarget] = useState<"video" | "images" | "">("");
  const [expanded, setExpanded] = useState<string>("");

  const videoPreview = useMemo(() => (video ? URL.createObjectURL(video) : ""), [video]);
  const imagePreviews = useMemo(
    () => images.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [images]
  );
  useEffect(() => {
    return () => {
      if (videoPreview) URL.revokeObjectURL(videoPreview);
      imagePreviews.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [videoPreview, imagePreviews]);

  function chooseVideo(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      onNotice("请上传 MP4、MOV 或 WebM 对标视频");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      onNotice("对标视频不能超过 100MB");
      return;
    }
    setVideo(file);
    setVideoDuration(0);
  }

  function appendImages(files: File[]) {
    const valid = files.filter((file) => file.type.startsWith("image/"));
    if (valid.length !== files.length) onNotice("已忽略非图片文件");
    if (valid.some((file) => file.size > 12 * 1024 * 1024)) {
      onNotice("单张产品图片不能超过 12MB");
      return;
    }
    setImages((current) => {
      const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      const appended = valid.filter(
        (file) => !known.has(`${file.name}:${file.size}:${file.lastModified}`)
      );
      if (current.length + appended.length > 12) {
        onNotice("产品图片最多 12 张");
      }
      return [...current, ...appended].slice(0, 12);
    });
  }

  async function saveDefaults() {
    try {
      await api("/api/reference-remix", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ duration, region }),
      });
      onNotice(`默认参数已保存：${region} · ${duration}秒`);
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存默认参数失败");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!video) return onNotice("请上传一条对标视频");
    if (!images.length) return onNotice("请上传产品图片");
    if (videoDuration > 60) return onNotice("对标视频超过 60 秒，请先裁剪后再上传");
    if (!geminiAccountId) return onNotice("请选择一个已登录的 Gemini 网页账号");
    if (!tiktokAccountName) return onNotice("请先在创作中心添加 TK 归档账号");
    if (!integrations.gemini || integrations.geminiMode !== "web") {
      return onNotice("爆款复刻需要在线的 Gemini 网页 Pro 执行器");
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("video", video, video.name);
      images.forEach((file) => form.append("images", file, file.name));
      form.set("duration", String(duration));
      form.set("region", region.trim());
      form.set("productName", productName.trim());
      form.set("externalId", externalId.trim());
      form.set("saveToLibrary", String(saveToLibrary));
      form.set("autoQueue", String(autoQueue));
      form.set("geminiAccountId", geminiAccountId);
      form.set("tiktokAccountName", tiktokAccountName);
      await api("/api/reference-remix", { method: "POST", body: form });
      setVideo(null);
      setVideoDuration(0);
      setImages([]);
      setProductName("");
      setExternalId("");
      onNotice("爆款复刻任务已加入队列；两轮 Gemini 会在同一个对话中完成");
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建爆款复刻任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, requestedAction: "retry" | "queue" | "delete") {
    try {
      if (requestedAction === "delete") {
        if (!await confirmAction("确认删除这条复刻任务及其临时素材？已保存到商品库的副本不会删除。")) return;
        await api("/api/reference-remix", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
      } else {
        await api("/api/reference-remix", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, action: requestedAction }),
        });
      }
      onNotice(
        requestedAction === "retry"
          ? "任务已从第一轮重新开始"
          : requestedAction === "queue"
            ? "已提交 Seedance 队列"
            : "复刻任务已删除"
      );
      await onReload();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败");
    }
  }

  return (
    <div className="page-body remix-page">
      <PageIntro
        title="爆款视频复刻"
        text="先让 Gemini 拆解对标视频，再在同一对话上传产品图完成改编，最终自动送入 Seedance。该模块与普通 Gem 创作完全隔离。"
      />
      <form className="remix-builder" onSubmit={submit}>
        <div className="remix-builder-head">
          <div>
            <span className="step-kicker">REFERENCE REMIX</span>
            <h3>一条对标视频 + 一组产品图</h3>
            <p>建议对标视频控制在 20 秒内；最长接受 60 秒、100MB。</p>
          </div>
          <div className="locked-gem-card">
            <span>内置 Gem · 已锁定</span>
            <b>爆款视频结构复刻智能体</b>
            <small>仅本模块使用，不会出现在普通 Gem 列表</small>
          </div>
        </div>

        <div className="remix-upload-grid">
          <label
            className={`remix-drop ${dragTarget === "video" ? "dragging" : ""} ${video ? "has-file" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragTarget("video"); }}
            onDragLeave={() => setDragTarget("")}
            onDrop={(event: DragEvent<HTMLLabelElement>) => {
              event.preventDefault();
              setDragTarget("");
              chooseVideo(event.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(event) => chooseVideo(event.target.files?.[0])}
            />
            {videoPreview ? (
              <video
                src={videoPreview}
                controls
                onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
              />
            ) : (
              <div className="remix-drop-empty"><b>01</b><strong>拖入对标爆款视频</strong><span>MP4 / MOV / WebM · 建议 ≤20秒</span></div>
            )}
            {video && (
              <div className="remix-file-caption">
                <b>{video.name}</b>
                <span>{(video.size / 1024 / 1024).toFixed(1)}MB{videoDuration ? ` · ${videoDuration.toFixed(1)}秒` : ""}</span>
                {videoDuration > 20 && <em>可用，但建议先压缩到 20 秒内</em>}
              </div>
            )}
          </label>

          <label
            className={`remix-drop product-drop ${dragTarget === "images" ? "dragging" : ""} ${images.length ? "has-file" : ""}`}
            onDragOver={(event) => { event.preventDefault(); setDragTarget("images"); }}
            onDragLeave={() => setDragTarget("")}
            onDrop={(event: DragEvent<HTMLLabelElement>) => {
              event.preventDefault();
              setDragTarget("");
              appendImages(Array.from(event.dataTransfer.files));
            }}
          >
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={(event) => appendImages(Array.from(event.target.files || []))}
            />
            {!images.length && (
              <div className="remix-drop-empty"><b>02</b><strong>拖入你的产品图片</strong><span>最多 12 张 · 可分多次继续添加</span></div>
            )}
            {imagePreviews.length > 0 && (
              <div className="remix-image-strip">
                {imagePreviews.map((item, index) => (
                  <span key={`${item.file.name}-${item.file.lastModified}`}>
                    <img src={item.url} alt={item.file.name} />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        setImages((current) => current.filter((_, itemIndex) => itemIndex !== index));
                      }}
                    >×</button>
                  </span>
                ))}
                <em>{images.length}/12 张</em>
              </div>
            )}
          </label>
        </div>

        <div className="remix-config-grid">
          <label><span>投放地区</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="例如：马来西亚" /></label>
          <label><span>视频秒数</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={15}>15 秒</option></select></label>
          <button className="secondary remix-save-default" type="button" onClick={saveDefaults}>保存地区与秒数为默认</button>
          <label><span>商品名称 <small>选填</small></span><input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="留空则由 Gemini 识别" /></label>
          <label><span>商品 ID <small>选填</small></span><input value={externalId} onChange={(event) => setExternalId(event.target.value)} placeholder="自动识别首张图片文件名中的 ID，可修改" /></label>
          <label><span>Gemini 网页账号</span><select value={geminiAccountId} onChange={(event) => setGeminiAccountId(event.target.value)}><option value="">请选择已登录账号</option>{geminiAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.authenticated}>{account.name}{account.authenticated ? account.busy ? "（忙碌）" : "" : "（未登录）"}</option>)}</select></label>
          <label><span>TK 归档账号</span><select value={tiktokAccountName} onChange={(event) => setTikTokAccountName(event.target.value)}><option value="">请选择归档文件夹</option>{tiktokAccounts.map((account) => <option key={account.id} value={account.name}>{account.name}</option>)}</select></label>
        </div>
        <div className="remix-options">
          <label><input type="checkbox" checked={saveToLibrary} onChange={(event) => setSaveToLibrary(event.target.checked)} /> 同时把产品图保存到普通商品库</label>
          <label><input type="checkbox" checked={autoQueue} onChange={(event) => setAutoQueue(event.target.checked)} /> 提示词完成后自动进入 Seedance</label>
          <button className="primary" type="submit" disabled={busy}>{busy ? "正在上传…" : "开始自动复刻 ↗"}</button>
        </div>
      </form>

      <div className="remix-task-section">
        <div className="section-title"><div><span className="eyebrow">REMIX RUNS</span><h3>复刻任务</h3></div><span>{tasks.length} 条</span></div>
        {!tasks.length ? (
          <EmptyState icon="◎" title="还没有复刻任务" text="上传一条对标视频和产品图，系统会自动跑完双轮对话与视频生成。" />
        ) : tasks.map((task) => {
          const activeStage = task.status === "reference_queued" ? 1 : ["reference_analyzing", "product_adapting"].includes(task.status) ? 2 : ["prompt_ready", "seedance_blocked"].includes(task.status) ? 3 : ["video_queued", "video_generating"].includes(task.status) ? 4 : task.status === "video_ready" ? 5 : 0;
          const isExpanded = expanded === task.id;
          return (
            <article className="remix-task-card" key={task.id}>
              <button className="remix-task-summary" type="button" onClick={() => setExpanded(isExpanded ? "" : task.id)}>
                <div><b>{task.title}</b><span>{task.duration}秒 · {task.region} · TK：{task.tiktok_account_name}</span></div>
                <div className="remix-progress"><i style={{ width: `${task.progress}%` }} /></div>
                <span className={`status ${task.status}`}>{statusLabels[task.status] || task.status}</span>
                <em>{isExpanded ? "收起" : "详情"}</em>
              </button>
              <div className="remix-stage-chain">
                {["素材已保存", "拆解对标视频", "同对话换产品", "Seedance 生成", "成片归档"].map((label, index) => (
                  <div className={activeStage > index + 1 ? "done" : activeStage === index + 1 ? "active" : "waiting"} key={label}><span>{activeStage > index + 1 ? "✓" : index + 1}</span><b>{label}</b></div>
                ))}
              </div>
              {task.error && <div className="warning-box">{task.error}</div>}
              {isExpanded && (
                <div className="remix-task-detail">
                  <div><h4>第一轮 · 对标结构分析</h4><pre>{task.reference_analysis || "等待 Gemini 完成第一轮分析…"}</pre></div>
                  <div><h4>第二轮 · 最终 Seedance 提示词</h4><pre>{task.prompt || "等待同一对话上传产品图并继续改编…"}</pre></div>
                  {task.download_path && <p className="download-note">成片已归档：{task.download_path}</p>}
                  <div className="row-actions">
                    {task.prompt && <button type="button" onClick={() => navigator.clipboard.writeText(task.prompt).then(() => onNotice("最终提示词已复制"))}>复制最终提示词</button>}
                    {task.status === "prompt_ready" && <button type="button" onClick={() => action(task.id, "queue")}>提交 Seedance</button>}
                    {["failed", "seedance_blocked"].includes(task.status) && <button type="button" onClick={() => action(task.id, "retry")}>从第一轮重试</button>}
                    <button className="danger-text" type="button" onClick={() => action(task.id, "delete")}>删除</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PickImportPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="pick-import-panel">
    <div><b>从 FastMoss 送入商品</b><p>商品 ID、名称和参考图一起导入。扫码添加橱窗后，在创作中心选择商品即可继续。</p></div>
    <div className="row-actions">
      <button className="secondary" onClick={async () => {
        try { const desktop = desktopBridge(); if (!desktop?.publisherOpenExtension) throw new Error("请在 FlowCut 桌面应用中使用"); await desktop.publisherOpenExtension(); setMessage("已打开插件目录。在浏览器扩展管理中选择“加载已解压的扩展”，加载这个文件夹；以后直接在选品插件点击“发送所选商品”。"); }
        catch (error) { setMessage(error instanceof Error ? error.message : "打开失败"); }
      }}>打开选品插件目录</button>
      <label className="secondary import-file-button">{busy ? "正在导入…" : "导入选品 JSON"}<input type="file" accept=".json,application/json" disabled={busy} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        setBusy(true);
        try { const desktop = desktopBridge(); if (!desktop?.publisherImport) throw new Error("请在 FlowCut 桌面应用中使用"); const parsed = JSON.parse(await file.text()); const result = await desktop.publisherImport(Array.isArray(parsed) ? parsed : parsed.rows); const missing = result.results.filter(r => r.warning).length; setMessage(`已处理 ${result.total} 件商品，新增 ${result.added} 件。${missing ? `${missing} 件商品需点击“编辑”补充图片。` : ""}`); await onImported(); }
        catch (error) { setMessage(error instanceof Error ? error.message : "导入失败"); }
        finally { setBusy(false); }
      }} /></label>
    </div>
    {message && <p className="integration-message" role="status">{message}</p>}
  </section>;
}

function PublisherPage() {
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const desktop = desktopBridge();
    if (!desktop?.publisherStart) { setError("请在 FlowCut 桌面应用中打开发布管理"); return; }
    setError("");
    void desktop.publisherStart().then(value => { if (alive) setOrigin(value.origin); }).catch(value => { if (alive) setError(value instanceof Error ? value.message : "发布管理启动失败"); });
    return () => { alive = false; };
  }, [attempt]);
  return <div className="page-body publisher-page">
    <PageIntro title="检查成片后，统一发布" text="在任务详情确认成片并送入发布目录。发布账号名称需与制作时的 TK 归档账号一致；核对浏览器环境和发布时间后，再启动自动发布。" />
    {error ? <div className="warning-box">{error}<button className="secondary" onClick={() => setAttempt(attempt + 1)}>重试连接</button></div> : origin ? <iframe className="publisher-frame" src={origin} title="FlowCut 发布管理" /> : <p>正在打开本机发布管理…</p>}
  </div>;
}

function PublishReview({ task }: { task: Task }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return <section className="publish-review">
    <b>送入发布管理</b>
    <p>账号：{task.tiktok_account_name || "未设置"} · 商品 ID：{task.product_external_id || "未填写"}</p>
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已检查成片，且已扫码将此商品添加到这个账号的橱窗</label>
    <button className="primary" disabled={!confirmed || busy} onClick={async () => {
      setBusy(true);
      try { const desktop = desktopBridge(); if (!desktop?.publisherRelease) throw new Error("请在 FlowCut 桌面应用中使用"); const result = await desktop.publisherRelease(task.id, confirmed); setMessage(result.alreadyReleased ? "这条成片已经放行，不会重复入队。" : "已按商品 ID 命名并送入待发布目录。请在“发布管理”核对后启动发布。"); }
      catch (error) { setMessage(error instanceof Error ? error.message : "送入发布管理失败"); }
      finally { setBusy(false); }
    }}>{busy ? "正在处理…" : "确认成片并送去发布"}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}

function ProductsPage({
  products,
  onImported,
  onAdd,
  onEdit,
  onDelete,
}: {
  products: Product[];
  onImported: () => Promise<void>;
  onAdd: () => void;
  onEdit: (product: Product) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const dayOf = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "日期未知" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const days = [...new Set(products.map(p => dayOf(p.created_at)))].sort().reverse();
  const groups = new Map<string, Product[]>();
  for (const product of [...products].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const day = dayOf(product.created_at);
    if (selectedDay && day !== selectedDay) continue;
    if (query && !`${product.name} ${product.external_id}`.toLowerCase().includes(query.toLowerCase())) continue;
    groups.set(day, [...(groups.get(day) || []), product]);
  }
  return (
    <div className="page-body">
      <PageIntro title="商品素材库" text="保存商品图、商品 ID 与真实卖点，Gemini 会把它们作为每次创作的事实来源。" action="添加商品" onAction={onAdd} />
      <PickImportPanel onImported={onImported} />
      <div className="product-library-toolbar">
        <input aria-label="搜索商品库" placeholder="搜索商品名称或商品 ID" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="添加日期" value={selectedDay} onChange={event => setSelectedDay(event.target.value)}><option value="">全部添加日期</option>{days.map(day => <option key={day} value={day}>{day}</option>)}</select>
        <span>共 {products.length} 件商品 · 按添加日期留存</span>
      </div>
      {products.length ? (
        <div className="product-date-groups">
          {!groups.size && <p>没有匹配的商品</p>}
          {[...groups].map(([day, items]) => <section className="product-date-group" key={day}>
          <h3>{day}<small>{items.length} 件商品</small></h3>
          <div className="product-grid">
          {items.map((product) => (
            <article className="product-card" key={product.id}>
              <div className="product-image">
                {product.images?.length || product.image_key ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media?key=${encodeURIComponent(
                      product.images?.[0]?.object_key || product.image_key || ""
                    )}`}
                    alt={product.name || "商品参考图"}
                  />
                ) : <span>NO IMAGE</span>}
                {product.images?.length > 1 && (
                  <b className="image-count">＋{product.images.length - 1}</b>
                )}
              </div>
              <div className="product-info">
                <small>
                  商品 ID：{product.external_id?.trim() || "未填写"}
                </small>
                <time className="product-added-at">添加于 {formatTime(product.created_at)}</time>
                <h3>{product.name?.trim() || "未命名商品"}</h3>
                <p>
                  {product.features?.trim() ||
                    "未填写卖点；生成时将由 Gemini 结合全部图片识别。"}
                </p>
                <div className="product-card-foot">
                  <span>{product.images?.length || 0} 张商品图</span>
                  <div className="product-card-actions">
                    <button onClick={() => onEdit(product)}>编辑</button>
                    <button
                      className="danger-text"
                      onClick={() => onDelete(product.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
          </div></section>)}
        </div>
      ) : <EmptyState icon="▣" title="商品库还是空的" text="上传第一张产品图，之后就可以选择 Gem 自动创作。" action="添加商品" onAction={onAdd} />}
    </div>
  );
}

function GemsPage({
  gems,
  onAdd,
  onEdit,
  onDelete,
}: {
  gems: Gem[];
  onAdd: () => void;
  onEdit: (gem: Gem) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="page-body">
      <PageIntro title="Gem 模板中心" text="每个 Gem 都是一套独立的身份、规则与输出框架。运行任务前随时选择、更改或新建。" action="新建 Gem" onAction={onAdd} />
      <div className="gem-grid">
        {gems.map((gem, index) => (
          <article className="gem-card" key={gem.id}>
            <div className={`gem-orb orb-${index % 4}`}>◇</div>
            <div className="gem-tags">
              {gem.is_default ? <span>内置模板</span> : <span>自定义</span>}
            </div>
            <h3>{gem.name}</h3>
            <p>{gem.description || "未填写模板简介"}</p>
            <div className="gem-meta">
              <span>{gem.content.length.toLocaleString()} 字指令</span>
              <span>更新于 {formatTime(gem.updated_at)}</span>
            </div>
            <div className="gem-actions">
              <button className="secondary" onClick={() => onEdit(gem)}>编辑指令</button>
              <button className="danger-text" onClick={() => onDelete(gem.id)}>删除</button>
            </div>
          </article>
        ))}
        <button className="gem-add-card" onClick={onAdd}><span>＋</span><b>创建新的 Gem</b><small>从身份、规则和输出框架开始</small></button>
      </div>
    </div>
  );
}

function TasksPage({
  tasks,
  geminiRuntime,
  onPreview,
  onDelete,
  onClearCompleted,
  onClearAll,
}: {
  tasks: Task[];
  geminiRuntime?: Workspace["integrations"]["geminiRuntime"];
  onPreview: (task: Task) => void;
  onDelete: (id: string) => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const completed = (task: Task) => ["video_ready", "scheduled"].includes(task.status);
  const failed = (task: Task) => ["failed", "seedance_blocked"].includes(task.status);
  const visibleTasks = tasks.filter((task) => (
    filter === "all" || (filter === "completed" ? completed(task) : filter === "attention" ? failed(task) : !completed(task) && !failed(task))
  ) && `${task.product_name || task.title} ${task.tiktok_account_name || ""} ${task.product_external_id || ""}`.toLowerCase().includes(query.toLowerCase()));
  const progressText = (task: Task) => {
    if (["prompt_queued", "prompt_generating"].includes(task.status)) {
      if (!geminiRuntime?.online) return "Gemini 执行器离线，请在账号与设置中检查";
      const active = geminiRuntime.activeJobs?.find((job) => job.taskId === task.id);
      if (active) return `${active.accountName || "Gemini"} · ${active.stage || "正在处理"}`;
      if (!geminiRuntime.queueRunning) return "队列已暂停，请在账号与设置中继续";
      if (!geminiRuntime.authenticated) return "等待 Gemini 账号登录";
      return task.error || "排队中，账号空闲后自动开始";
    }
    return task.download_error || task.error || "";
  };
  return (
    <div className="page-body">
      <PageIntro
        title="自动化任务队列"
        text="每个任务都保留完整提示词和执行状态，失败后可以从断点继续。"
        action="清除已完成"
        actionIcon="✓"
        actionTone="secondary"
        onAction={onClearCompleted}
      />
      <button className="secondary danger-text clear-all-tasks" onClick={onClearAll}>清除全部任务</button>
      <div className="task-toolbar">
        <div role="group" aria-label="筛选任务">
          {[["all", "全部"], ["active", "进行中"], ["attention", "需处理"], ["completed", "已完成"]].map(([value, label]) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>
          ))}
        </div>
        <input aria-label="搜索任务" placeholder="搜索商品、商品 ID 或 TK 账号" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="table-panel tasks-table">
        <div className="table-head"><span>商品与账号</span><span>制作进度</span><span>当前状态</span><span>操作</span></div>
        {visibleTasks.map((task) => (
          <div className="table-row" key={task.id}>
            <button className="task-name" onClick={() => onPreview(task)}>
              <b>{task.product_name || task.title}</b>
              <small>
                {task.gem_name}
                {` · ${task.duration || DEFAULT_TASK_DURATION}秒 · ${
                  task.region || DEFAULT_TASK_REGION
                }`}
                {task.tiktok_account_name
                  ? ` · TK：${task.tiktok_account_name}`
                  : ""}
              </small>
              <small>{task.product_external_id ? `ID ${task.product_external_id} · ` : ""}{formatTime(task.created_at)}</small>
            </button>
            <TaskChain task={task} compact />
            <div className="task-live-status"><span className={`status ${task.status}`}>{taskStatusLabel(task)}</span><small>{progressText(task)}</small></div>
            <div className="row-actions"><button onClick={() => onPreview(task)}>{failed(task) ? "查看 / 继续" : "查看"}</button><button onClick={() => onDelete(task.id)}>×</button></div>
          </div>
        ))}
        {!!tasks.length && !visibleTasks.length && <EmptyState icon="↗" title="没有匹配的任务" text="换一个筛选条件或搜索词。" />}
        {!tasks.length && <EmptyState icon="↗" title="任务队列为空" text="从创作中心选择商品和 Gem 后启动第一条任务。" />}
      </div>
    </div>
  );
}

function CalendarPage({
  schedules,
  tasks,
  onSaved,
  onDelete,
}: {
  schedules: Schedule[];
  tasks: Task[];
  onSaved: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      setOpen(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-body">
      <PageIntro title="发布日历" text="把已经生成的成片安排到账号与时间。正式发布执行器接入后会自动消费队列。" action="添加排期" onAction={() => setOpen(true)} />
      <div className="calendar-layout">
        <div className="calendar-panel">
          <div className="calendar-title"><button>‹</button><h3>发布计划</h3><button>›</button></div>
          {schedules.length ? schedules.map((item) => (
            <article className="schedule-row" key={item.id}>
              <div className="date-tile"><b>{new Date(item.scheduled_at).getDate()}</b><span>{new Intl.DateTimeFormat("zh-CN", { month: "short" }).format(new Date(item.scheduled_at))}</span></div>
              <div><h4>{item.task_title || "视频发布任务"}</h4><p>{item.account_name} · {formatTime(item.scheduled_at)}</p><small>{item.caption || "无发布文案"}</small></div>
              <span className="status scheduled">已排期</span>
              <button className="delete-round" onClick={() => onDelete(item.id)}>×</button>
            </article>
          )) : <EmptyState icon="◫" title="还没有发布计划" text="生成提示词或成片后，可先在这里安排账号和时间。" action="添加排期" onAction={() => setOpen(true)} />}
        </div>
        <aside className="calendar-note">
          <span>发布策略</span>
          <h3>先审核，再自动发</h3>
          <p>自然账号发布需要遵守 TikTok 的用户确认要求。工作台保留预览与排期确认，接入广告 API 后可扩展到广告素材自动投放。</p>
          <ul><li>发布前预览成片</li><li>账号与隐私设置确认</li><li>失败状态自动回传</li></ul>
        </aside>
      </div>
      {open && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <form className="modal small-modal" onSubmit={submit}>
            <ModalHead title="添加发布排期" text="先保存计划，连接 TikTok 执行器后即可自动消费。" onClose={() => setOpen(false)} />
            <div className="form-body">
              <label>视频任务<select name="taskId" required>{tasks.map((task) => <option value={task.id} key={task.id}>{task.product_name || task.title}</option>)}</select></label>
              <label>TikTok 账号<input name="accountName" placeholder="@brand_indonesia" required /></label>
              <label>发布时间<input name="scheduledAt" type="datetime-local" required /></label>
              <label>发布文案<textarea name="caption" rows={4} placeholder="自然口语文案与标签，可在发布前修改" /></label>
            </div>
            <div className="modal-foot"><button type="button" className="secondary" onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存排期"}</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function SettingsPage({
  integrations,
  onUpdated,
  onNotice,
}: {
  integrations: Workspace["integrations"];
  onUpdated: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [settings, setSettings] = useState<{
    gemini: {
      mode: "web" | "api";
      model: string;
      baseUrl: string;
      secretConfigured: boolean;
      runtime?: Workspace["integrations"]["geminiRuntime"];
    };
    seedance: {
      mode: "local-api" | "webhook" | "async-api";
      endpoint: string;
      healthUrl: string;
      authHeader: string;
      authScheme: string;
      responseJobIdPath: string;
      responseOutputPath: string;
      statusUrlTemplate: string;
      statusPath: string;
      outputPath: string;
      successValue: string;
      failureValue: string;
      secretConfigured: boolean;
      runtime?: {
        online: boolean;
        authenticated?: boolean;
        queueRunning?: boolean;
        version?: string;
        maxConcurrent?: number;
      };
    };
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [accountName, setAccountName] = useState("");
  const [seedanceAccountName, setSeedanceAccountName] = useState("");
  const [seedanceDesktop, setSeedanceDesktop] =
    useState<SeedanceDesktopState | null>(null);
  useEffect(() => desktopBridge()?.onState?.(state => {
    if (state.seedance) setSeedanceDesktop(state.seedance);
  }), []);
  const [localSeedanceConfigured, setLocalSeedanceConfigured] = useState(false);
  const [localSeedanceVerified, setLocalSeedanceVerified] = useState(false);
  const [geminiMode, setGeminiMode] = useState<"web" | "api">("web");
  const [seedanceMode, setSeedanceMode] = useState<
    "local-api" | "webhook" | "async-api"
  >("local-api");

  const load = useCallback(async () => {
    const result = (await api("/api/settings")) as unknown as NonNullable<
      typeof settings
    >;
    setSettings(result);
    setGeminiMode(result.gemini.mode);
    setSeedanceMode(result.seedance.mode);
    setLocalSeedanceConfigured(result.seedance.secretConfigured);
    setLocalSeedanceVerified(
      Boolean(
        result.seedance.runtime?.online &&
          result.seedance.runtime?.authenticated &&
          result.seedance.runtime?.queueRunning
      )
    );
    const desktop = desktopBridge();
    if (desktop?.seedanceState) {
      setSeedanceDesktop(await desktop.seedanceState());
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load().catch((error) =>
        setMessage(error instanceof Error ? error.message : "接口配置加载失败")
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function providerAction(
    formElement: HTMLFormElement,
    provider: "gemini" | "seedance",
    action: "save" | "test"
  ) {
    setBusy(`${provider}-${action}`);
    setMessage("");
    const form = new FormData(formElement);
    const entries = Object.fromEntries(form);
    const apiKey = String(entries.apiKey || "");
    delete entries.apiKey;
    try {
      if (provider === "gemini" && entries.mode === "web") {
        if (action === "test") {
          const result = (await api("/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider, config: entries }),
          })) as { message?: string };
          setMessage(result.message || "Gemini 网页 Pro 执行器已连接");
          return;
        }
        await api("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, config: entries }),
        });
        setMessage("已切换为本机 Gemini 网页 Pro 执行器");
        await load();
        await onUpdated();
        return;
      }
      if (provider === "seedance" && entries.mode === "local-api") {
        if (action === "test") {
          const result = (await api("/api/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider, config: entries, apiKey }),
          })) as { message?: string };
          setLocalSeedanceVerified(true);
          setMessage(result.message || "FlowCut 内置 Seedance 连接正常");
          return;
        }
        await api("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, config: entries, apiKey }),
        });
        setLocalSeedanceConfigured(true);
        const runtime = settings?.seedance.runtime;
        setMessage(
          runtime?.online
            ? "Seedance Bridge Key 已加密保存，工作台已连接"
            : "Seedance Bridge Key 已加密保存；新版工作台打开后会在约 10 秒内自动连接"
        );
        const keyInput = formElement.elements.namedItem("apiKey");
        if (keyInput instanceof HTMLInputElement) keyInput.value = "";
        await load();
        await onUpdated();
        return;
      }
      if (provider === "gemini" && action === "save") {
        if (!apiKey && !settings?.gemini.secretConfigured) {
          throw new Error("请填写 Gemini API Key");
        }
        await api("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, config: entries, apiKey }),
        });
        await api("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, config: entries, apiKey }),
        });
        setMessage("Gemini API 已连接验证并加密保存，商品图会发送给真实 Gemini");
        formElement.reset();
        await load();
        await onUpdated();
        return;
      }
      const result = (await api("/api/settings", {
        method: action === "save" ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, config: entries, apiKey }),
      })) as { message?: string };
      setMessage(
        result.message ||
          `${provider === "gemini" ? "Gemini" : "Seedance"} 配置已加密保存`
      );
      if (action === "save") {
        formElement.reset();
        await load();
        await onUpdated();
      }
    } catch (error) {
      if (provider === "seedance" && entries.mode === "local-api") {
        setLocalSeedanceVerified(false);
      }
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  async function seedanceDesktopAction(
    action:
      | "add"
      | "open"
      | "reconnect"
      | "save-login"
      | "remove"
      | "toggle"
      | "choose-folder"
      | "open-folder",
    accountId = ""
  ) {
    const desktop = desktopBridge();
    if (!desktop?.seedanceState) {
      setMessage("请从 FlowCut 桌面 EXE 中管理 Seedance 账号");
      return;
    }
    setBusy(`seedance-desktop-${action}-${accountId}`);
    setMessage("");
    try {
      if (action === "add") {
        setSeedanceDesktop(
          await desktop.seedanceAddAccount(
            seedanceAccountName.trim() ||
              `Seedance 账号 ${(seedanceDesktop?.accountState.items.length || 0) + 1}`
          )
        );
        setSeedanceAccountName("");
        setMessage("TikTok Symphony 登录窗口已打开；完成登录后点击“保存登录并隐藏”");
      } else if (action === "open") {
        await desktop.seedanceOpenLogin(accountId);
        setMessage("TikTok Symphony 登录窗口已打开");
      } else if (action === "reconnect") {
        if (!desktop.seedanceReconnectLogin) throw new Error("请更新 FlowCut 桌面程序");
        setSeedanceDesktop(await desktop.seedanceReconnectLogin(accountId));
        setMessage("已按系统代理重新连接登录页面，账号资料保留。请自行完成登录验证。");
      } else if (action === "save-login") {
        setSeedanceDesktop(await desktop.seedanceSaveLogin(accountId));
        setMessage("Seedance 登录态已保存，窗口已隐藏");
      } else if (
        action === "remove" &&
        await confirmAction("移除这个 Seedance 执行账号并清除它的独立登录数据？正在上传或生成视频的账号需等任务结束后再删除。")
      ) {
        setSeedanceDesktop(await desktop.seedanceRemoveAccount(accountId));
        setMessage("Seedance 账号已移除");
        onNotice("Seedance 账号已移除");
      } else if (action === "toggle") {
        setSeedanceDesktop(
          await desktop.seedanceSetRunning(
            !Boolean(seedanceDesktop?.settings.running)
          )
        );
      } else if (action === "choose-folder") {
        setSeedanceDesktop(await desktop.seedanceChooseDownloadDirectory());
        setMessage("成片下载根目录已更新");
      } else if (action === "open-folder") {
        await desktop.seedanceOpenDownloadDirectory();
      }
      await new Promise((resolve) => window.setTimeout(resolve, 600));
      const latest = await desktop.seedanceState();
      setSeedanceDesktop(latest);
      await load();
      await onUpdated();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Seedance 账号操作失败";
      setMessage(errorMessage);
      onNotice(errorMessage);
    } finally {
      setBusy("");
    }
  }

  async function desktopAccountAction(
    action: "add" | "open" | "save-login" | "check" | "default" | "remove",
    accountId = ""
  ) {
    const desktop = desktopBridge();
    if (!desktop) {
      setMessage("请从桌面的 FlowCut EXE 打开工作台后管理 Gemini 账号");
      return;
    }
    setBusy(`account-${action}-${accountId}`);
    setMessage("");
    try {
      if (action === "add") {
        await desktop.addAccount(accountName.trim() || "Gemini Pro");
        setAccountName("");
        setMessage("已打开 Google 登录窗口；登录并确认 Pro 模型后，回到这里点“保存登录并隐藏”");
      } else if (action === "open") {
        await desktop.openLogin(accountId);
        setMessage("账号登录窗口已打开");
      } else if (action === "save-login") {
        await desktop.hideLogin(accountId);
        setMessage("Gemini 登录态已保存，登录窗口已隐藏");
      } else if (action === "check") {
        await desktop.checkAccount(accountId);
        setMessage("已重新检查该账号的 Google 登录状态");
      } else if (action === "default") {
        await desktop.setDefaultAccount(accountId);
        setMessage("已设为默认 Gemini 账号");
      } else if (
        action === "remove" &&
        await confirmAction("移除该账号并清除它在工作台中的独立登录数据？")
      ) {
        await desktop.removeAccount(accountId);
        setMessage("Gemini 账号已移除");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      await load();
      await onUpdated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号操作失败");
    } finally {
      setBusy("");
    }
  }

  async function toggleGeminiQueue() {
    const desktop = desktopBridge();
    if (!desktop?.setQueueRunning) {
      setMessage("请在 FlowCut 桌面程序中控制 Gemini 队列");
      return;
    }
    const running = !settings?.gemini.runtime?.queueRunning;
    if (running && !await confirmAction("启动 Gemini 队列后，已有的等待任务也会继续执行。确认启动？")) return;
    setBusy("gemini-queue");
    try {
      await desktop.setQueueRunning(running);
      // 更新本页的开关，不依赖下一次心跳；账号登录状态不变。
      setSettings(current => current && current.gemini.runtime ? {
        ...current, gemini: { ...current.gemini, runtime: { ...current.gemini.runtime, queueRunning: running } },
      } : current);
      setMessage(running ? "Gemini 队列已启动，等待任务将继续" : "Gemini 队列已暂停，正在执行的任务会收尾");
      await onUpdated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gemini 队列操作失败");
    } finally { setBusy(""); }
  }

  if (!settings) {
    return (
      <div className="page-body">
        <div className="settings-loading">正在读取接口配置…</div>
      </div>
    );
  }

  return (
    <div className="page-body">
      <PageIntro
        title="模型与执行器"
        text="只有真实连接验证通过后才会运行任务；系统不会再用演示提示词冒充商品图识别结果。"
      />
      {message && <div className="settings-message">{message}</div>}
      <div className="provider-settings">
        <form
          className="connection-card"
          onSubmit={(event) => {
            event.preventDefault();
            providerAction(event.currentTarget, "gemini", "save");
          }}
        >
          <div className="connection-head">
            <div className="provider-logo gemini-logo">G</div>
            <div>
              <span>提示词引擎</span>
              <h3>{geminiMode === "web" ? "Gemini 网页版 (3.7 Flash)" : "Gemini API"}</h3>
            </div>
            <em className={integrations.gemini ? "connected" : ""}>
              {integrations.gemini
                ? geminiMode === "web" && !settings.gemini.runtime?.queueRunning
                  ? "已登录 · 队列已暂停"
                  : "已验证可用"
                : geminiMode === "web"
                  ? settings.gemini.runtime?.online
                    ? "等待账号登录"
                    : "等待本机执行器"
                  : "未配置"}
            </em>
          </div>
          <p>
            {geminiMode === "web"
              ? "使用你本机已登录的 Gemini 网页版（默认 3.7 Flash），自动上传全部商品图和所选 Gem 设定。"
              : "使用 Google AI Studio API 分析商品图并生成提示词。"}
          </p>
          <div className="connection-fields">
            <label>
              接入方式
              <select
                name="mode"
                value={geminiMode}
                onChange={(event) =>
                  setGeminiMode(event.currentTarget.value as "web" | "api")
                }
              >
                <option value="web">本机 Gemini 网页版（默认 3.7 Flash，推荐）</option>
                <option value="api">Google AI Studio API</option>
              </select>
            </label>
            {geminiMode === "web" ? (
              <div className="gemini-desktop-settings full-field">
                <div className="local-api-note">
                  桌面执行器：
                  {settings.gemini.runtime?.online
                    ? `已连接 · ${
                        settings.gemini.runtime.accounts?.filter(
                          (account) => account.authenticated
                        ).length || 0
                      } 个账号已登录 · ${settings.gemini.runtime.queueRunning ? "队列运行中" : "队列已暂停"} · ${
                        settings.gemini.runtime.activeCount || 0
                      } 条正在生成`
                    : "正在连接本机执行器。"}
                  <br />
                  商品、Gem、账号和任务都在当前 FlowCut EXE 内管理；Google
                  登录窗口只在添加或重新登录时临时打开。
                  {!settings.gemini.runtime?.queueRunning && settings.gemini.runtime?.authenticated && (
                    <><br />账号可用；创建任务时会自动启动队列，测试连接不会启动任务。</>
                  )}
                </div>
                <div className="gemini-account-add">
                  <input
                    value={accountName}
                    onChange={(event) => setAccountName(event.target.value)}
                    placeholder="账号名称，例如：主账号 Pro"
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(busy)}
                    onClick={() => desktopAccountAction("add")}
                  >
                    添加 Gemini 账号
                  </button>
                </div>
                <div className="gemini-account-list">
                  {(settings.gemini.runtime?.accounts || []).map((account) => (
                    <article
                      className={account.authenticated ? "authenticated" : ""}
                      key={account.id}
                    >
                      <div>
                        <b>{account.name}</b>
                        {settings.gemini.runtime?.defaultAccountId ===
                          account.id && <em>默认</em>}
                        <small>
                          {account.authenticated
                            ? account.busy
                              ? "已登录 · 正在生成"
                              : "已登录 · 空闲"
                            : "等待登录"}
                        </small>
                      </div>
                      <div>
                        <button
                          type="button"
                          onClick={() => desktopAccountAction("open", account.id)}
                        >
                          打开登录
                        </button>
                        {!account.authenticated && (
                          <button
                            type="button"
                            onClick={() =>
                              desktopAccountAction("save-login", account.id)
                            }
                          >
                            保存登录并隐藏
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => desktopAccountAction("check", account.id)}
                        >
                          检查
                        </button>
                        {settings.gemini.runtime?.defaultAccountId !==
                          account.id && (
                          <button
                            type="button"
                            onClick={() =>
                              desktopAccountAction("default", account.id)
                            }
                          >
                            设为默认
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger-text"
                          onClick={() =>
                            desktopAccountAction("remove", account.id)
                          }
                        >
                          移除
                        </button>
                      </div>
                    </article>
                  ))}
                  {!settings.gemini.runtime?.accounts?.length && (
                    <p>还没有账号。输入名称并点击“添加 Gemini 账号”。</p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <label>
                  API Key
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      settings.gemini.secretConfigured
                        ? "已保存；留空表示不更换"
                        : "粘贴 Google AI Studio API Key"
                    }
                  />
                </label>
                <label>
                  API 模型（选填）
                  <input
                    name="model"
                    defaultValue={settings.gemini.model}
                    placeholder="留空自动读取可用模型，也可填写任意模型名"
                  />
                  <small>网页版默认使用 3.7 Flash 模型；API 模式填写什么就调用什么，留空则自动选择账号可用模型。</small>
                </label>
                <label className="full-field">
                  API Base URL
                  <input name="baseUrl" defaultValue={settings.gemini.baseUrl} />
                </label>
              </>
            )}
          </div>
          <div className="connection-actions">
            {geminiMode === "web" && (
              <button type="button" className="secondary" disabled={Boolean(busy) || !settings.gemini.runtime?.online}
                onClick={toggleGeminiQueue}>
                {settings.gemini.runtime?.queueRunning ? "暂停 Gemini 队列" : "启动 Gemini 队列"}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={Boolean(busy)}
              onClick={(event) =>
                providerAction(event.currentTarget.form!, "gemini", "test")
              }
            >
              {busy === "gemini-test" ? "测试中…" : "测试连接"}
            </button>
            <button className="primary" disabled={Boolean(busy)}>
              {busy === "gemini-save" ? "保存中…" : "保存接入方式"}
            </button>
          </div>
        </form>

        <form
          className="connection-card"
          onSubmit={(event) => {
            event.preventDefault();
            providerAction(event.currentTarget, "seedance", "save");
          }}
        >
          <div className="connection-head">
            <div className="provider-logo seedance-logo">S</div>
            <div>
              <span>视频生成器</span>
              <h3>Seedance 2.0</h3>
            </div>
            <em
              className={
                (seedanceMode === "local-api"
                  ? localSeedanceVerified
                  : integrations.seedance)
                  ? "connected"
                  : ""
              }
            >
              {(seedanceMode === "local-api"
                ? localSeedanceVerified
                : integrations.seedance)
                ? "已验证可用"
                : seedanceMode === "local-api" && localSeedanceConfigured
                  ? "已保存 · 待验证"
                  : "未配置"}
            </em>
          </div>
          <p>Seedance 账号、并发队列和成片下载已经内置在 FlowCut 中，不需要再启动第二个工作台。</p>
          <div className="connection-fields">
            <label>
              接入方式
              <select
                name="mode"
                value={seedanceMode}
                onChange={(event) =>
                  setSeedanceMode(
                    event.currentTarget.value as
                      | "local-api"
                      | "webhook"
                      | "async-api"
                  )
                }
              >
                <option value="local-api">FlowCut 内置 Seedance（推荐）</option>
                <option value="webhook">插件 / Webhook</option>
                <option value="async-api">异步 API</option>
              </select>
            </label>
            {seedanceMode !== "local-api" && (
              <label>
                API Key / Token
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    settings.seedance.secretConfigured
                      ? "已保存；留空表示不更换"
                      : "粘贴服务 API Key"
                  }
                />
              </label>
            )}
            {seedanceMode !== "local-api" && (
              <>
                <label className="full-field">
                  提交任务地址
                  <input
                    name="endpoint"
                    defaultValue={settings.seedance.endpoint}
                    placeholder="https://你的服务/video/generate"
                  />
                </label>
                <label className="full-field">
                  健康检查地址
                  <input
                    name="healthUrl"
                    defaultValue={settings.seedance.healthUrl}
                    placeholder="https://你的服务/health"
                  />
                </label>
              </>
            )}
          </div>
          {seedanceMode !== "local-api" && <details className="advanced-settings">
            <summary>异步 API 高级映射</summary>
            <div className="connection-fields">
              <label>鉴权请求头<input name="authHeader" defaultValue={settings.seedance.authHeader} /></label>
              <label>鉴权前缀<input name="authScheme" defaultValue={settings.seedance.authScheme} /></label>
              <label>任务 ID 路径<input name="responseJobIdPath" defaultValue={settings.seedance.responseJobIdPath} /></label>
              <label>直接成片路径<input name="responseOutputPath" defaultValue={settings.seedance.responseOutputPath} /></label>
              <label className="full-field">状态查询地址模板<input name="statusUrlTemplate" defaultValue={settings.seedance.statusUrlTemplate} placeholder="https://服务/tasks/{jobId}" /></label>
              <label>状态字段路径<input name="statusPath" defaultValue={settings.seedance.statusPath} /></label>
              <label>成片地址路径<input name="outputPath" defaultValue={settings.seedance.outputPath} /></label>
              <label>成功状态值<input name="successValue" defaultValue={settings.seedance.successValue} /></label>
              <label>失败状态值<input name="failureValue" defaultValue={settings.seedance.failureValue} /></label>
            </div>
          </details>}
          {seedanceMode === "local-api" && (
            <div className="gemini-desktop-settings full-field seedance-embedded-settings">
              <div className="local-api-note">
                内置执行器：
                {seedanceDesktop?.ready
                  ? `${seedanceDesktop.accountState.items.filter((item) => item.authenticated).length} 个账号已登录 · ${
                      seedanceDesktop.settings.running ? "队列运行中" : "队列已暂停"
                    } · ${seedanceDesktop.tasks.filter((task) => !["success", "failed"].includes(task.status)).length} 条处理中`
                  : "正在启动。"}
                <br />
                商品图、提示词会在本机直接进入 Seedance 队列；生成成功后按任务选择的 TK
                账号保存到指定文件夹。默认使用 Fast，可逐个账号选择首选模型；Mini 已禁用。
              </div>
              <div className="seedance-runtime-toolbar">
                <div>
                  <b>成片根目录</b>
                  <small>
                    {seedanceDesktop?.settings.downloadDirectory ||
                      "系统下载目录 / FlowCut视频"}
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => seedanceDesktopAction("choose-folder")}
                >
                  更改目录
                </button>
                <button
                  type="button"
                  onClick={() => seedanceDesktopAction("open-folder")}
                >
                  打开目录
                </button>
                <button
                  type="button"
                  className={
                    seedanceDesktop?.settings.running ? "danger-text" : ""
                  }
                  onClick={() => seedanceDesktopAction("toggle")}
                >
                  {seedanceDesktop?.settings.running ? "暂停队列" : "启动队列"}
                </button>
              </div>
              <div className="gemini-account-add">
                <input
                  value={seedanceAccountName}
                  onChange={(event) => setSeedanceAccountName(event.target.value)}
                  placeholder="账号名称，例如：广告户 A"
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => seedanceDesktopAction("add")}
                >
                  添加 Seedance 账号
                </button>
              </div>
              <div className="gemini-account-list">
                {(seedanceDesktop?.accountState.items || []).map((account) => (
                  <article
                    className={account.authenticated ? "authenticated" : ""}
                    key={account.id}
                  >
                    <div>
                      <b>{account.name}</b>
                      {account.active && <em>当前</em>}
                      <label>首选模型
                        <select aria-label={`${account.name} 首选模型`} value={account.preferredModel || "2000012"} disabled={Boolean(busy)} onChange={async event => {
                          const model = event.target.value;
                          setBusy(`model-${account.id}`);
                          try {
                            const desktop = desktopBridge();
                            if (!desktop?.seedanceSetPreferredModel) throw new Error("请更新 FlowCut 桌面程序");
                            setSeedanceDesktop(await desktop.seedanceSetPreferredModel(account.id, model));
                            setMessage("首选模型已保存，下次提交时生效；已提交的视频不受影响。");
                          } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
                          finally { setBusy(""); }
                        }}>
                          <option value="2000012">Seedance 2.0 Fast（优先）</option>
                          <option value="2000004">Seedance 2.0（消耗更高）</option>
                        </select>
                      </label>
                      <small>{account.effectiveModel === "2000004" ? "当前使用：Seedance 2.0" : account.effectiveModel === "2000012" ? "当前使用：Seedance 2.0 Fast" : "当前模型等待额度恢复或手动选择"}</small>
                      {account.loginNetworkError && <small className="form-error">{account.loginNetworkError}</small>}
                      {account.fastExhaustedToday && account.preferredModel !== "2000004" && account.fallbackDecision !== "standard" && <SeedanceQuotaChoice account={account} onUpdated={setSeedanceDesktop} onError={setMessage} />}
                      <small>
                        {account.authenticated
                          ? account.exhaustedToday
                            ? "已登录 · 今日额度已满"
                            : `已登录 · 并发 ${account.generatingCount || 0}/${account.maxConcurrent || 5}`
                          : account.error || "等待登录"}
                      </small>
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          seedanceDesktopAction("open", account.id)
                        }
                      >
                        打开登录
                      </button>
                      <button type="button" disabled={Boolean(busy)} onClick={() => seedanceDesktopAction("reconnect", account.id)}>重连登录</button>
                      {!account.authenticated && (
                        <button
                          type="button"
                          onClick={() =>
                            seedanceDesktopAction("save-login", account.id)
                          }
                        >
                          保存登录并隐藏
                        </button>
                      )}
                      {(seedanceDesktop?.accountState.items.length || 0) > 1 && (
                        <button
                          type="button"
                          className="danger-text"
                          onClick={() =>
                            seedanceDesktopAction("remove", account.id)
                          }
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
          <div className="connection-actions">
            <button
              type="button"
              className="secondary"
              disabled={Boolean(busy)}
              onClick={(event) =>
                providerAction(event.currentTarget.form!, "seedance", "test")
              }
            >
              {busy === "seedance-test" ? "测试中…" : "检查内置执行器"}
            </button>
            <button className="primary" disabled={Boolean(busy)}>
              {busy === "seedance-save" ? "保存中…" : "保存接入方式"}
            </button>
          </div>
        </form>
      </div>
      <div className="settings-security">
        <b>本机模式</b>
        <span>
          Gemini 网页版 (3.7 Flash)、Seedance 账号、商品素材与生成视频都保存在这台电脑；
          个人版不连接 FlowCut 云端授权中心；账号、商品和任务保存在本机。
        </span>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacySettingsPage({ integrations }: { integrations: Workspace["integrations"] }) {
  const providers = [
    { name: "Gemini API", key: "gemini" as const, tag: "提示词引擎", note: "读取商品图、Gem 指令并输出完整 Seedance 提示词。", env: "GEMINI_API_KEY" },
    { name: "Seedance 2.0", key: "seedance" as const, tag: "视频生成", note: "通过你的插件 Webhook 或 Symphony API 接收任务与回调成片。", env: "SEEDANCE_WEBHOOK_URL" },
    { name: "TikTok 发布", key: "tiktok" as const, tag: "发布执行器", note: "自然账号排期或 Ads Manager 素材投放，需要单独授权。", env: "待接入账号授权" },
  ];
  return (
    <div className="page-body">
      <PageIntro title="接口与执行器" text="密钥只保存在服务器运行环境，不写入浏览器或数据库。" />
      <div className="settings-grid">
        {providers.map((provider) => (
          <article className="provider-card" key={provider.name}>
            <div className="provider-top"><span>{provider.name.slice(0, 1)}</span><em className={integrations[provider.key] ? "connected" : ""}>{integrations[provider.key] ? "已连接" : "未连接"}</em></div>
            <small>{provider.tag}</small>
            <h3>{provider.name}</h3>
            <p>{provider.note}</p>
            <div className="env-row"><code>{provider.env}</code><span>{integrations[provider.key] ? "●" : "○"}</span></div>
          </article>
        ))}
      </div>
      <section className="setup-panel">
        <div><span className="step-kicker">NEXT CONNECTION</span><h3>接入真实自动化还缺什么</h3></div>
        <ol>
          <li><b>Gemini</b><span>Google AI Studio API Key；必须验证通过后才能创建真实任务。</span></li>
          <li><b>Seedance 插件</b><span>插件源码或一个可接收 JSON 任务的本机 Webhook。</span></li>
          <li><b>TikTok 路线</b><span>确认最终发布到自然账号、广告账户，或两者都需要。</span></li>
        </ol>
      </section>
    </div>
  );
}

function ProductModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [externalId, setExternalId] = useImageProductId(files);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files]
  );

  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews]
  );

  function addFiles(incoming: File[]) {
    setError("");
    const images = incoming.filter((file) => file.type.startsWith("image/"));
    if (images.length !== incoming.length) {
      setError("已忽略非图片文件");
    }
    const oversized = images.find((file) => file.size > 12 * 1024 * 1024);
    if (oversized) {
      setError(`${oversized.name} 超过 12MB`);
      return;
    }
    setFiles((current) => {
      const next = [...current];
      for (const file of images) {
        const duplicate = next.some(
          (item) => item.name === file.name && item.size === file.size
        );
        if (!duplicate && next.length < 12) next.push(file);
      }
      if (next.reduce((total, file) => total + file.size, 0) > 48 * 1024 * 1024) {
        setError("单个商品的图片总大小不能超过 48MB");
        return current;
      }
      if (current.length + images.length > 12) {
        setError("每个商品最多保留 12 张参考图");
      }
      return next;
    });
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!files.length) {
      setError("请至少上传一张商品参考图");
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    form.delete("images");
    files.forEach((file) => form.append("images", file, file.name));
    try {
      await api("/api/products", { method: "POST", body: form });
      onSaved();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "图片上传失败，请重试"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !busy && onClose()
      }
    >
      <form className="modal product-modal" onSubmit={submit}>
        <ModalHead
          title="添加商品"
          text="可拖拽或批量选择多张参考图；第一张会作为商品封面。"
          onClose={onClose}
        />
        <div className="form-body two-col product-form-grid">
          <div className="multi-upload-column">
            <label
              className={`upload-box multi-upload ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                name="images"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) =>
                  addFiles(Array.from(event.currentTarget.files || []))
                }
              />
              <span>＋</span>
              <b>拖拽商品图到这里</b>
              <small>或点击批量选择，最多 12 张，每张不超过 12MB</small>
            </label>
            {previews.length > 0 && (
              <div className="upload-previews">
                {previews.map((preview, index) => (
                  <div className="upload-preview" key={`${preview.file.name}-${index}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={preview.url} alt={preview.file.name} />
                    {index === 0 && <em>封面</em>}
                    <button
                      type="button"
                      aria-label={`移除 ${preview.file.name}`}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter((_, fileIndex) => fileIndex !== index)
                        )
                      }
                    >
                      ×
                    </button>
                    <span>{preview.file.name}</span>
                  </div>
                ))}
                {previews.length < 12 && (
                  <label className="upload-more">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) =>
                        addFiles(Array.from(event.currentTarget.files || []))
                      }
                    />
                    ＋
                  </label>
                )}
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
          </div>
          <div className="form-stack">
            <label>
              商品名称（选填）
              <input
                name="name"
                placeholder="留空则由 Gemini 根据商品图识别"
              />
            </label>
            <label>
              商品 ID
              <input
                name="externalId"
                value={externalId}
                onChange={(event) => setExternalId(event.target.value)}
                placeholder="自动识别首张图片文件名中的 ID，可修改"
              />
            </label>
            <label>
              核心功能与卖点
              <textarea
                name="features"
                rows={6}
                placeholder="只填写真实、可验证的功能。每行一个卖点，Gemini 会结合全部参考图进行判断。"
              />
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <span>{files.length ? `已选择 ${files.length} 张参考图` : "尚未选择图片"}</span>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? `正在上传 ${files.length} 张图片…` : "保存商品"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProductEditModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/products", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: product.id,
          name: String(form.get("name") || ""),
          externalId: String(form.get("externalId") || ""),
          features: String(form.get("features") || ""),
        }),
      });
      const images = form.getAll("images").filter((file) => file instanceof File && file.size > 0);
      if (images.length) {
        const attachments = new FormData(); attachments.set("id", product.id);
        images.forEach((file) => attachments.append("images", file));
        await api("/api/products", { method: "PATCH", body: attachments });
      }
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "商品资料保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !busy && onClose()
      }
    >
      <form className="modal small-modal" onSubmit={submit}>
        <ModalHead
          title="编辑商品资料"
          text={`${product.images?.length || 0} 张商品图已保留；商品名称可以留空。`}
          onClose={onClose}
        />
        <div className="form-body form-stack">
          <label>
            商品名称（选填）
            <input
              name="name"
              defaultValue={product.name || ""}
              placeholder="留空则显示为“未命名商品”"
            />
          </label>
          <label>
            商品 ID（选填）
            <input
              name="externalId"
              defaultValue={product.external_id || ""}
              placeholder="TikTok Shop Product ID"
            />
          </label>
          <label>
            核心功能与卖点（选填）
            <textarea
              name="features"
              rows={6}
              defaultValue={product.features || ""}
              placeholder="可留空，让 Gemini 结合商品图识别"
            />
          </label>
          <label>补充商品图<input name="images" type="file" accept="image/jpeg,image/png,image/webp" multiple /><small>现有图片会保留，每个商品最多 12 张。</small></label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <span>不会修改或删除现有商品图片</span>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyProductModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/products", { method: "POST", body: new FormData(event.currentTarget) });
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <ModalHead title="添加商品" text="产品图片与真实卖点会成为 Gemini 的事实依据。" onClose={onClose} />
        <div className="form-body two-col">
          <label className="upload-box">
            <input name="images" type="file" accept="image/jpeg,image/png,image/webp" multiple />
            <span>＋</span><b>上传产品图片</b><small>JPG / PNG / WebP，最大 12MB</small>
          </label>
          <div className="form-stack">
            <label>商品名称（选填）<input name="name" placeholder="留空则由 Gemini 根据商品图识别" /></label>
            <label>商品 ID<input name="externalId" placeholder="TikTok Shop Product ID（选填）" /></label>
            <label>核心功能与卖点<textarea name="features" rows={5} placeholder="只写真实、可验证的功能。每行一个卖点更清晰。" /></label>
          </div>
        </div>
        <div className="modal-foot"><button type="button" className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "上传中…" : "保存商品"}</button></div>
      </form>
    </div>
  );
}

function GemModal({ gem, onClose, onSaved }: { gem: Gem | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(gem?.name || "");
  const [description, setDescription] = useState(gem?.description || "");
  const [content, setContent] = useState(gem?.content || "");
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { nameInput.current?.focus(); }, []);
  const close = () => { if (!busy) onClose(); };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api("/api/gems", {
        method: gem ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: gem?.id, name, description, content }),
      });
      await onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请重试；输入内容已保留");
    } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}>
      <form className="modal wide-modal" role="dialog" aria-modal="true" aria-label={gem ? "编辑 Gem 指令" : "创建新的 Gem"} onSubmit={submit}>
        <ModalHead title={gem ? "编辑 Gem 指令" : "创建新的 Gem"} text="把身份、成交结构、生成规格和固定输出格式写在同一个模板里。" onClose={close} />
        <div className="form-body">
          <div className="gem-form-head">
            <label>Gem 名称<input ref={nameInput} name="name" value={name} onChange={event => setName(event.target.value)} placeholder="例如：促销带货视频脚本智能体" required /></label>
          </div>
          <label>模板简介<input name="description" value={description} onChange={event => setDescription(event.target.value)} placeholder="说明这个 Gem 适合什么视频" /></label>
          <label className="instruction-field">完整 Gem 指令<textarea name="content" value={content} onChange={event => setContent(event.target.value)} placeholder="一、身份&#10;二、输出结构&#10;三、禁止事项…" required /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal-foot"><span>保存后，下一次任务即可选择这个 Gem。</span><button type="button" className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存 Gem"}</button></div>
      </form>
    </div>
  );
}

function PromptDrawer({
  task,
  onClose,
  onUpdated,
}: {
  task: Task;
  onClose: () => void;
  onUpdated: (message: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  async function copy() {
    await navigator.clipboard.writeText(task.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  async function taskAction(action: "queue" | "check" | "retry" | "regenerate") {
    setBusy(action);
    try {
      await api("/api/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          action,
          autoQueue: action === "regenerate",
        }),
      });
      await onUpdated(
        action === "queue"
          ? "已提交到 Seedance 视频生成队列"
          : action === "regenerate"
            ? "Gemini 已重新识别商品图，并提交到 Seedance"
          : action === "check"
            ? "已刷新视频生成状态"
            : "任务已恢复到提示词就绪状态"
      );
    } catch (error) {
      setBusy("");
      await onUpdated(error instanceof Error ? error.message : "任务操作失败");
    }
  }
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <span className="step-kicker">AUTOMATION RESULT</span>
            <h2>{task.product_name || task.title}</h2>
            <p>{task.gem_name}</p>
          </div>
          <button onClick={onClose}>×</button>
        </div>
        <div className="drawer-status">
          <span className={`status ${task.status}`}>
            {taskStatusLabel(task)}
          </span>
          <em>
            {task.provider === "demo-engine"
              ? "旧版演示结果 · 未识别图片"
              : task.provider.startsWith("seedance")
                ? "Gemini → Seedance"
                : task.provider === "gemini-web"
                  ? "Gemini 网页版真实结果"
                  : "Gemini API 真实结果"}
          </em>
          {task.tiktok_account_name && (
            <em className="tk-task-badge">TK：{task.tiktok_account_name}</em>
          )}
          <em className="task-config-badge">
            {task.duration || DEFAULT_TASK_DURATION}秒 ·{" "}
            {task.region || DEFAULT_TASK_REGION} ·{" "}
            {task.shooting_style || DEFAULT_SHOOTING_STYLE}
          </em>
          <time>{formatTime(task.created_at)}</time>
        </div>
        <div className="drawer-chain-wrap">
          <span>本任务执行链路</span>
          <TaskChain task={task} />
        </div>
        {task.provider === "demo-engine" && (
          <div className="warning-box strong-warning">
            这段提示词不是根据你的商品图生成的。商品图片已经保存，但当时 Gemini
            未配置，旧版系统错误地塞入了演示内容。保存 Gemini Key
            后，点击下方按钮即可用原来的全部商品图重新识别。
          </div>
        )}
        {task.error && (
          <div className="warning-box">
            {task.error === "Failed to fetch"
              ? "上次 Seedance 提交失败：浏览器无法访问本机工作台。请在接口设置中重新测试，并允许浏览器访问本地网络。"
              : task.error}
          </div>
        )}
        {task.download_path && (
          <div className="download-result">
            <b>成片已自动归档</b>
            <span>{task.download_path}</span>
          </div>
        )}
        {task.download_path && ["video_ready", "scheduled"].includes(task.status) && <PublishReview task={task} />}
        {task.archive_directory && <p className="download-destination">本任务保存到：{task.archive_directory}</p>}
        {task.download_error && (
          <div className="warning-box">
            下载状态：{task.download_error}
          </div>
        )}
        {task.output_url && (
          <div className="video-result">
            <video src={task.output_url} controls playsInline />
            <a href={task.output_url} target="_blank" rel="noreferrer">
              在新窗口打开成片 ↗
            </a>
          </div>
        )}
        <div className="prompt-title">
          <b>{task.provider === "demo-engine" ? "旧演示提示词（不可提交）" : "Gemini 生成的 Seedance 提示词"}</b>
        </div>
        <pre>{task.prompt || "尚未生成提示词"}</pre>
        <div className="drawer-foot">
          <button
            className="secondary"
            onClick={copy}
            disabled={!task.prompt || task.provider === "demo-engine"}
          >
            {copied ? "已复制" : "复制提示词"}
          </button>
          {task.provider === "demo-engine" && (
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => taskAction("regenerate")}
            >
              {busy === "regenerate" ? "Gemini 识别中…" : "重新用 Gemini 识别并生成视频"}
            </button>
          )}
          {["prompt_ready", "seedance_blocked"].includes(task.status) &&
            task.provider !== "demo-engine" && (
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => taskAction("queue")}
            >
              {busy === "queue" ? "提交中…" : task.status === "seedance_blocked" ? "重试提交 Seedance" : "提交 Seedance"}
            </button>
          )}
          {["video_queued", "video_generating"].includes(task.status) &&
            task.provider_status_url &&
            task.provider !== "seedance-bridge" && (
              <button
                className="primary"
                disabled={Boolean(busy)}
                onClick={() => taskAction("check")}
              >
                {busy === "check" ? "查询中…" : "刷新生成状态"}
              </button>
            )}
          {task.status === "failed" && (
            <button
              className="primary"
              disabled={Boolean(busy)}
              onClick={() => taskAction("retry")}
            >
              恢复任务
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </aside>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyPromptDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(task.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer">
        <div className="drawer-head"><div><span className="step-kicker">GENERATED PROMPT</span><h2>{task.product_name || task.title}</h2><p>{task.gem_name}</p></div><button onClick={onClose}>×</button></div>
        <div className="drawer-status"><span className={`status ${task.status}`}>{statusLabels[task.status] || task.status}</span><em>{task.provider === "demo-engine" ? "演示引擎" : task.provider}</em><time>{formatTime(task.created_at)}</time></div>
        {task.error && <div className="warning-box">{task.error}</div>}
        <pre>{task.prompt}</pre>
        <div className="drawer-foot"><button className="secondary" onClick={copy}>{copied ? "已复制" : "复制完整提示词"}</button><button className="primary" onClick={onClose}>完成</button></div>
      </aside>
    </div>
  );
}

function PageIntro({
  title,
  text,
  action,
  actionIcon = "＋",
  actionTone = "primary",
  onAction,
}: {
  title: string;
  text: string;
  action?: string;
  actionIcon?: string;
  actionTone?: "primary" | "secondary";
  onAction?: () => void;
}) {
  return <div className="page-intro"><div><h2>{title}</h2><p>{text}</p></div>{action && <button className={actionTone} onClick={onAction}>{actionIcon} {action}</button>}</div>;
}

function ModalHead({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <div className="modal-head"><div><h2>{title}</h2><p>{text}</p></div><button type="button" onClick={onClose}>×</button></div>;
}

function EmptyState({ icon, title, text, action, onAction }: { icon: string; title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{text}</p>{action && <button className="secondary" onClick={onAction}>{action}</button>}</div>;
}
