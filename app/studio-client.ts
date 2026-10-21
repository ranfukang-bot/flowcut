import type { FlowCutDesktopBridge } from './studio-types';

export async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

export function desktopBridge() {
  if (typeof window === "undefined") return undefined;
  return (
    window as unknown as {
      flowcutDesktop?: FlowCutDesktopBridge;
    }
  ).flowcutDesktop;
}
