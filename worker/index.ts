/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  MEDIA?: R2Bucket;
  UPDATES?: R2Bucket;
  UPDATES_KV?: KVNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  FLOWCUT_CONTROL_PLANE?: string;
  FLOWCUT_CONTROL_PLANE_VERSION?: string;
  FLOWCUT_DESKTOP_RUNTIME?: string;
  FLOWCUT_PERSONAL_MODE?: string;
  FLOWCUT_DESKTOP_TOKEN?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isControlPlane = env.FLOWCUT_CONTROL_PLANE === "1";
    const isDesktopRuntime = env.FLOWCUT_DESKTOP_RUNTIME === "1";

    if (env.FLOWCUT_PERSONAL_MODE === "1" && /^\/api\/(?:license|admin|control-plane|updates)(?:\/|$)/.test(url.pathname)) {
      return Response.json({ error: "个人本机版不使用云端授权与更新" }, { status: 404 });
    }

    if (isDesktopRuntime && url.pathname.startsWith("/api/")) {
      const expected = String(env.FLOWCUT_DESKTOP_TOKEN || "");
      const supplied = String(request.headers.get("x-flowcut-desktop-token") || "");
      if (!expected || !supplied || !constantTimeEqual(expected, supplied)) {
        return Response.json(
          { error: "FlowCut 本机工作台访问凭证无效" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      }
    }

    if (
      isControlPlane &&
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/license/") &&
      !url.pathname.startsWith("/api/admin/") &&
      !url.pathname.startsWith("/api/control-plane/") &&
      !url.pathname.startsWith("/api/updates/")
    ) {
      return secureResponse(request, Response.json(
        { error: "公网授权中心不提供本地工作台业务接口" },
        { status: 404, headers: { "cache-control": "no-store" } },
      ), isControlPlane);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    return secureResponse(request, response, isControlPlane);
  },
};

function secureResponse(
  request: Request,
  response: Response,
  isControlPlane: boolean,
) {
  if (!isControlPlane) return response;
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  if (new URL(request.url).protocol === "https:") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }
  if (new URL(request.url).pathname.startsWith("/api/")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default worker;

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
