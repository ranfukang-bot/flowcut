import { runtimeEnv } from "../../../../../lib/storage";

type RouteContext = {
  params: Promise<{ asset: string }>;
};

type UpdateAssetManifest = {
  size: number;
  contentType: string;
  etag: string;
  chunks: Array<{ key: string; offset: number; size: number }>;
};

function requestedRange(header: string | null, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = header.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end)) end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  return {
    start,
    end: Math.min(size - 1, end),
    partial: true,
  };
}

async function serveFromKv(
  request: Request,
  key: string,
  cacheControl: string,
) {
  const kv = runtimeEnv().UPDATES_KV;
  if (!kv) return null;
  const manifest = await kv.get<UpdateAssetManifest>(
    `${key}.meta.json`,
    "json",
  );
  if (!manifest?.chunks?.length || !Number(manifest.size)) return null;
  const range = requestedRange(request.headers.get("range"), manifest.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${manifest.size}` },
    });
  }
  const chunks = manifest.chunks.filter(
    (chunk) =>
      chunk.offset <= range.end &&
      chunk.offset + chunk.size - 1 >= range.start,
  );
  let cursor = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[cursor++];
      const buffer = await kv.get(chunk.key, "arrayBuffer");
      if (!buffer) {
        controller.error(new Error("云更新分片缺失"));
        return;
      }
      const bytes = new Uint8Array(buffer);
      const start = Math.max(0, range.start - chunk.offset);
      const end = Math.min(bytes.length, range.end - chunk.offset + 1);
      controller.enqueue(bytes.subarray(start, end));
    },
  });
  const length = range.end - range.start + 1;
  const headers = new Headers({
    "content-type": manifest.contentType || "application/octet-stream",
    "content-length": String(length),
    "accept-ranges": "bytes",
    "cache-control": cacheControl,
    etag: `"${manifest.etag}"`,
  });
  if (range.partial) {
    headers.set(
      "content-range",
      `bytes ${range.start}-${range.end}/${manifest.size}`,
    );
  }
  return new Response(body, {
    status: range.partial ? 206 : 200,
    headers,
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { asset } = await context.params;
  if (
    !asset ||
    asset.includes("/") ||
    asset.includes("\\") ||
    asset.includes("..")
  ) {
    return Response.json({ error: "更新文件路径无效" }, { status: 400 });
  }
  const cacheControl =
    asset === "latest.yml" || asset === "release.json"
      ? "public, max-age=60, must-revalidate"
      : "public, max-age=31536000, immutable";
  const key = `updates/windows/${asset}`;
  const bucket = runtimeEnv().UPDATES || runtimeEnv().MEDIA;
  if (!bucket) {
    const response = await serveFromKv(request, key, cacheControl);
    if (response) return response;
  }
  if (!bucket) {
    return Response.json({ error: "更新存储尚未连接" }, { status: 503 });
  }
  const object = await bucket.get(key, {
    range: request.headers,
  });
  if (!object) {
    return Response.json({ error: "更新文件不存在" }, { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set(
    "cache-control",
    cacheControl,
  );
  const range = object.range;
  if (range && "offset" in range) {
    const offset = range.offset || 0;
    const length = range.length || object.size;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    headers.set("content-length", String(length));
  }
  return new Response(object.body, {
    status: range ? 206 : 200,
    headers,
  });
}
