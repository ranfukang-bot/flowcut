import {
  credentialEncryptionReady,
  GeminiConfig,
  getProviderConfig,
  saveProviderConfig,
  SeedanceConfig,
} from "../../../lib/provider-config";
import { resolveGeminiApiModel } from "../../../lib/gemini";
import { getProviderRuntime, jsonError, runtimeEnv } from "../../../lib/storage";

export async function GET() {
  try {
    const [gemini, seedance, encryptionReady, geminiRuntime, seedanceRuntime] = await Promise.all([
      getProviderConfig("gemini"),
      getProviderConfig("seedance"),
      credentialEncryptionReady(),
      getProviderRuntime("gemini-web"),
      getProviderRuntime("seedance"),
    ]);
    return Response.json(
      {
        desktopRuntime: runtimeEnv().FLOWCUT_DESKTOP_RUNTIME === "1",
        encryptionReady,
        gemini: {
          ...gemini.config,
          secretConfigured: gemini.secretConfigured,
          runtime: geminiRuntime,
        },
        seedance: {
          ...seedance.config,
          secretConfigured: seedance.secretConfigured,
          runtime: seedanceRuntime,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      provider?: "gemini" | "seedance";
      config?: Record<string, unknown>;
      apiKey?: string;
    };
    if (!body.provider || !body.config) {
      return Response.json({ error: "缺少接口配置" }, { status: 400 });
    }
    await saveProviderConfig(
      body.provider,
      body.config,
      body.apiKey?.trim() ? { apiKey: body.apiKey.trim() } : undefined
    );
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      provider?: "gemini" | "seedance";
      config?: Record<string, unknown>;
      apiKey?: string;
    };
    if (!body.provider) {
      return Response.json({ error: "缺少接口类型" }, { status: 400 });
    }
    const stored = await getProviderConfig(body.provider);
    const apiKey = body.apiKey?.trim() || stored.secrets.apiKey;
    const config = { ...stored.config, ...(body.config || {}) } as Record<string, string>;

    if (body.provider === "gemini") {
      const gemini = config as unknown as GeminiConfig;
      if (gemini.mode === "web") {
        const runtime = await getProviderRuntime("gemini-web");
        if (!runtime.online) {
          return Response.json(
            {
              error:
                "Gemini 网页执行器尚未连接。请打开本机 Gemini 网页执行器，登录账号后再测试。",
            },
            { status: 409 }
          );
        }
        if (!runtime.authenticated) {
          return Response.json(
            { error: "Gemini 网页执行器已连接，但还没有已登录账号" },
            { status: 409 }
          );
        }
        return Response.json({
          ok: true,
          runtime,
          message: runtime.queueRunning
            ? `Gemini 网页执行器已连接且账号已登录（${runtime.maxConcurrent || 1} 个账号并发）`
            : "Gemini 网页执行器已连接且账号已登录；队列已暂停，创建任务时会自动启动。本次连接测试不会启动任务。",
        });
      }
      if (!apiKey) throw new Error("请先填写 Gemini API Key");
      const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
      const model = await resolveGeminiApiModel(
        baseUrl,
        apiKey,
        String(config.model || "")
      );
      const response = await fetch(
        `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: "只回复 OK" }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 8,
            },
          }),
        }
      );
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Gemini 模型 ${model} 不可用：${response.status} ${detail.slice(0, 260)}`
        );
      }
      return Response.json({
        ok: true,
        model,
        message: config.model
          ? `Gemini API 与模型 ${model} 均可真实生成`
          : `Gemini API 已连接，已自动使用账号可用模型：${model}`,
      });
    }

    const seedance = config as unknown as SeedanceConfig;
    if (seedance.mode === "local-api") {
      const runtime = await getProviderRuntime("seedance");
      if (!runtime.online) {
        return Response.json(
          {
            error:
              "FlowCut 内置 Seedance 尚未完成启动，通常 10 秒内会自动连接。",
          },
          { status: 409 }
        );
      }
      if (!runtime.authenticated) {
        return Response.json({ error: "FlowCut 内置 Seedance 中的 TikTok 尚未登录" }, { status: 409 });
      }
      if (!runtime.queueRunning) {
        return Response.json({ error: "FlowCut 内置 Seedance 任务队列尚未启动" }, { status: 409 });
      }
      return Response.json({
        ok: true,
        runtime,
        message: `FlowCut 内置 Seedance 已连接（版本 ${runtime.version || "未知"}）`,
      });
    }
    const target = seedance.healthUrl || seedance.endpoint;
    if (!target) throw new Error("请填写 Seedance API 或插件地址");
    if (!seedance.healthUrl) {
      return Response.json({
        ok: true,
        message: "地址格式有效；保存后可用真实任务完成最终验证",
      });
    }
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers[seedance.authHeader || "Authorization"] = seedance.authScheme
        ? `${seedance.authScheme} ${apiKey}`
        : apiKey;
    }
    const response = await fetch(seedance.healthUrl, { headers });
    if (!response.ok) throw new Error(`Seedance 健康检查失败：${response.status}`);
    return Response.json({ ok: true, message: "Seedance 执行器连接成功" });
  } catch (error) {
    return jsonError(error);
  }
}
