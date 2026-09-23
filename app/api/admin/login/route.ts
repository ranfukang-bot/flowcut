import {
  checkLoginThrottle,
  clearLoginFailures,
  createAdminSession,
  recordLoginFailure,
} from "../../../../lib/license";
import { jsonError } from "../../../../lib/storage";

export async function POST(request: Request) {
  let username = "";
  try {
    const body = (await request.json()) as { username?: string; password?: string };
    username = String(body.username || "").trim();
    const throttle = await checkLoginThrottle(
      request,
      "admin",
      username || "missing",
    );
    if (!throttle.allowed) {
      return Response.json(
        { error: "登录失败次数过多，请稍后再试" },
        {
          status: 429,
          headers: {
            "retry-after": String(throttle.retryAfterSeconds),
            "cache-control": "no-store",
          },
        },
      );
    }
    const token = await createAdminSession(
      username,
      String(body.password || ""),
    );
    await clearLoginFailures(request, "admin", username);
    return Response.json(
      { ok: true },
      {
        headers: {
          "set-cookie": `flowcut_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    await recordLoginFailure(
      request,
      "admin",
      username || "missing",
    ).catch(() => {});
    return jsonError(error, 401);
  }
}
