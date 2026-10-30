'use strict';
/* ONTOS: declarative content script. No chrome.scripting.executeScript is used. */
(() => {
  const SCRIPT_VERSION = '1.3.1';
  const isChatGPTHost = () => location.hostname === 'chatgpt.com';
  function idFromPath(pathname) {
    // Ordinary: /c/<uuid>; project: /g/g-p-.../c/<uuid>.
    // Use the final /c/ component; project path does not have to be fixed.
    const match = pathname.match(/(?:^|\/)c\/([a-z0-9-]{16,128})(?:\/|$)/i);
    return match ? match[1] : '';
  }
  const describe = () => ({
    version: SCRIPT_VERSION,
    host: location.hostname,
    path: location.pathname,
    conversationId: idFromPath(location.pathname),
    core: Boolean(globalThis.ONTOSCore),
    live: Boolean(globalThis.ONTOSLive)
  });
  function progress(message) {
    try { chrome.runtime.sendMessage({kind:'ONTOS_PROGRESS', text: message}).catch(() => {}); }
    catch (_) { /* popup can close while export continues */ }
  }
  let busy = false;
  async function doExport(format) {
    if (busy) throw new Error('Экспорт уже выполняется в этой вкладке.');
    if (!isChatGPTHost()) throw new Error('Открыта страница другого сайта.');
    const id = idFromPath(location.pathname);
    if (!id) throw new Error('Не найден адрес беседы (/c/...). Открой конкретный разговор внутри ChatGPT.');
    if (!globalThis.ONTOSCore || !globalThis.ONTOSLive)
      throw new Error('Обработчик расширения загружен не полностью. Обнови вкладку.');
    if (!['html', 'json', 'md'].includes(format)) throw new Error('Неизвестный формат.');
    busy = true;
    try {
      progress('Соединение с историей ChatGPT…');
      const data = await globalThis.ONTOSLive.fetchConversation(id, progress);
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
        ok: true, filename,
        visible: model.visibleMessages,
        source: model.sourceMessages,
        alternate: model.branchMessages,
        nonText: model.nonTextCount,
        structurallyChecked: model.verified
      };
    } finally { busy = false; }
  }
  chrome.runtime.onMessage.addListener((request, _sender, reply) => {
    if (!request || typeof request !== 'object') return false;
    if (request.kind === 'ONTOS_PING') {
      reply({ok:true, ...describe()});
      return false;
    }
    if (request.kind !== 'ONTOS_EXPORT') return false;
    Promise.resolve().then(() => doExport(request.format)).then(
      result => reply(result),
      error => reply({ok:false, message:String(error && error.message || error).slice(0,1200)})
    );
    return true;
  });
})();
