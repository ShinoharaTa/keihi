// restic のサブプロセス（docs/mvp-plan-v0.1.md T5-0〜T5-3、architecture.md §3.4）。
// - 使ってよいサブコマンドは許可リストで絞る（追記のみの運用。古いスナップショットを消す系は呼べない）。
// - 子プロセスの環境は PATH・HOME など最小限 + secrets.env の restic 用の値だけ（GEMINI_API_KEY 等を渡さない）。
//   パスワードは RESTIC_PASSWORD で渡す（引数に載せない）。
// - テストでは RESTIC_BIN（settings.ts の findRestic）で偽物に差し替えて引数を検証する。
import { spawn } from 'node:child_process';

export const ALLOWED_SUBCOMMANDS = ['backup', 'check', 'restore', 'snapshots', 'version'] as const;
export type ResticSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

// 親の環境から引き継ぐ名前（restic のキャッシュ・一時ファイル・ロケール用）。
const PASS_THROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CACHE_HOME', 'RESTIC_CACHE_DIR'];
const MAX_CAPTURE = 256 * 1024;

export type ResticResult = { code: number; stdout: string; stderr: string };

export type Restic = {
  bin: string;
  run(subcommand: ResticSubcommand, args: string[]): Promise<ResticResult>;
};

export class ResticNotFoundError extends Error {
  constructor() {
    super('restic が見つからない（RESTIC_BIN、~/.local/bin/restic、PATH の順に探した）。docs/ops/backup.md §1 の手順で ~/.local/bin に入れる');
    this.name = 'ResticNotFoundError';
  }
}

function capture(buf: string, chunk: string): string {
  const s = buf + chunk;
  return s.length > MAX_CAPTURE ? s.slice(s.length - MAX_CAPTURE) : s;
}

export function childEnv(resticEnv: Record<string, string>, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (parent[k]) env[k] = parent[k]!;
  return { ...env, ...resticEnv };
}

export function createRestic(bin: string, resticEnv: Record<string, string>, parent: NodeJS.ProcessEnv = process.env): Restic {
  const env = childEnv(resticEnv, parent);
  return {
    bin,
    run(subcommand, args) {
      if (!(ALLOWED_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
        return Promise.reject(new Error(`restic ${String(subcommand)} は呼ばない（許可: ${ALLOWED_SUBCOMMANDS.join(', ')}）`));
      }
      return new Promise((resolve, reject) => {
        const child = spawn(bin, [subcommand, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout = capture(stdout, c)));
        child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr = capture(stderr, c)));
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
      });
    },
  };
}

// エラーメッセージ用に、出力の末尾を短くする。
export function tail(s: string, n = 500): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(t.length - n)}` : t;
}

// `restic backup --json` の出力から summary の snapshot_id を取る（無ければ null）。
export function parseBackupSummary(stdout: string): { snapshotId: string | null } {
  for (const line of stdout.split('\n').reverse()) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const o = JSON.parse(l) as { message_type?: string; snapshot_id?: string };
      if (o.message_type === 'summary') return { snapshotId: typeof o.snapshot_id === 'string' ? o.snapshot_id : null };
    } catch {
      // 進捗行が途中で切れていることがある
    }
  }
  return { snapshotId: null };
}
