import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../memory.mjs';

function fresh(t) {
  const store = createMemoryStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  return store;
}

function suggestion(content, fields = {}) {
  return { content, kind: 'fact', importance: 5, confidence: 0.8, ...fields };
}

function approve(store, content, fields = {}) {
  return store.approveMemory(store.suggestMemory(suggestion(content, fields)).id);
}

function assertInvalid(action) {
  assert.throws(action, error => error.code === 'INVALID_MEMORY' && error.statusCode === 400);
}

test('new suggestions stay pending until approved, including explicit status attempts', t => {
  const store = fresh(t);
  const row = store.suggestMemory(suggestion('Проект Антарктида состоит из двенадцати эпизодов.', {
    kind: 'project', status: 'approved', source_turn_id: '8c52b7fe-2121-4bd1-af11-04d5892b849c',
  }));
  assert.equal(row.status, 'pending');
  assert.equal(row.source_turn_id, '8c52b7fe-2121-4bd1-af11-04d5892b849c');
  assert.deepEqual(store.relevantMemories('Антарктида'), []);
  assert.deepEqual(store.memoryCounts(), { pending: 1, approved: 0, forgotten: 0 });
  const approved = store.approveMemory(row.id);
  assert.equal(approved.status, 'approved');
  assert.equal(store.relevantMemories('Антарктида')[0].id, row.id);
  assert.deepEqual(store.memoryCounts(), { pending: 0, approved: 1, forgotten: 0 });
  assert.ok(approved.created_at && approved.updated_at);
  assert.equal('active' in approved, false);
  assert.equal('score' in store.relevantMemories('Антарктида')[0], false);
});

test('normalized repeated extraction preserves reviewed metadata and user edits', t => {
  const store = fresh(t);
  const original = approve(store, 'Василь предпочитает тёмный ambient.', { kind: 'preference', importance: 6, confidence: 0.9 });
  const repeated = store.suggestMemory(suggestion('  ВАСИЛЬ   предпочитает темный AMBIENT! ', {
    kind: 'fact', importance: 10, confidence: 1,
  }));
  assert.deepEqual(repeated, original);
  const edited = store.updateMemory(original.id, { content: 'Василь предпочитает ambient без металла.' });
  assert.equal(edited.status, 'approved');
  const oldWording = store.suggestMemory(suggestion(original.content));
  assert.equal(oldWording.id, edited.id);
  assert.equal(oldWording.content, edited.content);
  assert.deepEqual(store.memoryCounts(), { pending: 0, approved: 1, forgotten: 0 });
});

test('forget blocks original and edited wordings, approve and edit cannot resurrect them', t => {
  const store = fresh(t);
  const original = approve(store, 'Проект NOX использует зелёный свет.');
  store.updateMemory(original.id, { content: 'Проект NOX использует янтарный свет.' });
  assert.equal(store.forgetMemory(original.id), true);
  assert.equal(store.forgetMemory(original.id), true);
  assert.equal(store.forgetMemory(987654), false);
  assert.equal(store.suggestMemory(suggestion('проект nox использует зеленый свет!')), null);
  assert.equal(store.suggestMemory(suggestion('Проект NOX использует янтарный свет.')), null);
  assertInvalid(() => store.approveMemory(original.id));
  assertInvalid(() => store.updateMemory(original.id, { content: 'Новое содержание.' }));
  assert.deepEqual(store.relevantMemories('NOX свет'), []);
  assert.deepEqual(store.listMemories(), []);
  assert.equal(store.listMemories({ status: 'forgotten' })[0].id, original.id);
  assert.deepEqual(store.memoryCounts(), { pending: 0, approved: 0, forgotten: 1 });
});

test('pending edits keep pending; conflicting or forgotten content is rejected atomically', t => {
  const store = fresh(t);
  const first = store.suggestMemory(suggestion('Первый самостоятельный проект.'));
  const second = approve(store, 'Второй самостоятельный проект.');
  assertInvalid(() => store.updateMemory(first.id, { content: second.content }));
  assert.equal(store.listMemories({ status: 'pending' })[0].content, first.content);
  store.forgetMemory(second.id);
  assertInvalid(() => store.updateMemory(first.id, { content: second.content }));
  const edited = store.updateMemory(first.id, { content: 'Переработанный самостоятельный проект.' });
  assert.equal(edited.status, 'pending');
  assert.equal(store.suggestMemory(suggestion(first.content)).content, edited.content);
});

test('strict validation rejects malformed memory values without storing partial rows', t => {
  const store = fresh(t);
  const bad = [
    null, [], 'текст', {}, { content: 42 }, { content: {} }, { content: false }, { content: '' },
    { content: '  \n ' }, { content: '!!!' }, { content: 'x'.repeat(2001) },
    ...['unknown', 'FACT', '', null, 123, {}].map(kind => suggestion('Валидный текст.', { kind })),
    ...[-1, 0, 11, 5.5, NaN, Infinity, '5', null, {}].map(importance => suggestion('Валидный текст.', { importance })),
    ...[-0.1, 1.01, NaN, Infinity, '0.8', null, {}].map(confidence => suggestion('Валидный текст.', { confidence })),
    ...['', ' ', 'x'.repeat(129), 12, {}].map(source_turn_id => suggestion('Валидный текст.', { source_turn_id })),
  ];
  for (const value of bad) assertInvalid(() => store.suggestMemory(value));
  assert.deepEqual(store.memoryCounts(), { pending: 0, approved: 0, forgotten: 0 });
  const row = store.suggestMemory({ content: '  Содержательный текст.  ' });
  assert.equal(row.content, 'Содержательный текст.');
  assert.equal(row.importance, 5);
  assert.equal(row.confidence, 0.8);
  assert.equal(row.kind, 'fact');
  assert.equal('source_turn_id' in row, false);
  for (const kind of ['fact', 'preference', 'project', 'decision', 'goal', 'correction', 'task', 'lesson']) {
    assert.equal(store.suggestMemory(suggestion(`Тип записи ${kind}.`, { kind, importance: 1, confidence: 0 })).kind, kind);
  }
});

test('method arguments and missing records have stable HTTP-compatible error codes', t => {
  const store = fresh(t);
  for (const id of [0, -1, 1.5, NaN, Infinity, '1', null]) {
    assertInvalid(() => store.approveMemory(id));
    assertInvalid(() => store.forgetMemory(id));
    assertInvalid(() => store.updateMemory(id, { content: 'Новый текст.' }));
  }
  for (const action of [() => store.approveMemory(123), () => store.updateMemory(123, { content: 'Новый текст.' })]) {
    assert.throws(action, error => error.code === 'MEMORY_NOT_FOUND' && error.statusCode === 404);
  }
  const row = store.suggestMemory(suggestion('Запись для редактирования.'));
  for (const patch of [null, [], {}, { content: '' }, { content: 'Текст.', status: 'approved' }, { content: 'Текст.', importance: 10 }]) {
    assertInvalid(() => store.updateMemory(row.id, patch));
  }
  assertInvalid(() => store.listMemories({ status: 'invalid' }));
  assertInvalid(() => store.relevantMemories({}));
  for (const limit of [0, -1, 1.5, 501, NaN, '10']) {
    assertInvalid(() => store.listMemories({ limit }));
    assertInvalid(() => store.relevantMemories('текст', limit));
  }
});

test('facts require meaningful whole-token overlap regardless of importance', t => {
  const store = fresh(t);
  const unrelated = approve(store, 'Василь строит мобильный дом.', { importance: 10, confidence: 1 });
  const relevant = approve(store, 'Suno сохраняет выбранный баритон.', { importance: 1, confidence: 0.1 });
  approve(store, 'Пользователь хранит формулу кислород.', { importance: 10 });
  const result = store.relevantMemories('Братик, пожалуйста, расскажи про Suno.');
  assert.deepEqual(result.map(row => row.id), [relevant.id]);
  assert.equal(result.some(row => row.id === unrelated.id), false);
  assert.deepEqual(store.relevantMemories('Привет, как дела?'), []);
  assert.deepEqual(store.relevantMemories('род'), []); // Do not substring-match кислород.
  assert.deepEqual(store.relevantMemories('Пользователь, что мне делать?'), []);
});

test('no more than two approved high-confidence preferences accompany unrelated queries', t => {
  const store = fresh(t);
  const first = approve(store, 'Отвечать по-русски.', { kind: 'preference', importance: 9, confidence: 0.9 });
  const second = approve(store, 'Писать прямо и кратко.', { kind: 'preference', importance: 8, confidence: 0.9 });
  approve(store, 'Сохранять мрачную атмосферу.', { kind: 'preference', importance: 7, confidence: 0.9 });
  approve(store, 'Добавлять пояснения.', { kind: 'preference', importance: 4, confidence: 1 });
  approve(store, 'Задавать больше вопросов.', { kind: 'preference', importance: 10, confidence: 0.69 });
  store.suggestMemory(suggestion('Предпочитать незавершенные ответы.', { kind: 'preference', importance: 10, confidence: 1 }));
  approve(store, 'Старый факт о печенье.', { importance: 10, confidence: 1 });
  assert.deepEqual(store.relevantMemories('Океан').map(row => row.id), [first.id, second.id]);
  const match = approve(store, 'Океан скрывает неизвестные глубины.', { importance: 1 });
  assert.deepEqual(store.relevantMemories('Океан', 3).map(row => row.id), [match.id, first.id, second.id]);
  assert.deepEqual(store.relevantMemories('Океан', 1).map(row => row.id), [match.id]);
});

test('list filtering, limits and counts expose pending first and omit forgotten by default', t => {
  const store = fresh(t);
  const approved = approve(store, 'Утвержденный факт.', { importance: 10 });
  const pending = store.suggestMemory(suggestion('Ожидающий факт.', { importance: 1 }));
  const forgotten = approve(store, 'Забытый факт.');
  store.forgetMemory(forgotten.id);
  assert.deepEqual(store.listMemories().map(row => row.id), [pending.id, approved.id]);
  assert.deepEqual(store.listMemories({ limit: 1 }).map(row => row.id), [pending.id]);
  assert.equal(store.listMemories({ status: 'all' }).length, 3);
  assert.deepEqual(store.listMemories({ status: 'approved' }).map(row => row.id), [approved.id]);
  assert.deepEqual(store.memoryCounts(), { pending: 1, approved: 1, forgotten: 1 });
});

test('legacy v0.2 migration preserves conversation IDs, text, timestamps and legacy kinds across reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'bratik-memory-migration-'));
  const dbPath = join(directory, 'bratik.db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      role TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL UNIQUE,
      importance INTEGER NOT NULL DEFAULT 5,
      confidence REAL NOT NULL DEFAULT 0.8,
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO conversations(id, created_at, role, content) VALUES
      (21, '2026-09-03 08:20:00', 'user', 'Сохрани мою историю.'),
      (22, '2026-09-03 08:20:10', 'assistant', 'История сохранена.');
    INSERT INTO memories(id, created_at, updated_at, kind, content, importance, confidence, active) VALUES
      (12, '2026-09-03 08:20:00', '2026-09-03 08:20:10', 'custom_legacy_kind', 'Проект Антарктида продолжается.', 9, 0.95, 1),
      (13, '2026-09-03 08:22:00', '2026-09-03 08:22:10', 'fact', 'Старая забытая информация.', 7, 0.8, 0);
  `);
  const oldConversations = legacy.prepare('SELECT * FROM conversations ORDER BY id').all().map(row => ({ ...row }));
  const oldConversationSQL = legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'conversations'").get().sql;
  legacy.close();

  let store = createMemoryStore({ dbPath });
  const old = store.listMemories({ status: 'approved' })[0];
  assert.equal(old.id, 12);
  assert.equal(old.kind, 'custom_legacy_kind');
  assert.equal(old.created_at, '2026-09-03 08:20:00');
  assert.equal(old.updated_at, '2026-09-03 08:20:10');
  assert.equal(store.relevantMemories('Антарктида')[0].id, 12);
  assert.equal(store.suggestMemory(suggestion('старая   забытая информация!')), null);
  const pending = store.suggestMemory(suggestion('Новое предложение про диалог.'));
  store.updateMemory(pending.id, { content: 'Измененное предложение про диалог.' });
  store.forgetMemory(pending.id);
  const remainsPending = store.suggestMemory(suggestion('Предложение для дальнейшего рассмотрения.'));
  store.close();

  store = createMemoryStore({ dbPath });
  try {
    assert.deepEqual(store.memoryCounts(), { pending: 1, approved: 1, forgotten: 2 });
    assert.equal(store.listMemories({ status: 'pending' })[0].id, remainsPending.id);
    assert.equal(store.suggestMemory(suggestion('Новое предложение про диалог.')), null);
    assert.equal(store.suggestMemory(suggestion('Измененное предложение про диалог.')), null);
    assert.equal(store.suggestMemory(suggestion('Старая забытая информация.')), null);
  } finally { store.close(); }
  const check = new DatabaseSync(dbPath);
  try {
    assert.deepEqual(check.prepare('SELECT * FROM conversations ORDER BY id').all().map(row => ({ ...row })), oldConversations);
    assert.equal(check.prepare("SELECT sql FROM sqlite_master WHERE name = 'conversations'").get().sql, oldConversationSQL);
    assert.equal(check.prepare('SELECT active FROM memories WHERE id = 12').get().active, 1);
    assert.equal(check.prepare('SELECT active FROM memories WHERE id = 13').get().active, 0);
  } finally { check.close(); }
});

test('closing a store with a shared DatabaseSync never closes its caller-owned connection', () => {
  const database = new DatabaseSync(':memory:');
  const store = createMemoryStore({ database });
  store.suggestMemory(suggestion('Общая база остается доступной.'));
  store.close();
  store.close();
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 1);
  database.exec('CREATE TABLE caller_still_owns_database (id INTEGER)');
  database.close();
});

test('legacy case-duplicate records retain independent text history when edited then forgotten', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL UNIQUE,
      importance INTEGER NOT NULL DEFAULT 5,
      confidence REAL NOT NULL DEFAULT 0.8,
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO memories(content) VALUES ('Проект Атлас использует синий цвет.');
    INSERT INTO memories(content) VALUES ('ПРОЕКТ АТЛАС ИСПОЛЬЗУЕТ СИНИЙ ЦВЕТ!');
  `);
  const store = createMemoryStore({ database });
  try {
    store.updateMemory(2, { content: 'Проект Атлас использует зеленый цвет.' });
    store.forgetMemory(2);
    assert.equal(store.suggestMemory(suggestion('Проект Атлас использует синий цвет.')), null);
    assert.equal(store.suggestMemory(suggestion('Проект Атлас использует зеленый цвет.')), null);
    assert.deepEqual(store.relevantMemories('Атлас'), []);
  } finally {
    store.close();
    database.close();
  }
});
