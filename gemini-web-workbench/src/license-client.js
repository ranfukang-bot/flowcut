const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { net, safeStorage } = require("electron");
const distribution = require("./license-distribution.json");

const configuredControlPlanes = Array.isArray(distribution.controlPlanes)
  ? distribution.controlPlanes
      .filter((item) => item?.id && item?.url && item?.publicJwk)
      .map((item) => ({
        ...item,
        url: String(item.url).replace(/\/+$/, ""),
      }))
  : [];
if (!configuredControlPlanes.length) {
  throw new Error("FlowCut 安装包没有可信授权中心配置");
}
const DEFAULT_CONTROL_PLANE_ID =
  distribution.defaultControlPlaneId || configuredControlPlanes[0].id;
const LEGACY_CONTROL_PLANE_ID =
  distribution.legacyControlPlaneId || DEFAULT_CONTROL_PLANE_ID;
const CONTROL_PLANES = process.env.FLOWCUT_CONTROL_PLANE_URL
  ? [
      {
        ...configuredControlPlanes.find(
          (item) => item.id === DEFAULT_CONTROL_PLANE_ID,
        ),
        id: "environment-override",
        url: String(process.env.FLOWCUT_CONTROL_PLANE_URL).replace(/\/+$/, ""),
      },
      ...configuredControlPlanes,
    ]
  : configuredControlPlanes;
const DEFAULT_CONTROL_PLANE =
  (process.env.FLOWCUT_CONTROL_PLANE_URL
    ? CONTROL_PLANES[0]
    : CONTROL_PLANES.find(
        (item) => item.id === DEFAULT_CONTROL_PLANE_ID,
      )) || CONTROL_PLANES[0];
const CONTROL_PLANE_URL = DEFAULT_CONTROL_PLANE.url;

function base64UrlBuffer(value) {
  return Buffer.from(
    String(value || "").replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

function machineId() {
  try {
    const output = execFileSync(
      "reg.exe",
      [
        "QUERY",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 4000 },
    );
    const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    if (match?.[1]) return match[1].trim();
  } catch {
    // Fall back to stable OS information if registry access is restricted.
  }
  return `${os.hostname()}|${os.platform()}|${os.arch()}|${os.cpus()[0]?.model || ""}`;
}

class LicenseClient {
  constructor(app, { version = "0.0.0", onChange = () => {}, onBlocked = () => {} } = {}) {
    this.app = app;
    this.version = version;
    this.onChange = onChange;
    this.onBlocked = onBlocked;
    this.filePath = path.join(app.getPath("userData"), "license-state.json");
    this.fingerprintHash = crypto
      .createHash("sha256")
      .update(`flowcut-device-v1|${machineId()}`)
      .digest("hex");
    this.deviceName = `${os.hostname()} · Windows ${os.release()}`;
    this.timer = null;
    this.busy = false;
    this.state = {
      status: "checking",
      authorized: false,
      offline: false,
      username: "",
      expiresAt: null,
      planCode: "",
      planName: "",
      maxDevices: 1,
      maxConcurrent: 1,
      leaseExpiresAt: null,
      lastCheckedAt: null,
      error: "",
    };
    this.saved = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      let sessionToken = "";
      if (parsed.sessionTokenEncrypted && safeStorage.isEncryptionAvailable()) {
        sessionToken = safeStorage.decryptString(
          Buffer.from(parsed.sessionTokenEncrypted, "base64"),
        );
      }
      return {
        sessionToken,
        lease: String(parsed.lease || ""),
        username: String(parsed.username || ""),
        controlPlaneId: String(
          parsed.controlPlaneId || LEGACY_CONTROL_PLANE_ID,
        ),
      };
    } catch {
      return {
        sessionToken: "",
        lease: "",
        username: "",
        controlPlaneId: DEFAULT_CONTROL_PLANE.id,
      };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = {
      lease: this.saved.lease,
      username: this.saved.username,
      controlPlaneId: this.saved.controlPlaneId,
      sessionTokenEncrypted:
        this.saved.sessionToken && safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(this.saved.sessionToken).toString("base64")
          : "",
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  publicState() {
    return {
      ...this.state,
      controlPlaneUrl: this.activeControlPlane().url,
    };
  }

  activeControlPlane(controlPlaneId = this.saved.controlPlaneId) {
    return (
      CONTROL_PLANES.find((item) => item.id === controlPlaneId) ||
      DEFAULT_CONTROL_PLANE
    );
  }

  emit() {
    this.onChange(this.publicState());
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.emit();
  }

  async verifySignedToken(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) throw new Error("本机授权凭证格式错误");
    let valid = false;
    for (const controlPlane of CONTROL_PLANES) {
      const key = await crypto.webcrypto.subtle.importKey(
        "jwk",
        controlPlane.publicJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      valid = await crypto.webcrypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        base64UrlBuffer(parts[2]),
        Buffer.from(`${parts[0]}.${parts[1]}`),
      );
      if (valid) break;
    }
    if (!valid) throw new Error("FlowCut 云端签名无效");
    const payload = JSON.parse(base64UrlBuffer(parts[1]).toString("utf8"));
    if (Number(payload.nbf || 0) * 1000 > Date.now() + 10_000) {
      throw new Error("FlowCut 云端凭证尚未生效");
    }
    if (Number(payload.exp || 0) * 1000 <= Date.now()) {
      throw new Error("FlowCut 云端凭证已经过期");
    }
    return payload;
  }

  async verifyLease(token) {
    const payload = await this.verifySignedToken(token);
    if (payload.aud !== "flowcut-desktop") throw new Error("授权凭证用途不正确");
    if (payload.deviceId == null) throw new Error("授权凭证没有绑定设备");
    if (
      payload.licenseExpiresAt &&
      new Date(payload.licenseExpiresAt).getTime() <= Date.now()
    ) {
      throw new Error("账号授权已到期");
    }
    return payload;
  }

  async authorizeExecution({ taskId, stage, kind = "standard" } = {}) {
    const normalizedTaskId = String(taskId || "").trim();
    const normalizedStage = String(stage || "").trim().toLowerCase();
    if (!normalizedTaskId || !["gemini", "seedance"].includes(normalizedStage)) {
      const error = new Error("任务执行许可参数不完整");
      error.code = "EXECUTION_PERMIT_INVALID";
      throw error;
    }
    if (!this.saved.sessionToken || !this.state.authorized) {
      const error = new Error("FlowCut 授权已失效，请重新登录");
      error.code = "EXECUTION_PERMIT_REQUIRED";
      throw error;
    }
    try {
      const data = await this.request("/api/license/permit", {
        sessionToken: this.saved.sessionToken,
        fingerprintHash: this.fingerprintHash,
        deviceName: this.deviceName,
        appVersion: this.version,
        taskId: normalizedTaskId,
        stage: normalizedStage,
        kind: String(kind || "standard"),
      });
      const permit = String(data.permit || "");
      const payload = await this.verifySignedToken(permit);
      if (
        payload.aud !== "flowcut-execution" ||
        payload.taskId !== normalizedTaskId ||
        payload.stage !== normalizedStage ||
        payload.fingerprintHash !== this.fingerprintHash
      ) {
        throw new Error("云端任务许可与当前设备或任务不匹配");
      }
      return { permit, payload };
    } catch (error) {
      const blocked = Number(error.status || 0) === 401 || Number(error.status || 0) === 403;
      if (blocked) {
        this.setState({
          status: "blocked",
          authorized: false,
          offline: false,
          error: error instanceof Error ? error.message : String(error),
        });
        this.onBlocked(this.publicState());
      }
      error.code ||= "EXECUTION_PERMIT_REQUIRED";
      throw error;
    }
  }

  applyLease(
    lease,
    account,
    offline = false,
    controlPlaneId = this.saved.controlPlaneId,
  ) {
    this.saved.lease = lease;
    this.saved.controlPlaneId = controlPlaneId;
    if (account?.username) this.saved.username = account.username;
    this.save();
    return this.verifyLease(lease).then((payload) => {
      this.setState({
        status: offline ? "offline" : "authorized",
        authorized: true,
        offline,
        username: String(payload.username || this.saved.username),
        expiresAt: payload.licenseExpiresAt || null,
        planCode: String(payload.planCode || "starter"),
        planName: String(payload.planName || "基础版"),
        maxDevices: Number(payload.maxDevices || 1),
        maxConcurrent: Number(payload.maxConcurrent || 1),
        leaseExpiresAt: new Date(Number(payload.exp) * 1000).toISOString(),
        lastCheckedAt: offline ? this.state.lastCheckedAt : new Date().toISOString(),
        error: offline ? "授权中心暂时无法连接，当前使用离线宽限" : "",
      });
      return this.publicState();
    });
  }

  async request(
    pathname,
    body,
    controlPlaneId = this.saved.controlPlaneId,
  ) {
    const controlPlane = this.activeControlPlane(controlPlaneId);
    let response;
    try {
      response = await net.fetch(`${controlPlane.url}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      error.networkFailure = true;
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `授权中心请求失败：${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async login(username, password) {
    this.setState({ status: "checking", error: "" });
    const controlPlaneId = DEFAULT_CONTROL_PLANE.id;
    const data = await this.request(
      "/api/license/login",
      {
        username,
        password,
        fingerprintHash: this.fingerprintHash,
        deviceName: this.deviceName,
        appVersion: this.version,
      },
      controlPlaneId,
    );
    this.saved.sessionToken = String(data.sessionToken || "");
    this.saved.username = String(data.account?.username || username);
    return this.applyLease(
      String(data.lease || ""),
      data.account,
      false,
      controlPlaneId,
    );
  }

  async refresh({ allowOffline = true } = {}) {
    if (this.busy) return this.publicState();
    this.busy = true;
    try {
      if (!this.saved.sessionToken) {
        throw new Error("请先使用 FlowCut 授权账号登录");
      }
      const data = await this.request("/api/license/lease", {
        sessionToken: this.saved.sessionToken,
        fingerprintHash: this.fingerprintHash,
        deviceName: this.deviceName,
        appVersion: this.version,
      });
      return await this.applyLease(String(data.lease || ""), data.account, false);
    } catch (error) {
      if (allowOffline && error.networkFailure && this.saved.lease) {
        try {
          await this.applyLease(this.saved.lease, null, true);
          return this.publicState();
        } catch (offlineError) {
          error = offlineError;
        }
      }
      const blocked = Number(error.status || 0) === 401 || Number(error.status || 0) === 403;
      this.setState({
        status: blocked ? "blocked" : "login_required",
        authorized: false,
        offline: false,
        error: error instanceof Error ? error.message : String(error),
      });
      if (blocked) this.onBlocked(this.publicState());
      return this.publicState();
    } finally {
      this.busy = false;
    }
  }

  async initialize() {
    if (
      this.saved.controlPlaneId === LEGACY_CONTROL_PLANE_ID &&
      LEGACY_CONTROL_PLANE_ID !== DEFAULT_CONTROL_PLANE_ID
    ) {
      const legacyUsername = this.saved.username;
      this.saved = {
        sessionToken: "",
        lease: "",
        username: "",
        controlPlaneId: DEFAULT_CONTROL_PLANE.id,
      };
      this.save();
      this.setState({
        status: "login_required",
        authorized: false,
        offline: false,
        username: "",
        expiresAt: null,
        planCode: "",
        planName: "",
        maxDevices: 1,
        maxConcurrent: 1,
        leaseExpiresAt: null,
        error: legacyUsername
          ? `授权中心已升级，请使用正式账号重新登录（原账号：${legacyUsername}）`
          : "授权中心已升级，请使用正式账号重新登录",
      });
      this.startHeartbeat();
      return this.publicState();
    }
    const state = await this.refresh({ allowOffline: true });
    this.startHeartbeat();
    return state;
  }

  startHeartbeat() {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh({ allowOffline: true }), 5 * 60_000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async logout() {
    const token = this.saved.sessionToken;
    const controlPlaneId = this.saved.controlPlaneId;
    this.saved = {
      sessionToken: "",
      lease: "",
      username: "",
      controlPlaneId: DEFAULT_CONTROL_PLANE.id,
    };
    this.save();
    if (token) {
      await this.request(
        "/api/license/logout",
        { sessionToken: token },
        controlPlaneId,
      ).catch(() => {});
    }
    this.setState({
      status: "login_required",
      authorized: false,
      offline: false,
      username: "",
      expiresAt: null,
      planCode: "",
      planName: "",
      maxDevices: 1,
      maxConcurrent: 1,
      leaseExpiresAt: null,
      error: "",
    });
    return this.publicState();
  }
}

module.exports = { LicenseClient, CONTROL_PLANE_URL };
