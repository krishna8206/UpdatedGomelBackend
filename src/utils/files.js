import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function saveDataUrl(dataUrl, destPath) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) return null;
  const [, mime, b64] = match;
  const buffer = Buffer.from(b64, 'base64');
  ensureDir(path.dirname(destPath));
  fs.writeFileSync(destPath, buffer);
  return destPath;
}
