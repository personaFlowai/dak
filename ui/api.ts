// The screens talk to the same HTTP API an agent would.

declare global {
  interface Window { DAK: { token: string; me: string; readers: { name: string; kind: "person" | "agent" }[] } }
}

export const boot = window.DAK;

export class ApiError extends Error { constructor(public code: string, message: string) { super(message); } }

export async function api<T = any>(path: string, init: Omit<RequestInit, "body"> & { body?: any } = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${boot.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error?.code ?? "http", data?.error?.message ?? `The server answered ${res.status}.`);
  return data as T;
}

const textCache = new Map<string, Promise<string>>();
export function blobText(sha: string): Promise<string> {
  if (!textCache.has(sha)) {
    textCache.set(sha, fetch(`/v1/blobs/${sha}`, { headers: { authorization: `Bearer ${boot.token}` } }).then((r) => {
      if (!r.ok) throw new ApiError("blob", "Could not load that file from the store.");
      return r.text();
    }));
  }
  return textCache.get(sha)!;
}

export const blobUrl = (sha: string, type?: string) => `/v1/blobs/${sha}?token=${boot.token}${type ? `&type=${encodeURIComponent(type)}` : ""}`;

// Per-person conveniences that live in this browser only: unsent comments and
// which chapters you have marked reviewed. Losing them loses nothing sent.
export const local = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(`dak:${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem(`dak:${key}`, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
  },
};
