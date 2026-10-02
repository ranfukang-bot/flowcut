// JSON cannot preserve Uint8Array. Keep real bytes for the page's paste/drop
// fallback as well as native chooser paths (base64 avoids large number arrays).
function pageFiles(files = []) {
  return files.map(({ name, mime, data }) => {
    const bytes = Buffer.from(data || []);
    if (!bytes.length) throw new Error(`商品附件为空，已停止上传：${name}`);
    return { name, mime, base64: bytes.toString('base64') };
  });
}
module.exports = { pageFiles };
