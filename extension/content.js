'use strict';
/* ONTOS: declarative content script; progress survives closing the popup. */
(() => {
  const SCRIPT_VERSION = '1.4.0';
  const isChatGPTHost = () => location.hostname === 'chatgpt.com';
  function idFromPath(pathname) {
    const match = pathname.match(/(?:^|\/)c\/([a-z0-9-]{16,128})(?:\/|$)/i);
    return match ? match[1] : '';
  }
  async function describe() {
    const conversationId = idFromPath(location.pathname);
    return {
      version: SCRIPT_VERSION, host: location.hostname, path: location.pathname,
      conversationId, core: Boolean(globalThis.ONTOSCore),
      live: Boolean(globalThis.ONTOSLive),
      checkpoint: conversationId && globalThis.ONTOSLive ?
        await globalThis.ONTOSLive.status(conversationId) : null
    };
  }
  function progress(message) {
    try { chrome.runtime.sendMessage({kind:'ONTOS_PROGRESS', text:message}).catch(() => {}); }
    catch (_) { /* Popup can close while pages continue to be stored. */ }
  }
  let busy = false;
  // A popup in another tab cannot see this tab's "busy" flag. Browser Web Locks
  // serialize exports and resets for a conversation across all chatgpt.com tabs.
  async function withConversationLock(id, callback) {
    const locks = globalThis.navigator && globalThis.navigator.locks;
    if (!locks || typeof locks.request !== 'function')
      throw new Error('Межвкладочная блокировка недоступна. Обнови браузер перед выгрузкой или сбросом.');
    return locks.request('ontos-chat-exporter:conversation:' + id, {mode:'exclusive'}, callback);
  }
  async function doExport(format, maxPages) {
    if (busy) throw new Error('Экспорт уже выполняется в этой вкладке.');
    if (!isChatGPTHost()) throw new Error('Открыта страница другого сайта.');
    const id = idFromPath(location.pathname);
    if (!id) throw new Error('Не найден адрес беседы (/c/...). Открой конкретный разговор внутри ChatGPT.');
    if (!globalThis.ONTOSCore || !globalThis.ONTOSLive || !globalThis.ONTOSCheckpoints)
      throw new Error('Обработчик расширения загружен не полностью. Обнови вкладку.');
    if (!['html','json','md'].includes(format)) throw new Error('Неизвестный формат.');
    busy = true;
    try {
      return await withConversationLock(id, async () => {
      progress('Читаю сохранённые страницы и продолжаю выгрузку…');
      const data = await globalThis.ONTOSLive.fetchConversation(id, progress, {maxPages});
      if (data.ontos_paused) {
        return {ok:true, complete:false, reason:data.reason, checkpoint:data.checkpoint};
      }
      progress('Проверяю цепочку сообщений…');
      const model = globalThis.ONTOSCore.normalizeConversation(data);
      const base = globalThis.ONTOSCore.safeSlug(model.title) + '_' + id.slice(0,8);
      const filename = base + '.' + format;
      progress(`Получено ${model.visibleMessages} видимых сообщений. Формирую файл…`);
      if (format === 'html') {
        globalThis.ONTOSCore.downloadText(globalThis.ONTOSCore.renderHTML(model), filename, 'text/html;charset=utf-8');
      } else if (format === 'md') {
        globalThis.ONTOSCore.downloadText(globalThis.ONTOSCore.renderMarkdown(model), filename, 'text/markdown;charset=utf-8');
      } else {
        globalThis.ONTOSCore.downloadText(JSON.stringify(data, null, 2), filename, 'application/json;charset=utf-8');
      }
      return {
        ok:true, complete:true, filename,
        visible:model.visibleMessages, source:model.sourceMessages,
        alternate:model.branchMessages, nonText:model.nonTextCount,
        structurallyChecked:model.verified,
        checkpoint:await globalThis.ONTOSLive.status(id)
      };
      });
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((request, _sender, reply) => {
    if (!request || typeof request !== 'object') return false;
    if (!['ONTOS_PING','ONTOS_EXPORT','ONTOS_RESET'].includes(request.kind)) return false;
    Promise.resolve().then(async () => {
      if (request.kind === 'ONTOS_PING') return {ok:true, ...await describe()};
      if (request.kind === 'ONTOS_RESET') {
        if (busy) throw new Error('Нельзя сбросить страницы во время активной выгрузки.');
        const id = idFromPath(location.pathname);
        if (!id) throw new Error('Открой конкретную беседу для сброса её контрольных точек.');
        busy = true;
        try {
          await withConversationLock(id, () => globalThis.ONTOSLive.reset(id));
          return {ok:true};
        } finally { busy = false; }
      }
      return doExport(request.format, request.maxPages);
    }).then(reply, error => reply({ok:false,message:String(error && error.message || error).slice(0,1200)}));
    return true;
  });
})();
