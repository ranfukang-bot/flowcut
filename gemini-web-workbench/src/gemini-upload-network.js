// Observe transport completion, not just the optimistic preview Gemini creates.
// Never retain request bodies, credentials, or uploaded file contents.
function isUploadRequest(request) {
  if (!request || !/^(POST|PUT|PATCH)$/i.test(request.method || '')) return false;
  try {
    const url = new URL(request.url);
    if (!/(^|\.)(googleapis\.com|google\.com|googleusercontent\.com)$/.test(url.hostname)) return false;
    return /upload/i.test(url.pathname) || Object.keys(request.headers || {}).some(key => /^x-goog-upload-/i.test(key));
  } catch { return false; }
}

async function observeGeminiUploads(contents) {
  const api = contents.debugger;
  const attachedHere = !api.isAttached();
  if (attachedHere) api.attach('1.3');
  let active = false, lost = false, updatedAt = Date.now();
  const requests = new Map();
  const generation = new Map();
  const detach = () => { lost = true; };
  const message = (_event, method, params) => {
    if (!active) return;
    if (method === 'Network.requestWillBeSent' && params.request?.method === 'POST') {
      try {
        const url = new URL(params.request.url);
        if ((url.hostname === 'gemini.google.com' && url.pathname.endsWith('/StreamGenerate')) ||
            (url.hostname === 'geminiweb-pa.clients6.google.com' && url.pathname === '/v1/processSession')) {
          generation.set(params.requestId, {endpoint:url.pathname.split('/').pop(),status:0,bytes:0,done:false,error:''});
        }
      } catch {}
    }
    const generating = generation.get(params.requestId);
    if (generating) {
      if (method === 'Network.responseReceived') generating.status = params.response.status;
      if (method === 'Network.dataReceived') generating.bytes += Number(params.dataLength || 0);
      if (method === 'Network.loadingFinished') generating.done = true;
      if (method === 'Network.loadingFailed') { generating.done = true; generating.error = params.errorText || '连接中断'; }
    }
    if (method === 'Network.requestWillBeSent' && isUploadRequest(params.request)) {
      requests.set(params.requestId, { done:false, status:0, error:'' });
      updatedAt = Date.now();
    }
    const request = requests.get(params.requestId);
    if (!request) return;
    if (method === 'Network.responseReceived') {
      request.status = params.response.status;
      if (request.status >= 400) request.error = `HTTP ${request.status}`;
    } else if (method === 'Network.loadingFinished') {
      request.done = true;
    } else if (method === 'Network.loadingFailed') {
      request.done = true;
      request.error = params.errorText || '上传连接中断';
    } else return;
    updatedAt = Date.now();
  };
  api.on('message', message);
  api.on('detach', detach);
  try {
    // Gemini defers response display when its worker loses focus/visibility.
    // Keep the page active throughout generation, not just during text input.
    contents.backgroundThrottling = false;
    await api.sendCommand('Network.enable');
    await api.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:true });
  }
  catch (error) {
    api.removeListener('message', message); api.removeListener('detach', detach);
    if (attachedHere && api.isAttached()) api.detach();
    throw error;
  }
  return {
    begin() { requests.clear(); generation.clear(); active = true; updatedAt = Date.now(); return this.status(); },
    status() {
      const values = [...requests.values()];
      return { available:!lost, observed:values.length, pending:values.filter(r => !r.done).length,
        completed:values.filter(r => r.done && !r.error && r.status >= 200 && r.status < 400).length,
        failed:values.filter(r => r.error).map(r => r.error), quietMs:Date.now()-updatedAt,
        generation:[...generation.values()].map(r=>({...r})) };
    },
    async stop() {
      active = false; api.removeListener('message', message); api.removeListener('detach', detach);
      if (!contents.isDestroyed?.() && api.isAttached()) {
        await api.sendCommand('Emulation.setFocusEmulationEnabled', { enabled:false }).catch(()=>{});
        if (attachedHere && api.isAttached()) api.detach();
      }
    },
  };
}
module.exports = { isUploadRequest, observeGeminiUploads };
