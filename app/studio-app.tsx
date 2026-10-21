"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_SHOOTING_STYLE, DEFAULT_TASK_DURATION, DEFAULT_TASK_REGION } from '../lib/task-config';
import { confirmAction } from './confirm-action';
import { DEFAULT_GEM_REQUEST, buildGemRequest, validateGemRequest } from '../lib/gem-request';
import { SPOKEN_LANGUAGE_OPTIONS } from '../lib/spoken-language';
import { DEFAULT_VARIANT_REQUEST, validateVariantRequest } from '../lib/prompt-blocks';
import type { VariantConfig } from './variant-config';
import { FissionPage } from './fission-page';
import { CalendarPage } from './calendar-page';
import { Dashboard } from './dashboard-page';
import { GemsPage, GemModal } from './gems-page';
import { ProductsPage, ProductModal, ProductEditModal } from './products-page';
import { PromptDrawer } from './prompt-drawer';
import { PublisherPage } from './publisher-page';
import { ReferenceRemixPage } from './reference-remix-page';
import { ScriptPipelinePage } from './script-pipeline-page';
import { SeedanceQuotaSummary } from './seedance-quota';
import { SettingsPage } from './settings-page';
import { api, desktopBridge } from './studio-client';
import type { Gem, Product, Task, TikTokAccount, Workspace, Page, SeedanceRuntime, UpdateState, SeedanceDesktopState } from './studio-types';
import { withChildren, taskStatusLabel } from './task-status';
import { TasksPage } from './tasks-page';
import { TikTokAccountModal, TikTokAccountManager } from './tiktok-accounts';
import { Icon, type IconName } from './icons';
import { APPROVED_REVIEW_STATUSES, GROUP_ROLES, VIDEO_RUNNING_STATUSES } from '../lib/task-statuses';

const nav: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: "dashboard", label: "创作中心", icon: "create" },
  { id: "scripts", label: "剧本提示词", icon: "scripts" },
  { id: "remix", label: "爆款复刻", icon: "remix" },
  { id: "fission", label: "多品裂变", icon: "fission" },
  { id: "products", label: "商品库", icon: "products" },
  { id: "gems", label: "Gem 模板", icon: "gems" },
  { id: "tasks", label: "任务队列", icon: "tasks" },
  { id: "publisher", label: "发布管理", icon: "publisher" },
  { id: "calendar", label: "发布日历", icon: "calendar" },
  { id: "settings", label: "账号与设置", icon: "settings" },
];

// 顶栏的 Gemini 状态：网页模式显示「已登录账号数 / 启用账号数」。
function geminiStatusText(data: Workspace) {
  const { gemini, geminiMode, geminiRuntime } = data.integrations;
  if (geminiMode !== "web") return gemini ? "Gemini API 已配置" : "Gemini API 未配置";
  if (!gemini) return geminiRuntime?.online ? "Gemini 账号未登录" : "Gemini 本机执行器未连接";
  const accounts = (geminiRuntime?.accounts || []).filter(account => account.enabled !== false);
  if (!accounts.length) return "Gemini 已登录";
  return `Gemini ${accounts.filter(account => account.authenticated).length}/${accounts.length} 在线`;
}

export function StudioApp() {
  const [seedanceStatus, setSeedanceStatus] = useState<SeedanceDesktopState | null>(null);
  const seedanceWorkPending = Boolean(seedanceStatus?.tasks.some(task => ["upload_wait", "uploading", "queued", "submitting", "generating", "retry_wait", "model_wait"].includes(task.status)));
  const [page, setPage] = useState<Page>("dashboard");
  // 创作中心点「待检查 / 需处理…」时，任务队列直接打开对应筛选。
  const [taskFilter, setTaskFilter] = useState("all");
  function goTo(next: Page, filter = "all") {
    setTaskFilter(filter);
    setPage(next);
  }
  const [moreTools, setMoreTools] = useState(false);
  const [data, setData] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [gemOpen, setGemOpen] = useState(false);
  const [tiktokAccountOpen, setTikTokAccountOpen] = useState(false);
  const [tiktokAccountManagerOpen, setTikTokAccountManagerOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingGem, setEditingGem] = useState<Gem | null>(null);
  const [previewTask, setPreviewTask] = useState<Task | null>(null);
  const taskDetailRequest = useRef(0);
  async function openTask(task: Task) {
    const request = ++taskDetailRequest.current;
    try {
      const detail = await api('/api/tasks?id=' + encodeURIComponent(task.id)) as unknown as Task;
      if (request === taskDetailRequest.current) setPreviewTask(detail);
    } catch (error) { if (request === taskDetailRequest.current) setNotice(error instanceof Error ? error.message : '任务详情加载失败'); }
  }
  const [selectedProduct, setSelectedProduct] = useState("");
  const [productMode, setProductMode] = useState<"new" | "library">("new");
  const [productChoiceLoaded, setProductChoiceLoaded] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
    try {
      const choice = JSON.parse(window.localStorage.getItem("flowcut-product-choice-v1") || "null");
      if (choice && typeof choice.id === "string") {
        setSelectedProduct(choice.id);
        setProductMode(choice.mode === "library" ? "library" : "new");
      }
    } catch { /* Selection still works when local storage is unavailable. */ }
    setProductChoiceLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!productChoiceLoaded) return;
    try { window.localStorage.setItem("flowcut-product-choice-v1", JSON.stringify({id:selectedProduct, mode:productMode})); }
    catch { /* Keep the selection for this session. */ }
  }, [selectedProduct, productMode, productChoiceLoaded]);
  const [selectedGem, setSelectedGem] = useState("");
  const [selectedTikTokAccount, setSelectedTikTokAccount] = useState("");
  const [selectedDuration, setSelectedDuration] = useState(DEFAULT_TASK_DURATION);
  const [selectedRegion, setSelectedRegion] = useState(DEFAULT_TASK_REGION);
  const [selectedShootingStyle, setSelectedShootingStyle] = useState(
    DEFAULT_SHOOTING_STYLE
  );
  const [autoQueue, setAutoQueue] = useState(true);
  const [gemRequestTemplate, setGemRequestTemplate] = useState(DEFAULT_GEM_REQUEST);
  const [spokenLanguage,setSpokenLanguage]=useState('auto');
  useEffect(()=>{const timer=window.setTimeout(()=>{try{const saved=window.localStorage.getItem('flowcut-spoken-language-v1');if(saved && SPOKEN_LANGUAGE_OPTIONS.includes(saved))setSpokenLanguage(saved);}catch{/* Use automatic selection without browser storage. */}},0);return()=>window.clearTimeout(timer);},[]);
  function changeSpokenLanguage(value:string){setSpokenLanguage(value);try{window.localStorage.setItem('flowcut-spoken-language-v1',value);}catch{/* Selection still works for this visit. */}}
  useEffect(() => {
    const timer = window.setTimeout(() => {
    try {
      const saved = window.localStorage.getItem("flowcut-gem-request-template-v1");
      if (saved !== null) setGemRequestTemplate(saved);
    } catch { /* The editor still works when local storage is unavailable. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  function changeGemRequestTemplate(value: string) {
    setGemRequestTemplate(value);
    try { window.localStorage.setItem("flowcut-gem-request-template-v1", value); }
    catch { setNotice("文字已修改，但本机无法记住此设置；重启后请检查"); }
  }
  const [variantConfig, setVariantConfig] = useState<VariantConfig>({ enabled: false, gemId: "", template: DEFAULT_VARIANT_REQUEST });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem("flowcut-variant-config-v1") || "null");
        if (saved && typeof saved.template === "string") {
          setVariantConfig({ enabled: saved.enabled === true, gemId: String(saved.gemId || ""), template: saved.template });
        }
      } catch { /* Defaults still work when local storage is unavailable. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  function changeVariantConfig(value: VariantConfig) {
    setVariantConfig(value);
    try { window.localStorage.setItem("flowcut-variant-config-v1", JSON.stringify(value)); }
    catch { setNotice("设置已修改，但本机无法记住；重启后请检查"); }
  }
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
              detail: "内置执行器已连接，API 提交不设本地生成并发上限",
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
      setSelectedProduct((current) => result.products.some(product => product.id === current) ? current : "");
      setSelectedGem((current) =>
        result.gems.some((gem) => gem.id === current)
          ? current
          : result.gems[0]?.id || ""
      );
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
      withChildren(data?.tasks || []).some((task) =>
        [
          "prompt_queued",
          "prompt_generating",
          "variant_queued",
          "variant_generating",
          "concat_running",
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
    // The desktop may recover a task which the page still considers failed.
    // Keep polling while Seedance owns pending work, including model decisions.
    if (!active && !seedanceWorkPending) return;
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [data?.tasks, data?.referenceRemixTasks, data?.scriptPipelineTasks, seedanceWorkPending, reload]);

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
      withChildren(data?.tasks || []).filter(
        (task) =>
          task.provider !== "seedance-local" &&
          Boolean(task.provider_status_url) &&
          VIDEO_RUNNING_STATUSES.includes(task.status)
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
    () => withChildren(data?.tasks || []).filter((task) => task.status === "video_ready" && APPROVED_REVIEW_STATUSES.includes(task.review_status || '')) || [],
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
      const geminiRequestText = data.integrations.geminiMode === "web"
        ? validateGemRequest(buildGemRequest(gemRequestTemplate, { duration: selectedDuration, region: selectedRegion, shooting_style: selectedShootingStyle, spoken_language:spokenLanguage }))
        : undefined;
      const variantActive = variantConfig.enabled && data.integrations.geminiMode === "web" && selectedDuration !== 30;
      if (variantActive && !data.gems.some(gem => gem.id === variantConfig.gemId)) throw new Error("请选择变体 Gem，或关闭“变体两轮”");
      const variantRequestText = variantActive ? validateVariantRequest(variantConfig.template) : undefined;
      const savedProduct = input.mode === "new"
        ? await quickUploadProduct(
            input.files,
            input.productName,
            input.externalId
          )
        : null;
      const productId = savedProduct?.id || selectedProduct;
      if (!productId) throw new Error("没有可用于创作的商品");
      setSelectedProduct(productId);
      await api("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId,
          imageKeys: savedProduct?.imageKeys || (data.products.find(product => product.id === productId)?.images.length
            ? data.products.find(product => product.id === productId)?.images.map(image => image.object_key) : undefined),
          gemId: selectedGem,
          autoQueue,
          tiktokAccountName: selectedTikTokAccount,
          duration: selectedDuration,
          region: selectedRegion,
          shootingStyle: selectedShootingStyle,
          spokenLanguage,
          geminiRequestText,
          ...(variantActive ? { variantGemId: variantConfig.gemId, variantRequestText } : {}),
        }),
      });
      let queueNotice = `${savedProduct?.reused ? "已识别相同商品 ID，复用已有商品并使用本次上传图片。" : ""}任务已创建${variantActive ? "：先生成母版，再由变体 Gem 按代码块数量生成视频" : "，将按所选模板生成并保存到归档文件夹"}`;
      const desktop = desktopBridge();
      try {
        if (data.integrations.geminiMode === "web") await desktop?.setQueueRunning?.(true);
        if (autoQueue) await desktop?.seedanceSetRunning?.(true);
      } catch (queueError) {
        queueNotice = `任务已保存，自动启动未成功，请在账号与设置中启动队列：${queueError instanceof Error ? queueError.message : "执行器暂不可用"}`;
      }
      setNotice(queueNotice);
      await reload();
      setProductMode("library");
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

  async function updateTikTokAccount(account: TikTokAccount, name: string, archiveDirectory: string) {
    await api("/api/tiktok-accounts", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: account.id, name, archiveDirectory }),
    });
    setSelectedTikTokAccount(current => current === account.name ? name.trim() : current);
    await reload();
    setNotice("TK 账号已更新，已有任务和文件不受影响");
  }

  async function deleteTikTokAccount(account: TikTokAccount) {
    await api("/api/tiktok-accounts", {
      method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: account.id }),
    });
    await reload();
    setNotice(`已移除 TK 账号：${account.name}，历史任务和视频已保留`);
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
      })) as { id: string; reused: boolean; imageKeys: string[] };
      return result;
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
        <button className="brand" onClick={() => goTo("dashboard")}>
          <span className="brand-mark">F</span>
          <span><b>FlowCut</b></span>
        </button>

        <nav className="nav-list" aria-label="主导航">
          {(["dashboard", "remix", "fission", "tasks", "products", "publisher", "gems", "settings"] as Page[]).map((id) => nav.find((item) => item.id === id)!).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => goTo(item.id)}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.id === "tasks" && (data.taskCounts?.total ?? data.tasks.length) > 0 && (
                <em>{data.taskCounts?.total ?? data.tasks.length}</em>
              )}
            </button>
          ))}
          <button className="more-tools-toggle" aria-expanded={moreTools} onClick={() => setMoreTools(!moreTools)}>
            <Icon name={moreTools ? "minus" : "plus"} />更多工具
          </button>
          {moreTools && nav.filter((item) => ["scripts", "calendar"].includes(item.id)).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => goTo(item.id)}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          {updateState?.currentVersion && <span className="version-badge" title={`当前安装版本：FlowCut ${updateState.currentVersion}`}>v{updateState.currentVersion}</span>}
          <span title="本机使用，无授权到期限制">个人本机版</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{nav.find((item) => item.id === page)?.label}</h1>
          <div className="top-actions" aria-label="运行状态">
            <span className="health">
              <i className={data.integrations.gemini ? "online" : "offline"} />
              {geminiStatusText(data)}
            </span>
            {data.integrations.gemini && data.integrations.geminiMode === "web" && <span className="health">
              <i className={data.integrations.geminiRuntime?.queueRunning ? "online" : ""} />
              {data.integrations.geminiRuntime?.queueRunning ? "队列运行中" : "队列已暂停"}
            </span>}
            <span className="health" title={seedanceRuntime.detail}>
              <i className={seedanceRuntime.status === "ready" ? "online" : seedanceRuntime.status === "checking" ? "" : "offline"} />
              {seedanceRuntime.status === "ready" ? "Seedance 在线" : `Seedance ${seedanceRuntime.label}`}
            </span>
          </div>
        </header>

        {seedanceStatus && <SeedanceQuotaSummary state={seedanceStatus} onUpdated={setSeedanceStatus} onError={setNotice} />}

        {page === "dashboard" && (
          <Dashboard
            data={data}
            selectedProduct={selectedProduct}
            productMode={productMode}
            onProductMode={setProductMode}
            selectedGem={selectedGem}
            selectedTikTokAccount={selectedTikTokAccount}
            selectedDuration={selectedDuration}
            selectedRegion={selectedRegion}
            selectedShootingStyle={selectedShootingStyle}
            gemRequestTemplate={gemRequestTemplate}
            spokenLanguage={spokenLanguage} onSpokenLanguage={changeSpokenLanguage}
            onGemRequestTemplate={changeGemRequestTemplate}
            variantConfig={variantConfig}
            onVariantConfig={changeVariantConfig}
            autoQueue={autoQueue}
            busy={busy}
            onProduct={setSelectedProduct}
            onGem={setSelectedGem}
            onTikTokAccount={setSelectedTikTokAccount}
            onDuration={setSelectedDuration}
            onRegion={setSelectedRegion}
            onShootingStyle={setSelectedShootingStyle}
            onAddTikTokAccount={() => setTikTokAccountOpen(true)}
            onManageTikTokAccounts={() => setTikTokAccountManagerOpen(true)}
            onChooseArchiveDirectory={chooseSelectedArchiveDirectory}
            onAutoQueue={setAutoQueue}
            onRun={runTask}
            onPreview={openTask}
            onNavigate={goTo}
          />
        )}
        {page === "scripts" && (
          <ScriptPipelinePage
            tasks={data.scriptPipelineTasks}
            geminiAccounts={(data.integrations.geminiRuntime?.accounts || []).filter(account => account.enabled !== false)}
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
            geminiAccounts={(data.integrations.geminiRuntime?.accounts || []).filter(account => account.enabled !== false)}
            defaultGeminiAccountId={
              data.integrations.geminiRuntime?.defaultAccountId || ""
            }
            tiktokAccounts={data.tiktokAccounts}
            integrations={data.integrations}
            onReload={reload}
            onNotice={setNotice}
          />
        )}
        {page === 'fission' && <FissionPage products={data.products} gems={data.gems} accounts={data.tiktokAccounts}
          gemRequestTemplate={gemRequestTemplate}
          request={api} onUpload={quickUploadProduct} onOpenTask={openTask} statusLabel={taskStatusLabel}
          onCreated={async(autoQueue)=>{try{await desktopBridge()?.setQueueRunning?.(true);if(autoQueue)await desktopBridge()?.seedanceSetRunning?.(true);}catch{setNotice('任务已保存，请在账号与设置中启动队列');}await reload();}} />}
        {page === "products" && (
          <ProductsPage
            products={data.products}
            onImported={reload}
            onAdd={() => setProductOpen(true)}
            onEdit={setEditingProduct}
            onCreate={(product) => { setSelectedProduct(product.id); setProductMode("library"); goTo("dashboard"); window.scrollTo(0, 0); setNotice(`已带入商品 ${product.external_id || product.name || ""} 的图片，可直接选择 Gem 制作`); }}
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
            counts={data.taskCounts}
            initialFilter={taskFilter}
            geminiRuntime={data.integrations.geminiRuntime}
            onPreview={openTask}
            onDelete={(task) => deleteRecord("/api/tasks", task.id, GROUP_ROLES.includes(task.task_role||'')
              ? `确认删除这一整组任务（含 ${task.children?.length || 0} 条视频记录）？已下载到待检查文件夹的视频文件会保留。`
              : "确认删除这个任务？")}
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
      {tiktokAccountManagerOpen && data && (
        <TikTokAccountManager
          accounts={data.tiktokAccounts}
          selected={selectedTikTokAccount}
          onClose={() => setTikTokAccountManagerOpen(false)}
          onSelect={name => { setSelectedTikTokAccount(name); setTikTokAccountManagerOpen(false); }}
          onAdd={addTikTokAccount}
          onUpdate={updateTikTokAccount}
          onDelete={deleteTikTokAccount}
        />
      )}
      {previewTask && (
        <PromptDrawer
          key={previewTask.id}
          task={previewTask}
          gems={data.gems}
          onOpenTask={openTask}
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
