"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Device = {
  id: string;
  deviceName: string;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

type User = {
  id: string;
  username: string;
  status: string;
  expiresAt: string | null;
  planCode: string;
  maxDevices: number;
  maxConcurrent: number;
  offlineGraceHours: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
  devices: Device[];
};

type Plan = {
  code: string;
  name: string;
  monthlyPriceYuan: number;
  maxDevices: number;
  maxConcurrent: number;
  termPrices: Record<string, number>;
};

type Payment = {
  id: string;
  userId: string;
  username: string;
  planCode: string;
  months: number;
  amountYuan: number;
  paymentMethod: string;
  reference: string;
  periodEndsAt: string;
  createdAt: string;
};

type Overview = {
  users: User[];
  plans: Plan[];
  payments: Payment[];
  generatedAt: string;
  stats: {
    totalUsers: number;
    activeUsers: number;
    activeDevices: number;
    expiringSoon: number;
    currentMonthRevenueYuan: number;
  };
};

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || `请求失败：${response.status}`));
  return data;
}

function defaultExpiry() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return localInput(date.toISOString());
}

function localInput(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatTime(value: string | null) {
  if (!value) return "长期有效";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AdminApp() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [login, setLogin] = useState({ username: "admin", password: "" });
  const [message, setMessage] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [renewing, setRenewing] = useState<User | null>(null);
  const [passwordUser, setPasswordUser] = useState<User | null>(null);
  const backupInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = (await requestJson("/api/admin/license")) as unknown as Overview;
      setOverview(data);
    } catch {
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      await requestJson("/api/admin/login", {
        method: "POST",
        body: JSON.stringify(login),
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function action(payload: Record<string, unknown>) {
    setMessage("");
    try {
      const data = (await requestJson("/api/admin/license", {
        method: "POST",
        body: JSON.stringify(payload),
      })) as unknown as Overview;
      setOverview(data);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function exportBackup() {
    setMessage("");
    try {
      const response = await fetch("/api/admin/backup", { cache: "no-store" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `导出失败：${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `flowcut-license-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("授权账号备份已下载，请妥善保管");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setMessage("");
    try {
      const backup = JSON.parse(await file.text()) as Record<string, unknown>;
      await requestJson("/api/admin/backup", {
        method: "POST",
        body: JSON.stringify({ backup }),
      });
      await load();
      setMessage("授权账号和设备记录已导入");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  if (loading) {
    return <main className="license-shell"><div className="license-loading">正在连接 FlowCut 授权中心…</div></main>;
  }

  if (!overview) {
    return (
      <main className="license-shell">
        <section className="license-login-card">
          <div className="license-brand"><span>FC</span><div><b>FlowCut Control</b><small>桌面客户端授权中心</small></div></div>
          <h1>管理员登录</h1>
          <p>管理可使用 FlowCut 的账号、设备数量和有效期。</p>
          <form onSubmit={submitLogin}>
            <label>管理员账号<input value={login.username} onChange={(event) => setLogin({ ...login, username: event.target.value })} autoComplete="username" /></label>
            <label>密码<input type="password" value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} autoComplete="current-password" autoFocus /></label>
            {message && <div className="license-error">{message}</div>}
            <button type="submit">进入授权中心</button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="license-admin">
      <header className="license-topbar">
        <div className="license-brand"><span>FC</span><div><b>FlowCut Control</b><small>授权与设备管理</small></div></div>
        <div className="license-top-actions">
          <button className="secondary" onClick={() => void load()}>刷新</button>
          <button className="secondary" onClick={() => void exportBackup()}>导出备份</button>
          <button className="secondary" onClick={() => backupInput.current?.click()}>导入备份</button>
          <input
            ref={backupInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void importBackup(event)}
          />
          <button onClick={() => setShowCreate(true)}>+ 新建账号</button>
          <button className="ghost" onClick={async () => { await requestJson("/api/admin/logout", { method: "POST" }); setOverview(null); }}>退出</button>
        </div>
      </header>
      <section className="license-content">
        <div className="license-heading"><div><p>SUBSCRIPTION CONTROL</p><h1>账号、套餐与续费</h1><span>当前采用后台人工开通与续费；收费确认后点击续费，客户端会自动同步新的有效期。</span></div></div>
        <div className="license-stats">
          <Stat label="账号总数" value={overview.stats.totalUsers} />
          <Stat label="有效账号" value={overview.stats.activeUsers} tone="green" />
          <Stat label="已绑定设备" value={overview.stats.activeDevices} tone="blue" />
          <Stat label="7 天内到期" value={overview.stats.expiringSoon} tone="orange" />
          <Stat label="本月已登记收入" value={`¥${overview.stats.currentMonthRevenueYuan.toLocaleString("zh-CN")}`} tone="green" />
        </div>
        <div className="plan-strip">
          {overview.plans.filter((plan) => plan.code !== "trial").map((plan) => (
            <article key={plan.code}>
              <div><b>{plan.name}</b><span>{plan.code === "custom" ? "价格面议" : `¥${plan.monthlyPriceYuan}/月`}</span></div>
              <small>{plan.code === "custom" ? "设备与每台并发由管理员自定义" : `${plan.maxDevices} 台设备 · 每台${plan.maxConcurrent >= 999 ? "不限并发" : `最多 ${plan.maxConcurrent} 条并发`}`}</small>
            </article>
          ))}
        </div>
        {message && <div className="license-error wide">{message}</div>}
        <div className="license-table-wrap">
          <table className="license-table">
            <thead><tr><th>账号</th><th>套餐</th><th>状态</th><th>有效期</th><th>设备</th><th>每台并发</th><th>离线宽限</th><th>备注</th><th>操作</th></tr></thead>
            <tbody>
              {overview.users.map((user) => {
                const expired = Boolean(
                  user.expiresAt &&
                    new Date(user.expiresAt).getTime() <=
                      new Date(overview.generatedAt).getTime(),
                );
                const activeDevices = user.devices.filter((device) => device.status === "active").length;
                return (
                  <tr key={user.id}>
                    <td><b>{user.username}</b><small>创建于 {formatTime(user.createdAt)}</small></td>
                    <td><b>{overview.plans.find((plan) => plan.code === user.planCode)?.name || user.planCode}</b></td>
                    <td><span className={`license-status ${user.status === "active" && !expired ? "active" : "blocked"}`}>{expired ? "已到期" : user.status === "active" ? "使用中" : "已停用"}</span></td>
                    <td>{formatTime(user.expiresAt)}</td>
                    <td><b>{activeDevices} / {user.maxDevices}</b>{user.devices.length > 0 && <details><summary>查看设备</summary><div className="device-list">{user.devices.map((device) => <div key={device.id}><div><b>{device.deviceName || "Windows 设备"}</b><small>最近：{formatTime(device.lastSeenAt)}</small></div><button className={device.status === "active" ? "danger-link" : "text-link"} onClick={() => void action({ action: device.status === "active" ? "revokeDevice" : "allowDevice", deviceId: device.id })}>{device.status === "active" ? "撤销" : "恢复"}</button><button className="text-link" onClick={() => void action({ action: "removeDevice", deviceId: device.id })}>解绑</button></div>)}</div></details>}</td>
                    <td><b>{user.maxConcurrent >= 999 ? "不限" : user.maxConcurrent}</b></td>
                    <td>{user.offlineGraceHours} 小时</td>
                    <td className="notes">{user.notes || "—"}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={() => setRenewing(user)}>续费</button>
                        <button className="secondary" onClick={() => setEditing(user)}>编辑</button>
                        <button className="secondary" onClick={() => setPasswordUser(user)}>改密码</button>
                        <button
                          className="danger-link"
                          onClick={() => {
                            if (
                              window.confirm(
                                `确认永久删除账号“${user.username}”？该账号的设备绑定和登录会话也会一并删除。`
                              )
                            ) {
                              void action({ action: "deleteUser", userId: user.id });
                            }
                          }}
                        >
                          删除账号
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!overview.users.length && <tr><td colSpan={8} className="empty">还没有授权账号，点击右上角“新建账号”。</td></tr>}
            </tbody>
          </table>
        </div>
        <section className="payment-history">
          <div><p>BILLING LOG</p><h2>最近续费记录</h2></div>
          {overview.payments.length ? (
            <div className="payment-list">
              {overview.payments.slice(0, 20).map((payment) => (
                <article key={payment.id}>
                  <div><b>{payment.username}</b><small>{overview.plans.find((plan) => plan.code === payment.planCode)?.name || payment.planCode} · {payment.months} 个月</small></div>
                  <strong>¥{payment.amountYuan.toLocaleString("zh-CN")}</strong>
                  <span>{payment.paymentMethod === "wechat" ? "微信" : payment.paymentMethod === "alipay" ? "支付宝" : payment.paymentMethod === "bank" ? "银行转账" : "人工登记"}</span>
                  <time>{formatTime(payment.createdAt)}</time>
                </article>
              ))}
            </div>
          ) : <div className="empty">还没有续费记录。</div>}
        </section>
      </section>
      {showCreate && <UserModal title="新建授权账号" submitLabel="创建账号" plans={overview.plans} onClose={() => setShowCreate(false)} onSubmit={async (values) => { const ok = await action({ action: "createUser", ...values }); if (ok) setShowCreate(false); }} />}
      {editing && <UserModal title={`编辑 ${editing.username}`} submitLabel="保存修改" user={editing} plans={overview.plans} onClose={() => setEditing(null)} onSubmit={async (values) => { const ok = await action({ action: "updateUser", userId: editing.id, ...values }); if (ok) setEditing(null); }} />}
      {renewing && <RenewalModal user={renewing} plans={overview.plans} onClose={() => setRenewing(null)} onSubmit={async (values) => { const ok = await action({ action: "renewUser", userId: renewing.id, ...values }); if (ok) setRenewing(null); }} />}
      {passwordUser && <PasswordModal username={passwordUser.username} onClose={() => setPasswordUser(null)} onSubmit={async (password) => { const ok = await action({ action: "resetPassword", userId: passwordUser.id, password }); if (ok) setPasswordUser(null); }} />}
    </main>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: number | string; tone?: string }) {
  return <div className={`license-stat ${tone}`}><small>{label}</small><b>{value}</b></div>;
}

function UserModal({ title, submitLabel, user, plans, onClose, onSubmit }: { title: string; submitLabel: string; user?: User; plans: Plan[]; onClose: () => void; onSubmit: (values: Record<string, unknown>) => void | Promise<void> }) {
  const initialPlan = plans.find((plan) => plan.code === (user?.planCode || "starter")) || plans[0];
  const [values, setValues] = useState({
    username: user?.username || "",
    password: "",
    status: user?.status || "active",
    expiresAt: user ? localInput(user.expiresAt || null) : defaultExpiry(),
    planCode: user?.planCode || "starter",
    maxDevices: user?.maxDevices || initialPlan?.maxDevices || 1,
    maxConcurrent: user?.maxConcurrent || initialPlan?.maxConcurrent || 1,
    offlineGraceHours: user?.offlineGraceHours || 24,
    notes: user?.notes || "",
  });
  const valid = useMemo(() => Boolean(user || (values.username && values.password.length >= 8)), [user, values]);
  return <div className="license-modal-backdrop"><form className="license-modal" onSubmit={(event) => { event.preventDefault(); void onSubmit(values); }}><div className="modal-head"><h2>{title}</h2><button type="button" className="ghost" onClick={onClose}>×</button></div>{!user && <><label>登录账号<input value={values.username} onChange={(event) => setValues({ ...values, username: event.target.value.toLowerCase() })} placeholder="例如：team-01" required /></label><label>初始密码<input type="password" value={values.password} onChange={(event) => setValues({ ...values, password: event.target.value })} placeholder="至少 8 位" required /></label></>}<div className="two-col">{user && <label>状态<select value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value })}><option value="active">允许使用</option><option value="suspended">停用账号</option></select></label>}<label>套餐<select value={values.planCode} onChange={(event) => { const plan = plans.find((item) => item.code === event.target.value); setValues({ ...values, planCode: event.target.value, maxDevices: plan?.maxDevices || values.maxDevices, maxConcurrent: plan?.maxConcurrent || values.maxConcurrent }); }}>{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}{plan.monthlyPriceYuan ? ` · ¥${plan.monthlyPriceYuan}/月` : plan.code === "custom" ? " · 价格面议" : ""}</option>)}</select></label><label>到期时间<input type="datetime-local" value={values.expiresAt} onChange={(event) => setValues({ ...values, expiresAt: event.target.value })} /></label><label>设备上限<input type="number" min={1} max={100} value={values.maxDevices} disabled={values.planCode !== "custom"} onChange={(event) => setValues({ ...values, maxDevices: Number(event.target.value) })} /></label><label>每台设备并发上限<input type="number" min={1} max={999} value={values.maxConcurrent} disabled={values.planCode !== "custom"} onChange={(event) => setValues({ ...values, maxConcurrent: Number(event.target.value) })} /><small>{values.maxConcurrent >= 999 ? "不限并发" : `每台设备最多同时执行 ${values.maxConcurrent} 条任务`}</small></label><label>离线宽限（小时）<input type="number" min={1} max={168} value={values.offlineGraceHours} onChange={(event) => setValues({ ...values, offlineGraceHours: Number(event.target.value) })} /></label></div><label>备注<textarea value={values.notes} onChange={(event) => setValues({ ...values, notes: event.target.value })} placeholder="例如：客户来源、联系方式、特殊约定" /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" disabled={!valid}>{submitLabel}</button></div></form></div>;
}

function RenewalModal({ user, plans, onClose, onSubmit }: { user: User; plans: Plan[]; onClose: () => void; onSubmit: (values: Record<string, unknown>) => void | Promise<void> }) {
  const initialPlan = plans.find((item) => item.code === user.planCode) || plans[0];
  const initialAmount = Number(initialPlan?.termPrices?.["1"] ?? initialPlan?.monthlyPriceYuan ?? 0);
  const [values, setValues] = useState({ planCode: user.planCode, months: 1, paymentMethod: "wechat", amountYuan: initialAmount, reference: "" });
  const plan = plans.find((item) => item.code === values.planCode) || plans[0];
  const suggested = Number(plan?.termPrices?.[String(values.months)] ?? (plan?.monthlyPriceYuan || 0) * values.months);
  return <div className="license-modal-backdrop"><form className="license-modal small" onSubmit={(event) => { event.preventDefault(); void onSubmit(values); }}><div className="modal-head"><h2>为 {user.username} 续费</h2><button type="button" className="ghost" onClick={onClose}>×</button></div><p>当前有效期：{formatTime(user.expiresAt)}。续费会从当前到期时间继续顺延；如果已经到期，则从现在开始计算。</p><label>套餐<select value={values.planCode} onChange={(event) => { const nextPlan = plans.find((item) => item.code === event.target.value); const amountYuan = Number(nextPlan?.termPrices?.[String(values.months)] ?? (nextPlan?.monthlyPriceYuan || 0) * values.months); setValues({ ...values, planCode: event.target.value, amountYuan }); }}>{plans.filter((item) => item.code !== "trial").map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><div className="two-col"><label>续费周期<select value={values.months} onChange={(event) => { const months = Number(event.target.value); const amountYuan = Number(plan?.termPrices?.[String(months)] ?? (plan?.monthlyPriceYuan || 0) * months); setValues({ ...values, months, amountYuan }); }}><option value={1}>1 个月</option><option value={3}>3 个月</option><option value={12}>12 个月</option></select></label><label>实收金额（元）<input type="number" min={0} step="0.01" value={values.amountYuan} onChange={(event) => setValues({ ...values, amountYuan: Number(event.target.value) })} /></label><label>收款方式<select value={values.paymentMethod} onChange={(event) => setValues({ ...values, paymentMethod: event.target.value })}><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行转账</option><option value="cash">现金</option><option value="other">其他</option></select></label></div><label>备注 / 流水号<textarea value={values.reference} onChange={(event) => setValues({ ...values, reference: event.target.value })} placeholder="选填，便于以后核账" /></label><div className="renewal-summary"><span>建议价格</span><b>¥{suggested.toLocaleString("zh-CN")}</b><small>{plan?.name} · {values.months} 个月</small></div><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit">确认收款并续费</button></div></form></div>;
}

function PasswordModal({ username, onClose, onSubmit }: { username: string; onClose: () => void; onSubmit: (password: string) => void | Promise<void> }) {
  const [password, setPassword] = useState("");
  return <div className="license-modal-backdrop"><form className="license-modal small" onSubmit={(event) => { event.preventDefault(); void onSubmit(password); }}><div className="modal-head"><h2>重置 {username} 的密码</h2><button type="button" className="ghost" onClick={onClose}>×</button></div><p>保存后该账号在所有设备上的现有登录都会失效。</p><label>新密码<input type="password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required /></label><div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" disabled={password.length < 8}>确认重置</button></div></form></div>;
}
