import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { configuration, validModelName, VERSION } from '../config.mjs';
import { createOllama } from '../ollama.mjs';

async function savedModel(dbPath) {
  let file;
  try { file = await stat(dbPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { model: null, exists: false };
    throw error;
  }
  if (!file.isFile()) throw new Error(`Путь базы не является файлом: ${dbPath}`);
  if (file.size === 0) throw new Error(`Файл базы пуст: ${dbPath}. Диагностика его не изменяла.`);

  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1500 });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!table) return { model: null, exists: true };
    const value = db.prepare('SELECT value FROM settings WHERE key=?').get('model')?.value;
    if (!value) return { model: null, exists: true };
    if (!validModelName(value)) throw new Error('В базе сохранено некорректное имя модели. Проверь настройки модели в интерфейсе.');
    return { model: value, exists: true };
  } finally {
    db.close();
  }
}

async function main() {
  const config = configuration();
  console.log(`Bratik Core ${VERSION} — диагностика`);
  console.log(`Node: ${process.version}`);
  console.log(`База: ${config.dbPath}`);
  const saved = await savedModel(config.dbPath);
  const model = saved.model || config.model;
  console.log(saved.exists ? 'База прочитана без изменения схемы и содержимого.' : 'База ещё не создана. Проверка не создаёт пустой файл.');
  console.log(`Модель: ${model}${saved.model ? ' (выбрана в интерфейсе)' : ' (из окружения или по умолчанию)'}`);
  console.log(`Ollama: ${config.ollamaUrl}`);

  const ollama = createOllama({ url: config.ollamaUrl, timeoutMs: config.timeoutMs });
  const result = await ollama.status(model);
  console.log(`${result.ready ? 'Готово' : 'Нужно исправить'}: ${result.message}`);
  console.log(`Код: ${result.code}`);
  if (result.models.length) {
    console.log('Модели, доступные через Ollama:');
    for (const item of result.models) console.log(`  ${item.name}`);
  }
  console.log('Генерация не запускалась: успешная проверка не измеряет скорость и не гарантирует, что модель поместится в память.');
  console.log('Для работы только на компьютере отключи облачные функции в самом Ollama; инструкция есть в README.');
  process.exitCode = result.ready ? 0 : 1;
}

main().catch(error => {
  console.error(`Диагностика не завершена: ${error.message}`);
  process.exitCode = 1;
});
