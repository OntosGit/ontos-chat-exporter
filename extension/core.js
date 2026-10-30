/* ONTOS Chat Exporter | local data processing only | 2026-10-30 */
(function (root) {
  'use strict';
  const asString = value => (value === undefined || value === null ? '' : String(value));
  const htmlEscape = value => asString(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
  const safeSlug = value => asString(value || 'ChatGPT-conversation').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'ChatGPT-conversation';
  const formattedTime = timestamp => {
    if (timestamp === null || timestamp === undefined || timestamp === '') return '';
    const numeric = Number(timestamp);
    const date = typeof timestamp === 'string' && isNaN(numeric) ? new Date(timestamp) : new Date(numeric * (numeric < 1e12 ? 1000 : 1));
    return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '';
  };
  function extractContents(content, metadata) {
    const blocks = [];
    let nonText = 0;
    if (!content || typeof content !== 'object') {
      if (typeof content === 'string') blocks.push(content);
    } else if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (typeof part === 'string') { blocks.push(part); continue; }
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') { blocks.push(part.text); continue; }
        if (typeof part.transcript === 'string') { blocks.push(part.transcript); continue; }
        const kind = part.content_type || part.type || 'данные';
        const name = part.asset_pointer || part.file_id || part.name || part.filename || '';
        blocks.push(`[Нетекстовое вложение: ${kind}${name ? ' / ' + name : ''}]`);
        nonText++;
      }
    } else {
      for (const key of ['text', 'content', 'summary', 'result']) {
        if (typeof content[key] === 'string' && content[key]) { blocks.push(content[key]); break; }
      }
      if (!blocks.length && content.content_type) {
        blocks.push(`[Содержимое типа «${content.content_type}» представлено в исходных данных]`);
        nonText++;
      }
    }
    const attachments = Array.isArray(metadata && metadata.attachments) ? metadata.attachments : [];
    for (const attachment of attachments) {
      const name = attachment && (attachment.name || attachment.filename || attachment.id || 'без имени');
      blocks.push(`[Прикреплённый файл: ${name}${attachment && attachment.mime_type ? ', ' + attachment.mime_type : ''}]`);
      nonText++;
    }
    let text = blocks.join('\n\n');
    const references = metadata && Array.isArray(metadata.content_references) ? metadata.content_references : [];
    for (const reference of references) {
      const needle = reference && reference.matched_text;
      if (typeof needle === 'string' && /[\uE200-\uE203]/.test(needle) && typeof reference.alt === 'string') {
        text = text.split(needle).join(reference.alt);
      }
    }
    return { text, nonText };
  }
  function visibleMessage(message) {
    if (!message || typeof message !== 'object') return false;
    const role = message.author && message.author.role;
    if (role !== 'user' && role !== 'assistant') return false;
    const meta = message.metadata || {};
    if (meta.is_visually_hidden_from_conversation === true) return false;
    const channel = message.channel || meta.channel || meta.message_type;
    if (['analysis', 'justify', 'confidence', 'notification'].includes(channel)) return false;
    if (role === 'assistant' && message.recipient && message.recipient !== 'all') return false;
    // These record types are internal service data, not conversational messages.
    // The previous v1.2 counted 137 "thoughts" and 9 "reasoning_recap" as visible.
    const type = message.content && message.content.content_type;
    if (['thoughts', 'reasoning_recap', 'analysis'].includes(type)) return false;
    // Assistant tool commands and execution records belong only in the source JSON.
    if (role === 'assistant' && !['text', 'multimodal_text'].includes(type)) {
      if (!(type == null && Array.isArray(message.content && message.content.parts))) return false;
    }
    return true;
  }
  function normalizeConversation(conversation) {
    if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) throw new Error('Вместо данных беседы получен неверный JSON.');
    const title = conversation.title || 'Без названия';
    const id = conversation.conversation_id || conversation.id || '';
    const warnings = [];
    let path = [];
    let allNodes = 0;
    let branchMessages = 0;
    let sourceKind = '';
    let verified = true;
    if (conversation.mapping && typeof conversation.mapping === 'object' && !Array.isArray(conversation.mapping)) {
      sourceKind = 'Дерево сообщений';
      const mapping = conversation.mapping;
      const nodeIds = Object.keys(mapping);
      allNodes = nodeIds.filter(key => mapping[key] && mapping[key].message).length;
      let current = conversation.current_node || conversation.current_node_id;
      if (!current || !Object.prototype.hasOwnProperty.call(mapping, current)) {
        throw new Error('Нельзя подтвердить полноту: отсутствует current_node или соответствующий узел.');
      }
      const visited = new Set();
      let reachedRoot = false;
      while (current !== null && current !== undefined) {
        if (visited.has(current)) throw new Error('Повтор узла в цепочке сообщений: данные повреждены.');
        visited.add(current);
        const node = mapping[current];
        if (!node) throw new Error('Цепочка сообщений обрывается на недостающем узле: ' + current);
        if (node.message) path.push(node.message);
        if (node.parent === undefined || node.parent === null || node.parent === '') { reachedRoot = true; break; }
        current = node.parent;
      }
      if (!reachedRoot) throw new Error('Не найден корневой узел, сохранение прервано.');
      path.reverse();
      branchMessages = allNodes - path.length;
      if (branchMessages > 0) warnings.push(`В исходном дереве есть ${branchMessages} сообщений из альтернативных веток. Они не включены в основной диалог.`);
    } else if (Array.isArray(conversation.messages)) {
      sourceKind = 'Последовательность сообщений';
      const page = conversation.page_info;
      if (!page || typeof page.has_previous_page !== 'boolean' || typeof page.has_next_page !== 'boolean') {
        verified = false;
        warnings.push('В этом формате нет надёжных признаков окончания всех страниц. История сохранена в полученном объёме, полную сохранность подтвердить невозможно.');
      }
      if (page && (page.has_previous_page === true || page.has_next_page === true)) {
        throw new Error('Беседа содержит признаки неполной пагинации (page_info). Экспортировать как полный нельзя.');
      }
      path = conversation.messages.map(item => item && item.message ? item.message : item).filter(Boolean);
      allNodes = path.length;
      const ids = path.map(m => m.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) throw new Error('В данных беседы обнаружены повторяющиеся идентификаторы сообщений.');
    } else {
      throw new Error('Неизвестный формат беседы: нет ни mapping, ни messages.');
    }
    const visible = [];
    let nonTextCount = 0;
    let skipped = 0;
    path.forEach((message, index) => {
      if (!visibleMessage(message)) { skipped++; return; }
      const contents = extractContents(message.content, message.metadata || {});
      nonTextCount += contents.nonText;
      visible.push({
        sequence: index + 1,
        id: message.id || '',
        role: message.author.role,
        date: formattedTime(message.create_time),
        text: contents.text || '[Сообщение без извлекаемого текстового содержимого]',
        nonTextCount: contents.nonText
      });
    });
    const unfinished = path.filter(message => message && message.status === 'in_progress').length;
    if (unfinished) warnings.push(`В момент экспорта ${unfinished} служебных/текстовых записей имели статус in_progress. Последний ход мог ещё выполняться.`);
    if (!visible.length) throw new Error('В выбранной беседе не найдено видимых сообщений пользователя и ассистента.');
    if (nonTextCount > 0) warnings.push(`В тексте показаны обозначения ${nonTextCount} нетекстовых блоков/вложений. Их бинарные данные отдельно не сохраняются.`);
    return {
      title, id, updated: formattedTime(conversation.update_time), created: formattedTime(conversation.create_time),
      sourceKind, sourceMessages: allNodes, pathMessages: path.length, branchMessages,
      serviceMessages: skipped, visibleMessages: visible.length, nonTextCount, unfinishedMessages: unfinished,
      messages: visible, warnings, verified
    };
  }
  function renderHTML(model) {
    const count = model.visibleMessages;
    const messages = model.messages.map((message, index) => {
      const who = message.role === 'user' ? 'Вы' : 'ChatGPT';
      const role = message.role === 'user' ? 'user' : 'assistant';
      return `<article class="message ${role}" id="m${index + 1}"><header><span class="role">${who}</span><span>#${index + 1}${message.date ? ' · ' + htmlEscape(message.date) : ''}</span></header><pre>${htmlEscape(message.text)}</pre></article>`;
    }).join('\n');
    const warnings = model.warnings.length ? `<div class="notice">${model.warnings.map(x => `<p>${htmlEscape(x)}</p>`).join('')}</div>` : '';
    const title = htmlEscape(model.title);
    return `<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Архив ChatGPT</title><style>
:root{color-scheme:dark;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}body{background:#10141c;color:#e5e9f0;margin:0}main{max-width:1020px;margin:0 auto;padding:36px 24px 100px}h1{font-size:clamp(25px,4vw,38px);line-height:1.2;overflow-wrap:anywhere;margin:12px 0 14px}.sub{color:#9ca9bd}.stats{display:flex;gap:9px;flex-wrap:wrap;margin:24px 0}.stats span{padding:7px 11px;border:1px solid #354153;border-radius:10px;background:#1a2230}.notice{border-left:3px solid #bba779;padding:6px 16px;margin:14px 0;color:#d2cab8;background:#201e1d}.message{border:1px solid #303a49;border-radius:15px;background:#181f2b;margin:14px 0;overflow:hidden}.message.user{border-color:#325b65;background:#14292e}.message header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #33404f;padding:12px 18px;color:#aab7ca;font-size:13px}.role{font-size:14px;font-weight:700;color:#d7f3f6}.message.assistant .role{color:#d3d3ff}.message pre{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.65 "Segoe UI",system-ui,sans-serif;tab-size:4}.foot{font-size:12px;color:#95a2b5;margin-top:34px}@media print{:root{color-scheme:light}body{background:white;color:black}main{max-width:100%;padding:0}.message,.message.user{break-inside:avoid;background:white;color:black;border:1px solid #bbb}.message header{color:#444}.role,.message.assistant .role{color:black}.stats span{background:white;color:black}}
</style></head><body><main><div class="sub">ONTOS · Локальный архив разговора</div><h1>${title}</h1><div class="sub">ID: ${htmlEscape(model.id || 'не указан')} · ${htmlEscape(model.updated || model.created || '')}</div><div class="stats"><span>Сообщений в HTML: <b>${count}</b></span><span>Узлов основной ветки: <b>${model.pathMessages}</b></span><span>В исходных данных: <b>${model.sourceMessages}</b></span><span>Служебных скрыто: <b>${model.serviceMessages}</b></span><span>Альтернативных веток: <b>${model.branchMessages}</b></span></div><p class="sub">${model.verified ? 'Последовательность сообщений проверена по исходной структуре' : 'Полноту исходных данных подтвердить нельзя'} (${htmlEscape(model.sourceKind)}). Показаны текстовые сообщения пользователя и ассистента; служебные записи, рассуждения и результаты инструментов остаются в исходном JSON. Никакой виртуализации, все ${count} сообщений находятся в этом HTML одновременно.</p>${warnings}${messages}<p class="foot">Сформировано ONTOS Chat Exporter. Содержимое сохранено как текст; медиафайлы, динамические виджеты и связанные внешние ресурсы могут требовать отдельных оригиналов.</p></main></body></html>`;
  }
  function renderMarkdown(model) {
    const out = [`# ${model.title}`, '', `Разговор: ${model.id}`, `Сообщений: ${model.visibleMessages}; основная ветка: ${model.pathMessages}; всего узлов: ${model.sourceMessages}`, ''];
    for (const [i, message] of model.messages.entries()) {
      out.push(`## ${i + 1}. ${message.role === 'user' ? 'Вы' : 'ChatGPT'}${message.date ? ' · ' + message.date : ''}`, '', message.text, '');
    }
    if (model.warnings.length) out.push('---', '', ...model.warnings.map(x => '> ' + x), '');
    return out.join('\n');
  }
  function downloadText(data, filename, mimeType) {
    const blob = new Blob([data], {type: mimeType || 'text/plain;charset=utf-8'});
    const objectURL = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectURL;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectURL), 30000);
  }
  root.ONTOSCore = {normalizeConversation, renderHTML, renderMarkdown, downloadText, safeSlug, formattedTime};
})(globalThis);
