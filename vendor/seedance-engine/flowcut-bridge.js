const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ACTIVE_STATUSES = new Set([
  'upload_wait',
  'uploading',
  'queued',
  'submitting',
  'generating',
  'retry_wait',
  'model_wait',
]);

class FlowCutBridge {
  constructor({
    engine,
    store,
    uploadsDirectory,
    version,
    downloadTask = null,
    desktopToken = '',
    onChange = () => {},
    fetchImpl = fetch,
  }) {
    this.engine = engine;
    this.store = store;
    this.uploadsDirectory = uploadsDirectory;
    this.version = version;
    this.downloadTask = downloadTask;
    this.desktopToken = String(desktopToken || '');
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.timer = null;
    this.busy = false;
    this.lastError = '';
    this.lastSync = 0;
    this.sentStatus = new Map();
    this.autoDownloads = new Set();
  }

  info() {
    return {
      enabled: Boolean(this.store.settings.flowcutBridgeEnabled),
      online: Boolean(this.lastSync && Date.now() - this.lastSync < 30_000),
      lastSync: this.lastSync || null,
      error: this.lastError,
      url: this.store.settings.flowcutBridgeUrl,
    };
  }

  start() {
    this.stop();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  endpoint(query = '') {
    const base = String(this.store.settings.flowcutBridgeUrl || '').replace(/\/+$/, '');
    return `${base}/api/seedance-bridge${query}`;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.store.settings.apiKey}`,
      'x-flowcut-desktop-token': this.desktopToken,
      'Content-Type': 'application/json',
    };
  }

  workerId() {
    let id = this.store.settings.flowcutWorkerId;
    if (!id) {
      id = `seedance-${crypto.randomUUID()}`;
      this.store.updateSettings({ flowcutWorkerId: id });
    }
    return id;
  }

  async request(url, init = {}) {
    const response = await this.fetch(url, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `FlowCut Bridge 请求失败：${response.status}`);
    }
    return data;
  }

  async heartbeat() {
    const activeCount = this.store.tasks.filter((task) =>
      ACTIVE_STATUSES.has(task.status),
    ).length;
    await this.request(this.endpoint(), {
      method: 'POST',
      body: JSON.stringify({
        action: 'heartbeat',
        workerId: this.workerId(),
        version: this.version,
        authenticated: this.engine.authenticated,
        queueRunning: Boolean(this.store.settings.running),
        maxConcurrent: Number(this.store.settings.maxConcurrent || 5),
        activeCount,
        downloadDirectory: String(this.store.settings.downloadDirectory || ''),
      }),
    });
  }

  async downloadImages(job) {
    const directory = path.join(this.uploadsDirectory, 'flowcut', job.id);
    await fs.mkdir(directory, { recursive: true });
    const localPaths = [];
    for (const [index, imageUrl] of job.imageUrls.slice(0, 9).entries()) {
      const response = await this.fetch(imageUrl, {
        headers: { 'x-flowcut-desktop-token': this.desktopToken },
      });
      if (!response.ok) {
        throw new Error(`FlowCut 第 ${index + 1} 张商品图下载失败：${response.status}`);
      }
      const contentType = response.headers.get('content-type') || '';
      const extension = contentType.includes('png')
        ? '.png'
        : contentType.includes('webp')
          ? '.webp'
          : contentType.includes('bmp')
            ? '.bmp'
            : '.jpg';
      const filePath = path.join(directory, `${index + 1}${extension}`);
      await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
      localPaths.push(filePath);
    }
    if (!localPaths.length) throw new Error('FlowCut 任务没有可用商品图');
    return localPaths;
  }

  async acknowledge(jobId, task) {
    await this.request(this.endpoint(), {
      method: 'POST',
      body: JSON.stringify({
        action: 'submitted',
        taskId: jobId,
        kind: task.flowcutTaskKind || 'standard',
        providerJobId: task.id,
        workerId: this.workerId(),
      }),
    });
  }

  async acceptJobs() {
    const query = `?workerId=${encodeURIComponent(this.workerId())}`;
    const result = await this.request(this.endpoint(query));
    for (const job of result.jobs || []) {
      let task = this.store.tasks.find((item) => item.flowcutTaskId === job.id);
      if (
        task &&
        (String(task.prompt || '').trim() !== String(job.prompt || '').trim() ||
          String(task.tiktokAccountName || '').trim() !==
            String(job.tiktokAccountName || '').trim() ||
          String(task.productExternalId || '').trim() !==
            String(job.productExternalId || '').trim() ||
          Number(task.duration || 15) !== Number(job.duration || 15))
      ) {
        task.flowcutTaskId = '';
        task.flowcutSupersededAt = Date.now();
        this.store.upsertTask(task);
        this.store.log(
          `FlowCut 任务 ${job.id} 的提示词已更新，旧 Seedance 任务已解除关联并新建生成`,
        );
        task = null;
      }
      if (!task) {
        const imagePaths = await this.downloadImages(job);
        if (this.store.isFlowcutTaskCleared?.(job.id)) continue;
        task = this.engine.createTask(job.prompt, imagePaths, {
          source: 'flowcut',
          flowcutTaskId: job.id,
          flowcutTaskKind: String(job.kind || 'standard'),
          tiktokAccountName: String(job.tiktokAccountName || '').trim(),
          archiveDirectory: String(job.archiveDirectory || '').trim(),
          productExternalId: String(job.productExternalId || '').trim(),
          duration: Number(job.duration || 15),
          managedLocalFiles: imagePaths,
        });
      }
      await this.acknowledge(job.id, task);
    }
  }

  scheduleAutoDownload(task) {
    if (
      this.store.isFlowcutTaskCleared?.(task.flowcutTaskId) ||
      task.status !== 'success' ||
      !task.tiktokAccountName ||
      typeof this.downloadTask !== 'function' ||
      this.autoDownloads.has(task.id) ||
      Number(task.nextAutoDownloadAt || 0) > Date.now()
    ) {
      return;
    }
    const expectedDirectory = task.archiveDirectory || (task.tiktokAccountName && path.join(this.store.settings.downloadDirectory || '', task.tiktokAccountName));
    if (task.lastDownloadedPath && (
      task.archiveDirectory
        ? path.resolve(path.dirname(task.lastDownloadedPath)).toLowerCase() === path.resolve(expectedDirectory).toLowerCase()
        : path.basename(path.dirname(task.lastDownloadedPath)).localeCompare(task.tiktokAccountName, undefined, { sensitivity: 'accent' }) === 0
    )) return;

    this.autoDownloads.add(task.id);
    task.autoDownloadError = '';
    this.store.upsertTask(task);
    void this.downloadTask(task)
      .then(() => {
        if (this.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) return;
        task.autoDownloadError = '';
        task.nextAutoDownloadAt = 0;
        this.store.upsertTask(task);
        this.store.log(
          `FlowCut 成片已自动归档到 TK 账号文件夹“${task.tiktokAccountName}”`,
        );
      })
      .catch((error) => {
        if (this.store.isFlowcutTaskCleared?.(task.flowcutTaskId)) return;
        task.autoDownloadError =
          error instanceof Error ? error.message : String(error);
        task.nextAutoDownloadAt = Date.now() + 60_000;
        this.store.upsertTask(task);
        this.store.log(
          `FlowCut 成片等待下载，1 分钟后自动重试：${task.autoDownloadError}`,
          error?.code === 'VIDEO_NOT_READY' ? 'info' : 'warn',
        );
      })
      .finally(() => {
        this.autoDownloads.delete(task.id);
        this.onChange();
      });
  }

  scheduleAutoDownloads() {
    for (const task of this.store.tasks.filter((item) => item.flowcutTaskId)) {
      this.scheduleAutoDownload(task);
    }
  }

  async syncStatuses() {
    for (const task of this.store.tasks.filter((item) => item.flowcutTaskId)) {
      const snapshot = JSON.stringify([
        task.status,
        task.activity,
        task.videoUrl,
        task.errorMessage,
        task.lastDownloadedPath,
        task.autoDownloadError,
      ]);
      if (this.sentStatus.get(task.id) === snapshot) continue;
      await this.request(this.endpoint(), {
        method: 'POST',
        body: JSON.stringify({
          action: 'status',
          taskId: task.flowcutTaskId,
          kind: task.flowcutTaskKind || 'standard',
          providerJobId: task.id,
          providerStatus: task.status,
          outputUrl: task.videoUrl || '',
          error: task.errorMessage || '',
          downloadPath: task.lastDownloadedPath || '',
          downloadError: task.autoDownloadError || '',
          workerId: this.workerId(),
        }),
      });
      this.sentStatus.set(task.id, snapshot);
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // 成片归档只依赖本机 Seedance 结果，不能因为本地站点临时 503、
      // 页面关闭或 Bridge 写回失败而被跳过。
      this.scheduleAutoDownloads();
      if (
        !this.store.settings.flowcutBridgeEnabled ||
        !this.store.settings.flowcutBridgeUrl ||
        !this.store.settings.apiKey
      ) {
        return;
      }
      const errors = [];
      for (const operation of [
        () => this.heartbeat(),
        () => this.acceptJobs(),
        () => this.syncStatuses(),
      ]) {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw errors[0];
      const recovered = Boolean(this.lastError);
      this.lastError = '';
      this.lastSync = Date.now();
      if (recovered) this.store.log('FlowCut 公网任务桥已恢复连接');
      this.onChange();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) {
        this.store.log(`FlowCut 公网任务桥：${message}`, 'error');
      }
      this.lastError = message;
      this.onChange();
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { FlowCutBridge };
