const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { requireModel } = require('./models');

const BASE_URL = 'https://ads.tiktok.com';
const CREATE_ENDPOINT = '/creative_bff_i18n/api/cue/i2v/gen_r2v_video';
const HISTORY_PATH = '/creative_bff_i18n/api/cue/history/tasks';
const COUNT_PATH = '/creative_bff_i18n/api/cue/generating-task-count';
const MAX_COUNT_PATH = '/creative_bff_i18n/api/cue/get_generate_max_count';
const UPLOAD_TOKEN_PATH = '/creative_bff_i18n/api/cue/upload/token';
const UPLOAD_PROXY_PATH = '/creative/creativestudio/upload-proxy';
const SAVE_LIBRARY_PATH = '/creative_bff_i18n/api/cue/save_to_my_library';
const IMAGE_SERVICE_ID = 'n2703mo9gi';
const IMAGE_CDN_HOST = 'p19-creative-tool-sg.ibyteimg.com';
const QUERY_ARGS = 'aid=585599&app_name=creative_aio_client&device_platform=web';
const SUPPORTED_DURATIONS = new Set(Array.from({ length: 12 }, (_, i) => i + 4));
const TRANSIENT_REQUEST_PATTERN =
  /ERR_(?:HTTP2_PROTOCOL_ERROR|CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_ABORTED|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT)|ECONN(?:RESET|REFUSED|ABORTED)|EAI_AGAIN|ENET(?:DOWN|UNREACH)|ETIMEDOUT|fetch failed|network error|socket hang up|aborted|HTTP 5\d\d|超时|网络/i;

function isTransientRequestError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return TRANSIENT_REQUEST_PATTERN.test(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDuration(value) {
  const duration = Number(value || 15);
  if (!SUPPORTED_DURATIONS.has(duration)) {
    throw new Error(`Seedance 暂不支持 ${duration} 秒，请选择 4–15 秒`);
  }
  return duration;
}

class AuthRequiredError extends Error {
  constructor(message = 'TikTok 登录已失效，请重新登录') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

class TikTokClient {
  constructor(electronSession, logger = () => {}) {
    this.session = electronSession;
    this.logger = logger;
    this.apiHeaders = {};
  }

  captureHeaders(headers = {}) {
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (['x-csrftoken', 'x-creative-source', 'x-fp-id', 'agw-js-conv'].includes(lower)) {
        this.apiHeaders[key] = value;
      }
    }
  }

  async requestHeaders(json = true) {
    const headers = {
      Accept: 'application/json, text/plain, */*',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/creative/creativestudio/create/history`,
      ...this.apiHeaders,
    };
    if (json) headers['Content-Type'] = 'application/json';
    if (!Object.keys(headers).some((key) => key.toLowerCase() === 'x-csrftoken')) {
      const cookies = await this.session.cookies.get({ url: BASE_URL });
      const csrf = cookies.find((cookie) => cookie.name.toLowerCase() === 'csrftoken');
      if (csrf?.value) headers['X-csrftoken'] = csrf.value;
    }
    return headers;
  }

  async apiRequestOnce(endpoint, options = {}) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${BASE_URL}${endpoint}${separator}${QUERY_ARGS}`;
    const response = await this.session.fetch(url, {
      method: options.method || 'GET',
      headers: await this.requestHeaders(true),
      body: options.body == null ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const contentType = response.headers.get('content-type') || '';
    if ([401, 403].includes(response.status)) {
      throw new AuthRequiredError();
    }
    if (!contentType.includes('json')) {
      if (response.status >= 400) {
        throw new Error(`TikTok 接口暂时异常 HTTP ${response.status}`);
      }
      throw new AuthRequiredError();
    }
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(`接口 HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw Object.assign(new Error(`TikTok HTTP ${response.status}: ${json?.message || json?.msg || '接口请求失败'}`), { status: response.status, code: json?.code });
    }
    if (json?.code !== 0) {
      const message = json?.message || json?.msg || `接口错误 ${json?.code}`;
      if (/login|登录|unauthorized|not authorized/i.test(message)) {
        throw new AuthRequiredError(message);
      }
      throw Object.assign(new Error(message), { code: json?.code });
    }
    return json;
  }

  async apiRequest(endpoint, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const retries = Math.max(
      0,
      Number(options.transientRetries ?? (method === 'GET' ? 2 : 0)),
    );
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.apiRequestOnce(endpoint, options);
      } catch (error) {
        lastError = error;
        if (
          error instanceof AuthRequiredError ||
          !isTransientRequestError(error) ||
          attempt >= retries
        ) {
          throw error;
        }
        const delayMs = Math.min(8_000, 800 * 2 ** attempt);
        this.logger(
          `TikTok 接口网络波动，${delayMs / 1000} 秒后重试（${attempt + 1}/${retries}）：${error.message}`,
          'error',
        );
        await wait(delayMs);
      }
    }
    throw lastError;
  }

  uploadTimestamp() {
    return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  randomUploadSalt(length = 10) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  }

  crc32Hex(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }

  sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  hmacSha256(key, value) {
    return crypto.createHmac('sha256', key).update(value).digest();
  }

  canonicalQuery(params) {
    return [...params.entries()]
      // AWS SigV4 要求按 UTF-8 字节/代码点顺序排序。localeCompare 会受系统区域
      // 和大小写规则影响，在中文 Windows 上可能生成与服务端不同的 canonical query。
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${this.awsEncode(key)}=${this.awsEncode(value)}`)
      .join('&');
  }

  awsEncode(value) {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }

  signedUploadHeaders(method, query, token, body = '') {
    const amzDate = this.uploadTimestamp();
    const shortDate = amzDate.slice(0, 8);
    const payloadHash = this.sha256Hex(body);
    const canonicalHeaders = {
      host: 'ads.tiktok.com',
      'x-amz-date': amzDate,
      'x-amz-security-token': token.SessionToken,
    };
    if (method === 'POST') {
      canonicalHeaders['content-type'] = 'application/json';
      canonicalHeaders['x-amz-content-sha256'] = payloadHash;
    }
    const signedHeaderNames = Object.keys(canonicalHeaders).sort();
    const canonicalHeaderText = `${signedHeaderNames
      .map((name) => `${name}:${canonicalHeaders[name].trim()}`)
      .join('\n')}\n`;
    const canonicalRequest = [
      method,
      UPLOAD_PROXY_PATH,
      this.canonicalQuery(query),
      canonicalHeaderText,
      signedHeaderNames.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${shortDate}/i18n/imagex/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      this.sha256Hex(canonicalRequest),
    ].join('\n');
    const dateKey = this.hmacSha256(`AWS4${token.SecretAccessKey}`, shortDate);
    const regionKey = this.hmacSha256(dateKey, 'i18n');
    const serviceKey = this.hmacSha256(regionKey, 'imagex');
    const signingKey = this.hmacSha256(serviceKey, 'aws4_request');
    const signature = this.hmacSha256(signingKey, stringToSign).toString('hex');
    const headers = {
      'x-amz-date': amzDate,
      'x-amz-security-token': token.SessionToken,
      Authorization: `AWS4-HMAC-SHA256 Credential=${token.AccessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`,
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['x-amz-content-sha256'] = payloadHash;
    }
    return headers;
  }

  async checkedJson(response, label) {
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(`${label}返回了非 JSON 内容`);
    }
    if (json?.ResponseMetadata?.Error) {
      throw new Error(json.ResponseMetadata.Error.Message || json.ResponseMetadata.Error.Code);
    }
    if (!response.ok) throw new Error(json?.message || `${label} HTTP ${response.status}`);
    if (json?.code != null && ![0, 2000].includes(Number(json.code))) {
      throw new Error(json.message || `${label}错误 ${json.code}`);
    }
    return json;
  }

  async uploadBinaryWithRetry(
    buffer,
    storeUri,
    storageAuth,
    uploadHosts,
    crc32,
    onProgress = () => {},
  ) {
    let lastError;
    const hosts = [...new Set(uploadHosts.filter(Boolean))];
    if (!hosts.length) throw new Error('没有可用的图片上传节点');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const host = hosts[attempt % hosts.length];
      onProgress(`正在上传图片数据（节点尝试 ${attempt + 1}/3）`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await this.session.fetch(`https://${host}/upload/v1/${storeUri}`, {
          method: 'POST',
          headers: {
            Authorization: storageAuth,
            'Content-CRC32': crc32,
            'Content-Disposition': 'attachment; filename="upload"',
            'Content-Type': 'application/octet-stream',
            'X-Storage-U': 'ad_creative_tools_unknown_user',
          },
          body: buffer,
          signal: controller.signal,
        });
        const result = await this.checkedJson(response, '上传图片数据');
        if (Number(result?.code) === 2000) return result;
        lastError = new Error(result?.message || '图片数据上传未成功');
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
    throw new Error(lastError?.name === 'AbortError' ? '图片数据上传超时' : lastError?.message);
  }

  async uploadImageOnce(filePath, onProgress = () => {}) {
    onProgress('正在获取 TikTok 上传凭证');
    const stat = await fs.stat(filePath);
    const tokenResult = await this.apiRequest(UPLOAD_TOKEN_PATH, {
      method: 'POST',
      body: {},
      transientRetries: 3,
    });
    const token = tokenResult?.data;
    if (!token?.SessionToken || !token?.AccessKeyId || !token?.SecretAccessKey) {
      throw new Error('没有取得完整的临时上传凭证');
    }

    onProgress('正在申请新的图片上传地址');
    const applyQuery = new URLSearchParams({
      Action: 'ApplyImageUpload',
      Version: '2018-08-01',
      ServiceId: IMAGE_SERVICE_ID,
      FileSize: String(stat.size),
      s: this.randomUploadSalt(),
      device_platform: 'web',
    });
    const applyResponse = await this.session.fetch(
      `${BASE_URL}${UPLOAD_PROXY_PATH}?${applyQuery}`,
      { headers: this.signedUploadHeaders('GET', applyQuery, token) },
    );
    const applyResult = await this.checkedJson(applyResponse, '申请图片上传地址');
    const uploadAddress = applyResult?.Result?.UploadAddress;
    const store = uploadAddress?.StoreInfos?.[0];
    const uploadHosts = [
      ...(uploadAddress?.UploadHosts || []),
      ...(applyResult?.Result?.InnerUploadAddress?.UploadNodes || []).map(
        (node) => node.UploadHost,
      ),
    ];
    if (!store?.StoreUri || !store?.Auth || !uploadHosts.length || !uploadAddress?.SessionKey) {
      throw new Error('上传地址返回不完整');
    }

    const buffer = await fs.readFile(filePath);
    await this.uploadBinaryWithRetry(
      buffer,
      store.StoreUri,
      store.Auth,
      uploadHosts,
      this.crc32Hex(buffer),
      onProgress,
    );

    onProgress('图片数据已发送，正在确认上传结果');
    const commitBody = JSON.stringify({ SessionKey: uploadAddress.SessionKey });
    const commitQuery = new URLSearchParams({
      Action: 'CommitImageUpload',
      Version: '2018-08-01',
      ServiceId: IMAGE_SERVICE_ID,
    });
    const commitResponse = await this.session.fetch(
      `${BASE_URL}${UPLOAD_PROXY_PATH}?${commitQuery}`,
      {
        method: 'POST',
        headers: this.signedUploadHeaders('POST', commitQuery, token, commitBody),
        body: commitBody,
      },
    );
    const commitResult = await this.checkedJson(commitResponse, '提交图片上传');
    const imageUri =
      commitResult?.Result?.PluginResult?.[0]?.ImageUri ||
      commitResult?.Result?.Results?.[0]?.Uri ||
      store.StoreUri;
    if (!imageUri) throw new Error('上传完成但没有返回图片 URI');

    const imageUrl = `https://${IMAGE_CDN_HOST}/${imageUri}~tplv-${IMAGE_SERVICE_ID}-webp:1280:1280.image`;
    try {
      onProgress('正在保存图片到 TikTok 素材库');
      const libraryResult = await this.apiRequest(SAVE_LIBRARY_PATH, {
        method: 'POST',
        transientRetries: 2,
        body: {
          assets: [{ assetType: 'image', content: imageUrl, fileName: path.basename(filePath) }],
        },
      });
      return libraryResult?.data?.assets?.[0]?.content || imageUrl;
    } catch (error) {
      this.logger(`素材库保存跳过：${error.message}`);
      return imageUrl;
    }
  }

  async uploadImage(filePath, onProgress = () => {}) {
    let lastError;
    for (let sessionAttempt = 1; sessionAttempt <= 3; sessionAttempt += 1) {
      try {
        if (sessionAttempt > 1) {
          onProgress(`正在重建上传会话（${sessionAttempt}/3）`);
        }
        return await this.uploadImageOnce(filePath, onProgress);
      } catch (error) {
        if (error instanceof AuthRequiredError) throw error;
        lastError = error;
        if (sessionAttempt < 3) {
          onProgress(`本次上传会话失败，准备更换上传地址：${error.message}`);
          this.logger(
            `${path.basename(filePath)} 上传会话未成功，正在申请新的上传地址（${sessionAttempt}/3）：${error.message}`,
            'error',
          );
          await new Promise((resolve) => setTimeout(resolve, sessionAttempt * 1200));
        }
      }
    }
    throw lastError;
  }

  async submitTask(task) {
    const model = requireModel(task.model);
    const imageUrls = task.imageItems.map((item) => item.uploadedUrl).filter(Boolean);
    if (!imageUrls.length || imageUrls.length !== task.imageItems.length) {
      throw new Error('任务图片尚未全部上传');
    }
    const images = task.imageItems.map((item, index) => ({
      id: crypto.randomUUID(),
      name: item.name,
      previewUrl: item.uploadedUrl,
      fileType: 'image',
      label: `图片 ${index + 1}`,
    }));
    const duration = normalizeDuration(task.duration);
    return this.apiRequest(CREATE_ENDPOINT, {
      method: 'POST',
      body: {
        image: '',
        images: imageUrls,
        prompt: task.prompt,
        duration,
        model,
        settings: JSON.stringify({
          images,
          prompt: task.prompt,
          aiModel: model,
          duration,
        }),
        mentions: imageUrls.map((url) => ({ type: 1, id: url })),
      },
    });
  }

  async fetchHistory(wantedTaskIds = []) {
    const wanted = new Set(wantedTaskIds.filter(Boolean).map(String));
    const mergedItems = [];
    const mergedIds = new Set();
    const pageSignatures = new Set();
    let firstResult = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const result = await this.apiRequest(HISTORY_PATH, {
        method: 'POST',
        transientRetries: 3,
        body: {
          pageOffset: pageIndex * 50,
          pageLimit: 50,
          edited: false,
          sorted: 2,
          start_time: String(Math.floor(Date.now() / 1000) - 365 * 86400),
          mini_app_type: [2, 3, 11, 13],
          showPlayInfo: true,
          parseSettings: true,
        },
      });
      if (!firstResult) firstResult = result;
      const pageItems = result?.data?.draft_infos || [];
      const signature = pageItems.map((item) => String(item.taskId)).join(',');
      if (pageSignatures.has(signature)) break;
      pageSignatures.add(signature);
      for (const item of pageItems) {
        const taskId = String(item.taskId);
        if (mergedIds.has(taskId)) continue;
        mergedIds.add(taskId);
        mergedItems.push(item);
      }
      const foundAll = [...wanted].every((taskId) => mergedIds.has(taskId));
      if (!wanted.size || foundAll || pageItems.length < 50) break;
    }
    return {
      ...firstResult,
      data: { ...(firstResult?.data || {}), draft_infos: mergedItems },
    };
  }

  async getGeneratingCount() {
    const result = await this.apiRequest(COUNT_PATH);
    return Number(result?.data?.total || 0);
  }

  async getMaxConcurrent() {
    const result = await this.apiRequest(MAX_COUNT_PATH);
    return Number(result?.data?.['CreativeStudio/ReferenceToVideo/ReferenceToVideo'] || 5);
  }

  async checkAuth() {
    try {
      await this.getGeneratingCount();
      return true;
    } catch (error) {
      if (error instanceof AuthRequiredError) return false;
      throw error;
    }
  }
}

module.exports = {
  TikTokClient,
  AuthRequiredError,
  isTransientRequestError,
  BASE_URL,
};
