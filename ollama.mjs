import { localOllamaUrl } from './config.mjs';

export class AppError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function modelIsInstalled(model, models) {
  return models.some(item => item.name === model || (!model.includes(':') && item.name === `${model}:latest`));
}

export function createOllama({url, timeoutMs = 180_000, statusTimeoutMs = 5_000}) {
  url = localOllamaUrl(url);
  async function models() {
    let response;
    try { response = await fetch(`${url}/api/tags`, {signal: AbortSignal.timeout(statusTimeoutMs), redirect: 'error'}); }
    catch { throw new AppError(`Не удаётся связаться с Ollama. Открой приложение Ollama или выполни ollama serve, затем нажми «Проверить».`, 'OLLAMA_UNAVAILABLE', 503); }
    if (!response.ok) throw new AppError(`Ollama вернула ошибку ${response.status} при проверке моделей.`, 'OLLAMA_ERROR', 502);
    let data;
    try { data = await response.json(); } catch { throw new AppError('Ollama вернула некорректный список моделей.', 'OLLAMA_ERROR', 502); }
    if (!Array.isArray(data.models)) throw new AppError('Список моделей Ollama не распознан.', 'OLLAMA_ERROR', 502);
    return data.models.filter(item => item && typeof (item.name || item.model) === 'string').map(item => ({name: item.name || item.model, size: Number(item.size) || 0, remote: Boolean(item.remote_model || item.remote_host)})).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function ensureLocalModel(model, signal) {
    const timeout = AbortSignal.timeout(statusTimeoutMs);
    let response;
    try {
      response = await fetch(`${url}/api/show`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({model}), redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AppError('Не удалось проверить модель в Ollama. Открой Ollama и повтори проверку.', 'OLLAMA_UNAVAILABLE', 503);
    }
    if (response.status === 404) throw new AppError(`Модель ${model} не найдена. Выбери установленную модель в боковой панели.`, 'MODEL_MISSING', 503);
    if (!response.ok) throw new AppError(`Ollama не смогла проверить модель: HTTP ${response.status}.`, 'OLLAMA_ERROR', 502);
    let data;
    try { data = await response.json(); } catch { throw new AppError('Не удалось прочитать сведения о модели.', 'OLLAMA_ERROR', 502); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('Ollama вернула некорректные сведения о модели.', 'OLLAMA_ERROR', 502);
    if (data.remote_model || data.remote_host) throw new AppError('Выбрана облачная модель Ollama. Для этой версии Братика выбери модель, загруженную на компьютер.', 'REMOTE_MODEL_UNSUPPORTED', 400);
    if (Array.isArray(data.capabilities) && !data.capabilities.includes('completion')) throw new AppError('Эта модель не поддерживает текстовый разговор. Выбери другую установленную модель.', 'MODEL_UNSUPPORTED', 400);
  }

  async function status(model) {
    try {
      const installed = await models();
      const localModels = installed.filter(item => !item.remote);
      const ready = modelIsInstalled(model, localModels);
      if (modelIsInstalled(model, installed) && !ready) return {ready: false, code: 'error', message: 'Выбрана облачная модель. Выбери модель, загруженную на компьютер.', models: localModels, url};
      if (ready) {
        try { await ensureLocalModel(model); }
        catch (error) { return {ready: false, code: error.code === 'OLLAMA_UNAVAILABLE' ? 'unreachable' : 'error', message: error.message, models: localModels, url}; }
      }
      return {ready, code: ready ? 'ready' : 'model_missing', message: ready ? 'Ollama доступна. Модель установлена.' : `Модель ${model} не установлена. Выбери установленную модель или загрузи нужную через Ollama.`, models: localModels, url};
    } catch (error) {
      return {ready: false, code: error.code === 'OLLAMA_UNAVAILABLE' ? 'unreachable' : 'error', message: error.message, models: [], url};
    }
  }

  async function chat(messages, {model, format, signal} = {}) {
    await ensureLocalModel(model, signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response;
    try {
      response = await fetch(`${url}/api/chat`, {
        method: 'POST', headers: {'content-type': 'application/json'}, signal: combinedSignal, redirect: 'error',
        body: JSON.stringify({model, messages, stream: false, ...(format ? {format, options: {temperature: 0}} : {})}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new AppError('Модель не успела ответить. Первая загрузка может занять время. Можно повторить запрос или выбрать другую установленную модель.', 'MODEL_TIMEOUT', 504);
      throw new AppError('Ollama недоступна. Открой Ollama и проверь её состояние в боковой панели.', 'OLLAMA_UNAVAILABLE', 503);
    }
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new AppError('Ожидание ответа модели истекло. Можно повторить запрос.', 'MODEL_TIMEOUT', 504);
      throw new AppError('Ollama вернула ответ в неизвестном формате.', 'OLLAMA_ERROR', 502);
    }
    if (!response.ok || data?.error) {
      const message = typeof data?.error === 'string' ? data.error.slice(0, 400) : `HTTP ${response.status}`;
      if (response.status === 404 && /model.+not found/i.test(message)) throw new AppError(`Модель ${model} не найдена. Выбери установленную модель в боковой панели.`, 'MODEL_MISSING', 503);
      throw new AppError(`Ошибка Ollama: ${message}`, 'OLLAMA_ERROR', 502);
    }
    const content = data?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new AppError('Модель вернула пустой ответ. Повтори запрос или выбери другую установленную модель.', 'EMPTY_RESPONSE', 502);
    return content.trim();
  }
  return {models, status, chat, ensureLocalModel, url};
}
