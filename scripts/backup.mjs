import { mkdir, open, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { configuration, VERSION } from '../config.mjs';

async function main() {
  const { dbPath } = configuration();
  let file;
  try { file = await stat(dbPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`База ещё не существует: ${dbPath}. Копировать нечего; пустая база не создана.`);
    throw error;
  }
  if (!file.isFile() || file.size === 0) throw new Error(`Нужен существующий непустой файл SQLite: ${dbPath}`);

  const source = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 });
  let destination;
  let reserved = false;
  let complete = false;
  try {
    // Validate the source before creating the destination directory or file.
    source.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
    const directory = join(dirname(dbPath), 'backups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = basename(dbPath, extname(dbPath));
    destination = join(directory, `${name}-${stamp}-${randomUUID()}.sqlite`);
    // Reserve our own unique file. An existing backup is never overwritten.
    const handle = await open(destination, 'wx', 0o600);
    reserved = true;
    await handle.close();
    const pages = await backup(source, destination);

    const copy = new DatabaseSync(destination, { readOnly: true, timeout: 3000 });
    try {
      const checks = copy.prepare('PRAGMA quick_check').all();
      if (checks.length !== 1 || Object.values(checks[0])[0] !== 'ok') {
        throw new Error('Копия не прошла SQLite quick_check. Исходная база не изменена.');
      }
    } finally {
      copy.close();
    }
    complete = true;
    console.log(`Bratik Core ${VERSION} — резервная копия готова`);
    console.log(`Источник: ${dbPath}`);
    console.log(`Копия: ${destination}`);
    console.log(`Скопировано страниц: ${pages}. SQLite quick_check: ok.`);
    console.log('Копия содержит историю и память. Храни её как личные данные.');
  } finally {
    source.close();
    if (reserved && !complete) {
      for (const path of [destination, `${destination}-wal`, `${destination}-shm`]) {
        await rm(path, { force: true }).catch(() => {});
      }
    }
  }
}

main().catch(error => {
  console.error(`Резервная копия не создана: ${error.message}`);
  process.exitCode = 1;
});
