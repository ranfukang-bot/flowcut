// The desktop advertises only logged-in, idle, non-cooling accounts.
// Product jobs ignore legacy pins; explicitly assigned specialist tools retain them.
export function chooseGeminiAccount(
  kind: string,
  pinnedAccountId: string | null | undefined,
  available: Set<string>,
): string | null {
  const pin = kind === "standard" ? "" : pinnedAccountId;
  if (pin) return available.has(pin) ? pin : null;
  return available.values().next().value ?? null;
}
