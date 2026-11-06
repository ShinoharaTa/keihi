// サーバーとの通信。認証は tailscale serve が付ける Tailscale-User-Login に任せる（Cookie は使わない）。
import { INGEST_URL, type Send } from './queue/queue.ts';

async function jsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export const sendIngest: Send = async (body) => {
  const res = await fetch(INGEST_URL, { method: 'POST', body, credentials: 'same-origin', cache: 'no-store' });
  return { status: res.status, body: await jsonOrNull(res) };
};

export async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return { status: res.status, body: await jsonOrNull(res) };
  } catch {
    return { status: 0, body: null };
  }
}
