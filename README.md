<div align="center">

<img src="launcher/assets/vrcast-icon.png" width="88" alt="">

# VRCast Bridge

Videos, anime and your screen in a VRChat video player, with one link.

[![Download](https://img.shields.io/github/v/release/Kevanko/VRCast-Bridge?label=Download&style=flat-square&color=8a5cff)](https://github.com/Kevanko/VRCast-Bridge/releases/latest)
![Windows 10 and 11](https://img.shields.io/badge/Windows-10%20%2F%2011-3b4bff?style=flat-square)
![Linux](https://img.shields.io/badge/Linux-X11-3b4bff?style=flat-square)
[![MIT](https://img.shields.io/badge/license-MIT-2a2f55?style=flat-square)](LICENSE)

<img src="docs/media/demo.gif" width="800" alt="VRCast Bridge: paste a link, go live, copy one link into AVPro in VRChat">

**[English](#english)** &nbsp;|&nbsp; **[Русский](#русский)**

</div>

## English

VRCast Bridge turns what's on your PC into a single link for the AVPro player in a VRChat world. The link stays the same while the app is open, so you can switch videos, pause or move to screen capture without anyone pressing resync. It reaches the world in about half a second.

- **Queue:** YouTube and playlists, VK, Rutube, AnimeLib and other Kodik sites, direct `.mp4` / `.m3u8` links, your own files. Spotify playlists, albums and copied tracks play via YouTube.
- **Screen:** a monitor, a window or a region, with system or per-app sound.
- **Friends:** a free public link (Cloudflare, Serveo) or your own server, installed with one command.
- **Phone remote:** scan a QR code and control the stream from your phone's browser.

### Quick start

**Windows:** download [VRCast Bridge.exe](https://github.com/Kevanko/VRCast-Bridge/releases/latest) and run it. It installs itself and fetches everything else on first launch.

**Linux (X11):** download the `.AppImage` (any distro) or `.deb` (Ubuntu, Debian) from [Releases](https://github.com/Kevanko/VRCast-Bridge/releases/latest). Nothing else to install; `ffmpeg` is fetched on first launch if missing.

```bash
chmod +x VRCast-Bridge-*.AppImage && ./VRCast-Bridge-*.AppImage
# or: sudo apt install ./VRCast-Bridge-*-amd64.deb
```

Then:

1. Paste a link into the queue, or open **Screen**.
2. Press **Go live**.
3. Copy the link at the top and paste it into AVPro in the world.

The world needs an **AVPro** player, and **Allow Untrusted URLs** must be on in your VRChat settings (it is per account).

### Your own server

On any Linux VPS with systemd:

```bash
curl -fsSL https://raw.githubusercontent.com/Kevanko/VRCast-Bridge/main/server/install.sh | sudo bash
```

It prints the address and a key. In the app: **Settings → Links and servers → Add server → Already set up**, paste both, then pick **Own server** at the top. Manage it later with `vrcast status`, `sudo vrcast key`, `sudo vrcast update` or `sudo vrcast uninstall`.

### Phone remote

**Settings → Phone**, then scan the QR code with a phone on the same Wi-Fi. Only paired devices can control the app.

More: [Linux, phone and building from source](docs/LINUX-AND-PHONE.md) (in Russian), [full guide](docs/GUIDE.md).

## Русский

VRCast Bridge отдаёт то, что происходит на компьютере, одной ссылкой для плеера AVPro в мире VRChat. Ссылка не меняется, пока программа открыта: можно переключать видео, ставить паузу или переходить на захват экрана, и никому не нужно жать resync. Картинка доходит до мира примерно за полсекунды.

- **Очередь:** YouTube и плейлисты, VK, Rutube, AnimeLib и другие сайты с Kodik, прямые ссылки `.mp4` и `.m3u8`, свои файлы. Плейлисты, альбомы и скопированные треки Spotify — звук берётся с YouTube.
- **Экран:** монитор, окно или область, системный звук или звук одного приложения.
- **Для друзей:** бесплатная публичная ссылка (Cloudflare, Serveo) или свой сервер, который ставится одной командой.
- **Пульт с телефона:** наведите камеру на QR-код и управляйте эфиром из браузера телефона.

### Быстрый старт

**Windows:** скачайте [VRCast Bridge.exe](https://github.com/Kevanko/VRCast-Bridge/releases/latest) и запустите. Программа установится сама и при первом запуске докачает всё остальное.

**Linux (X11):** скачайте `.AppImage` (любой дистрибутив) или `.deb` (Ubuntu, Debian) из [релизов](https://github.com/Kevanko/VRCast-Bridge/releases/latest). Больше ничего ставить не нужно; `ffmpeg` докачается при первом запуске, если его нет.

```bash
chmod +x VRCast-Bridge-*.AppImage && ./VRCast-Bridge-*.AppImage
# или: sudo apt install ./VRCast-Bridge-*-amd64.deb
```

Дальше:

1. Вставьте ссылку в очередь или откройте вкладку «Экран».
2. Нажмите «Начать эфир».
3. Скопируйте ссылку сверху и вставьте в AVPro в мире.

В мире нужен плеер **AVPro**, а в настройках VRChat включён **Allow Untrusted URLs** (это настройка аккаунта, у каждого своя).

### Свой сервер

На любом Linux-сервере с systemd:

```bash
curl -fsSL https://raw.githubusercontent.com/Kevanko/VRCast-Bridge/main/server/install.sh | sudo bash
```

Скрипт покажет адрес и ключ. В программе: «Настройки → Ссылки и серверы → Добавить сервер → Уже настроен», вставьте их и сверху выберите «Свой сервер». Дальше сервером управляет команда `vrcast`: `vrcast status`, `sudo vrcast key`, `sudo vrcast update`, `sudo vrcast uninstall`.

Без консоли тоже можно: «Добавить сервер → Настроить с нуля», программа сама зайдёт по SSH (пароль не сохраняется).

### Пульт с телефона

«Настройки → Телефон», затем наведите камеру телефона в той же Wi-Fi на QR-код. Управлять программой могут только привязанные устройства.

Подробнее: [Linux, телефон и сборка](docs/LINUX-AND-PHONE.md), [полное руководство](docs/GUIDE.md).

<div align="center">

<sub>[MIT](LICENSE)</sub>

</div>
