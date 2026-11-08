/* ONTOS Chat Exporter 1.4. Fetches authenticated first-party pages and checkpoints every page. */
(function (root) {
  'use strict';
  const allow = host => host === 'chatgpt.com';
  const pause = (state, reason) => ({ontos_paused:true, reason, checkpoint:root.ONTOSCheckpoints.stats(state)});
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function unwrap(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.data && (Array.isArray(value.data.messages) || value.data.mapping)) return value.data;
    if (value.conversation && (Array.isArray(value.conversation.messages) || value.conversation.mapping)) return value.conversation;
    return value;
  }
  async function sessionHeaders() {
    const headers = {'Accept':'application/json'};
    try {
      const response = await fetch('/api/auth/session', {method:'GET', headers, cache:'no-store', credentials:'include'});
      if (response.ok) {
        const data = await response.json();
        const token = data && (data.accessToken || data.access_token);
        if (typeof token === 'string' && token) headers.Authorization = `Bearer ${token}`;
      }
    } catch (_) { /* Cookie-only authentication can still work. */ }
    return headers;
  }
  function retryAfterMs(response) {
    const value = response.headers && response.headers.get && response.headers.get('Retry-After');
    if (!value) return undefined;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.min(24 * 60 * 60_000, number * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
  }
  async function requestJSON(path, headers) {
    if (!path.startsWith('/backend-api/')) throw new Error('Запрещён адрес за пределами ChatGPT.');
    const url = new URL(path, location.origin);
    if (!allow(url.hostname)) throw new Error('Запрещён внешний адрес запроса.');
    let response;
    try { response = await fetch(url.href, {method:'GET', headers, credentials:'include', cache:'no-store'}); }
    catch (error) {throw new Error('Не удалось подключиться к ChatGPT: ' + error.message);}
    if (!response.ok) {
      const error = new Error(`ChatGPT вернул HTTP ${response.status}.`);
      error.status = response.status;
      if (response.status === 429) error.retryAfterMs = retryAfterMs(response);
      throw error;
    }
    try {return unwrap(await response.json());}
    catch (_) {throw new Error('ChatGPT прислал ответ, который нельзя разобрать как JSON.');}
  }
  async function fetchConversation(id, onProgress = () => {}, options = {}) {
    if (!allow(location.hostname)) throw new Error('Открой беседу на chatgpt.com.');
    if (!/^[a-z0-9-]{16,128}$/i.test(id)) throw new Error('Неверный идентификатор разговора.');
    const store = root.ONTOSCheckpoints;
    let state = await store.get(id);
    if (state && state.status === 'complete') {
      onProgress(`Восстанавливаю готовый архив из ${state.pageCount} сохранённых страниц…`);
      return store.assemble(state);
    }
    if (state && state.retryAt > Date.now()) return pause(state, 'rate_limit');
    const headers = await sessionHeaders();
    if (!state) {
      let base = null;
      let endpoint = 'conversations';
      for (const name of ['conversations', 'conversation']) {
        try {
          base = await requestJSON(`/backend-api/${name}/${encodeURIComponent(id)}?num_turns=100`, headers);
          endpoint = name;
          break;
        } catch (error) {
          if (error.status !== 404 && error.status !== 405) throw error;
        }
      }
      if (!base) throw new Error('История разговора недоступна через текущий интерфейс ChatGPT.');
      if (base.mapping) {
        if (base.page_info && (base.page_info.has_previous_page || base.page_info.has_next_page))
          throw new Error('Дерево сообщений пришло постранично; полноту подтвердить нельзя.');
        root.ONTOSCore.normalizeConversation(base);
        return base;
      }
      let prefix = `/backend-api/${endpoint}/${encodeURIComponent(id)}`;
      if (!Array.isArray(base.messages)) {
        prefix = `/backend-api/conversations/${encodeURIComponent(id)}/messages`;
        const part = await requestJSON(`${prefix}?num_turns=100&include_has_versions=true`, headers);
        if (!Array.isArray(part.messages)) throw new Error('Сервер изменил формат истории сообщений.');
        base = Object.assign({}, base, part, {
          title: base.title || part.title, conversation_id: base.conversation_id || id,
          current_node: part.current_node || base.current_node
        });
      }
      state = await store.start(id, base, prefix);
      onProgress(`Сохранена первая страница: ${state.messageCount} сообщений.`);
    } else {
      onProgress(`Продолжаю с ${state.pageCount} сохранённых страниц, ${state.messageCount} сообщений…`);
    }
    // Unlimited if called by tests/integrations; popup selects an explicit per-click batch size.
    const requested = Number(options.maxPages);
    const budget = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 250) : Infinity;
    let downloaded = 0;
    while (state.older.more || state.newer.more) {
      if (downloaded >= budget) return pause(state, 'batch_limit');
      if (state.pageCount >= 2000) throw new Error('Слишком много страниц: защита от бесконечной загрузки.');
      const direction = state.older.more ? 'before' : 'after';
      const cursor = direction === 'before' ? state.older.cursor : state.newer.cursor;
      const already = direction === 'before' ? state.seenBefore : state.seenAfter;
      if (!cursor || already.includes(cursor)) throw new Error('Пагинация зациклилась или лишена указателя страницы.');
      const suffix = state.prefix.endsWith('/messages') ? '&include_has_versions=true' : '';
      const url = `${state.prefix}?num_turns=100${suffix}&${direction}=${encodeURIComponent(cursor)}`;
      // Request pacing is independent of the popup lifetime.
      if (downloaded > 0) await sleep(900);
      let chunk;
      try { chunk = await requestJSON(url, headers); }
      catch (error) {
        if (error.status === 429) {
          state = await store.rateLimited(state, error.retryAfterMs);
          onProgress(`HTTP 429. ${state.pageCount} страниц сохранены; продолжение после ограничения сервера.`);
          return pause(state, 'rate_limit');
        }
        throw error; // All previously committed pages remain on disk.
      }
      state = await store.addPage(state, direction, cursor, chunk);
      downloaded++;
      onProgress(`Сохранено страниц: ${state.pageCount}. Сообщений: ${state.messageCount}.`);
    }
    onProgress(`Все ${state.pageCount} страниц сохранены. Проверяю структуру…`);
    // Verify the assembled message sequence before marking the checkpoint complete.
    const assembled = await store.assemble({...state, status:'complete'});
    root.ONTOSCore.normalizeConversation(assembled);
    await store.finished(state);
    return assembled;
  }
  async function status(id) { return root.ONTOSCheckpoints.stats(await root.ONTOSCheckpoints.get(id)); }
  async function reset(id) { return root.ONTOSCheckpoints.reset(id); }
  root.ONTOSLive = {fetchConversation, status, reset};
})(globalThis);
