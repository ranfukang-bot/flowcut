"use client";

import { useCallback, useEffect, useState } from 'react';
import { confirmAction } from './confirm-action';
import { GeminiModelSettingsPanel } from './gemini-model-settings';
import { GeminiAccountAccessButtons, GeminiLoginDialog, type GeminiLoginState } from './gemini-login';
import { LocalBackups } from './local-backups';
import { SeedanceQuotaChoice } from './seedance-quota';
import { api, desktopBridge } from './studio-client';
import type { Workspace, SeedanceDesktopState } from './studio-types';
import { PageIntro } from './studio-ui';

export function AccountNameEditor({ name, disabled, onSave }: {
  name: string; disabled: boolean; onSave: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState("");
  async function save() {
    const value = draft.trim();
    if (!value) { setError("账号名称不能为空"); return; }
    try { await onSave(value); setEditing(false); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "名称保存失败"); }
  }
  return <span className="account-name-editor">
    {editing ? <>
      <input aria-label="账号名称" value={draft} autoFocus disabled={disabled} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (!disabled) void save(); } else if (event.key === "Escape") { event.preventDefault(); setEditing(false); } }} />
      <button type="button" disabled={disabled} onClick={() => void save()}>保存名称</button>
      <button type="button" disabled={disabled} onClick={() => setEditing(false)}>取消</button>
      {error && <small role="alert">{error}</small>}
    </> : <><b>{name}</b><button type="button" disabled={disabled} onClick={() => { setDraft(name); setError(""); setEditing(true); }}>编辑名称</button></>}
  </span>;
}

export function SettingsPage({
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
  const [geminiLogin, setGeminiLogin] = useState<GeminiLoginState | null>(null);
  const [seedanceAccountName, setSeedanceAccountName] = useState("");

  async function updateManagedAccount(kind: "gemini" | "seedance", id: string, change: { name: string } | { enabled: boolean }) {
    const desktop = desktopBridge();
    if (!desktop) throw new Error("请在 FlowCut 桌面程序中管理账号");
    setBusy(`account-update-${id}`);
    try {
      if (kind === "gemini") {
        if ("name" in change) await desktop.renameAccount(id, change.name);
        else await desktop.setAccountEnabled(id, change.enabled);
      } else {
        setSeedanceDesktop("name" in change ? await desktop.seedanceRenameAccount(id, change.name) : await desktop.seedanceSetAccountEnabled(id, change.enabled));
      }
      await load();
      await onUpdated();
      setMessage("name" in change ? "账号名称已保存" : change.enabled ? "账号已恢复使用，后续任务可分配到此账号" : "账号已暂停使用，登录状态保留；正在执行的任务继续收尾");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号更新失败");
      throw error;
    } finally { setBusy(""); }
  }
  const [seedanceDesktop, setSeedanceDesktop] =
    useState<SeedanceDesktopState | null>(null);
  useEffect(() => desktopBridge()?.onState?.(state => {
    if (state.seedance) setSeedanceDesktop(state.seedance);
    if (state.geminiLogin !== undefined) setGeminiLogin(state.geminiLogin);
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
    const desktop = desktopBridge();
    const local = await desktop?.getState?.();
    setGeminiLogin(local?.geminiLogin || null);
    if (local?.accounts && result.gemini.runtime) {
      result.gemini.runtime = { ...result.gemini.runtime,
        accounts: local.accounts.map(account => ({ ...account, busy: local.bridge?.activeJobs.some(job => job.accountId === account.id) })),
        defaultAccountId: local.defaultAccountId,
      };
    }
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
          setMessage(result.message || "Gemini 网页执行器已连接");
          return;
        }
        await api("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, config: entries }),
        });
        setMessage("已切换为本机 Gemini 网页执行器");
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
    action: "add" | "view" | "open" | "login-open" | "login-import" | "login-cancel" | "check" | "default" | "remove",
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
        await desktop.addAccount(accountName.trim() || "Gemini 账号");
        setAccountName("");
        setMessage("请在对话框中打开 Firefox 并完成登录");
      } else if (action === "view") {
        if (!desktop.openGeminiAccountWindow) throw new Error("请更新 FlowCut 桌面程序后打开 Gemini");
        await desktop.openGeminiAccountWindow(accountId);
        setMessage("已打开该账号当前的 Gemini 页面，关闭窗口只会隐藏，不会中止任务");
      } else if (action === "open") {
        await desktop.openLogin(accountId);
        setMessage("请在对话框中通过 Firefox 重新登录");
      } else if (action === "login-open") {
        if (!desktop.openGeminiLoginBrowser) throw new Error("请更新 FlowCut 桌面程序");
        await desktop.openGeminiLoginBrowser();
        setMessage("请在 Firefox 中完成登录后回来点“我已登录”");
      } else if (action === "login-import") {
        if (!desktop.importGeminiLogin) throw new Error("请更新 FlowCut 桌面程序");
        const result = await desktop.importGeminiLogin();
        setMessage(result.geminiLoginResult === "cancelled" ? "已取消，原登录保持不变" : "Firefox 登录导入及检查成功，账号可正常使用");
      } else if (action === "login-cancel") {
        if (!desktop.cancelGeminiLogin) throw new Error("请更新 FlowCut 桌面程序");
        await desktop.cancelGeminiLogin();
        setMessage("已取消，临时登录资料已清理，原账号保持不变");
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
      <LocalBackups />
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
              ? "使用你本机已登录的 Gemini 网页版，按全局模型设置执行，自动上传全部商品图和所选 Gem 设定。"
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
                <option value="web">本机 Gemini 网页版</option>
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
                  登录使用 Firefox 临时窗口，已有登录账号可继续使用。
                  {!settings.gemini.runtime?.queueRunning && settings.gemini.runtime?.authenticated && (
                    <><br />账号可用；创建任务时会自动启动队列，测试连接不会启动任务。</>
                  )}
                </div>
                <GeminiModelSettingsPanel bridge={desktopBridge} />
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
                      className={account.enabled === false ? "account-paused" : account.authenticated ? "authenticated" : ""}
                      key={account.id}
                    >
                      <div>
                        <AccountNameEditor name={account.name} disabled={Boolean(busy)} onSave={name => updateManagedAccount("gemini", account.id, { name })} />
                        {settings.gemini.runtime?.defaultAccountId ===
                          account.id && <em>默认</em>}
                        <small>
                          {account.enabled === false ? `已暂停使用 · ${account.busy ? "当前任务完成后停止分配" : account.authenticated ? "登录状态保留" : "等待登录"}` : account.authenticated
                            ? account.busy
                              ? "已登录 · 正在生成"
                              : "已登录 · 空闲"
                            : "等待登录"}
                        </small>
                      </div>
                      <div>
                        <button type="button" disabled={Boolean(busy)} onClick={() => void updateManagedAccount("gemini", account.id, { enabled: account.enabled === false }).catch(() => {})}>
                          {account.enabled === false ? "恢复使用" : "暂停使用"}
                        </button>
                        <GeminiAccountAccessButtons disabled={Boolean(busy)}
                          onOpen={() => void desktopAccountAction("view", account.id)}
                          onRelogin={() => void desktopAccountAction("open", account.id)} />
                        <button
                          type="button"
                          onClick={() => desktopAccountAction("check", account.id)}
                        >
                          检查
                        </button>
                        {account.enabled !== false && settings.gemini.runtime?.defaultAccountId !==
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
                    className={account.enabled === false ? "account-paused" : account.authenticated ? "authenticated" : ""}
                    key={account.id}
                  >
                    <div>
                      <AccountNameEditor name={account.name} disabled={Boolean(busy)} onSave={name => updateManagedAccount("seedance", account.id, { name })} />
                      {account.active && <em>当前</em>}
                      {account.enabled === false && <small>已暂停使用 · 登录状态保留，已提交的视频继续处理</small>}
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
                      <small>Fast：{account.fastExhaustedToday ? "今日已上限" : "今日尚未检测到上限"} · 2.0：{account.standardExhaustedToday ? "今日已上限" : "今日尚未检测到上限"}</small>
                      {account.enabled !== false && seedanceDesktop?.accountState.allFastExhausted && account.fastExhaustedToday && account.preferredModel !== "2000004" && account.fallbackDecision !== "standard" && <SeedanceQuotaChoice account={account} onUpdated={setSeedanceDesktop} onError={setMessage} />}
                      <small>
                        {account.authenticated
                          ? account.exhaustedToday
                            ? "已登录 · 今日额度已满"
                            : `已登录 · 本机生成中 ${account.generatingCount || 0} 条 · API 不设本地并发上限`
                          : account.error || "等待登录"}
                      </small>
                    </div>
                    <div>
                      <button type="button" disabled={Boolean(busy)} onClick={() => void updateManagedAccount("seedance", account.id, { enabled: account.enabled === false }).catch(() => {})}>
                        {account.enabled === false ? "恢复使用" : "暂停使用"}
                      </button>
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
      <GeminiLoginDialog flow={geminiLogin} busy={busy.startsWith("account-")} onAction={action => void desktopAccountAction(action)} />
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
