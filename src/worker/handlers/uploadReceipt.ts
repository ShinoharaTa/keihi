// upload_receipt ジョブ（R7 の即アップロード）。中身は T1-11 で実装する。
// 未実装のまま「完了」にすると送っていない証憑が送ったことになるので、失敗として扱う（再試行に回る）。
import type { Handler } from '../../jobs/worker.ts';

export const uploadReceipt: Handler = async () => {
  throw new Error('upload_receipt は未実装（T1-11）');
};
