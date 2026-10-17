// extract ジョブ（Gemini での抽出）。中身は M2（T2-3）で実装する。未実装のまま完了にはしない。
import type { Handler } from '../../jobs/worker.ts';

export const extract: Handler = async () => {
  throw new Error('extract は未実装（T2-3）');
};
