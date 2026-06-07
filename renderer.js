const records = [];

const commandInput = document.getElementById('commandInput');
const results = document.getElementById('results');
const detailDialog = document.getElementById('detailDialog');
const closeDialog = document.getElementById('closeDialog');

const detailStatus = document.getElementById('detailStatus');
const detailCommand = document.getElementById('detailCommand');
const detailHeaders = document.getElementById('detailHeaders');
const detailBody = document.getElementById('detailBody');
const detailError = document.getElementById('detailError');

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

function sortRecords() {
  records.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function getStatusHtml(record) {
  if (record.status === 'running') {
    return '<span class="status running"><span class="spinner" aria-hidden="true"></span>実行中</span>';
  }

  if (record.status === 'success') {
    return `<span class="status success">成功 (HTTP ${record.httpStatus ?? '-'})</span>`;
  }

  return `<span class="status failure">失敗${record.httpStatus ? ` (HTTP ${record.httpStatus})` : ''}</span>`;
}

function render() {
  sortRecords();

  if (records.length === 0) {
    results.innerHTML = '<div class="empty">fetchコマンドを入力してEnterで実行してください。</div>';
    return;
  }

  results.innerHTML = '';

  for (const record of records) {
    const card = document.createElement('article');
    card.className = 'card';

    card.innerHTML = `
      <div class="card-top">
        <div class="meta">
          <div>開始: ${formatDate(record.startedAt)}</div>
          <div>URL: ${record.url || '-'}</div>
          <div>Method: ${record.method || '-'}</div>
          <div>実行時間: ${record.durationMs ?? 0} ms</div>
          <div>message: ${escapeHtml(extractResponseMessage(record.responseBody, record.errorMessage))}</div>
        </div>
        <div>${getStatusHtml(record)}</div>
      </div>
      <pre class="command-preview">${escapeHtml(record.command)}</pre>
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

async function executeFetchCommand(command) {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand) {
    return;
  }

  const startedAt = new Date().toISOString();
  const { url, method } = extractSummary(normalizedCommand);

  const record = {
    id: generateId(),
    startedAt,
    command: normalizedCommand,
    url,
    method,
    durationMs: 0,
    status: 'running',
    httpStatus: undefined,
    responseHeaders: undefined,
    responseBody: undefined,
    errorMessage: undefined,
  };

  records.push(record);
  render();

  const startMs = performance.now();

  try {
    const runner = new Function(
      'fetch',
      `return (async () => {
        const result = await (${normalizedCommand});
        return result;
      })();`
    );

    const response = await runner(fetch);

    if (!(response instanceof Response)) {
      throw new Error('fetch(...) の戻り値(Response)が取得できませんでした。');
    }

    const durationMs = Math.round(performance.now() - startMs);
    const responseBody = await response.text();
    const responseHeaders = toHeaderObject(response.headers);

    record.durationMs = durationMs;
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
    const index = records.findIndex((item) => item.id === id);
    if (index >= 0) {
      records.splice(index, 1);
      render();
    }
  }
});

closeDialog.addEventListener('click', () => {
  detailDialog.close();
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

render();
