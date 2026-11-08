'use strict';
/* ONTOS 1.4: checkpoint-aware UI. No remote services outside chatgpt.com. */
const saveButton = document.getElementById('save');
const jsonButton = document.getElementById('source');
const mdButton = document.getElementById('markdown');
const resumeButton = document.getElementById('resume');
const resetButton = document.getElementById('reset');
const batchSelect = document.getElementById('batch');
const checkpoint = document.getElementById('checkpoint');
const status = document.getElementById('status');
const help = document.getElementById('help');
const buttons = [saveButton, jsonButton, mdButton, resumeButton, resetButton];
const shortError = error => String((error && error.message) || error || 'Неизвестная ошибка').slice(0,1000);
let activeTabId = null;
let lastFormat = 'md';
function setStatus(value) { status.textContent = value; }
function setBusy(value) { buttons.forEach(button => button.disabled = value); batchSelect.disabled = value; }
function setHelp(message) {
  const low = message.toLowerCase();
  if (/нет связи с обработчиком|receiving end does not exist|message port closed|blocked|permission|denied|could not establish/i.test(low)) {
    help.textContent = 'Нет связи со страницей: обнови вкладку ChatGPT через Ctrl+R и повтори. Проверь доступ расширения к сайту в Edge.';
  } else if (/http 40[13]|http 429|не удалось подключиться|сервер|json|формат/i.test(low)) {
    help.textContent = 'Сохранённые страницы остаются в браузере. При следующем запуске расширение продолжит с контрольной точки, если она существует.';
  } else {
    help.textContent = 'При необходимости используй официальный экспорт ChatGPT ZIP и локальный ONTOS Reader.';
  }
}
async function getTab() {
  const tabs = await chrome.tabs.query({active:true, currentWindow:true});
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number' || !/^https:\/\/chatgpt\.com\//i.test(tab.url || ''))
    throw new Error('Открой нужный разговор на chatgpt.com.');
  activeTabId = tab.id;
  return tab;
}
async function send(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (error) { throw new Error('Нет связи с обработчиком страницы: ' + shortError(error)); }
}
function showCheckpoint(data) {
  resumeButton.hidden = !data || data.complete || !data.hasMore;
  resetButton.hidden = !data;
  if (!data) {
    checkpoint.textContent = 'Для этой беседы ещё нет сохранённых страниц.';
    return;
  }
  const lines = [`Локально сохранено: ${data.pages} стр., ${data.messages} сообщений.`];
  if (data.complete) lines.push('История собрана. Любой формат скачивается без повторного обращения к серверу.');
  else if (data.hasMore) lines.push('Остались ' + data.direction + ' страницы. Нажми «Продолжить».');
  if (data.retryAt && data.retryAt > Date.now())
    lines.push('HTTP 429: следующая попытка после ' + new Date(data.retryAt).toLocaleTimeString() + '.');
  if (data.lastError && data.lastError !== 'HTTP 429') lines.push('Последняя ошибка: ' + data.lastError);
  checkpoint.textContent = lines.join('\n');
}
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.kind === 'ONTOS_PROGRESS' && typeof message.text === 'string' &&
      (!sender.tab || sender.tab.id === activeTabId)) setStatus(message.text);
});
async function ping() {
  const tab = await getTab();
  const reply = await send(tab.id, {kind:'ONTOS_PING'});
  if (!reply || !reply.ok || reply.version !== '1.4.0')
    throw new Error('Вкладка использует прежнюю версию расширения. Обнови вкладку через Ctrl+R.');
  if (!reply.conversationId) throw new Error('Нужна конкретная беседа с адресом /c/…');
  if (!reply.core || !reply.live) throw new Error('Экспортёр загружен не полностью. Обнови вкладку.');
  showCheckpoint(reply.checkpoint);
  return tab;
}
async function save(format) {
  lastFormat = format;
  setBusy(true);
  help.textContent = '';
  try {
    setStatus('Проверяю контрольную точку беседы…');
    const tab = await ping();
    const maxPages = Number(batchSelect.value) || 0;
    const result = await send(tab.id, {kind:'ONTOS_EXPORT', format, maxPages});
    if (!result || !result.ok) throw new Error(result && result.message || 'Экспорт не подтверждён.');
    showCheckpoint(result.checkpoint);
    if (!result.complete) {
      if (result.reason === 'rate_limit') {
        setStatus('HTTP 429. Все ранее полученные страницы сохранены. Продолжи после указанного времени.');
      } else {
        setStatus('Порция страниц сохранена. Нажми «Продолжить», чтобы загрузить следующую.');
      }
      return;
    }
    setStatus(`Сформирован файл: ${result.filename}\nТекстовых сообщений: ${result.visible}; исходных узлов: ${result.source}. Проверь загрузки Edge (Ctrl+J).`);
    if (result.alternate) help.textContent = `Альтернативных веток: ${result.alternate}; они остаются в исходном JSON. `;
    if (result.nonText) help.textContent += `Нетекстовых блоков/вложений: ${result.nonText}; сами файлы не сохранены. `;
    if (!result.structurallyChecked) help.textContent += 'Полнота всех страниц не подтверждена.';
  } catch (error) {
    const message = shortError(error);
    setStatus('Ошибка: ' + message);
    setHelp(message);
    try { await ping(); } catch (_) { /* Keep the original error. */ }
  } finally { setBusy(false); }
}
async function reset() {
  if (!confirm('Удалить сохранённые страницы только этой беседы? Следующая выгрузка начнётся заново.')) return;
  setBusy(true);
  try {
    const tab = await getTab();
    const result = await send(tab.id, {kind:'ONTOS_RESET'});
    if (!result || !result.ok) throw new Error(result && result.message || 'Не удалось очистить данные.');
    setStatus('Контрольные точки этой беседы удалены.');
    help.textContent = '';
    showCheckpoint(null);
  } catch (error) { setStatus('Ошибка: ' + shortError(error)); }
  finally { setBusy(false); }
}
mdButton.addEventListener('click', () => save('md'));
saveButton.addEventListener('click', () => save('html'));
jsonButton.addEventListener('click', () => save('json'));
resumeButton.addEventListener('click', () => save(lastFormat));
resetButton.addEventListener('click', reset);
(async () => {
  try { await ping(); } catch (error) { setStatus(shortError(error)); setHelp(shortError(error)); }
})();
