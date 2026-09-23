const api = window.geminiWorkbench;
let state = null;

const byId = (id) => document.getElementById(id);

function escapeText(value) {
  return String(value == null ? "" : value);
}

function renderAccounts() {
  const list = byId("account-list");
  const empty = byId("empty-accounts");
  list.replaceChildren();
  empty.hidden = state.accounts.length > 0;
  const template = byId("account-template");
  for (const account of state.accounts) {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector(".account-card");
    card.dataset.id = account.id;
    card.classList.toggle("authenticated", Boolean(account.authenticated));
    card.classList.toggle("default", state.defaultAccountId === account.id);
    fragment.querySelector("h3").textContent = escapeText(account.name);
    fragment.querySelector(".account-state").textContent = account.authenticated
      ? "已登录 · 可接收 Gemini 网页任务"
      : account.error || "未登录";
    list.appendChild(fragment);
  }
}

function renderJobs() {
  const list = byId("job-list");
  const jobs = state.bridge.activeJobs || [];
  list.replaceChildren();
  byId("empty-jobs").hidden = jobs.length > 0;
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "job";
    const left = document.createElement("b");
    left.textContent = `${job.accountName} · ${job.taskId.slice(0, 8)}`;
    const stage = document.createElement("span");
    stage.textContent = job.stage;
    row.append(left, stage);
    list.appendChild(row);
  }
}

function renderLogs() {
  const logs = byId("logs");
  logs.replaceChildren();
  for (const item of state.logs.slice().reverse()) {
    const row = document.createElement("div");
    row.className = `log ${item.level || ""}`;
    row.textContent = `[${new Date(item.time).toLocaleString()}] ${item.message}`;
    logs.appendChild(row);
  }
}

function render() {
  if (!state) return;
  const authenticated = state.accounts.filter(
    (account) => account.authenticated
  ).length;
  byId("account-count").textContent = String(authenticated);
  byId("active-count").textContent = String(
    state.bridge.activeJobs?.length || 0
  );
  byId("queue-label").textContent = state.settings.queueRunning
    ? "运行中"
    : "已暂停";
  byId("queue-toggle").textContent = state.settings.queueRunning
    ? "暂停接单"
    : "继续接单";
  byId("flowcut-url").value = state.settings.flowcutUrl;
  byId("bridge-key").placeholder = state.settings.hasBridgeKey
    ? "已读取；留空表示不更换"
    : "请粘贴本机 Bridge Key";
  const bridgeStatus = byId("bridge-status");
  bridgeStatus.classList.toggle("offline", !state.bridge.online);
  bridgeStatus.textContent = state.bridge.online
    ? "FlowCut 本机桥已连接"
    : "FlowCut 本机桥未连接";
  byId("last-error").textContent = state.bridge.lastError || "";
  renderAccounts();
  renderJobs();
  renderLogs();
}

async function invoke(action) {
  try {
    state = await action();
    render();
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}

byId("add-account").addEventListener("click", () => {
  const dialog = byId("account-name-dialog");
  byId("account-name").value = `Gemini Pro ${state.accounts.length + 1}`;
  dialog.showModal();
  byId("account-name").focus();
  byId("account-name").select();
});

byId("cancel-account-name").addEventListener("click", () => {
  byId("account-name-dialog").close();
});

byId("account-name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = byId("account-name").value.trim();
  if (!name) return;
  byId("account-name-dialog").close();
  void invoke(() => api.addAccount(name));
});

byId("account-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const card = event.target.closest(".account-card");
  if (!button || !card) return;
  const id = card.dataset.id;
  const action = button.dataset.action;
  if (action === "open") void invoke(() => api.openLogin(id).then(() => api.getState()));
  if (action === "save-login") void invoke(() => api.hideLogin(id));
  if (action === "check") void invoke(() => api.checkAccount(id));
  if (action === "default") void invoke(() => api.setDefaultAccount(id));
  if (
    action === "remove" &&
    confirm("移除该账号并清除它在执行器中的独立登录数据？")
  ) {
    void invoke(() => api.removeAccount(id));
  }
});

byId("queue-toggle").addEventListener("click", () => {
  void invoke(() => api.setQueueRunning(!state.settings.queueRunning));
});

byId("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void invoke(() =>
    api.saveSettings({
      flowcutUrl: byId("flowcut-url").value.trim(),
      bridgeKey: byId("bridge-key").value.trim(),
    })
  );
  byId("bridge-key").value = "";
});

api.onState((next) => {
  state = next;
  render();
});

void invoke(() => api.getState());
