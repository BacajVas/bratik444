(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const STORAGE_KEY = 'bratik-core-draft-v3';
  const MAX_MESSAGE = 8000;
  const ACKNOWLEDGED_FAILURES = new Set(['OLLAMA_UNAVAILABLE', 'OLLAMA_ERROR', 'EMPTY_RESPONSE', 'MODEL_MISSING', 'MODEL_TIMEOUT', 'CHAT_BUSY', 'INVALID_REQUEST', 'REMOTE_MODEL_UNSUPPORTED', 'MODEL_UNSUPPORTED', 'REQUEST_CONFLICT']);
  const ui = {
    form: $('#form'), input: $('#input'), send: $('#send-button'), chat: $('#chat'), scroll: $('#chat-scroll'),
    model: $('#model-select'), memories: $('#memories'), controls: $('#controls-panel'),
  };
  let statusData = null;
  let statusError = '';
  let statusSequence = 0;
  let statusRequest = null;
  let settingsBusy = false;
  let booting = true;
  let pending = null;
  let sending = false;
  let reconciling = false;
  let draftWarning = '';
  let historyMessages = [];
  let historyLoaded = false;
  let historyLoading = false;
  let historyHasMore = false;
  let historyBefore = null;
  const completedTurns = new Map();
  let memoryItems = [];
  let memoryFilter = 'pending';
  let memoriesLoaded = false;
  let memoryLoading = false;
  const memoryCache = new Map();
  const memoryRequests = new Map();
  let memoryRevision = 0;
  const memoryMutations = new Set();
  const memoryDrafts = new Map();
  const memorySources = new Map();
  let editingMemory = null;
  let reflectionLocalPending = false;
  let reflectionRetrying = false;
  let reflectionWasActive = false;
  let pollTimer = null;
  let pollRunning = false;

  class ApiError extends Error {
    constructor(message, code, status = 0) { super(message); this.code = code; this.status = status; }
  }

  async function request(path, {method = 'GET', body, timeout = 16000} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: {Accept: 'application/json', ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new ApiError('Сервер вернул непонятный ответ. Проверь соединение с Братиком.', 'INVALID_RESPONSE', response.status); }
      if (!response.ok) throw new ApiError(data.error || 'Не удалось выполнить запрос.', data.code || 'SERVER_ERROR', response.status);
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(controller.signal.aborted ? 'Время ожидания ответа сервера истекло.' : 'Не удалось связаться с локальным сервером Братика.', controller.signal.aborted ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function feedback(selector, text = '', error = false) {
    const element = $(selector);
    if (element.textContent !== text) element.textContent = text;
    element.dataset.state = error ? 'error' : '';
  }

  function safeDate(value) {
    if (!value) return null;
    // SQLite's CURRENT_TIMESTAMP is UTC but has no explicit suffix.
    const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function timeElement(value, short = false) {
    const date = safeDate(value);
    if (!date) return null;
    const element = node('time', '', new Intl.DateTimeFormat('ru', short
      ? {day: 'numeric', month: 'short'} : {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}).format(date));
    element.dateTime = date.toISOString();
    return element;
  }

  function saveDraft() {
    try {
      if (ui.input.value || pending) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({draft: ui.input.value, pending}));
      } else window.localStorage.removeItem(STORAGE_KEY);
      draftWarning = '';
    } catch (_) {
      draftWarning = 'Не удалось сохранить черновик в браузере. Не закрывай вкладку, пока нужен этот текст.';
    }
    renderDraftStatus();
  }

  function restoreDraft() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      if (typeof saved.draft === 'string') ui.input.value = saved.draft;
      const item = saved.pending;
      if (item && typeof item.message === 'string' && item.message.trim() && item.message.length <= MAX_MESSAGE
        && typeof item.request_id === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(item.request_id)) {
        const acknowledged = item.state === 'failed' && ACKNOWLEDGED_FAILURES.has(item.error?.code);
        pending = {
          request_id: item.request_id, message: item.message, created_at: item.created_at || new Date().toISOString(),
          state: acknowledged ? 'failed' : 'uncertain',
          error: acknowledged ? {code: item.error.code, message: String(item.error.message || 'Сервер не смог выполнить запрос.')}
            : {code: 'RESTORED', message: 'Проверяю результат сохранённого запроса.'},
        };
      }
    } catch (_) { draftWarning = 'Сохранённый черновик недоступен. Новые сообщения можно написать здесь.'; }
    renderDraftStatus();
  }

  function renderDraftStatus() {
    $('#draft-status').textContent = draftWarning || (pending
      ? 'Этот запрос сохранён в браузере для восстановления после обновления страницы.'
      : ui.input.value ? 'Черновик сохраняется в этом браузере.' : '');
  }

  function modelReady() { return Boolean(statusData?.ollama?.ready && !statusError); }
  function activeRequest() { return sending || reconciling || Boolean(statusData?.busy); }

  function renderComposer() {
    const length = ui.input.value.length;
    const waiting = Boolean(pending);
    ui.input.disabled = sending || reconciling || waiting;
    ui.send.disabled = booting || settingsBusy || waiting || activeRequest() || !modelReady() || !ui.input.value.trim() || length > MAX_MESSAGE;
    $('#send-label').textContent = sending ? 'Думаю…' : waiting ? 'Жду результат' : 'Отправить';
    $('#input-count').textContent = `${length} / ${MAX_MESSAGE}`;
    $('#input-count').dataset.state = length > MAX_MESSAGE ? 'error' : '';
    ui.form.setAttribute('aria-busy', String(sending || reconciling));
    ui.model.disabled = settingsBusy || sending || reconciling || Boolean(statusData?.busy) || !statusData?.ollama?.models?.length;
    $$('[data-prompt]').forEach(button => { button.disabled = waiting || sending || reconciling; });
    $('#thinking').hidden = !(sending || reconciling || (pending && statusData?.busy));
    $('#thinking-title').textContent = reconciling ? 'Проверяю сохранённый ответ…' : 'Братик готовит ответ…';
    $('#thinking-detail').textContent = pending && !sending && statusData?.busy
      ? 'Сервер ещё занят. Проверю результат автоматически.' : 'Скорость зависит от модели и компьютера.';
    renderTurnError();
  }

  function renderModels() {
    const models = Array.isArray(statusData?.ollama?.models) ? statusData.ollama.models : [];
    const installed = models.filter(model => model && typeof model.name === 'string');
    const selected = statusData?.model || '';
    const signature = JSON.stringify([installed, selected, Boolean(statusError)]);
    if (ui.model.dataset.signature !== signature) {
      const options = [];
      if (!installed.some(model => model.name === selected)) {
        const placeholder = node('option', '', installed.length ? 'Выбери установленную модель' : 'Установленных моделей не видно');
        placeholder.value = ''; placeholder.disabled = Boolean(installed.length); options.push(placeholder);
      }
      for (const model of installed) {
        const size = typeof model.size === 'number' && model.size > 0 ? ` · ${(model.size / 1e9).toLocaleString('ru', {maximumFractionDigits: 1})} ГБ` : '';
        const option = node('option', '', model.name + size); option.value = model.name; options.push(option);
      }
      ui.model.replaceChildren(...options);
      ui.model.value = installed.some(model => model.name === selected) ? selected : '';
      ui.model.dataset.signature = signature;
    }
    $('#active-model').textContent = selected || 'Не выбрана';
    $('#ollama-address').textContent = statusData?.ollama?.url || 'Не удалось проверить';
    $('#model-note').textContent = statusData?.busy || sending ? 'Модель можно сменить после текущего ответа.'
      : installed.length ? 'Выбор сохраняется для следующих ответов. Размер — объём модели на диске.'
      : 'Установи модель в Ollama, затем обнови список кнопкой проверки.';
  }

  function renderStatus() {
    const state = statusData?.ollama;
    let title, message, badge, tone;
    if (statusError) {
      title = 'Сервер Братика недоступен'; message = statusError; badge = 'Нет связи с Братиком'; tone = 'error';
    } else if (!state) {
      title = 'Проверяю Ollama…'; message = 'Нужны работающая Ollama и установленная модель.'; badge = 'Проверяю соединение'; tone = 'checking';
    } else if (state.ready) {
      title = 'Ollama на связи'; message = `Модель ${statusData.model} найдена. Ответ проверим на твоём сообщении.`;
      badge = statusData.busy ? 'Братик работает' : 'Ollama на связи'; tone = 'ready';
    } else {
      title = state.code === 'model_missing' ? 'Нужна установленная модель' : state.code === 'unreachable' ? 'Ollama не отвечает' : 'Проверь выбранную модель';
      message = state.message || 'Проверь Ollama и выбери модель из списка.';
      badge = state.code === 'model_missing' ? 'Модель не найдена' : 'Нужна проверка'; tone = 'error';
    }
    $('#diagnostic-title').textContent = title; $('#diagnostic-message').textContent = message;
    $('#diagnostic').dataset.state = tone; $('#connection-badge').dataset.state = tone; $('#connection-label').textContent = badge;
    renderModels(); renderMemoryCounts(); renderReflection(); renderComposer();
  }

  async function refreshStatus({force = false} = {}) {
    if (settingsBusy) return false;
    if (statusRequest && !force) return statusRequest;
    const sequence = ++statusSequence;
    $('#refresh-status').disabled = true;
    const promise = (async () => {
      try {
        const data = await request('/api/status');
        if (sequence !== statusSequence) return false;
        if (!data?.ok || !data.ollama) throw new ApiError('Сервер не прислал диагностику Ollama.', 'INVALID_RESPONSE');
        statusData = data; statusError = ''; reflectionLocalPending = false;
        renderStatus(); return true;
      } catch (error) {
        if (sequence === statusSequence) { statusError = error.message; renderStatus(); }
        return false;
      } finally {
        if (statusRequest === promise) { $('#refresh-status').disabled = settingsBusy; statusRequest = null; }
      }
    })();
    statusRequest = promise;
    return promise;
  }

  function addMessageElement(message, transient = false, usedCount = null) {
    const item = node('article', `message ${message.role}${transient ? ' pending' : ''}`);
    if (message.request_id) item.dataset.requestId = message.request_id;
    const head = node('div', 'message-head');
    head.append(node('strong', '', message.role === 'user' ? 'Ты' : 'Братик'));
    const time = timeElement(message.created_at); if (time) head.append(time);
    if (transient) head.append(node('span', '', sending ? 'отправляется' : 'ожидает результата'));
    item.append(head, node('div', 'message-bubble', message.content));
    if (message.role === 'assistant' && usedCount !== null) item.append(node('p', 'message-memories', usedCount
      ? `Учтено подтверждённых записей: ${usedCount}` : 'Без дополнительных записей из памяти'));
    return item;
  }

  function hasHistoryRole(id, role) { return historyMessages.some(message => message.request_id === id && message.role === role); }

  function renderHistory({bottom = false, older = false} = {}) {
    const previousHeight = ui.scroll.scrollHeight;
    const previousTop = ui.scroll.scrollTop;
    const nearBottom = previousHeight - previousTop - ui.scroll.clientHeight < 100;
    const items = historyMessages.map(message => addMessageElement(message));
    for (const [id, turn] of completedTurns) {
      if (!hasHistoryRole(id, 'user')) items.push(addMessageElement({role: 'user', content: turn.message, created_at: turn.created_at, request_id: id}));
      if (!hasHistoryRole(id, 'assistant')) items.push(addMessageElement({role: 'assistant', content: turn.answer, created_at: turn.created_at, request_id: id}, false, turn.memories_used?.length || 0));
      if (hasHistoryRole(id, 'user') && hasHistoryRole(id, 'assistant')) completedTurns.delete(id);
    }
    if (pending && !hasHistoryRole(pending.request_id, 'user')) items.push(addMessageElement({role: 'user', content: pending.message, created_at: pending.created_at, request_id: pending.request_id}, true));
    ui.chat.replaceChildren(...items);
    $('#empty-state').hidden = !historyLoaded || items.length > 0;
    $('#load-earlier').hidden = !historyHasMore;
    $('#load-earlier').disabled = historyLoading;
    if (older) ui.scroll.scrollTop = previousTop + ui.scroll.scrollHeight - previousHeight;
    else if (bottom || nearBottom) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }

  async function loadHistory({older = false, bottom = false} = {}) {
    if (historyLoading || (older && !historyBefore)) return;
    historyLoading = true; ui.chat.setAttribute('aria-busy', 'true'); $('#load-earlier').disabled = true;
    $('#history-status').textContent = older ? 'Загружаю предыдущие сообщения…' : historyLoaded ? '' : 'Загружаю разговор…';
    $('#retry-history').hidden = true;
    try {
      const data = await request(`/api/history?limit=60${older ? `&before=${encodeURIComponent(historyBefore)}` : ''}`);
      if (!Array.isArray(data.messages)) throw new ApiError('Не удалось прочитать историю разговора.', 'INVALID_RESPONSE');
      const messages = data.messages.filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string');
      const merged = new Map(historyMessages.map(message => [String(message.id), message]));
      for (const message of messages) merged.set(String(message.id), message);
      historyMessages = [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id));
      if (older || !historyLoaded) { historyHasMore = Boolean(data.has_more); historyBefore = data.before; }
      historyLoaded = true;
      $('#history-status').textContent = '';
      renderHistory({bottom, older});
    } catch (error) {
      $('#history-status').textContent = `История пока не загрузилась. ${error.message}`;
      $('#retry-history').hidden = false;
    } finally { historyLoading = false; ui.chat.setAttribute('aria-busy', 'false'); $('#load-earlier').disabled = false; }
  }

  function memoryCount(state) {
    const reported = statusData?.memories?.[state];
    return Number.isFinite(reported) ? reported : memoryCache.has(state) ? memoryCache.get(state).length : null;
  }

  function renderMemoryCounts() {
    const pendingCount = memoryCount('pending');
    const approvedCount = memoryCount('approved');
    $('#pending-count').textContent = pendingCount ?? '—';
    $('#approved-count').textContent = approvedCount ?? '—';
    $('#memory-total').textContent = pendingCount !== null && approvedCount !== null ? pendingCount + approvedCount : '—';
    const shown = memoryCache.get(memoryFilter)?.length;
    const total = memoryCount(memoryFilter);
    const range = $('#memory-range');
    if (range) range.textContent = shown !== undefined && total !== null && shown < total ? `Показано ${shown} из ${total} записей. Полная память доступна в выгрузке.` : '';
  }

  const memoryKinds = {
    fact: 'Факт', preference: 'Предпочтение', preferences: 'Предпочтения', goal: 'Цель', project: 'Проект',
    decision: 'Решение', correction: 'Уточнение', instruction: 'Пожелание', identity: 'О тебе',
  };

  function memoryButton(label, className, action, disabled) {
    const button = node('button', className, label); button.type = 'button'; button.disabled = disabled;
    button.addEventListener('click', action); return button;
  }

  function renderMemories() {
    memoryItems = memoryCache.get(memoryFilter) || [];
    memoryLoading = memoryRequests.has(memoryFilter);
    $$('[data-memory-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.memoryFilter === memoryFilter)));
    ui.memories.setAttribute('aria-busy', String(memoryLoading));
    renderMemoryCounts();
    $('#memory-filter-hint').textContent = memoryFilter === 'pending'
      ? 'На проверке — сохранено для просмотра, пока не добавляется в память для ответов.'
      : 'Эти записи разрешено учитывать в ответах. Их можно уточнить или исключить из памяти.';
    const signature = JSON.stringify([memoryFilter, memoryItems, editingMemory, [...memoryMutations], [...memoryDrafts], memoryCache.has(memoryFilter)]);
    if (ui.memories.dataset.signature === signature) return;
    ui.memories.dataset.signature = signature;
    const activeEditor = document.activeElement?.dataset.memoryEditor;
    const selection = activeEditor ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    if (!memoryItems.length) {
      const empty = node('div', 'memory-empty');
      if (!memoryCache.has(memoryFilter)) empty.textContent = 'Загружаю память…';
      else if (memoryFilter === 'pending') empty.append(node('strong', '', 'Пока нечего подтверждать.'), node('p', '', 'После разговора здесь могут появиться предложенные факты и решения.'));
      else empty.append(node('strong', '', 'Подтверждённой памяти пока нет.'), node('p', '', 'Выбери полезные записи на вкладке «На проверке».'));
      ui.memories.replaceChildren(empty); return;
    }
    const cards = memoryItems.map(memory => {
      const id = String(memory.id);
      const busy = memoryMutations.has(id);
      const card = node('article', 'memory-card'); card.dataset.memoryId = id; card.setAttribute('aria-busy', String(busy));
      const head = node('div', 'memory-card-head');
      head.append(node('span', 'memory-kind', memoryKinds[memory.kind] || memory.kind || 'Запись'));
      const time = timeElement(memory.created_at, true); if (time) head.append(time);
      card.append(head);
      if (editingMemory === id) {
        const editor = node('form', 'memory-editor');
        const label = node('label', '', 'Уточни формулировку'); label.htmlFor = `memory-edit-${id}`;
        const field = node('textarea'); field.id = `memory-edit-${id}`; field.rows = 4; field.maxLength = 2000; field.required = true; field.disabled = busy;
        field.dataset.memoryEditor = id; field.value = memoryDrafts.get(id) ?? memory.content;
        field.addEventListener('input', () => { memoryDrafts.set(id, field.value); field.setCustomValidity(''); });
        const actions = node('div', 'memory-actions');
        const save = node('button', 'approve-memory', busy ? 'Сохраняю…' : 'Сохранить правку'); save.type = 'submit'; save.disabled = busy;
        const cancel = memoryButton('Отмена', '', () => { editingMemory = null; memoryDrafts.delete(id); renderMemories(); }, busy);
        actions.append(save, cancel); editor.append(label, field, actions);
        if (memory.status === 'pending') editor.append(node('p', 'memory-editor-note', 'После правки запись всё ещё нужно подтвердить.'));
        editor.addEventListener('submit', event => {
          event.preventDefault();
          if (!field.value.trim() || field.value.length > 2000) { field.setCustomValidity('Напиши запись длиной от 1 до 2000 символов.'); field.reportValidity(); return; }
          void mutateMemory(memory, 'edit', field.value.trim());
        });
        card.append(editor);
      } else {
        card.append(node('p', 'memory-content', memory.content));
        const actions = node('div', 'memory-actions');
        if (memory.status === 'pending') actions.append(memoryButton(busy ? 'Подтверждаю…' : 'Подтвердить', 'approve-memory', () => void mutateMemory(memory, 'approve'), busy));
        actions.append(memoryButton('Изменить', '', () => {
          editingMemory = id;
          if (!memoryDrafts.has(id)) memoryDrafts.set(id, memory.content);
          renderMemories(); $(`#memory-edit-${id}`)?.focus({preventScroll: true});
        }, busy));
        actions.append(memoryButton('Забыть', 'forget-memory', () => void mutateMemory(memory, 'forget'), busy));
        card.append(actions);
      }
      if (memory.source_turn_id) {
        const source = node('details', 'memory-source');
        const text = node('p', '', memorySources.get(memory.source_turn_id) || 'Загружаю исходное сообщение…');
        source.append(node('summary', '', 'Источник этой записи'), text);
        source.addEventListener('toggle', async () => {
          if (!source.open || source.dataset.loading === 'true') return;
          if (memorySources.has(memory.source_turn_id)) { text.textContent = memorySources.get(memory.source_turn_id); return; }
          source.dataset.loading = 'true';
          try {
            const turn = await request(`/api/turns/${encodeURIComponent(memory.source_turn_id)}`);
            if (typeof turn.message !== 'string') throw new ApiError('Исходное сообщение не найдено.', 'INVALID_RESPONSE');
            memorySources.set(memory.source_turn_id, turn.message); text.textContent = turn.message;
          } catch (error) { text.textContent = `Источник не загрузился. ${error.message} Закрой и открой этот блок, чтобы повторить.`; }
          finally { source.dataset.loading = 'false'; }
        });
        card.append(source);
      }
      return card;
    });
    ui.memories.replaceChildren(...cards);
    if (activeEditor) {
      const field = $(`#memory-edit-${activeEditor}`);
      if (field) { field.focus({preventScroll: true}); field.setSelectionRange(...selection); }
    }
  }

  async function refreshMemories(filter = memoryFilter) {
    if (memoryRequests.has(filter)) return memoryRequests.get(filter);
    const revision = memoryRevision;
    const promise = (async () => {
      try {
        const data = await request(`/api/memories?status=${filter}`);
        if (revision !== memoryRevision) return false;
        if (!Array.isArray(data.memories)) throw new ApiError('Не удалось прочитать список памяти.', 'INVALID_RESPONSE');
        memoryCache.set(filter, data.memories.filter(memory => memory.status === filter && typeof memory.content === 'string'));
        memoriesLoaded = true;
        if (filter === memoryFilter) { $('#retry-memories').hidden = true; renderMemories(); }
        return true;
      } catch (error) {
        if (revision !== memoryRevision) return false;
        if (filter === memoryFilter) {
          feedback('#memory-feedback', `Память не обновилась. ${error.message}`, true); $('#retry-memories').hidden = false;
          if (!memoryCache.has(filter)) ui.memories.replaceChildren(node('p', 'memory-empty', 'Список сейчас недоступен. Сохранённые записи остаются в локальной базе.'));
        }
        return false;
      } finally {
        if (memoryRequests.get(filter) === promise) memoryRequests.delete(filter);
        if (filter === memoryFilter) ui.memories.setAttribute('aria-busy', String(memoryRequests.has(filter)));
      }
    })();
    memoryRequests.set(filter, promise); ui.memories.setAttribute('aria-busy', String(filter === memoryFilter));
    return promise;
  }

  async function mutateMemory(memory, action, content) {
    const id = String(memory.id);
    if (memoryMutations.has(id)) return;
    memoryMutations.add(id); feedback('#memory-feedback'); renderMemories();
    try {
      const result = await request(`/api/memories/${encodeURIComponent(id)}${action === 'approve' ? '/approve' : ''}`, {
        method: action === 'forget' ? 'DELETE' : action === 'edit' ? 'PATCH' : 'POST',
        ...(action === 'forget' ? {} : {body: action === 'edit' ? {content} : {}}),
      });
      if (action === 'forget' && result.ok !== true) throw new ApiError('Сервер не подтвердил изменение памяти.', 'INVALID_RESPONSE');
      if (action !== 'forget' && (!result.memory || String(result.memory.id) !== id)) throw new ApiError('Сервер не подтвердил изменение этой записи.', 'INVALID_RESPONSE');
      // A read started before this confirmed mutation must not restore stale cards.
      memoryRevision += 1;
      memoryRequests.clear();
      for (const [filter, items] of memoryCache) {
        const changed = items.filter(item => String(item.id) !== id);
        if (result.memory?.status === filter) changed.push(result.memory);
        memoryCache.set(filter, changed);
      }
      if (editingMemory === id) editingMemory = null;
      memoryDrafts.delete(id);
      feedback('#memory-feedback', action === 'approve' ? 'Подтверждено. Братик может учитывать эту запись в ответах.'
        : action === 'edit' ? 'Формулировка сохранена.' : 'Запись исключена из памяти для ответов.');
      await Promise.allSettled([refreshMemories(), refreshStatus({force: true})]);
    } catch (error) { feedback('#memory-feedback', error.message, true); }
    finally { memoryMutations.delete(id); renderMemories(); schedulePoll(); }
  }

  function renderReflection() {
    const jobs = statusData?.reflection;
    const running = Boolean(jobs?.running);
    const queued = Number(jobs?.queued || 0);
    const failed = Number(jobs?.failed || 0);
    const active = running || queued > 0 || reflectionLocalPending;
    const element = $('#reflection-status');
    element.hidden = !(active || failed || reflectionWasActive);
    element.dataset.state = active ? 'running' : failed ? 'failed' : 'completed';
    const text = active ? (running ? 'Проверяю, что из разговора стоит предложить в память.' : 'Разговор ждёт проверки на полезную память.')
      : failed ? `Не удалось завершить проверку памяти: ${failed}. Ответы в разговоре сохранены.`
      : 'Проверка завершена. Новые предложения появятся в разделе «На проверке», если есть что сохранить.';
    if ($('#reflection-message').textContent !== text) $('#reflection-message').textContent = text;
    $('#retry-reflection').hidden = failed === 0;
    $('#retry-reflection').disabled = reflectionRetrying || !modelReady() || sending || Boolean(statusData?.busy);
    if (active) reflectionWasActive = true;
  }

  function renderTurnError() {
    const error = pending?.error;
    const visible = Boolean(pending && error && !sending && !reconciling && !statusData?.busy);
    $('#turn-error').hidden = !visible;
    if (!visible) return;
    const known = ACKNOWLEDGED_FAILURES.has(error.code);
    const titles = {
      OLLAMA_UNAVAILABLE: 'Ollama пока не отвечает', MODEL_MISSING: 'Для ответа нужна установленная модель',
      OLLAMA_ERROR: 'Ollama вернула ошибку', EMPTY_RESPONSE: 'Модель вернула пустой ответ',
      MODEL_TIMEOUT: 'Модель не успела ответить', CHAT_BUSY: 'Этот запрос ещё не выполнен', INVALID_REQUEST: 'Нужно проверить сообщение',
      REQUEST_CONFLICT: 'Запрос не удалось сопоставить', REMOTE_MODEL_UNSUPPORTED: 'Выбранная модель недоступна', MODEL_UNSUPPORTED: 'Модель не подходит для этого запроса',
    };
    $('#turn-error-title').textContent = titles[error.code] || 'Не удалось подтвердить ответ';
    $('#turn-error-detail').textContent = known ? `${error.message} Текст сохранён — повтор отправит этот же запрос.`
      : 'Текст сохранён. Можно проверить готовый ответ или повторить тот же запрос: новый идентификатор не создаётся.';
    $('#retry-turn').disabled = activeRequest() || settingsBusy || !modelReady();
    $('#check-turn').disabled = reconciling || sending;
    $('#edit-failed-turn').hidden = !known;
    $('#edit-failed-turn').disabled = activeRequest();
  }

  async function acceptTurn(result, message) {
    if (!pending || result.request_id !== pending.request_id || typeof result.answer !== 'string') throw new ApiError('Ответ не совпал с ожидаемым запросом.', 'INVALID_RESPONSE');
    if (typeof result.message === 'string' && result.message !== message.trim()) throw new ApiError('Этот идентификатор относится к другому сообщению. Текущий текст сохранён в черновике запроса.', 'REQUEST_CONFLICT');
    completedTurns.set(result.request_id, {
      ...result, message: result.message || message, created_at: result.created_at || pending.created_at,
    });
    pending = null; saveDraft();
    reflectionLocalPending = ['queued', 'running'].includes(result.reflection?.state);
    const used = Array.isArray(result.memories_used) ? result.memories_used.length : 0;
    feedback('#answer-meta', `${result.replayed ? 'Восстановлен сохранённый ответ' : 'Ответ готов'} · ${result.model || 'локальная модель'}${used ? ` · учтено записей памяти: ${used}` : ''}`);
    renderHistory({bottom: true}); renderComposer(); renderReflection();
    await loadHistory({bottom: true});
  }

  async function reconcilePending({manual = false} = {}) {
    if (!pending || sending || reconciling) return false;
    const current = pending;
    reconciling = true; renderComposer();
    try {
      const result = await request(`/api/turns/${encodeURIComponent(current.request_id)}`);
      if (pending?.request_id !== current.request_id) return false;
      await acceptTurn(result, current.message);
      return true;
    } catch (error) {
      if (pending?.request_id !== current.request_id) return false;
      if (error.status === 404) {
        const acknowledged = ACKNOWLEDGED_FAILURES.has(current.error?.code);
        current.state = statusData?.busy ? 'waiting' : acknowledged ? 'failed' : 'uncertain';
        if (!acknowledged) current.error = {code: 'UNCONFIRMED', message: 'Сохранённого ответа пока нет.'};
      } else {
        current.state = 'uncertain';
        if (manual || !current.error) current.error = {code: error.code, message: error.message};
      }
      saveDraft(); return false;
    } finally { reconciling = false; renderComposer(); }
  }

  async function sendPending() {
    if (!pending || sending || reconciling || settingsBusy) return;
    const current = pending;
    sending = true; current.state = 'sending'; current.error = null; saveDraft();
    feedback('#answer-meta'); renderComposer(); renderHistory({bottom: true});
    try {
      const result = await request('/api/chat', {
        method: 'POST', body: {message: current.message, request_id: current.request_id}, timeout: 650000,
      });
      if (pending?.request_id !== current.request_id) return;
      await acceptTurn(result, current.message);
    } catch (error) {
      if (pending?.request_id === current.request_id) {
        current.state = ACKNOWLEDGED_FAILURES.has(error.code) ? 'failed' : 'uncertain';
        current.error = {code: error.code, message: error.message}; saveDraft();
      }
    } finally {
      sending = false;
      await refreshStatus();
      if (pending) await reconcilePending();
      else await refreshMemories();
      renderComposer(); renderHistory(); schedulePoll();
    }
  }

  function shouldPoll() {
    return !statusError && (reflectionLocalPending || statusData?.reflection?.running || Number(statusData?.reflection?.queued) > 0 || statusData?.busy);
  }

  function schedulePoll() {
    clearTimeout(pollTimer); pollTimer = null;
    if (document.hidden || pollRunning || !shouldPoll()) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null; pollRunning = true;
      try {
        const previous = JSON.stringify([statusData?.memories, statusData?.reflection]);
        await refreshStatus();
        if (pending && !sending) await reconcilePending();
        const changed = previous !== JSON.stringify([statusData?.memories, statusData?.reflection]);
        if (changed) await refreshMemories();
      } finally { pollRunning = false; schedulePoll(); }
    }, 5000);
  }

  ui.form.addEventListener('submit', event => {
    event.preventDefault();
    if (booting || pending || activeRequest() || settingsBusy || !modelReady()) return;
    const message = ui.input.value.trim();
    ui.input.setCustomValidity(!message ? 'Напиши сообщение Братику.' : ui.input.value.length > MAX_MESSAGE ? 'В одном сообщении можно отправить до 8000 символов.' : '');
    if (!ui.input.reportValidity()) return;
    let id;
    try { id = window.crypto.randomUUID(); }
    catch (_) { feedback('#answer-meta', 'Этот браузер не смог создать запрос. Открой Братика по адресу localhost в современном браузере.'); return; }
    pending = {request_id: id, message, created_at: new Date().toISOString(), state: 'sending', error: null};
    ui.input.value = ''; saveDraft(); void sendPending();
  });
  ui.input.addEventListener('input', () => { ui.input.setCustomValidity(''); saveDraft(); renderComposer(); });
  ui.input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); ui.form.requestSubmit(); }
  });
  $$('[data-prompt]').forEach(button => button.addEventListener('click', () => {
    if (pending || sending) return;
    if (!ui.input.value.trim()) ui.input.value = button.dataset.prompt;
    ui.input.focus(); ui.input.setSelectionRange(ui.input.value.length, ui.input.value.length); saveDraft(); renderComposer();
  }));
  $('#retry-turn').addEventListener('click', async () => {
    if (!pending || activeRequest() || settingsBusy) return;
    const recovered = await reconcilePending({manual: true});
    if (!recovered && pending && modelReady() && !statusData?.busy) await sendPending();
    schedulePoll();
  });
  $('#check-turn').addEventListener('click', async () => { await refreshStatus(); await reconcilePending({manual: true}); schedulePoll(); });
  $('#edit-failed-turn').addEventListener('click', () => {
    if (!pending || activeRequest() || !ACKNOWLEDGED_FAILURES.has(pending.error?.code)) return;
    ui.input.value = pending.message; pending = null; saveDraft(); renderHistory(); renderComposer(); ui.input.focus();
  });
  $('#load-earlier').addEventListener('click', () => void loadHistory({older: true}));
  $('#retry-history').addEventListener('click', () => void loadHistory({bottom: !historyLoaded}));
  $('#refresh-status').addEventListener('click', async () => { await refreshStatus(); if (pending) await reconcilePending({manual: true}); schedulePoll(); });
  ui.model.addEventListener('change', async () => {
    const model = ui.model.value;
    if (!model || model === statusData?.model || activeRequest() || settingsBusy) return;
    settingsBusy = true; ++statusSequence; $('#refresh-status').disabled = true; renderComposer(); feedback('#settings-status', 'Выбираю модель…');
    try {
      const data = await request('/api/settings', {method: 'POST', body: {model}});
      if (!data?.ok || data.model !== model) throw new ApiError('Сервер не подтвердил выбор модели.', 'INVALID_RESPONSE');
      ++statusSequence;
      statusData = data; statusError = ''; reflectionLocalPending = false;
      feedback('#settings-status', `Для следующих ответов: ${model}`);
    } catch (error) { feedback('#settings-status', error.message, true); }
    finally { settingsBusy = false; $('#refresh-status').disabled = Boolean(statusRequest); ui.model.dataset.signature = ''; renderStatus(); schedulePoll(); }
  });
  $$('[data-memory-filter]').forEach(button => button.addEventListener('click', () => {
    memoryFilter = button.dataset.memoryFilter; editingMemory = null;
    feedback('#memory-feedback'); renderMemories(); void refreshMemories();
  }));
  $('#retry-memories').addEventListener('click', async () => { feedback('#memory-feedback'); await refreshMemories(); await refreshStatus(); schedulePoll(); });
  $('#retry-reflection').addEventListener('click', async () => {
    if (reflectionRetrying) return;
    reflectionRetrying = true; renderReflection();
    try {
      const result = await request('/api/reflection/retry', {method: 'POST', body: {}});
      if (!result.ok) throw new ApiError('Не удалось повторить извлечение памяти.', 'INVALID_RESPONSE');
      reflectionLocalPending = result.count > 0;
      feedback('#memory-feedback', result.count ? `Повторная проверка поставлена в очередь: ${result.count}.` : 'Сейчас нет неудачных проверок для повтора.');
      await refreshStatus();
    } catch (error) { feedback('#memory-feedback', error.message, true); }
    finally { reflectionRetrying = false; renderReflection(); schedulePoll(); }
  });
  $('#controls-toggle').addEventListener('click', () => {
    const button = $('#controls-toggle'); const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-label', open ? 'Скрыть модель и память' : 'Открыть модель и память');
    ui.controls.classList.toggle('is-open', open);
  });
  $('#export-data').addEventListener('click', async () => {
    const button = $('#export-data'); if (button.disabled) return;
    button.disabled = true; feedback('#export-status', 'Готовлю выгрузку…');
    try {
      const data = await request('/api/export', {timeout: 30000});
      if (!Array.isArray(data.messages) || !Array.isArray(data.memories)) throw new ApiError('Выгрузка пришла в неожиданном формате.', 'INVALID_RESPONSE');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json;charset=utf-8'}));
      const link = node('a'); link.href = url; link.download = `bratik-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback('#export-status', 'Скачивание началось. В файле — переписка и записи памяти.');
    } catch (error) { feedback('#export-status', error.message, true); }
    finally { button.disabled = false; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = null; }
    else schedulePoll();
  });

  async function start() {
    restoreDraft(); renderComposer(); renderMemoryCounts();
    await Promise.allSettled([refreshStatus(), loadHistory({bottom: true}), refreshMemories()]);
    if (pending) { renderHistory({bottom: true}); await reconcilePending(); }
    booting = false; renderComposer(); schedulePoll();
  }
  void start();
})();
