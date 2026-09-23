import { getProviderConfig } from "./provider-config";
import { runtimeEnv } from "./storage";

type ProductInput = {
  duration: number;
  region: string;
  shooting_style: string;
  name?: string;
  features?: string;
};

export function buildGeminiPrompt(gemContent: string, product: ProductInput) {
  const details = [
    `时长：${product.duration}秒`,
    `地区：${product.region}`,
    `拍摄风格：${product.shooting_style}`,
    "执行方式：这是无人值守批量任务；请直接完成本次成品。若图片信息不完整，请仅依据可见内容保守处理，不要停下来询问或等待补充。",
  ];
  return `${gemContent.trim()}\n\n${details.join("\n")}`;
}

export async function resolveGeminiApiModel(
  baseUrl: string,
  apiKey: string,
  requestedModel?: string
) {
  const requested = String(requestedModel || "")
    .trim()
    .replace(/^models\//, "");
  if (requested) return requested;

  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/models?pageSize=100&key=${encodeURIComponent(apiKey)}`
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gemini 无法读取当前账号可用模型：${response.status} ${detail.slice(0, 260)}`
    );
  }
  const payload = (await response.json()) as {
    models?: Array<{
      name?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  const available = payload.models?.find((model) =>
    model.supportedGenerationMethods?.includes("generateContent")
  );
  const model = available?.name?.replace(/^models\//, "");
  if (!model) {
    throw new Error("当前 Gemini API 账号没有返回可用于 generateContent 的模型");
  }
  return model;
}

export async function generatePrompt(
  gemContent: string,
  product: ProductInput,
  imageKeys: string[] = []
) {
  const provider = await getProviderConfig("gemini");
  const apiKey = provider.secrets.apiKey;
  if (!apiKey) {
    throw new Error(
      "Gemini API 尚未配置。系统已停止生成，不会再用演示提示词冒充真实识别结果；请先到「接口设置」保存并测试 Gemini API Key。"
    );
  }

  const parts: Array<Record<string, unknown>> = [
    {
      text: buildGeminiPrompt(gemContent, product),
    },
  ];

  let loadedImageCount = 0;
  for (const imageKey of imageKeys.slice(0, 12)) {
    const object = await runtimeEnv().MEDIA?.get(imageKey);
    if (object) {
      const bytes = await object.arrayBuffer();
      parts.push({
        inline_data: {
          mime_type: object.httpMetadata?.contentType || "image/jpeg",
          data: Buffer.from(bytes).toString("base64"),
        },
      });
      loadedImageCount += 1;
    }
  }
  if (imageKeys.length > 0 && loadedImageCount === 0) {
    throw new Error("商品图片已记录，但 Gemini 无法读取图片文件，请重新上传后再试。");
  }
  if (!loadedImageCount && !product.name && !product.features) {
    throw new Error("没有可供 Gemini 识别的商品图片或商品资料。");
  }

  const baseUrl = provider.config.baseUrl.replace(/\/+$/, "");
  const model = await resolveGeminiApiModel(
    baseUrl,
    apiKey,
    provider.config.model || runtimeEnv().GEMINI_MODEL
  );
  const endpoint =
    `${baseUrl}/models/${model}:streamGenerateContent` +
    `?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const payload = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: 4000,
    },
  });

  let response: Response | null = null;
  let streamText = "";
  let lastNetworkError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const current = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: payload,
      });
      response = current;
      if (!current.ok) break;
      streamText = await current.text();
      break;
    } catch (error) {
      response = null;
      lastNetworkError =
        error instanceof Error ? error.message : "Gemini 网络连接中断";
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
  }
  if (!response) {
    throw new Error(`Gemini 网络连接失败，自动重试后仍未恢复：${lastNetworkError}`);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini 调用失败：${response.status} ${detail.slice(0, 300)}`);
  }

  const chunks: Array<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  }> = [];
  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(data));
    } catch {
      throw new Error("Gemini 流式结果解析失败，请重试");
    }
  }

  const prompt = chunks
    .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts || [])
    .filter((part) => !part.thought)
    .map((part) => part.text || "")
    .join("")
    .trim();
  if (!prompt) throw new Error("Gemini 没有返回可用提示词");
  return { prompt, mode: "live" as const };
}
