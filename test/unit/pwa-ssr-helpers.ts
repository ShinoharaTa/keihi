// PWA の描画だけの部品（hooks を使わない関数コンポーネント）を HTML の文字列にする（「お金」タブの SSR スナップショット用）。
// - .tsx は Node の型ストリップで読めないので、vite の SSR（ssrLoadModule。pwa/vite.config.ts の JSX 設定）で読む。ポートは開かない。
// - preact の vnode をたどって文字列にする。関数コンポーネントはそのまま呼ぶ（hooks を呼ぶ部品には使えない）。on* のハンドラは出さない。
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '../../pwa');

export async function startSsr(): Promise<ViteDevServer> {
  return createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    root: ROOT,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ATTR_NAMES: Record<string, string> = { className: 'class', htmlFor: 'for' };

type VNode = { type: unknown; props: Record<string, unknown> };
const isVNode = (v: unknown): v is VNode => typeof v === 'object' && v !== null && 'type' in v && 'props' in v;

export function renderHtml(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node));
  if (Array.isArray(node)) return node.map(renderHtml).join('');
  if (!isVNode(node)) throw new Error(`描画できない値: ${String(node)}`);
  if (typeof node.type === 'function') return renderHtml((node.type as (p: unknown) => unknown)(node.props));
  const tag = node.type as string;
  let attrs = '';
  for (const [k, v] of Object.entries(node.props)) {
    const name = ATTR_NAMES[k] ?? k;
    if (typeof v === 'boolean' && name.startsWith('aria-')) {
      attrs += ` ${name}="${v}"`;
      continue;
    }
    if (k === 'children' || k === 'key' || /^on[A-Z]/.test(k) || v === false || v === null || v === undefined) continue;
    attrs += v === true ? ` ${name}` : ` ${name}="${esc(String(v))}"`;
  }
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${renderHtml(node.props.children)}</${tag}>`;
}

// スナップショットを読みやすくするため、閉じタグの後で行に分ける（行の配列で保存する）。
export const pretty = (html: string) => html.replace(/(<\/(?:li|tr|p|div|dl|ul|table|caption|thead|tbody|button|label|select|form)>)/g, '$1\n');
export const lines = (html: string) => html.split('\n').filter((l) => l !== '');
