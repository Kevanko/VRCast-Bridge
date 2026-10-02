#!/usr/bin/env bash
# VRCast Bridge — сервер трансляции одной командой.
#   curl -fsSL https://raw.githubusercontent.com/Kevanko/VRCast-Bridge/main/server/install.sh | sudo bash
# Порт можно задать: ... | sudo VRCAST_PORT=9554 bash
# Ставит MediaMTX службой vrcast-relay в /opt/vrcast-relay и команду `vrcast`
# (status, key, update, restart, logs, uninstall). Повторный запуск = обновление,
# ключ публикации при этом сохраняется.
set -eu

MTX_VERSION=v1.20.1
DIR=/opt/vrcast-relay
KEY_FILE="$DIR/publish.key"
PORT_FILE="$DIR/port"
INSTALL_URL=https://raw.githubusercontent.com/Kevanko/VRCast-Bridge/main/server/install.sh

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; R=$'\e[31m'; C=$'\e[36m'; Y=$'\e[33m'; N=$'\e[0m'; else B= D= G= R= C= Y= N=; fi
# VRCAST_MACHINE=1 — запуск из программы («Настроить с нуля»): итог одной строкой VRCAST_OK/VRCAST_ERR.
MACHINE="${VRCAST_MACHINE:-}"
fail() { if [ -n "$MACHINE" ]; then echo "VRCAST_ERR $*"; else echo "${R}✗ $*${N}" >&2; fi; exit 1; }
step() { [ -n "$MACHINE" ] || echo "${C}›${N} $*"; }

[ "$(id -u)" -eq 0 ] || fail "Нужны права root: запустите через sudo."
command -v curl >/dev/null 2>&1 || fail "Нет curl: apt install curl (или yum install curl)."
command -v systemctl >/dev/null 2>&1 || fail "Нет systemd — нужен обычный Linux-сервер (Ubuntu, Debian, CentOS…)."
case "$(uname -m)" in
  x86_64|amd64) ARCH=linux_amd64 ;;
  aarch64|arm64) ARCH=linux_arm64 ;;
  armv7*) ARCH=linux_armv7 ;;
  *) fail "Процессор не поддерживается: $(uname -m)" ;;
esac

mkdir -p "$DIR"
PORT="${VRCAST_PORT:-$(cat "$PORT_FILE" 2>/dev/null || echo 8554)}"
case "$PORT" in ''|*[!0-9]*) fail "Порт должен быть числом: $PORT" ;; esac
echo "$PORT" > "$PORT_FILE"

if [ ! -x "$DIR/mediamtx" ] || [ "$("$DIR/mediamtx" --version 2>/dev/null)" != "$MTX_VERSION" ]; then
  step "Скачиваю MediaMTX $MTX_VERSION ($ARCH)…"
  URL="https://github.com/bluenviron/mediamtx/releases/download/$MTX_VERSION/mediamtx_${MTX_VERSION}_$ARCH.tar.gz"
  curl -fsSL "$URL" -o /tmp/vrcast-mtx.tar.gz || fail "Не скачался MediaMTX: $URL"
  systemctl stop vrcast-relay >/dev/null 2>&1 || true
  tar xzf /tmp/vrcast-mtx.tar.gz -C "$DIR" mediamtx
  rm -f /tmp/vrcast-mtx.tar.gz
else
  step "MediaMTX $MTX_VERSION уже стоит"
fi

[ -s "$KEY_FILE" ] || { head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$KEY_FILE"; chmod 600 "$KEY_FILE"; }
KEY=$(cat "$KEY_FILE")
# MediaMTX требует чётный RTP-порт; UDP-порты держим рядом с RTSP, чтобы не лезть в чужие.
RTP=$(( PORT + 1 + (PORT + 1) % 2 ))
HLSPORT=$(( PORT + 10 ))

step "Пишу настройку и службу…"
id vrcast-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin vrcast-relay 2>/dev/null || true
cat > "$DIR/mediamtx.yml" <<EOF
logLevel: error
readTimeout: 10s
writeTimeout: 10s
# Очередь исходящих пакетов на зрителя: запас для медленных каналов и VR-клиентов.
writeQueueSize: 1024
rtspAddress: :$PORT
rtpAddress: :$RTP
rtcpAddress: :$((RTP + 1))
multicastRTPPort: $((RTP + 2))
multicastRTCPPort: $((RTP + 3))
rtspAuthMethods: [digest]
rtmp: no
hls: yes
hlsAddress: :$HLSPORT
hlsVariant: mpegts
hlsSegmentCount: 4
hlsSegmentDuration: 1s
hlsAlwaysRemux: no
webrtc: no
srt: no
moq: no
api: no
metrics: no
pprof: no
playback: no
authInternalUsers:
- user: any
  permissions:
  - action: read
- user: vrcast
  pass: $KEY
  permissions:
  - action: publish
paths:
  live:
    # Программа пропала (перезапуск, сон ПК, обрыв) — зрителям идёт заставка,
    # соединение не рвётся; вернулась — поток продолжается сам.
    alwaysAvailable: yes
    alwaysAvailableTracks:
    - codec: H264
    - codec: MPEG4Audio
      sampleRate: 48000
      channelCount: 2
  all_others: {}
EOF
chmod 600 "$DIR/mediamtx.yml"
if id vrcast-relay >/dev/null 2>&1; then chown -R vrcast-relay: "$DIR"; RUN_AS="User=vrcast-relay
Group=vrcast-relay"; else RUN_AS=""; fi

cat > /etc/systemd/system/vrcast-relay.service <<EOF
[Unit]
Description=VRCast Bridge media relay
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$DIR/mediamtx $DIR/mediamtx.yml
$RUN_AS
Restart=always
RestartSec=1
Nice=-10
IOSchedulingClass=best-effort
IOSchedulingPriority=0
OOMScoreAdjust=-900
LimitNOFILE=65536
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadOnlyPaths=$DIR

[Install]
WantedBy=multi-user.target
EOF

# Команда обслуживания. Пишется из установщика, поэтому обновляется вместе с ним.
cat > /usr/local/bin/vrcast <<'CLI'
#!/usr/bin/env bash
DIR=/opt/vrcast-relay
INSTALL_URL=https://raw.githubusercontent.com/Kevanko/VRCast-Bridge/main/server/install.sh
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; R=$'\e[31m'; C=$'\e[36m'; Y=$'\e[33m'; N=$'\e[0m'; else B= D= G= R= C= Y= N=; fi
need_root() { [ "$(id -u)" -eq 0 ] || { echo "${R}Нужны права root: sudo vrcast $1${N}"; exit 1; }; }
PORT=$(cat "$DIR/port" 2>/dev/null || echo 8554)
ip_addr() { curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'; }
card() {
  local ip; ip=$(ip_addr)
  local key; key=$(cat "$DIR/publish.key" 2>/dev/null || echo "(нет доступа — запустите через sudo)")
  local addr="$ip"; [ "$PORT" = 8554 ] || addr="$ip:$PORT"
  echo
  echo "  ${B}${C}┌─────────────────────────────────────────${N}"
  echo "  ${B}${C}│${N}  ${B}VRCast Bridge — сервер готов${N}"
  echo "  ${B}${C}├─────────────────────────────────────────${N}"
  echo "  ${B}${C}│${N}  Адрес  ${B}${G}$addr${N}"
  echo "  ${B}${C}│${N}  Ключ   ${B}${G}$key${N}"
  echo "  ${B}${C}└─────────────────────────────────────────${N}"
  echo
  echo "  ${B}Как подключить${N}"
  echo "  1. VRCast Bridge → Настройки → Сеть и серверы → «Добавить сервер»"
  echo "  2. Вкладка «Уже настроен»: вставьте адрес и ключ, нажмите «Подключить»"
  echo "  3. Сверху выберите «Свой сервер» — ссылка для VRChat появится сама:"
  echo "     ${D}rtspt://$ip:$PORT/live${N}"
  echo
  echo "  ${D}Ключ никому не показывайте: с ним можно вещать на ваш сервер.${N}"
  echo "  ${D}Команды: vrcast status · key · update · restart · logs · uninstall${N}"
  echo
}
case "${1:-help}" in
  status)
    if systemctl is-active --quiet vrcast-relay; then
      echo "${G}● работает${N}  с $(systemctl show vrcast-relay -p ActiveEnterTimestamp --value)"
    else
      echo "${R}● остановлен${N} — посмотрите: vrcast logs"
    fi
    echo "  MediaMTX $("$DIR/mediamtx" --version 2>/dev/null || echo '?') · порт RTSP $PORT, HLS $((PORT + 10))"
    if command -v ss >/dev/null 2>&1; then
      n=$(ss -tn state established "( sport = :$PORT )" 2>/dev/null | tail -n +2 | wc -l)
      echo "  Подключений сейчас: $n ${D}(программа + зрители)${N}"
    fi
    ;;
  key|info) card ;;
  update) need_root update; curl -fsSL "$INSTALL_URL" | bash ;;
  restart) need_root restart; systemctl restart vrcast-relay && echo "${G}Перезапущен${N}" ;;
  logs) journalctl -u vrcast-relay -n "${2:-50}" --no-pager ;;
  uninstall)
    need_root uninstall
    read -r -p "Удалить сервер VRCast и ключ? Ссылки у друзей перестанут работать. [y/N] " a < /dev/tty
    [ "$a" = y ] || [ "$a" = Y ] || exit 0
    systemctl disable --now vrcast-relay >/dev/null 2>&1
    rm -f /etc/systemd/system/vrcast-relay.service; systemctl daemon-reload
    if command -v ufw >/dev/null 2>&1; then ufw delete allow "$PORT/tcp" >/dev/null 2>&1; ufw delete allow "$((PORT + 10))/tcp" >/dev/null 2>&1; fi
    rm -rf "$DIR" /usr/local/bin/vrcast
    echo "${G}Удалено.${N}"
    ;;
  *)
    echo "${B}vrcast${N} — сервер трансляции VRCast Bridge"
    echo "  vrcast status      работает ли, сколько подключений"
    echo "  vrcast key         адрес и ключ для программы"
    echo "  sudo vrcast update     обновить до последней версии (ключ сохранится)"
    echo "  sudo vrcast restart    перезапустить"
    echo "  vrcast logs [N]    последние строки журнала"
    echo "  sudo vrcast uninstall  удалить сервер"
    ;;
esac
CLI
chmod 755 /usr/local/bin/vrcast

step "Запускаю службу…"
systemctl daemon-reload
systemctl enable vrcast-relay >/dev/null 2>&1 || true
systemctl restart vrcast-relay

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true; ufw allow "$HLSPORT/tcp" >/dev/null 2>&1 || true
  step "Открыл порты $PORT и $HLSPORT в ufw"
fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port="$HLSPORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  step "Открыл порты $PORT и $HLSPORT в firewalld"
fi

sleep 2
if ! systemctl is-active --quiet vrcast-relay; then
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT$"; then
    fail "Порт $PORT занят другой программой. Поставьте на другой: curl … | sudo VRCAST_PORT=9554 bash"
  fi
  [ -n "$MACHINE" ] && fail "служба не запустилась: $(journalctl -u vrcast-relay -n 5 --no-pager 2>/dev/null | tr '\n' ' ' | tail -c 700)"
  journalctl -u vrcast-relay -n 10 --no-pager >&2 || true
  fail "Служба не запустилась — строки выше подскажут почему."
fi

if [ -n "$MACHINE" ]; then
  IP=$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  echo "VRCAST_OK ip=$IP port=$PORT hls=$HLSPORT key=$KEY"
  exit 0
fi
echo "${G}✓ Готово.${N} ${D}Если у хостера есть свой файрвол в панели — откройте там TCP $PORT.${N}"
/usr/local/bin/vrcast key
