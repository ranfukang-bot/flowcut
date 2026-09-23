import { ensureLicenseSchema } from "../../../../lib/license";
import { jsonError, runtimeEnv } from "../../../../lib/storage";

export async function GET() {
  try {
    const env = runtimeEnv();
    if (env.FLOWCUT_CONTROL_PLANE !== "1") {
      return Response.json(
        { error: "当前实例不是公网授权中心" },
        { status: 404 },
      );
    }
    await ensureLicenseSchema();
    return Response.json(
      {
        ok: true,
        service: "flowcut-control-plane",
        version: env.FLOWCUT_CONTROL_PLANE_VERSION || "development",
        database: "connected",
        updates: env.UPDATES_KV || env.UPDATES || env.MEDIA
          ? "connected"
          : "not-configured",
        signingKeyConfigured: Boolean(
          env.FLOWCUT_LICENSE_PRIVATE_JWK &&
            env.FLOWCUT_LICENSE_PUBLIC_JWK,
        ),
        time: new Date().toISOString(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
