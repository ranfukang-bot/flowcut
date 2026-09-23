import { runtimeEnv } from "../../../lib/storage";

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key || !runtimeEnv().MEDIA) return new Response("Not found", { status: 404 });
  const object = await runtimeEnv().MEDIA!.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=86400");
  return new Response(object.body, { headers });
}
