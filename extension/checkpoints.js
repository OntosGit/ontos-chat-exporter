/* ONTOS Chat Exporter 1.4: isolated extension storage, one durable record per page. */
(function (root) {
  'use strict';
  const PREFIX = 'ontos:conversation-checkpoint:v1:';
  const key = id => PREFIX + id + ':state';
  const chunkKey = (id, direction, index) => PREFIX + id + ':' + direction + ':' + String(index).padStart(5, '0');
  const storage = () => {
    if (!root.chrome || !root.chrome.storage || !root.chrome.storage.local)
      throw new Error('Локальное хранилище расширения недоступно. Проверь разрешение Storage.');
    return root.chrome.storage.local;
  };
  const validateId = id => {
    if (!/^[a-z0-9-]{16,128}$/i.test(id)) throw new Error('Неверный идентификатор разговора.');
  };
  const checkPage = page => {
    if (!page || typeof page !== 'object' ||
        typeof page.has_previous_page !== 'boolean' || typeof page.has_next_page !== 'boolean')
      throw new Error('Сервер не вернул полную информацию о пагинации (page_info).');
    return page;
  };
  const stats = state => state ? {
    pages: state.pageCount, messages: state.messageCount,
    complete: state.status === 'complete',
    hasMore: Boolean(state.older.more || state.newer.more),
    retryAt: state.retryAt || 0, rateLimitCount: state.rateLimitCount || 0,
    updatedAt: state.updatedAt, lastError: state.lastError || '',
    direction: state.older.more ? 'ранние' : state.newer.more ? 'поздние' : '',
    title: state.base.title || ''
  } : null;
  async function get(id) {
    validateId(id);
    const entry = (await storage().get(key(id)))[key(id)];
    if (!entry) return null;
    if (entry.schema !== 1 || entry.id !== id || !Array.isArray(entry.olderKeys) ||
        !Array.isArray(entry.newerKeys) || !entry.base || !entry.older || !entry.newer)
      throw new Error('Контрольная точка несовместима или повреждена; сбрось её в расширении.');
    return entry;
  }
  async function put(state) {
    const update = {...state, updatedAt: new Date().toISOString()};
    await storage().set({[key(state.id)]: update});
    return update;
  }
  async function start(id, base, endpoint) {
    validateId(id);
    if (!Array.isArray(base.messages)) throw new Error('Нет начальной страницы сообщений.');
    const page = checkPage(base.page_info);
    const initialKey = chunkKey(id, 'initial', 0);
    const header = {...base};
    delete header.messages;
    const state = {
      schema: 1, id, base: header, prefix: endpoint, initialKey,
      olderKeys: [], newerKeys: [],
      older: {more: page.has_previous_page, cursor: page.start_cursor || null},
      newer: {more: page.has_next_page, cursor: page.end_cursor || null},
      seenBefore: [], seenAfter: [], pageCount: 1, messageCount: base.messages.length,
      status: 'in_progress', retryAt: 0, rateLimitCount: 0, lastError: '',
      createdAt: new Date().toISOString()
    };
    // Two writes on purpose. If metadata fails, the cursor never advances.
    await storage().set({[initialKey]: base.messages});
    return put(state);
  }
  async function addPage(state, direction, cursor, chunk) {
    if (direction !== 'before' && direction !== 'after') throw new Error('Недопустимое направление страниц.');
    if (!Array.isArray(chunk.messages) || !chunk.messages.length)
      throw new Error('Пустая промежуточная страница: полнота истории не подтверждена.');
    const page = checkPage(chunk.page_info);
    const side = direction === 'before' ? 'older' : 'newer';
    const seenField = direction === 'before' ? 'seenBefore' : 'seenAfter';
    const keysField = direction === 'before' ? 'olderKeys' : 'newerKeys';
    if (!cursor || state[side].cursor !== cursor || state[seenField].includes(cursor))
      throw new Error('Пагинация зациклилась или изменила указатель.');
    const pageKey = chunkKey(state.id, direction, state[keysField].length + 1);
    const updated = {
      ...state,
      [keysField]: direction === 'before' ? [pageKey, ...state[keysField]] : [...state[keysField], pageKey],
      [seenField]: [...state[seenField], cursor],
      [side]: direction === 'before' ?
        {more: page.has_previous_page, cursor: page.start_cursor || null} :
        {more: page.has_next_page, cursor: page.end_cursor || null},
      pageCount: state.pageCount + 1, messageCount: state.messageCount + chunk.messages.length,
      retryAt: 0, lastError: ''
    };
    // Data first, manifest last: a failed write cannot claim an unfetched page.
    await storage().set({[pageKey]: chunk.messages});
    return put(updated);
  }
  async function rateLimited(state, retryAfterMs) {
    const count = (state.rateLimitCount || 0) + 1;
    const fallback = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(count - 1, 4));
    const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ?
      Math.max(0, retryAfterMs) : fallback;
    return put({...state, retryAt: Date.now() + delay, rateLimitCount: count, lastError:'HTTP 429'});
  }
  async function finished(state) {
    if (state.older.more || state.newer.more) throw new Error('История ещё не выгружена полностью.');
    return put({...state, status:'complete', retryAt:0, lastError:''});
  }
  async function assemble(state) {
    if (!state || state.status !== 'complete' || state.older.more || state.newer.more)
      throw new Error('Неполная история не может быть выдана за готовый архив.');
    const keys = [...state.olderKeys, state.initialKey, ...state.newerKeys];
    const all = [];
    for (let index = 0; index < keys.length; index += 10) {
      const batchKeys = keys.slice(index, index + 10);
      const pages = await storage().get(batchKeys);
      for (const name of batchKeys) {
        if (!Array.isArray(pages[name])) throw new Error('Не найдена сохранённая страница архива: ' + name);
        all.push(...pages[name]);
      }
    }
    const ids = all.map(item => item && item.message ? item.message.id : item && item.id).filter(Boolean);
    if (new Set(ids).size !== ids.length)
      throw new Error('Перекрывающиеся страницы: повторяются сообщения. Архив не будет объявлен полным.');
    if (all.length !== state.messageCount || keys.length !== state.pageCount)
      throw new Error('Контрольная точка не совпадает с сохранёнными страницами.');
    return {
      ...state.base, messages: all, conversation_id: state.base.conversation_id || state.id,
      page_info: {has_previous_page:false, has_next_page:false},
      ontos_pagination_audit: {pages:state.pageCount, source:state.prefix, message_count:all.length,
        resumed:true, checkpoint_schema:'ontos:conversation-checkpoint:v1'}
    };
  }
  async function reset(id) {
    validateId(id);
    const state = await get(id);
    const keys = state ? [key(id), state.initialKey, ...state.olderKeys, ...state.newerKeys] : [key(id)];
    await storage().remove(keys);
    // If a previous metadata write failed, remove its unreferenced page too.
    if (typeof storage().getKeys === 'function') {
      const orphanKeys = (await storage().getKeys()).filter(item => item.startsWith(PREFIX + id + ':'));
      if (orphanKeys.length) await storage().remove(orphanKeys);
    }
  }
  root.ONTOSCheckpoints = {get, start, addPage, rateLimited, finished, assemble, reset, stats, checkPage};
})(globalThis);
