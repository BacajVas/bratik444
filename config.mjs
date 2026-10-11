import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ROOT = fileURLToPath(new URL('.', import.meta.url));
export const VERSION = '0.3.0';
export const DEFAULT_MODEL = 'gpt-oss:20b';

export function configuration(env = process.env) {
  const port = Number(env.PORT || 3044);
  const timeoutMs = Number(env.BRATIK_TIMEOUT_MS || 180_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error('BRATIK_TIMEOUT_MS должен быть от 1000 до 600000 мс.');
  const rawModel = env.BRATIK_MODEL || DEFAULT_MODEL;
  if (!validModelName(rawModel)) throw new Error('BRATIK_MODEL: укажи название установленной модели Ollama.');
  return {
    port,
    timeoutMs,
    model: rawModel.trim(),
    ollamaUrl: localOllamaUrl(env.OLLAMA_URL || 'http://127.0.0.1:11434'),
    dbPath: resolve(ROOT, env.BRATIK_DB_PATH || 'bratik.db'),
  };
}

export function validModelName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\s\u0000-\u001f]/u.test(value);
}

export function localOllamaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('OLLAMA_URL должен быть локальным HTTP-адресом.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Эта версия работает с локальной Ollama: используй http://127.0.0.1:11434 или localhost.');
  }
  return url.origin;
}
