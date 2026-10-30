/* ONTOS Chat Exporter. Runs in the signed-in ChatGPT tab, never sends data to third-party hosts. */
(function (root) {
  'use strict';
  const allow = host => host === 'chatgpt.com' || host === 'www.chatgpt.com';
  function unwrap(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.data && (Array.isArray(value.data.messages) || value.data.mapping)) return value.data;
    if (value.conversation && (Array.isArray(value.conversation.messages) || value.conversation.mapping)) return value.conversation;
    return value;
  }
  function addStatus() {
    const el = document.createElement('div');
    el.id = 'ontos-chat-export-progress';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;max-width:370px;padding:15px 18px;background:#10212b;color:#e7f6f9;border:1px solid #3e7786;border-radius:12px;box-shadow:0 15px 35px #0008;font:14px/1.5 system-ui, sans-serif;white-space:pre-wrap';
    document.body.appendChild(el);
    return {update: text => {el.textContent = 'ONTOS · ' + text;}, finish: () => {setTimeout(() => el.remove(), 15000);}};
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
  async function requestJSON(path, headers) {
    if (!path.startsWith('/backend-api/')) throw new Error('Запрещён адрес за пределами ChatGPT.');
    const url = new URL(path, location.origin);
    if (!allow(url.hostname)) throw new Error('Запрещён внешний адрес запроса.');
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await fetch(url.href, {method:'GET', headers, credentials:'include', cache:'no-store'}); }
      catch (error) {throw new Error('Не удалось подключиться к ChatGPT: ' + error.message);}
      if (response.status === 429 && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 2500));
        continue;
      }
      if (!response.ok) {
        const error = new Error(`ChatGPT вернул HTTP ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      try {return unwrap(await response.json());}
      catch (_) {throw new Error('ChatGPT прислал ответ, который нельзя разобрать как JSON.');}
    }
    throw new Error('ChatGPT ограничил частоту запросов.');
  }
  function paginationInfo(data) {
    const page = data.page_info;
    if (!page || typeof page !== 'object') throw new Error('Сервер не вернул page_info; проверить полноту постраничной истории нельзя.');
    return page;
  }
  async function fetchConversation(id, onProgress) {
    if (!allow(location.hostname)) throw new Error('Открой беседу на chatgpt.com.');
    if (!/^[a-z0-9-]{16,128}$/i.test(id)) throw new Error('Неверный идентификатор разговора.');
    const headers = await sessionHeaders();
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
      root.ONTOSCore.normalizeConversation(base); // fail closed on broken parent chain
      return base;
    }
    let messagesEndpoint = null;
    if (!Array.isArray(base.messages)) {
      messagesEndpoint = `/backend-api/conversations/${encodeURIComponent(id)}/messages`;
      const msgPart = await requestJSON(`${messagesEndpoint}?num_turns=100&include_has_versions=true`, headers);
      if (!Array.isArray(msgPart.messages)) throw new Error('Сервер изменил формат истории сообщений.');
      base = Object.assign({}, base, msgPart, {
        title: base.title || msgPart.title, conversation_id: base.conversation_id || id,
        current_node: msgPart.current_node || base.current_node
      });
    }
    const paged = paginationInfo(base);
    const prefix = messagesEndpoint || `/backend-api/${endpoint}/${encodeURIComponent(id)}`;
    const pageURL = (direction, cursor) => `${prefix}?num_turns=100${messagesEndpoint ? '&include_has_versions=true' : ''}&${direction}=${encodeURIComponent(cursor)}`;
    const initial = base.messages;
    const older = [];
    const newer = [];
    const seenCursors = new Set();
    let pointer = paged;
    let pageNumber = 1;
    while (pointer.has_previous_page === true) {
      const cursor = pointer.start_cursor;
      if (!cursor || seenCursors.has('before:' + cursor)) throw new Error('Пагинация зациклилась или лишена указателя начала страницы.');
      seenCursors.add('before:' + cursor);
      const chunk = await requestJSON(pageURL('before', cursor), headers);
      if (!Array.isArray(chunk.messages) || chunk.messages.length === 0) throw new Error('Получена пустая промежуточная страница: история неполная.');
      older.unshift(...chunk.messages);
      pointer = paginationInfo(chunk);
      pageNumber++;
      onProgress(`Прочитано страниц: ${pageNumber}. Сообщений: ${older.length + initial.length + newer.length}`);
      if (pageNumber > 2000) throw new Error('Слишком много страниц: остановка для защиты от бесконечной загрузки.');
    }
    pointer = paged;
    while (pointer.has_next_page === true) {
      const cursor = pointer.end_cursor;
      if (!cursor || seenCursors.has('after:' + cursor)) throw new Error('Пагинация зациклилась или лишена указателя конца страницы.');
      seenCursors.add('after:' + cursor);
      const chunk = await requestJSON(pageURL('after', cursor), headers);
      if (!Array.isArray(chunk.messages) || chunk.messages.length === 0) throw new Error('Получена пустая последующая страница: история неполная.');
      newer.push(...chunk.messages);
      pointer = paginationInfo(chunk);
      pageNumber++;
      onProgress(`Прочитано страниц: ${pageNumber}. Сообщений: ${older.length + initial.length + newer.length}`);
      if (pageNumber > 2000) throw new Error('Слишком много страниц: остановка для защиты от бесконечной загрузки.');
    }
    const all = older.concat(initial, newer);
    const ids = all.map(m => (m && m.message ? m.message.id : m && m.id)).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error('Перекрывающиеся страницы: повторяются сообщения; результат не будет сохранён как полный.');
    return Object.assign({}, base, {
      messages: all,
      conversation_id: base.conversation_id || id,
      page_info: {has_previous_page: false, has_next_page: false},
      ontos_pagination_audit: {pages: pageNumber, source: prefix, message_count: all.length}
    });
  }
  async function exportCurrent(format = 'html') {
    const id = (location.pathname.match(/\/c\/([a-z0-9-]{16,128})(?:\/|$)/i) || [])[1];
    if (!id) throw new Error('Сначала открой конкретную беседу ChatGPT (адрес с /c/...).');
    const toast = addStatus();
    try {
      toast.update('Получаю сообщения напрямую из истории, а не из прокручиваемой страницы…');
      const data = await fetchConversation(id, toast.update);
      toast.update('Проверяю последовательность и формирую файл…');
      const model = root.ONTOSCore.normalizeConversation(data);
      const basename = root.ONTOSCore.safeSlug(model.title) + '_' + id.slice(0, 8);
      let name;
      if (format === 'html') {
        name = basename + '.html';
        root.ONTOSCore.downloadText(root.ONTOSCore.renderHTML(model), name, 'text/html;charset=utf-8');
      } else if (format === 'md') {
        name = basename + '.md';
        root.ONTOSCore.downloadText(root.ONTOSCore.renderMarkdown(model), name, 'text/markdown;charset=utf-8');
      } else if (format === 'json') {
        name = basename + '.json';
        root.ONTOSCore.downloadText(JSON.stringify(data, null, 2), name, 'application/json;charset=utf-8');
      } else throw new Error('Неизвестный формат сохранения.');
      toast.update(`Готово. ${model.visibleMessages} видимых сообщений. Файл скачан.`);
      toast.finish();
      return {ok:true, name, visible:model.visibleMessages, path:model.pathMessages, source:model.sourceMessages, attachments:model.nonTextCount};
    } catch (error) {
      toast.update('Ошибка: ' + (error && error.message || 'Неизвестная ошибка'));
      toast.finish();
      throw error;
    }
  }
  root.ONTOSLive = {fetchConversation, exportCurrent};
})(globalThis);
