const records = [];
const RECORD_DB_NAME = 'fetch-request-manager-db';
const RECORD_STORE_NAME = 'requestRecords';
const MAX_RECORDS = 100;

let recordDbPromise;

const commandInput = document.getElementById('commandInput');
const results = document.getElementById('results');
const detailDialog = document.getElementById('detailDialog');
const closeDialog = document.getElementById('closeDialog');
const clipboardMonitorToggle = document.getElementById('clipboardMonitorToggle');
const clipboardMonitorStatus = document.getElementById('clipboardMonitorStatus');
const queueProcessingToggle = document.getElementById('queueProcessingToggle');
const queueProcessingStatus = document.getElementById('queueProcessingStatus');
const statusSummary = document.getElementById('statusSummary');

const detailStatus = document.getElementById('detailStatus');
const detailCommand = document.getElementById('detailCommand');
const detailHeaders = document.getElementById('detailHeaders');
const detailBody = document.getElementById('detailBody');
const detailError = document.getElementById('detailError');

const clipboardMonitor = {
  enabled: false,
  timerId: null,
  lastClipboardText: '',
  isChecking: false,
  isExecuting: false,
  autoProcessEnabled: true,
  pendingCommands: [],
};

async function createQueuedRecord(command) {
  const normalizedCommand = normalizeCommand(command);
  const startedAt = new Date().toISOString();
  const { url, method } = extractSummary(normalizedCommand);
  const inspectedRequest = await inspectFetchRequest(normalizedCommand, url, method);

  const record = {
    id: generateId(),
    startedAt,
    command: normalizedCommand,
    url: inspectedRequest.url || url,
    method: inspectedRequest.method || method,
    requestBody: inspectedRequest.bodyText || '',
    durationMs: 0,
    status: 'queued',
    httpStatus: undefined,
    responseHeaders: undefined,
    responseBody: undefined,
    errorMessage: '',
  };

  records.push(record);
  enforceRecordLimit();
  await saveRecordsToDb();
  return record;
}

async function enqueueClipboardCommand(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) {
    return null;
  }

  const lastQueued = clipboardMonitor.pendingCommands[clipboardMonitor.pendingCommands.length - 1]?.command;
  if (lastQueued === normalized) {
    return null;
  }

  const existingQueued = clipboardMonitor.pendingCommands.find((item) => item.command === normalized);
  if (existingQueued) {
    return existingQueued;
  }

  const record = await createQueuedRecord(normalized);
  const queuedItem = { recordId: record.id, command: normalized };
  clipboardMonitor.pendingCommands.push(queuedItem);
  render();
  void processPendingClipboardQueue();
  return queuedItem;
}

async function clearQueuedCommandsAndCards() {
  if (clipboardMonitor.pendingCommands.length === 0) {
    return;
  }

  const pendingIds = new Set(clipboardMonitor.pendingCommands.map((item) => item.recordId));
  clipboardMonitor.pendingCommands = [];

  let changed = false;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (pendingIds.has(records[i].id) || records[i].status === 'queued') {
      records.splice(i, 1);
      changed = true;
    }
  }

  if (changed) {
    render();
    await saveRecordsToDb();
  }
}

function rebuildQueueFromQueuedCards() {
  const queuedRecords = records
    .filter((record) => record.status === 'queued' && normalizeCommand(record.command))
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  clipboardMonitor.pendingCommands = queuedRecords.map((record) => ({
    recordId: record.id,
    command: normalizeCommand(record.command),
  }));
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openRecordDb() {
  if (recordDbPromise) {
    return recordDbPromise;
  }

  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  recordDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORD_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE_NAME)) {
        db.createObjectStore(RECORD_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });

  return recordDbPromise;
}

function normalizeStoredRecord(record) {
  return {
    id: String(record.id || generateId()),
    startedAt: String(record.startedAt || new Date().toISOString()),
    command: String(record.command || ''),
    url: record.url ? String(record.url) : '',
    method: record.method ? String(record.method) : '',
    requestBody: record.requestBody ? String(record.requestBody) : '',
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : 0,
    status: record.status || 'failure',
    httpStatus: Number.isFinite(record.httpStatus) ? record.httpStatus : undefined,
    responseHeaders: record.responseHeaders && typeof record.responseHeaders === 'object' ? record.responseHeaders : {},
    responseBody: record.responseBody ? String(record.responseBody) : '',
    errorMessage: record.errorMessage ? String(record.errorMessage) : '',
  };
}

function enforceRecordLimit() {
  sortRecords();
  if (records.length > MAX_RECORDS) {
    records.splice(MAX_RECORDS);
  }
}

async function saveRecordsToDb() {
  const db = await openRecordDb();
  if (!db) {
    return;
  }

  const snapshot = records.map((record) => normalizeStoredRecord(record));
  snapshot.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const limited = snapshot.slice(0, MAX_RECORDS);

  await new Promise((resolve, reject) => {
    const tx = db.transaction(RECORD_STORE_NAME, 'readwrite');
    const store = tx.objectStore(RECORD_STORE_NAME);
    store.clear();
    for (const record of limited) {
      store.put(record);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to save records'));
    tx.onabort = () => reject(tx.error || new Error('Record save transaction aborted'));
  });
}

async function loadRecordsFromDb() {
  const db = await openRecordDb();
  if (!db) {
    return;
  }

  const tx = db.transaction(RECORD_STORE_NAME, 'readonly');
  const store = tx.objectStore(RECORD_STORE_NAME);
  const stored = await requestToPromise(store.getAll());

  records.length = 0;
  for (const item of stored) {
    records.push(normalizeStoredRecord(item));
  }

  enforceRecordLimit();
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function extractSummary(command) {
  const fetchCall = command.match(/fetch\s*\(\s*(['"`])(.+?)\1/s);
  const method = command.match(/method\s*:\s*(['"`])([A-Za-z]+)\1/i);

  return {
    url: fetchCall ? fetchCall[2] : '',
    method: method ? method[2].toUpperCase() : 'GET',
  };
}

function formatDate(iso) {
  return new Date(iso).toLocaleString();
}

function toHeaderObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

function extractResponseMessage(responseBody, errorMessage) {
  if (typeof responseBody === 'string' && responseBody.trim()) {
    try {
      const parsed = JSON.parse(responseBody);
      if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
        return parsed.message;
      }
    } catch {
      // Response body is not JSON; fallback below.
    }

    return responseBody.trim().slice(0, 200);
  }

  if (typeof errorMessage === 'string' && errorMessage.trim()) {
    return errorMessage.trim().slice(0, 200);
  }

  return '-';
}

function normalizeCommand(command) {
  return command.trim().replace(/;+\s*$/, '');
}

function canUseClipboardMonitor() {
  return typeof window.electronAPI?.readClipboardText === 'function';
}

async function readClipboardText() {
  if (!canUseClipboardMonitor()) {
    throw new Error('clipboard_unavailable');
  }

  return window.electronAPI.readClipboardText();
}

function extractFetchCommandFromText(text) {
  if (typeof text !== 'string') {
    return '';
  }

  const trimmed = text.trim();
  return /fetch\s*\(/.test(trimmed) ? trimmed : '';
}

function setClipboardMonitorStatus(message) {
  clipboardMonitorStatus.textContent = message;
}

function renderQueueProcessingState() {
  if (!queueProcessingToggle || !queueProcessingStatus) {
    return;
  }

  const pressed = clipboardMonitor.autoProcessEnabled ? 'true' : 'false';
  queueProcessingToggle.setAttribute('aria-pressed', pressed);
  queueProcessingToggle.textContent = `キュー自動処理: ${clipboardMonitor.autoProcessEnabled ? 'ON' : 'OFF'}`;
  queueProcessingStatus.textContent = clipboardMonitor.autoProcessEnabled
    ? 'キュー自動処理はONです'
    : 'キュー自動処理はOFFです(キューは保持されます)';
}

function maybeStartQueueProcessing() {
  if (!clipboardMonitor.autoProcessEnabled) {
    return;
  }

  void processPendingClipboardQueue();
}

function renderClipboardMonitorState() {
  const pressed = clipboardMonitor.enabled ? 'true' : 'false';
  clipboardMonitorToggle.setAttribute('aria-pressed', pressed);
  clipboardMonitorToggle.textContent = `クリップボード監視: ${clipboardMonitor.enabled ? 'ON' : 'OFF'}`;

  if (!canUseClipboardMonitor()) {
    setClipboardMonitorStatus('この環境ではクリップボード監視を利用できません');
    clipboardMonitorToggle.disabled = true;
    return;
  }

  clipboardMonitorToggle.disabled = false;

  if (!clipboardMonitor.enabled) {
    setClipboardMonitorStatus('クリップボード監視はOFFです');
    return;
  }

  setClipboardMonitorStatus('監視ON: fetchコマンドを検知すると自動実行します');
}

async function checkClipboardForFetchCommand() {
  if (!clipboardMonitor.enabled || clipboardMonitor.isChecking) {
    return;
  }

  clipboardMonitor.isChecking = true;

  try {
    const clipboardText = await readClipboardText();

    if (clipboardText === clipboardMonitor.lastClipboardText) {
      return;
    }

    clipboardMonitor.lastClipboardText = clipboardText;
    const fetchCommand = extractFetchCommandFromText(clipboardText);
    if (!fetchCommand) {
      return;
    }

    const normalizedCommand = normalizeCommand(fetchCommand);
    if (!normalizedCommand) {
      return;
    }

    if (clipboardMonitor.isExecuting) {
      await enqueueClipboardCommand(normalizedCommand);
      setClipboardMonitorStatus('監視ON: 実行中のため次のfetchコマンドをキューしました');
      return;
    }

    await enqueueClipboardCommand(normalizedCommand);
    maybeStartQueueProcessing();
  } catch (error) {
    clipboardMonitor.enabled = false;
    if (clipboardMonitor.timerId) {
      window.clearInterval(clipboardMonitor.timerId);
      clipboardMonitor.timerId = null;
    }
    setClipboardMonitorStatus('クリップボード監視を開始できませんでした');
    renderClipboardMonitorState();
  } finally {
    clipboardMonitor.isChecking = false;
  }
}

async function runClipboardCommand(initialCommand) {
  if (clipboardMonitor.isExecuting) {
    await enqueueClipboardCommand(initialCommand);
    return;
  }

  if (!clipboardMonitor.autoProcessEnabled) {
    await enqueueClipboardCommand(initialCommand);
    return;
  }

  clipboardMonitor.isExecuting = true;

  try {
    await enqueueClipboardCommand(initialCommand);

    while (clipboardMonitor.pendingCommands.length > 0) {
      const nextItem = clipboardMonitor.pendingCommands.shift();
      const queuedRecord = records.find((item) => item.id === nextItem.recordId);
      if (!queuedRecord) {
        continue;
      }

      commandInput.value = nextItem.command;
      setClipboardMonitorStatus('監視ON: クリップボードのfetchコマンドを自動実行しました');
      await executeFetchCommand(nextItem.command, queuedRecord);
      commandInput.value = '';
    }
  } finally {
    clipboardMonitor.isExecuting = false;
  }
}

async function processPendingClipboardQueue() {
  if (!clipboardMonitor.autoProcessEnabled) {
    return;
  }

  if (clipboardMonitor.isExecuting) {
    return;
  }

  clipboardMonitor.isExecuting = true;

  try {
    while (clipboardMonitor.pendingCommands.length > 0) {
      const nextItem = clipboardMonitor.pendingCommands.shift();
      const queuedRecord = records.find((item) => item.id === nextItem.recordId);
      if (!queuedRecord) {
        continue;
      }

      commandInput.value = nextItem.command;
      setClipboardMonitorStatus('監視ON: クリップボードのfetchコマンドを自動実行しました');
      await executeFetchCommand(nextItem.command, queuedRecord);
      commandInput.value = '';
    }
  } finally {
    clipboardMonitor.isExecuting = false;
  }
}

async function setClipboardMonitorEnabled(enabled) {
  if (!canUseClipboardMonitor()) {
    renderClipboardMonitorState();
    return;
  }

  clipboardMonitor.enabled = enabled;

  if (clipboardMonitor.timerId) {
    window.clearInterval(clipboardMonitor.timerId);
    clipboardMonitor.timerId = null;
  }

  if (enabled) {
    try {
      const clipboardText = await readClipboardText();
      clipboardMonitor.lastClipboardText = clipboardText;

      const immediateCommand = normalizeCommand(extractFetchCommandFromText(clipboardText));
      if (immediateCommand) {
        await enqueueClipboardCommand(immediateCommand);
        if (clipboardMonitor.isExecuting) {
          setClipboardMonitorStatus('監視ON: 実行中のため次のfetchコマンドをキューしました');
        }
        maybeStartQueueProcessing();
      }
    } catch {
      clipboardMonitor.enabled = false;
      renderClipboardMonitorState();
      setClipboardMonitorStatus('クリップボード監視を開始できませんでした');
      return;
    }

    clipboardMonitor.timerId = window.setInterval(() => {
      void checkClipboardForFetchCommand();
    }, 1000);

  }

  if (clipboardMonitor.pendingCommands.length > 0) {
    maybeStartQueueProcessing();
  }

  renderClipboardMonitorState();
}

function isDownloadPostRecord(record) {
  const byResolvedRequest = record.method === 'POST' && /\/download(?:$|[/?#])/i.test(record.url || '');
  if (byResolvedRequest) {
    return true;
  }

  const byCommandText =
    /method\s*:\s*['"`]POST['"`]/i.test(record.command || '') && /\/download(?:$|[/?#'"`])/i.test(record.command || '');
  return byCommandText;
}

function extractDownloadBodySummaryFromText(bodyText) {
  const summary = {
    siteName: '-',
    title: '-',
    imgUrlsCount: 0,
  };

  if (typeof bodyText !== 'string' || !bodyText.trim()) {
    return summary;
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.siteName === 'string' && parsed.siteName.trim()) {
        summary.siteName = parsed.siteName;
      }
      if (typeof parsed.title === 'string' && parsed.title.trim()) {
        summary.title = parsed.title;
      }
      if (Array.isArray(parsed.imgUrls)) {
        summary.imgUrlsCount = parsed.imgUrls.length;
      }
    }
  } catch {
    // If body is not valid JSON, keep fallback values.
  }

  return summary;
}

function extractDownloadBodySummary(command, requestBody) {
  if (typeof requestBody === 'string' && requestBody.trim()) {
    return extractDownloadBodySummaryFromText(requestBody);
  }

  const summary = {
    siteName: '-',
    title: '-',
    imgUrlsCount: 0,
  };

  const jsonBodyMatch = command.match(/body\s*:\s*(['"`])([\s\S]*?)\1/s);
  if (jsonBodyMatch) {
    try {
      const parsed = JSON.parse(jsonBodyMatch[2]);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.siteName === 'string' && parsed.siteName.trim()) {
          summary.siteName = parsed.siteName;
        }
        if (typeof parsed.title === 'string' && parsed.title.trim()) {
          summary.title = parsed.title;
        }
        if (Array.isArray(parsed.imgUrls)) {
          summary.imgUrlsCount = parsed.imgUrls.length;
        }
      }
      return summary;
    } catch {
      // Continue to object-literal parsing fallback.
    }
  }

  const objectBodyMatch = command.match(/body\s*:\s*JSON\.stringify\(\s*({[\s\S]*?})\s*\)/s);
  if (!objectBodyMatch) {
    return summary;
  }

  const bodyLiteral = objectBodyMatch[1];
  const siteNameMatch = bodyLiteral.match(/siteName\s*:\s*(['"`])([\s\S]*?)\1/s);
  const titleMatch = bodyLiteral.match(/title\s*:\s*(['"`])([\s\S]*?)\1/s);
  const imgUrlsMatch = bodyLiteral.match(/imgUrls\s*:\s*\[([\s\S]*?)\]/s);

  if (siteNameMatch && siteNameMatch[2].trim()) {
    summary.siteName = siteNameMatch[2].trim();
  }

  if (titleMatch && titleMatch[2].trim()) {
    summary.title = titleMatch[2].trim();
  }

  if (imgUrlsMatch) {
    const itemMatches = imgUrlsMatch[1].match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g);
    summary.imgUrlsCount = itemMatches ? itemMatches.length : 0;
  }

  return summary;
}

function toRequestBodyText(body) {
  if (body == null) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  if (body instanceof FormData) {
    const out = {};
    for (const [key, value] of body.entries()) {
      out[key] = typeof value === 'string' ? value : '[binary]';
    }
    return JSON.stringify(out);
  }

  if (body instanceof Blob) {
    return '[blob]';
  }

  try {
    return String(body);
  } catch {
    return '';
  }
}

function deriveUrlAndMethod(input, init) {
  if (input instanceof Request) {
    return {
      url: input.url || '',
      method: (init?.method || input.method || 'GET').toUpperCase(),
    };
  }

  if (typeof input === 'string' || input instanceof URL) {
    return {
      url: String(input),
      method: (init?.method || 'GET').toUpperCase(),
    };
  }

  return {
    url: '',
    method: 'GET',
  };
}

async function inspectFetchRequest(command, fallbackUrl, fallbackMethod) {
  let capturedRequest = {
    url: fallbackUrl || '',
    method: fallbackMethod || 'GET',
    bodyText: '',
  };

  const inspectFetch = async (input, init) => {
    const req = deriveUrlAndMethod(input, init);
    capturedRequest = {
      url: req.url || capturedRequest.url,
      method: req.method || capturedRequest.method,
      bodyText: toRequestBodyText(init?.body),
    };

    return new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  };

  try {
    const runner = new Function(
      'fetch',
      `return (async () => {
        const result = await (${command});
        return result;
      })();`
    );

    await runner(inspectFetch);
  } catch {
    // Fall back to regex-derived values when dry-run inspection fails.
  }

  return capturedRequest;
}

function getCommandPreviewHtml(record) {
  if (!isDownloadPostRecord(record)) {
    return `<pre class="command-preview">${escapeHtml(record.command)}</pre>`;
  }

  const summary = extractDownloadBodySummary(record.command, record.requestBody);
  return `<div class="command-preview"><div>siteName: ${escapeHtml(summary.siteName)}</div><div>title: ${escapeHtml(summary.title)}</div><div>imgUrls count: ${summary.imgUrlsCount}</div></div>`;
}

function getMetaHtml(record) {
  if (isDownloadPostRecord(record)) {
    return `
      <div class="meta">
        <div>開始: ${formatDate(record.startedAt)}</div>
        <div>URL: ${record.url || '-'}</div>
        <div>Method: ${record.method || '-'}</div>
        <div>実行時間: ${record.durationMs ?? 0} ms</div>
        <div>message: ${escapeHtml(extractResponseMessage(record.responseBody, record.errorMessage))}</div>
      </div>
    `;
  }

  return `
    <div class="meta">
      <div>開始: ${formatDate(record.startedAt)}</div>
      <div>URL: ${record.url || '-'}</div>
      <div>Method: ${record.method || '-'}</div>
      <div>実行時間: ${record.durationMs ?? 0} ms</div>
      <div>message: ${escapeHtml(extractResponseMessage(record.responseBody, record.errorMessage))}</div>
    </div>
  `;
}

function sortRecords() {
  records.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function getStatusHtml(record) {
  if (record.status === 'queued') {
    return '<span class="status queued">実行前</span>';
  }

  if (record.status === 'running') {
    return '<span class="status running"><span class="spinner" aria-hidden="true"></span>実行中</span>';
  }

  if (record.status === 'success') {
    return `<span class="status success">成功 (HTTP ${record.httpStatus ?? '-'})</span>`;
  }

  return `<span class="status failure">失敗${record.httpStatus ? ` (HTTP ${record.httpStatus})` : ''}</span>`;
}

function renderStatusSummary() {
  if (!statusSummary) {
    return;
  }

  const counts = {
    total: records.length,
    queued: 0,
    running: 0,
    success: 0,
    failure: 0,
  };

  for (const record of records) {
    if (record.status === 'queued') {
      counts.queued += 1;
    } else if (record.status === 'running') {
      counts.running += 1;
    } else if (record.status === 'success') {
      counts.success += 1;
    } else {
      counts.failure += 1;
    }
  }

  statusSummary.innerHTML = `
    <span class="status-chip total">全体: ${counts.total}</span>
    <span class="status-chip queued">実行前: ${counts.queued}</span>
    <span class="status-chip running">実行中: ${counts.running}</span>
    <span class="status-chip success">成功: ${counts.success}</span>
    <span class="status-chip failure">失敗: ${counts.failure}</span>
  `;
}

function render() {
  sortRecords();
  renderStatusSummary();

  if (records.length === 0) {
    results.innerHTML = '<div class="empty">fetchコマンドを入力してEnterで実行してください。</div>';
    return;
  }

  results.innerHTML = '';

  for (const record of records) {
    const card = document.createElement('article');
    card.className = isDownloadPostRecord(record) ? 'card card--compact' : 'card';

    card.innerHTML = `
      <div class="card-top">
        ${getMetaHtml(record)}
        <div>${getStatusHtml(record)}</div>
      </div>
      ${getCommandPreviewHtml(record)}
      <div class="actions">
        <button type="button" data-action="detail" data-id="${record.id}">詳細表示</button>
        <button type="button" data-action="rerun" data-id="${record.id}">再実行</button>
        <button type="button" data-action="delete" data-id="${record.id}">削除</button>
      </div>
    `;

    results.appendChild(card);
  }
}

function escapeHtml(input) {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fillDetail(record) {
  detailStatus.textContent = JSON.stringify(
    {
      status: record.status,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      httpStatus: record.httpStatus ?? null,
      url: record.url || null,
      method: record.method || null,
    },
    null,
    2
  );
  detailCommand.textContent = record.command || '';
  detailHeaders.textContent = JSON.stringify(record.responseHeaders ?? {}, null, 2);
  detailBody.textContent = record.responseBody ?? '';
  detailError.textContent = record.errorMessage ?? '';
}

async function executeFetchCommand(command, existingRecord) {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return;
  }

  const startedAt = new Date().toISOString();
  const { url, method } = extractSummary(normalizedCommand);
  const inspectedRequest = await inspectFetchRequest(normalizedCommand, url, method);

  const record = existingRecord || {
    id: generateId(),
    startedAt,
    command: normalizedCommand,
    url: inspectedRequest.url || url,
    method: inspectedRequest.method || method,
    requestBody: inspectedRequest.bodyText || '',
    durationMs: 0,
    status: 'running',
    httpStatus: undefined,
    responseHeaders: undefined,
    responseBody: undefined,
    errorMessage: undefined,
  };

  if (!existingRecord) {
    records.push(record);
  } else {
    record.startedAt = startedAt;
    record.command = normalizedCommand;
    record.url = inspectedRequest.url || url;
    record.method = inspectedRequest.method || method;
    record.requestBody = inspectedRequest.bodyText || '';
    record.durationMs = 0;
    record.status = 'running';
    record.httpStatus = undefined;
    record.responseHeaders = undefined;
    record.responseBody = undefined;
    record.errorMessage = undefined;
  }

  enforceRecordLimit();
  render();
  await saveRecordsToDb();

  const startMs = performance.now();

  try {
    let capturedRequest = {
      url: record.url || '',
      method: record.method || 'GET',
      bodyText: record.requestBody || '',
    };

    const fetchProxy = async (input, init) => {
      const req = deriveUrlAndMethod(input, init);
      capturedRequest = {
        url: req.url,
        method: req.method,
        bodyText: toRequestBodyText(init?.body),
      };
      return fetch(input, init);
    };

    const runner = new Function(
      'fetch',
      `return (async () => {
        const result = await (${normalizedCommand});
        return result;
      })();`
    );

    const response = await runner(fetchProxy);

    if (!(response instanceof Response)) {
      throw new Error('fetch(...) の戻り値(Response)が取得できませんでした。');
    }

    const durationMs = Math.round(performance.now() - startMs);
    const responseBody = await response.text();
    const responseHeaders = toHeaderObject(response.headers);

    record.durationMs = durationMs;
  record.url = capturedRequest.url || record.url;
  record.method = capturedRequest.method || record.method;
  record.requestBody = capturedRequest.bodyText || '';
    record.httpStatus = response.status;
    record.responseHeaders = responseHeaders;
    record.responseBody = responseBody;

    if (response.ok) {
      record.status = 'success';
    } else {
      record.status = 'failure';
      record.errorMessage = `HTTP error: ${response.status} ${response.statusText}`;
    }
  } catch (error) {
    record.durationMs = Math.round(performance.now() - startMs);
    record.status = 'failure';
    record.errorMessage = error instanceof Error ? error.message : String(error);
  }

  render();
  await saveRecordsToDb();
}

commandInput.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter' || event.shiftKey) {
    return;
  }

  event.preventDefault();

  const command = commandInput.value;
  commandInput.value = '';

  if (!command.trim()) {
    return;
  }

  await executeFetchCommand(command);
});

results.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  const id = target.dataset.id;

  if (!action || !id) {
    return;
  }

  const record = records.find((item) => item.id === id);
  if (!record) {
    return;
  }

  if (action === 'detail') {
    fillDetail(record);
    detailDialog.showModal();
    return;
  }

  if (action === 'rerun') {
    await executeFetchCommand(record.command);
    return;
  }

  if (action === 'delete') {
    const queueIndex = clipboardMonitor.pendingCommands.findIndex((item) => item.recordId === id);
    if (queueIndex >= 0) {
      clipboardMonitor.pendingCommands.splice(queueIndex, 1);
    }

    const index = records.findIndex((item) => item.id === id);
    if (index >= 0) {
      records.splice(index, 1);
      render();
      await saveRecordsToDb();
    }
  }
});

closeDialog.addEventListener('click', () => {
  detailDialog.close();
});

clipboardMonitorToggle.addEventListener('click', async () => {
  await setClipboardMonitorEnabled(!clipboardMonitor.enabled);
});

queueProcessingToggle.addEventListener('click', () => {
  clipboardMonitor.autoProcessEnabled = !clipboardMonitor.autoProcessEnabled;
  renderQueueProcessingState();
  maybeStartQueueProcessing();
});

detailDialog.addEventListener('click', (event) => {
  const rect = detailDialog.getBoundingClientRect();
  const isOutside =
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom;

  if (isOutside) {
    detailDialog.close();
  }
});

const ACTIVE_REQUESTS_URL = 'http://localhost:8081/requests/active';

async function checkRunningRecordsOnStartup() {
  const runningRecords = records.filter((record) => record.status === 'running');
  if (runningRecords.length === 0) {
    return;
  }

  let activeTitles = new Set();

  try {
    const response = await fetch(ACTIVE_REQUESTS_URL);
    if (response.ok) {
      const data = await response.json();
      const activeRequests = Array.isArray(data.requests) ? data.requests : [];
      for (const req of activeRequests) {
        if (req.body && typeof req.body.title === 'string' && req.body.title) {
          activeTitles.add(req.body.title);
        }
      }
    }
  } catch {
    // Server unreachable: treat all running records as needing to be queued
  }

  let changed = false;

  for (const record of runningRecords) {
    let title = '';

    if (record.requestBody) {
      try {
        const parsed = JSON.parse(record.requestBody);
        if (parsed && typeof parsed.title === 'string') {
          title = parsed.title;
        }
      } catch {
        // requestBody is not JSON, fall through
      }
    }

    if (title && activeTitles.has(title)) {
      continue;
    }

    record.status = 'queued';
    changed = true;
  }

  if (changed) {
    await saveRecordsToDb();
  }
}

async function initializeApp() {
  await loadRecordsFromDb();
  await checkRunningRecordsOnStartup();
  rebuildQueueFromQueuedCards();
  enforceRecordLimit();
  render();
  renderClipboardMonitorState();
  renderQueueProcessingState();

  if (clipboardMonitor.pendingCommands.length > 0) {
    maybeStartQueueProcessing();
  }
}

void initializeApp();
