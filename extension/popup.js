'use strict';
/* ONTOS: communicate with the declarative content script. */
const saveButton = document.getElementById('save');
const jsonButton = document.getElementById('source');
const mdButton = document.getElementById('markdown');
const status = document.getElementById('status');
const help = document.getElementById('help');
const setStatus = value => {status.textContent = value;};
const shortError = error => String((error && error.message) || error || 'Неизвестная ошибка').slice(0,1000);
function setHelp(message) {
  const low = message.toLowerCase();
  if (/нет связи с обработчиком|receiving end does not exist|message port closed|blocked|permission|denied|could not establish/i.test(low)) {
    help.textContent = 'Расширение не смогло связаться со страницей. Настройку серого переключателя менять не нужно. Обнови вкладку ChatGPT (Ctrl+R) и повтори. Если сообщение остаётся, Edge не допускает обработчик на эту страницу либо расширение не внедрилось: используй официальный ZIP с ONTOS Reader.';
  } else if (/http 40[13]|http 429|история разговора недоступна|не удалось подключиться|сервер|json|формат/i.test(low)) {
    help.textContent = 'Связь со страницей есть, но запрос к внутреннему интерфейсу ChatGPT не прошёл. Это ограничение прямого маршрута: официальный ZIP открывается локально в ONTOS Reader.';
  } else if (/адрес беседы|не найден|conversation/i.test(low)) {
    help.textContent = 'Нужна открытая конкретная беседа. Поддерживаются обычные адреса /c/… и беседы в проектах /g/…/c/….';
  } else {
    help.textContent = 'Для альтернативного маршрута используй официальный экспорт данных ChatGPT и файл ONTOS_Reader.html из комплекта.';
  }
}
async function getTab() {
  const tabs = await chrome.tabs.query({active:true, currentWindow:true});
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number' || !/^https:\/\/chatgpt\.com\//i.test(tab.url || ''))
    throw new Error('Открой нужный разговор на chatgpt.com.');
  return tab;
}
async function send(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (error) { throw new Error('Нет связи с обработчиком страницы: ' + shortError(error)); }
}
chrome.runtime.onMessage.addListener(message => {
  if (message && message.kind === 'ONTOS_PROGRESS' && typeof message.text === 'string')
    setStatus(message.text);
});
async function save(format) {
  saveButton.disabled = true;
  jsonButton.disabled = true;
  mdButton.disabled = true;
  help.textContent = '';
  try {
    setStatus('Проверяю связь со страницей ChatGPT…');
    const tab = await getTab();
    const ping = await send(tab.id, {kind:'ONTOS_PING'});
    if (!ping || !ping.ok || ping.version !== '1.3.1') throw new Error('Вкладка использует прежнюю версию. Обнови её через Ctrl+R.');
    if (!ping.conversationId) throw new Error('Не найден адрес беседы (/c/…). Открой конкретный разговор.');
    if (!ping.core || !ping.live) throw new Error('Не загружены компоненты экспортёра; обнови вкладку.');
    setStatus('Читаю историю и восстанавливаю цепочку сообщений…');
    const result = await send(tab.id, {kind:'ONTOS_EXPORT', format});
    if (!result || !result.ok) throw new Error(result && result.message || 'Экспорт не подтверждён.');
    setStatus(`Сформирован файл: ${result.filename}\nТекстовых сообщений: ${result.visible}; исходных узлов: ${result.source}. Проверь загрузки Edge (Ctrl+J).`);
    if (result.alternate) help.textContent = `Альтернативных веток: ${result.alternate}; они остаются в исходном JSON.`;
    if (result.nonText) help.textContent += ` Нетекстовых блоков/вложений: ${result.nonText}; сами файлы не сохранены.`;
    if (!result.structurallyChecked) help.textContent += ' Не удалось проверить полноту всех страниц исходных данных.';
  } catch (error) {
    const message = shortError(error);
    setStatus('Ошибка: ' + message);
    setHelp(message);
  } finally {
    saveButton.disabled = false;
    jsonButton.disabled = false;
    mdButton.disabled = false;
  }
}
saveButton.addEventListener('click', () => save('html'));
jsonButton.addEventListener('click', () => save('json'));
mdButton.addEventListener('click', () => save('md'));
