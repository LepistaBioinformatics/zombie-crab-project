#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Teste do crab-shell-proxy -- 100% NAO-INTERATIVO, sem sudo, containers NAO-root.
#
# Sobe o proxy, gera um template picoclaw "cru" (scaffold nao-interativo), forja
# o header x-mycelium-profile (base64+zstd, igual ao mycelium) e manda um chat
# direto ao proxy (sem mycelium/conta) -> o proxy sobe picoclaw-<agent>-<hash>
# do usuario (uid 1000), injeta provider/model/chave (do config.yaml + env) e
# conduz o turno.
#
# Provider/model vem do crab-shell-proxy/config.yaml (default: deepseek /
# deepseek-chat). A CHAVE vem do ENV: exporte DEEPSEEK_API_KEY antes de rodar
# para resposta real; sem ela, valida todo o pipeline e a resposta falha so na
# chamada ao modelo.
#
# Uso:
#   export DEEPSEEK_API_KEY=sk-...     # opcional (resposta real)
#   ./test-crab-shell.sh [agent] [email] [mensagem]
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

AGENT="${1:-alpha}"
EMAIL="${2:-tester@exemplo.com}"
MESSAGE="${3:-Ola, quem e voce?}"
SESSION="conv-$(date +%s)"
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-dummy-sem-key}"

IMG="docker.io/sipeed/picoclaw:latest"
NET="crab-test-net"
PROXY_CTR="crab-shell-proxy-test"
ROOT=/tmp/crab-agents
TMPL="$ROOT/templates/$AGENT"

echo ">> 1/6 gerando template CRU (scaffold nao-interativo) em $TMPL"
if [ ! -f "$TMPL/config.json" ]; then
  mkdir -p "$TMPL"
  # scaffold nao-interativo: em dir vazio o picoclaw gera config.json e sai (sem TTY).
  # provider/model/pico/chave sao injetados pelo proxy (config.yaml + env), nao aqui.
  docker run --rm -v "$TMPL":/root/.picoclaw "$IMG" >/dev/null 2>&1 || true
  [ -f "$TMPL/config.json" ] || { echo "   !! scaffold falhou"; exit 1; }
  docker run --rm -v "$TMPL":/x alpine chown -R "$(id -u):$(id -g)" /x
  rm -rf "$TMPL/workspace" "$TMPL/logs" "$TMPL/.picoclaw.pid"
  echo "   template cru pronto (proxy injeta provider/model/chave no provisionamento)"
else
  echo "   template ja existe, reaproveitando"
fi

echo ">> 2/6 build da imagem do proxy"
docker build --network=host -t crab-shell-proxy:dev ./crab-shell-proxy >/dev/null
docker network create "$NET" >/dev/null 2>&1 || true

echo ">> 3/6 subindo o proxy standalone em '$NET' (containers picoclaw = uid 1000)"
docker rm -f "$PROXY_CTR" >/dev/null 2>&1 || true
docker run -d --name "$PROXY_CTR" --network "$NET" --network-alias crab-shell-proxy \
  -e CRAB_NETWORK="$NET" \
  -e CRAB_HOST_DATA_ROOT="$ROOT" \
  -e MYC_PICOCLAW_ALPHA_TOKEN=tok-alpha \
  -e MYC_PICOCLAW_BETA_TOKEN=tok-beta \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$ROOT":/data/agents \
  crab-shell-proxy:dev >/dev/null

echo -n "   aguardando /healthz"
for _ in $(seq 1 30); do
  docker exec "$PROXY_CTR" wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 && { echo " ok"; break; }
  echo -n "."; sleep 1
done

echo ">> 4/6 chat direto (agent=$AGENT, email=$EMAIL, session=$SESSION, key=$([ "$DEEPSEEK_API_KEY" = dummy-sem-key ] && echo DUMMY || echo real))"
PROFILE=$(printf '{"owners":[{"email":"%s","isPrincipal":true}]}' "$EMAIL" | zstd -q -c | base64 -w0)
echo "   --- resposta (stream, max 90s) ---"
docker run --rm --network "$NET" curlimages/curl:latest -sN --max-time 90 \
  -X POST "http://crab-shell-proxy:8080/v1/chat/completions" \
  -H "x-mycelium-service-name: picoclaw-${AGENT}" \
  -H "Authorization: Bearer tok-${AGENT}" \
  -H "x-mycelium-profile: ${PROFILE}" \
  -H "Content-Type: application/json" \
  -d "{\"stream\":true,\"session_id\":\"${SESSION}\",\"messages\":[{\"role\":\"user\",\"content\":\"${MESSAGE}\"}]}" || true
echo; echo "   ----------------------------------"

echo ">> 5/6 containers criados pelo proxy (User deve ser 1000:1000):"
for c in $(docker ps -q --filter label=crab-shell.managed=true); do
  docker inspect "$c" --format '   {{.Name}}  status={{.State.Status}}  User={{.Config.User}}  mode={{index .Config.Labels "crab-shell.mode"}}'
done

echo ">> 6/6 ultimos logs do proxy:"
docker logs --tail 12 "$PROXY_CTR" 2>&1 | sed 's/^/   /'

echo
echo "Limpeza:"
echo "  docker rm -f $PROXY_CTR \$(docker ps -aq --filter label=crab-shell.managed=true); docker network rm $NET"
