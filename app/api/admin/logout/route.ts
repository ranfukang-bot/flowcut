export async function POST() {
  return Response.json(
    { ok: true },
    {
      headers: {
        "set-cookie": "flowcut_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        "cache-control": "no-store",
      },
    },
  );
}
