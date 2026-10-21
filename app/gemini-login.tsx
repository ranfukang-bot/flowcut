export type GeminiLoginState = {
  id: string; accountId: string; name: string; mode: "add" | "relogin";
  phase: "ready" | "waiting-for-user" | "importing" | "failed" | "missing";
  busy: boolean; error: string; downloadUrl: string;
};

export function GeminiLoginDialog({ flow, busy, onAction }: {
  flow: GeminiLoginState | null; busy: boolean;
  onAction: (action: "login-open" | "login-import" | "login-cancel") => void;
}) {
  if (!flow) return null;
  const locked = busy || flow.busy;
  return <div className="modal-backdrop">
    <section className="modal small-modal" role="dialog" aria-modal="true" aria-label="Firefox 登录 Gemini">
      <div className="form-body">
        <h3>{flow.mode === "relogin" ? "重新登录" : "添加 Gemini 账号"} · {flow.name}</h3>
        <p>Google 不允许在本程序里直接登录。请打开 Firefox，在那里登录 Google 并能看到 Gemini 页面后，回到这里点“我已登录”。</p>
        {flow.mode === "relogin" && <p>导入前会确认覆盖此账号的登录；失败或取消保留原登录。</p>}
        {flow.phase === "missing" && <p role="alert">未找到 Firefox。请先从 <a href={flow.downloadUrl} target="_blank" rel="noreferrer">Firefox 官网下载安装</a>，安装后点下方按钮重试。</p>}
        {flow.phase === "waiting-for-user" && <p>Firefox 登录窗口已打开，等待你完成登录。</p>}
        {flow.phase === "importing" && <p>正在导入并检查，请稍候…</p>}
        {flow.error && <p role="alert">{flow.error}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="secondary" disabled={locked} onClick={() => onAction("login-cancel")}>取消</button>
        <button type="button" className="secondary" disabled={locked || flow.phase === "waiting-for-user"} onClick={() => onAction("login-open")}>{flow.phase === "waiting-for-user" ? "Firefox 已打开" : "打开 Firefox 登录窗口"}</button>
        <button type="button" className="primary" disabled={locked || flow.phase !== "waiting-for-user"} onClick={() => onAction("login-import")}>{locked ? "处理中…" : "我已登录"}</button>
      </div>
    </section>
  </div>;
}
