'use strict';
// После упаковки для Linux: запуск через скрипт с --no-sandbox. Без этого
// AppImage и .deb в Ubuntu 24.04 падают ещё до кода оболочки (AppArmor и
// suid-помощник Chromium), и app.commandLine.appendSwitch не успевает помочь.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async context => {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const binary = path.join(context.appOutDir, name);
  fs.renameSync(binary, `${binary}.bin`);
  fs.writeFileSync(binary, `#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/${name}.bin" --no-sandbox "$@"\n`, { mode: 0o755 });
};
