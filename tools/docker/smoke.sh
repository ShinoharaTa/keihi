#!/usr/bin/env bash
# コンテナの動作確認（DEPLOYMENT.md §9）。イメージをビルドし、使い捨てのボリュームで起動して確かめる。
#   - ポートをホストに公開しない（確認はコンテナの中の curl）。外部の API は呼ばない（provider.kind = fake・シークレット無し）。
#   - 使い方: tools/docker/smoke.sh            （docker。podman なら DOCKER=podman tools/docker/smoke.sh）
#            SKIP_BUILD=1 IMAGE=keihi:dev tools/docker/smoke.sh   （ビルド済みのイメージで）
set -euo pipefail

DOCKER="${DOCKER:-docker}"
IMAGE="${IMAGE:-keihi:smoke}"
BASE_NAME="keihi-smoke-$$"
NAME="$BASE_NAME"
VOLUME="keihi-smoke-data-$$"
USER_HDR='Tailscale-User-Login: you@example.com'
BASE='http://127.0.0.1:8795'

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; "$DOCKER" logs "$NAME" 2>&1 | tail -n 40 >&2 || true; exit 1; }
cleanup() {
  "$DOCKER" rm -f "$BASE_NAME" "$BASE_NAME-neg" "$BASE_NAME-access" >/dev/null 2>&1 || true
  "$DOCKER" volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# コンテナの中から叩く（Cloudflare Access も Traefik も通らない経路 = Coolify のヘルスチェックと同じ）
cx() { "$DOCKER" exec "$NAME" curl -sS -o /dev/null -w '%{http_code}' "$@"; }
body() { "$DOCKER" exec "$NAME" curl -sS "$@"; }

run_app() { # $1 = コンテナ名、残り = 追加の引数
  local name="$1"; shift
  "$DOCKER" run -d --name "$name" -v "$VOLUME:/data" \
    -e KEIHI_PROVIDER_KIND=fake \
    -e KEIHI_WEB_ALLOWED_USERS=you@example.com \
    "$@" "$IMAGE" >/dev/null
}

wait_ready() {
  for _ in $(seq 1 60); do
    if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then fail "コンテナが起動直後に終了した"; fi
    if [ "$(cx "$BASE/health/ready" 2>/dev/null || true)" = "200" ]; then return 0; fi
    sleep 1
  done
  fail "/health/ready が 60 秒以内に 200 にならない"
}

if [ -z "${SKIP_BUILD:-}" ]; then
  "$DOCKER" build -t "$IMAGE" .
  pass "ビルド"
fi

"$DOCKER" volume create "$VOLUME" >/dev/null

# 1. 起動とヘルスチェック
run_app "$NAME" -e KEIHI_INSECURE_HEADER_AUTH=1
wait_ready
pass "起動（/health/ready = 200）"
[ "$(body "$BASE/health")" = '{"status":"ok"}' ] || fail '/health の本文が {"status":"ok"} でない'
[ "$(cx "$BASE/health/live")" = "200" ] || fail "/health/live"
pass '/health・/health/live・/health/ready'

# 2. 非 root・PID 1 が node
[ "$("$DOCKER" exec "$NAME" id -u)" != "0" ] || fail "root で動いている"
"$DOCKER" exec "$NAME" sh -c 'tr "\0" " " </proc/1/cmdline' | grep -q '^node src/web/main.ts' || fail "PID 1 が node でない"
pass "非 root・PID 1 = node"

# 3. HTTP API と認証
[ "$(cx "$BASE/api/status")" = "401" ] || fail "利用者のヘッダ無しで 401 にならない"
[ "$(cx -H "$USER_HDR" "$BASE/api/status")" = "200" ] || fail "/api/status"
[ "$(cx -H "$USER_HDR" "$BASE/")" = "200" ] || fail "PWA の index.html"
[ "$(cx -H "$USER_HDR" -H 'Host: evil.example.com' "$BASE/api/status")" = "400" ] || fail "許可していない Host を拒否しない"
pass "API・PWA・Host の検査"

# 4. 書き込み → 停止（SIGTERM）→ 同じボリュームで作り直し → 読める
LABEL="smoke-$$"
[ "$(cx -X POST -H "$USER_HDR" -H 'Content-Type: application/json' -d "{\"label\":\"$LABEL\",\"color\":0}" "$BASE/api/categories")" = "201" ] || fail "カテゴリの作成"
t0=$(date +%s)
"$DOCKER" stop -t 30 "$NAME" >/dev/null
t1=$(date +%s)
code="$("$DOCKER" inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$code" = "0" ] || fail "SIGTERM での終了コードが $code（0 のはず）"
[ $((t1 - t0)) -lt 25 ] || fail "停止に $((t1 - t0)) 秒かかった（SIGKILL を待った疑い）"
pass "SIGTERM で正常終了（終了コード 0、$((t1 - t0)) 秒）"

# 5. ログ: 標準出力・標準エラーが 1 行 1 JSON で、必須の項目がある
LOGF="$(mktemp)"; "$DOCKER" logs "$NAME" >"$LOGF" 2>&1
python3 - "$LOGF" <<'PY' || fail "ログが JSON でない・項目が足りない"
import json, sys
lines = [l for l in open(sys.argv[1]).read().splitlines() if l.strip()]
assert lines, 'ログが 1 行も無い'
for l in lines:
    o = json.loads(l)
    for k in ('ts', 'level', 'service', 'env', 'msg'):
        assert k in o, f'{k} が無い: {l}'
    assert o['env'] == 'production', l
assert any(o.get('msg') == 'request' for o in map(json.loads, lines)), 'アクセスログが無い'
assert not any('/health' in json.loads(l).get('path', '') for l in lines), 'ヘルスチェックがアクセスログに出ている'
PY
rm -f "$LOGF"
pass "JSON のログ（ts・level・service・env・msg、アクセスログ）"

"$DOCKER" rm "$NAME" >/dev/null
run_app "$NAME" -e KEIHI_INSECURE_HEADER_AUTH=1
wait_ready
body -H "$USER_HDR" "$BASE/api/categories" | grep -q "\"$LABEL\"" || fail "作り直したコンテナで、書いたデータが読めない"
pass "コンテナを作り直してもデータが残る（/data のボリューム）"
"$DOCKER" rm -f "$NAME" >/dev/null

# 6. ヘッダだけの認証のまま 0.0.0.0 で公開する設定は、起動を拒否する
run_app "$BASE_NAME-neg"
for _ in $(seq 1 20); do
  [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$BASE_NAME-neg")" = "false" ] && break
  sleep 1
done
[ "$("$DOCKER" inspect -f '{{.State.Running}}' "$BASE_NAME-neg")" = "false" ] || fail "認証の設定が無いのに起動した"
[ "$("$DOCKER" inspect -f '{{.State.ExitCode}}' "$BASE_NAME-neg")" != "0" ] || fail "起動の拒否なのに終了コードが 0"
pass "認証の設定が無ければ起動しない（終了コード ≠ 0）"
"$DOCKER" rm -f "$BASE_NAME-neg" >/dev/null

# 7. Cloudflare Access の方式: /health は通り、JWT の無いリクエストはヘッダを付けても通らない
NAME="$BASE_NAME-access"
run_app "$NAME" -e KEIHI_WEB_AUTH=cloudflare_access \
  -e KEIHI_WEB_ACCESS_TEAM_DOMAIN=example.cloudflareaccess.com -e KEIHI_WEB_ACCESS_AUD=smoke-aud
wait_ready
[ "$(cx -H "$USER_HDR" "$BASE/api/status")" = "401" ] || fail "Access の方式で、JWT が無いのに通った"
[ "$(cx -H 'Cf-Access-Jwt-Assertion: a.b.c' "$BASE/api/status")" = "401" ] || fail "壊れた JWT が通った"
pass "Access の方式: JWT が無ければ 401（Tailscale のヘッダは無視）"

echo "smoke: すべて通った"
