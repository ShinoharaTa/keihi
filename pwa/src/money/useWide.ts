// 明細の並べ方の幅の判定（#74 PR4）。描画だけの部品は wide を props で受け、判定はここ 1 か所（殻の Txns.tsx から呼ぶ）。
// 1024px 以上を PC 幅とし、幅が変われば追う。SSR（window が無い・matchMedia が無い）では false。
import { useEffect, useState } from 'preact/hooks';

export const WIDE_QUERY = '(min-width: 1024px)';

const query = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null);

export function useWide(): boolean {
  const [wide, setWide] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}
