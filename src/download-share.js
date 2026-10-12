// Доля скачанного по строкам прогресса yt-dlp (0…1).
// yt-dlp качает видео и звук по очереди, и проценты начинаются заново:
// видео — 90 % полосы, звук — последние 10 %.
export function downloadShare() {
  let этап = 0, прошлый = 0;
  return line => {
    const m = /\[download\]\s+([\d.]+)%/.exec(line);
    if (!m) return null;
    const p = Math.min(100, Number(m[1])) / 100;
    if (p + 0.2 < прошлый) этап++;
    прошлый = p;
    return этап === 0 ? p * 0.9 : Math.min(0.99, 0.9 + p * 0.1);
  };
}
