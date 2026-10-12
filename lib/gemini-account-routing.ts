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

// Matches the desktop's saved-Gem identity, including the task's instruction
// snapshot. A changed template must not inherit a previous version's hold.
export async function availableGemAccounts(available: Set<string>, blocked: Record<string, string[]>, id: string, content: string): Promise<Set<string>> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([String(id), String(content).trim()])));
  const version = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2,"0")).join("");
  return new Set([...available].filter(account=>!blocked[account]?.includes(version)));
}
