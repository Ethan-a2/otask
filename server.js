const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const VAULT = process.env.OBSIDIAN_VAULT || 'base';
const TASK_FILE = process.env.OBSIDIAN_TASK_FILE || 'Tasks.md';
const PUBLIC_DIR = path.join(__dirname, 'public');
const VALID_STATUSES = ['todo', 'in-progress', 'blocked', 'done'];
const VALID_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const VALID_REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

function runObsidian(commandArgs) {
  return new Promise((resolve, reject) => {
    const args = [`vault=${VAULT}`, ...commandArgs];
    const child = spawn('obsidian', args, { env: process.env });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(Object.assign(error, { stdout, stderr, args })));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), args });
        return;
      }
      reject(Object.assign(new Error(stderr.trim() || `Obsidian exited with code ${code}`), { stdout, stderr, code, args }));
    });
  });
}

function createId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function localDate(offset = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function decodeOutput(value) {
  return String(value || '').replaceAll('\\n', '\n').replaceAll('\\t', '\t');
}

function findJson(output) {
  const text = output.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const starts = [text.indexOf('['), text.indexOf('{')].filter((index) => index >= 0).sort((left, right) => left - right);
  for (const start of starts) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  return null;
}

function flattenRecords(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['tasks', 'items', 'data', 'results', 'rows']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

function valueFrom(record, keys) {
  for (const key of keys) {
    if (record && record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return '';
}

function splitDateTime(value) {
  const match = String(value || '').match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/u);
  return { date: match ? match[1] : '', time: match && match[2] ? match[2].padStart(5, '0') : '' };
}

function parseTaskText(rawText) {
  const raw = decodeOutput(rawText);
  const checkbox = raw.match(/^\s*[-*]\s*\[([^\]])\]/u);
  const commentMatch = raw.match(/<!--\s*taskbase\s+(\{.*?\})\s*-->/u);
  let metadata = {};
  if (commentMatch) {
    try { metadata = JSON.parse(commentMatch[1]); } catch {}
  }
  const dueMarker = raw.match(/📅\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/u);
  const deadlineMarker = raw.match(/⏳\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/u);
  const priorityMarker = raw.match(/🔴|🟠|🟡|🟢/u)?.[0] || '';
  const repeatMarker = raw.match(/🔁\s*(daily|weekdays|weekly|monthly)/iu)?.[1]?.toLowerCase() || '';
  const due = metadata.dueDate ? { date: String(metadata.dueDate), time: String(metadata.dueTime || '') } : splitDateTime(metadata.due || (dueMarker ? `${dueMarker[1]} ${dueMarker[2] || ''}` : ''));
  const deadline = metadata.deadlineDate ? { date: String(metadata.deadlineDate), time: String(metadata.deadlineTime || '') } : splitDateTime(metadata.deadline || (deadlineMarker ? `${deadlineMarker[1]} ${deadlineMarker[2] || ''}` : ''));
  const fallbackPriority = { '🔴': 'urgent', '🟠': 'high', '🟡': 'medium', '🟢': 'low' }[priorityMarker] || 'none';
  const tags = [...raw.matchAll(/(^|\s)#([^\s#]+)/gu)].map((match) => match[2]).filter((tag) => tag !== 'taskbase');
  const rawStatus = checkbox?.[1] || '';
  const status = metadata.status || rawStatus;
  const title = raw
    .replace(/^\s*[-*]\s*\[[^\]]\]\s*/u, '')
    .replace(/\s*<!--\s*taskbase\s+\{.*?\}\s*-->\s*/u, '')
    .replace(/\s+📅\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?/gu, '')
    .replace(/\s+⏳\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?/gu, '')
    .replace(/\s+🔁\s*(?:daily|weekdays|weekly|monthly)/giu, '')
    .replace(/\s+[🔴🟠🟡🟢]/gu, '')
    .replace(/\s+#([^\s#]+)/gu, '')
    .trim();
  return {
    title,
    dueDate: due.date,
    dueTime: due.time,
    deadlineDate: deadline.date,
    deadlineTime: deadline.time,
    repeat: metadata.repeat || repeatMarker || 'none',
    project: String(metadata.project || '').trim(),
    list: String(metadata.list || '').trim(),
    priority: metadata.priority || fallbackPriority,
    status,
    tags,
    note: String(metadata.note || '').trim()
  };
}

function normalizeStatus(value, completed = false) {
  if (completed) return 'done';
  const token = String(value || '').toLowerCase();
  if (['x', '✓', 'done', 'completed'].includes(token)) return 'done';
  if (['/', '>', 'in-progress', 'in progress', 'doing'].includes(token)) return 'in-progress';
  if (['-', '!', 'blocked'].includes(token)) return 'blocked';
  return 'todo';
}

function normalizeRecord(record, index) {
  const raw = typeof record === 'string' ? record : valueFrom(record, ['text', 'task', 'content', 'description', 'title', 'name', 'value']);
  const sourcePath = String(valueFrom(record, ['path', 'file', 'filePath', 'fileName']) || TASK_FILE);
  const line = Number(valueFrom(record, ['line', 'lineNumber', 'row', 'rowNumber'])) || index + 1;
  const parsed = parseTaskText(raw);
  const dueDate = String(valueFrom(record, ['dueDate', 'date', 'due']) || parsed.dueDate).slice(0, 10);
  const dueTime = String(valueFrom(record, ['dueTime', 'time', 'scheduledTime']) || parsed.dueTime).match(/\d{1,2}:\d{2}/)?.[0] || '';
  const deadline = splitDateTime(valueFrom(record, ['deadline', 'deadlineDate']) || `${parsed.deadlineDate} ${parsed.deadlineTime}`);
  const priorityValue = String(valueFrom(record, ['priority', 'importance']) || parsed.priority || 'none').toLowerCase();
  const tagsValue = valueFrom(record, ['tags', 'tag']);
  const tags = Array.isArray(tagsValue) ? tagsValue.map(String) : parsed.tags;
  const completed = record && typeof record === 'object' && (record.completed === true || record.done === true);
  const status = normalizeStatus(valueFrom(record, ['status', 'symbol', 'completion']) || parsed.status, completed);
  const title = String(valueFrom(record, ['title', 'name']) || parsed.title).trim();
  const task = {
    id: createId(`${sourcePath}:${line}`),
    title,
    dueDate,
    dueTime,
    deadlineDate: deadline.date,
    deadlineTime: deadline.time,
    repeat: VALID_REPEATS.includes(parsed.repeat) ? parsed.repeat : 'none',
    project: parsed.project || '未归档',
    list: parsed.list || tags[0] || '收件箱',
    tags,
    priority: VALID_PRIORITIES.includes(priorityValue) ? priorityValue : 'none',
    status,
    completed: status === 'done',
    note: parsed.note,
    path: sourcePath,
    line,
    source: 'obsidian'
  };
  if (!task.title || !task.dueDate) return null;
  return task;
}

function parseTextTasks(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(.*?)(?:\t|:)(\d+)\s+(.*)$/u);
    if (match) rows.push({ file: match[1].trim(), line: Number(match[2]), text: match[3] });
  }
  return rows;
}

function parseTasksOutput(output) {
  const payload = findJson(output);
  const records = payload ? flattenRecords(payload) : parseTextTasks(output);
  return records.map(normalizeRecord).filter(Boolean);
}

function taskStatusChar(status) {
  return { todo: ' ', 'in-progress': '/', blocked: '-', done: 'x' }[status] || ' ';
}

function taskLine(task) {
  const due = `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}`;
  const deadline = task.deadlineDate ? `${task.deadlineDate}${task.deadlineTime ? ` ${task.deadlineTime}` : ''}` : '';
  const priority = { urgent: ' 🔴', high: ' 🟠', medium: ' 🟡', low: ' 🟢' }[task.priority] || '';
  const repeat = task.repeat && task.repeat !== 'none' ? ` 🔁 ${task.repeat}` : '';
  const tags = [...new Set((task.tags || []).map((tag) => String(tag).replace(/^#/, '')).filter(Boolean))].map((tag) => `#${tag}`).join(' ');
  const metadata = JSON.stringify({ taskbase: 1, dueDate: task.dueDate, dueTime: task.dueTime || '', deadlineDate: task.deadlineDate || '', deadlineTime: task.deadlineTime || '', repeat: task.repeat || 'none', project: task.project || '未归档', list: task.list || '收件箱', priority: task.priority || 'none', status: task.status || 'todo', tags: task.tags || [], note: task.note || '' }).replaceAll('-->', '-- >');
  return `- [${taskStatusChar(task.status)}] ${task.title.trim()} 📅 ${due}${deadline ? ` ⏳ ${deadline}` : ''}${repeat}${priority}${tags ? ` ${tags}` : ''} <!-- taskbase ${metadata} -->`.trim();
}

function safeTaskInput(body) {
  const dueDate = String(body.dueDate || '').slice(0, 10);
  const dueTime = String(body.dueTime || '').match(/^\d{1,2}:\d{2}$/)?.[0] || '';
  const deadlineDate = String(body.deadlineDate || '').slice(0, 10);
  const deadlineTime = String(body.deadlineTime || '').match(/^\d{1,2}:\d{2}$/)?.[0] || '';
  if (!String(body.title || '').trim() || !dueDate) throw new Error('任务标题和日期不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('日期格式应为 YYYY-MM-DD');
  if (deadlineDate && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineDate)) throw new Error('截止日期格式应为 YYYY-MM-DD');
  const status = VALID_STATUSES.includes(body.status) ? body.status : body.completed ? 'done' : 'todo';
  return {
    title: String(body.title).trim(), dueDate, dueTime, deadlineDate, deadlineTime,
    repeat: VALID_REPEATS.includes(body.repeat) ? body.repeat : 'none',
    project: String(body.project || '未归档').trim() || '未归档',
    list: String(body.list || '收件箱').trim() || '收件箱',
    priority: VALID_PRIORITIES.includes(body.priority) ? body.priority : 'none',
    status, completed: status === 'done',
    tags: Array.isArray(body.tags) ? body.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 12) : [],
    note: String(body.note || '').trim()
  };
}

async function loadTasks() {
  try {
    const result = await runObsidian(['tasks', 'verbose', 'format=json']);
    return { tasks: parseTasksOutput(result.stdout), connected: true, fallback: false, vault: VAULT, taskFile: TASK_FILE };
  } catch (error) {
    return { tasks: demoTasks(), connected: false, fallback: true, vault: VAULT, taskFile: TASK_FILE, error: error.message };
  }
}

async function readTaskFile(filePath) {
  const result = await runObsidian(['read', `path=${filePath}`]);
  return result.stdout;
}

async function writeTaskFile(filePath, content) {
  await runObsidian(['create', `path=${filePath}`, `content=${content}`, 'overwrite']);
}

async function createTask(body) {
  const task = safeTaskInput(body);
  if (body.demo) return { ...task, id: createId(`demo:${Date.now()}`), source: 'demo', path: TASK_FILE, line: 1 };
  const content = taskLine(task);
  let fileExists = true;
  try { await readTaskFile(TASK_FILE); } catch { fileExists = false; }
  if (fileExists) await runObsidian(['append', `path=${TASK_FILE}`, `content=${content}`]);
  else await runObsidian(['create', `path=${TASK_FILE}`, `content=${content}`]);
  return { ...task, id: createId(`${TASK_FILE}:${Date.now()}`), source: 'obsidian', path: TASK_FILE, line: 0 };
}

async function updateTask(taskId, body) {
  const task = safeTaskInput(body);
  if (body.source === 'demo' || taskId.startsWith('demo-')) return { ...task, id: taskId, source: 'demo', path: TASK_FILE, line: Number(body.line) || 1 };
  const filePath = String(body.path || TASK_FILE);
  const lineNumber = Number(body.line);
  if (!lineNumber) throw new Error('缺少任务行号，无法更新');
  const content = await readTaskFile(filePath);
  const lines = content.split(/\r?\n/);
  if (!lines[lineNumber - 1]) throw new Error('找不到要更新的任务行');
  lines[lineNumber - 1] = taskLine(task);
  await writeTaskFile(filePath, lines.join('\n'));
  return { ...task, id: taskId, source: 'obsidian', path: filePath, line: lineNumber };
}

async function deleteTask(taskId, body) {
  if (body.source === 'demo' || taskId.startsWith('demo-')) return { deleted: true, source: 'demo' };
  const filePath = String(body.path || TASK_FILE);
  const lineNumber = Number(body.line);
  if (!lineNumber) throw new Error('缺少任务行号，无法删除');
  const content = await readTaskFile(filePath);
  const lines = content.split(/\r?\n/);
  if (!lines[lineNumber - 1]) throw new Error('找不到要删除的任务行');
  lines.splice(lineNumber - 1, 1);
  await writeTaskFile(filePath, lines.join('\n'));
  return { deleted: true, source: 'obsidian' };
}

function demoTasks() {
  const task = (id, title, offset, time, deadlineTime, project, priority, status, repeat, tags, note = '') => ({ id, title, dueDate: localDate(offset), dueTime: time, deadlineDate: localDate(offset), deadlineTime, project, list: project, priority, status, completed: status === 'done', repeat, tags, note, source: 'demo', path: TASK_FILE, line: 1 });
  return [
    task('demo-1', '整理本周产品反馈', 0, '09:30', '11:30', '产品升级', 'high', 'in-progress', 'none', ['反馈', '工作'], '把客服、销售和用户访谈里的高频问题归档。'),
    task('demo-2', '完成首页信息架构', 0, '13:00', '17:30', '产品升级', 'urgent', 'todo', 'none', ['设计', '工作']),
    task('demo-3', '午休散步 20 分钟', 0, '12:30', '13:00', '个人生活', 'low', 'done', 'daily', ['健康']),
    task('demo-4', '发布 v1.4.0 更新说明', 1, '10:00', '18:00', '产品升级', 'urgent', 'blocked', 'none', ['发布'], '等待研发确认最终版本号。'),
    task('demo-5', '预约周末羽毛球场', 2, '18:30', '20:00', '个人生活', 'none', 'todo', 'weekly', ['运动']),
    task('demo-6', '整理季度 OKR 复盘材料', 3, '09:00', '12:00', '团队协作', 'medium', 'todo', 'none', ['复盘', '工作']),
    task('demo-7', '提交差旅报销', -1, '16:00', '18:00', '团队协作', 'medium', 'done', 'monthly', ['行政']),
    task('demo-8', '清理桌面和下载目录', -1, '20:00', '21:00', '个人生活', 'none', 'done', 'none', ['整理'])
  ];
}

async function seedTasks() {
  const samples = [
    { title: '确认数据看板口径', dueDate: localDate(-1), dueTime: '16:00', deadlineDate: localDate(-1), deadlineTime: '18:00', project: '团队协作', list: '团队协作', priority: 'medium', status: 'done', repeat: 'none', tags: ['数据'], note: '已和数据团队完成口径确认。' },
    { title: '梳理下周迭代范围', dueDate: localDate(1), dueTime: '09:30', deadlineDate: localDate(1), deadlineTime: '12:00', project: '产品升级', list: '产品升级', priority: 'high', status: 'in-progress', repeat: 'none', tags: ['计划', '工作'], note: '和研发、设计一起确认范围。' },
    { title: '整理用户访谈录音', dueDate: localDate(2), dueTime: '14:00', deadlineDate: localDate(2), deadlineTime: '17:00', project: '研究项目', list: '研究项目', priority: 'medium', status: 'todo', repeat: 'none', tags: ['研究'] },
    { title: '晚间拉伸 15 分钟', dueDate: localDate(3), dueTime: '21:00', deadlineDate: localDate(3), deadlineTime: '22:00', project: '个人生活', list: '个人生活', priority: 'low', status: 'todo', repeat: 'daily', tags: ['健康'] },
    { title: '发送周报', dueDate: localDate(0), dueTime: '17:30', deadlineDate: localDate(0), deadlineTime: '18:00', project: '团队协作', list: '团队协作', priority: 'urgent', status: 'blocked', repeat: 'weekly', tags: ['沟通'], note: '等待数据团队补充本周数据。' }
  ];
  const current = await loadTasks();
  const existingTitles = new Set(current.tasks.map((item) => item.title));
  const created = [];
  for (const sample of samples) {
    if (!existingTitles.has(sample.title)) created.push(await createTask(sample));
  }
  return { created: created.length, samples };
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('请求体过大'));
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('请求体不是有效 JSON')); }
    });
    request.on('error', reject);
  });
}

function contentType(filePath) {
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' }[path.extname(filePath)] || 'application/octet-stream';
}

async function handleApi(request, response, url) {
  try {
    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      jsonResponse(response, 200, await loadTasks());
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      try {
        const result = await runObsidian(['tasks', 'total']);
        jsonResponse(response, 200, { connected: true, vault: VAULT, taskFile: TASK_FILE, total: Number(result.stdout) || 0 });
      } catch (error) {
        jsonResponse(response, 200, { connected: false, vault: VAULT, taskFile: TASK_FILE, error: error.message });
      }
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      jsonResponse(response, 201, { task: await createTask(await readBody(request)) });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/seed') {
      jsonResponse(response, 201, await seedTasks());
      return true;
    }
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/u);
    if (match && request.method === 'PATCH') {
      jsonResponse(response, 200, { task: await updateTask(decodeURIComponent(match[1]), await readBody(request)) });
      return true;
    }
    if (match && request.method === 'DELETE') {
      jsonResponse(response, 200, await deleteTask(decodeURIComponent(match[1]), await readBody(request)));
      return true;
    }
    return false;
  } catch (error) {
    jsonResponse(response, 400, { error: error.message || '操作失败' });
    return true;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(request, response, url);
    if (handled) return;
  }
  const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-cache' });
    response.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Taskbase is running at http://localhost:${PORT}`);
  console.log(`Obsidian vault: ${VAULT} · task file: ${TASK_FILE}`);
});
