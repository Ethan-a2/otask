const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT || 3000);
const VAULT = process.env.OBSIDIAN_VAULT || 'base';
const TASK_FILE = process.env.OBSIDIAN_TASK_FILE || 'Tasks.md';
const INCLUDE_UNDATED = process.argv.includes('--include-undated') || /^(1|true|yes)$/iu.test(process.env.OBSIDIAN_INCLUDE_UNDATED || '');
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
  const metadataDue = metadata.dueDate ? { date: String(metadata.dueDate), time: String(metadata.dueTime || '') } : splitDateTime(metadata.due);
  const metadataDeadline = metadata.deadlineDate ? { date: String(metadata.deadlineDate), time: String(metadata.deadlineTime || '') } : splitDateTime(metadata.deadline);
  const due = dueMarker ? { date: dueMarker[1], time: dueMarker[2]?.padStart(5, '0') || metadataDue.time } : metadataDue;
  const deadline = deadlineMarker ? { date: deadlineMarker[1], time: deadlineMarker[2]?.padStart(5, '0') || metadataDeadline.time } : metadataDeadline;
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
  const parsedStatus = String(parsed.status || '').trim();
  const recordStatus = valueFrom(record, ['status', 'symbol', 'completion']);
  const status = normalizeStatus(parsedStatus || recordStatus, completed);
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
  if (!task.title) return null;
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

function tasksForDisplay(tasks) {
  return INCLUDE_UNDATED ? tasks : tasks.filter((task) => task.dueDate);
}

function taskStatusChar(status) {
  return { todo: ' ', 'in-progress': '/', blocked: '-', done: 'x' }[status] || ' ';
}

function taskLine(task) {
  const due = task.dueDate ? ` 📅 ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}` : '';
  const deadline = task.deadlineDate ? `${task.deadlineDate}${task.deadlineTime ? ` ${task.deadlineTime}` : ''}` : '';
  const priority = { urgent: ' 🔴', high: ' 🟠', medium: ' 🟡', low: ' 🟢' }[task.priority] || '';
  const repeat = task.repeat && task.repeat !== 'none' ? ` 🔁 ${task.repeat}` : '';
  const tags = [...new Set((task.tags || []).map((tag) => String(tag).replace(/^#/, '')).filter(Boolean))].map((tag) => `#${tag}`).join(' ');
  const metadata = JSON.stringify({ taskbase: 1, dueDate: task.dueDate, dueTime: task.dueTime || '', deadlineDate: task.deadlineDate || '', deadlineTime: task.deadlineTime || '', repeat: task.repeat || 'none', project: task.project || '未归档', list: task.list || '收件箱', priority: task.priority || 'none', status: task.status || 'todo', tags: task.tags || [], note: task.note || '' }).replaceAll('-->', '-- >');
  return `- [${taskStatusChar(task.status)}] ${task.title.trim()}${due}${deadline ? ` ⏳ ${deadline}` : ''}${repeat}${priority}${tags ? ` ${tags}` : ''} <!-- taskbase ${metadata} -->`.trim();
}

function safeTaskInput(body) {
  const dueDate = String(body.dueDate || '').slice(0, 10);
  const dueTime = String(body.dueTime || '').match(/^\d{1,2}:\d{2}$/)?.[0] || '';
  const deadlineDate = String(body.deadlineDate || '').slice(0, 10);
  const deadlineTime = String(body.deadlineTime || '').match(/^\d{1,2}:\d{2}$/)?.[0] || '';
  if (!String(body.title || '').trim()) throw new Error('任务标题不能为空');
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('日期格式应为 YYYY-MM-DD');
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
    return { tasks: tasksForDisplay(parseTasksOutput(result.stdout)), connected: true, fallback: false, vault: VAULT, taskFile: TASK_FILE, includeUndated: INCLUDE_UNDATED };
  } catch (error) {
    return { tasks: demoTasks(), connected: false, fallback: true, vault: VAULT, taskFile: TASK_FILE, includeUndated: INCLUDE_UNDATED, error: error.message };
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
  const task = (id, title, offset, time, deadlineTime, project, priority, status, repeat, tags, note = '', list = project) => ({ id, title, dueDate: localDate(offset), dueTime: time, deadlineDate: localDate(offset), deadlineTime, project, list, priority, status, completed: status === 'done', repeat, tags, note, source: 'demo', path: TASK_FILE, line: 1 });
  return [
    task('demo-1', '整理本周产品反馈', 0, '09:30', '11:30', '产品升级', 'high', 'in-progress', 'none', ['反馈', '工作'], '把客服、销售和用户访谈里的高频问题归档。', '收件箱'),
    task('demo-2', '完成首页信息架构', 0, '13:00', '17:30', '产品升级', 'urgent', 'todo', 'none', ['设计', '工作'], '', '收件箱'),
    task('demo-3', '午休散步 20 分钟', 0, '12:30', '13:00', '个人生活', 'low', 'done', 'daily', ['健康']),
    task('demo-4', '发布 v1.4.0 更新说明', 1, '10:00', '18:00', '产品升级', 'urgent', 'blocked', 'none', ['发布'], '等待研发确认最终版本号。'),
    task('demo-5', '预约周末羽毛球场', 2, '18:30', '20:00', '个人生活', 'none', 'todo', 'weekly', ['运动']),
    task('demo-6', '整理季度 OKR 复盘材料', 3, '09:00', '12:00', '团队协作', 'medium', 'todo', 'none', ['复盘', '工作']),
    task('demo-7', '提交差旅报销', -1, '16:00', '18:00', '团队协作', 'medium', 'done', 'monthly', ['行政']),
    task('demo-8', '清理桌面和下载目录', -1, '20:00', '21:00', '个人生活', 'none', 'done', 'none', ['整理'])
  ];
}

async function seedTasks() {
  const sample = (title, offset, dueTime, project, list, priority = 'none', options = {}) => {
    const deadlineOffset = Number.isInteger(options.deadlineOffset) ? options.deadlineOffset : offset;
    return {
      title,
      dueDate: localDate(offset),
      dueTime,
      deadlineDate: localDate(deadlineOffset),
      deadlineTime: options.deadlineTime || dueTime,
      project,
      list,
      priority,
      status: options.status || 'todo',
      repeat: options.repeat || 'none',
      tags: options.tags || [],
      note: options.note || ''
    };
  };
  const product = '📈 产品';
  const design = '🎨 设计';
  const development = '🧑‍💻 开发';
  const operations = '✨ 运营';
  const testing = '✓ 测试';
  const work = '努力工作';
  const life = '用心生活';
  const growth = '个人提升';
  const memo = '个人备忘';
  const shoppingNote = '子任务：鸡蛋、牛奶、面包、纸巾、沐浴露。';
  const samples = [
    sample('项目启动', 0, '09:00', product, work, 'high', { deadlineOffset: 1, deadlineTime: '12:00', tags: ['项目'] }),
    sample('产品文档交付', 1, '09:00', product, work, 'high', { deadlineOffset: 2, deadlineTime: '18:00', tags: ['产品'] }),
    sample('跟进用户反馈', 1, '13:00', product, work, 'medium', { deadlineOffset: 2, deadlineTime: '17:00', tags: ['用户'] }),
    sample('数据分析', 2, '10:00', product, work, 'medium', { tags: ['数据'] }),
    sample('产品评审', 1, '15:00', product, work, 'urgent', { tags: ['评审'] }),
    sample('设计调研', 0, '09:00', design, growth, 'medium', { deadlineOffset: 1, deadlineTime: '18:00', tags: ['设计'] }),
    sample('UI设计', 1, '10:00', design, growth, 'high', { deadlineOffset: 2, deadlineTime: '18:00', tags: ['设计'] }),
    sample('设计评审', 3, '14:00', design, growth, 'high', { tags: ['评审'] }),
    sample('技术调研', 1, '09:00', development, work, 'medium', { deadlineOffset: 2, deadlineTime: '18:00', tags: ['技术'] }),
    sample('页面开发', 3, '10:00', development, work, 'high', { deadlineOffset: 5, deadlineTime: '18:00', tags: ['开发'] }),
    sample('制定运营策略', 2, '09:00', operations, work, 'high', { deadlineOffset: 3, deadlineTime: '18:00', tags: ['运营'] }),
    sample('活动内容规划', 3, '13:00', operations, work, 'medium', { deadlineOffset: 4, deadlineTime: '18:00', tags: ['运营'] }),
    sample('初稿', 4, '15:00', operations, work, 'low', { tags: ['内容'] }),
    sample('测试计划', 3, '09:00', testing, work, 'high', { deadlineOffset: 4, deadlineTime: '18:00', tags: ['测试'] }),
    sample('测试用例设计', 4, '10:00', testing, work, 'medium', { deadlineOffset: 5, deadlineTime: '18:00', tags: ['测试'] }),

    sample('实习生面试', 0, '10:00', product, work, 'urgent', { tags: ['招聘'] }),
    sample('跟进外部合作', 0, '13:00', product, work, 'high', { tags: ['合作'] }),
    sample('出席会议', 1, '10:00', product, work, 'medium', { tags: ['会议'] }),
    sample('发言稿准备', 2, '09:00', operations, work, 'medium', { tags: ['沟通'] }),
    sample('宣传物料', 3, '10:00', operations, work, 'low', { tags: ['内容'] }),
    sample('组织项目会议', 4, '13:00', product, work, 'high', { tags: ['会议'] }),
    sample('资源盘点', 4, '15:00', development, work, 'none', { tags: ['整理'] }),
    sample('晨跑', 0, '07:00', design, life, 'none', { repeat: 'daily', tags: ['健康'] }),
    sample('拿快递', 1, '18:00', operations, life, 'none', { tags: ['生活'] }),
    sample('买狗粮', 2, '18:30', operations, life, 'none', { tags: ['生活'] }),
    sample('周末和家人共进晚餐', 4, '19:00', operations, life, 'high', { tags: ['家庭'] }),
    sample('数据分析大会', 5, '09:00', product, growth, 'urgent', { tags: ['学习'] }),
    sample('内部培训', 6, '14:00', development, growth, 'high', { tags: ['培训'] }),
    sample('烘焙课', 7, '10:00', design, growth, 'none', { tags: ['兴趣'] }),
    sample('阅读专业书籍', 8, '20:00', design, growth, 'none', { tags: ['学习'] }),
    sample('部门培训', 9, '14:00', development, growth, 'medium', { tags: ['培训'] }),
    sample('瑜伽课', 10, '18:00', design, growth, 'none', { tags: ['健康'] }),
    sample('订机票', 11, '21:00', operations, memo, 'low', { tags: ['出行'] }),

    sample('去超市买东西', 0, '09:00', operations, life, 'medium', { note: shoppingNote, tags: ['购物'] }),
    sample('制定营销策略', 1, '10:00', operations, work, 'high', { tags: ['营销'] }),
    sample('ins 初稿', 2, '11:00', operations, work, 'none', { tags: ['内容'] }),
    sample('看望老人', 3, '15:00', operations, life, 'none', { tags: ['家庭'] }),
    sample('准备出行计划', 4, '08:00', operations, memo, 'high', { tags: ['出行'] }),
    sample('确认周末天气', 4, '09:00', operations, memo, 'none', { tags: ['生活'] }),
    sample('和李雷沟通工作', 5, '09:00', product, work, 'high', { tags: ['沟通'] }),
    sample('公司运动会', 6, '10:00', operations, life, 'none', { tags: ['运动'] }),
    sample('同学聚会', 6, '18:00', operations, life, 'none', { tags: ['社交'] }),
    sample('修剪花园植物', -1, '08:00', operations, life, 'none', { tags: ['家务'] }),
    sample('和妈妈逛街', -1, '13:00', operations, life, 'none', { tags: ['家庭'] }),
    sample('月度账单', -2, '09:00', product, memo, 'high', { tags: ['财务'] }),
    sample('制定预算', -2, '14:00', product, memo, 'high', { tags: ['财务'] }),
    sample('写日报', -2, '17:00', product, work, 'medium', { tags: ['工作'] }),
    sample('学习基础编程', -2, '20:00', development, growth, 'medium', { tags: ['学习'] }),
    sample('参加社区活动', -1, '16:00', operations, life, 'none', { tags: ['社交'] }),
    sample('用户反馈跟进', 0, '16:00', product, work, 'high', { tags: ['用户'] }),
    sample('版本更新', 2, '18:00', development, work, 'high', { tags: ['发布'] }),
    sample('社群运营', 5, '11:00', operations, work, 'medium', { tags: ['运营'] }),
    sample('主持项目会议', 7, '14:00', product, work, 'high', { tags: ['会议'] }),

    sample('工作汇报', 0, '09:00', product, work, 'urgent', { tags: ['工作'] }),
    sample('参加项目会议', 1, '10:00', product, work, 'urgent', { tags: ['会议'] }),
    sample('完成客户方案', 2, '16:00', product, work, 'urgent', { tags: ['客户'] }),
    sample('制定工作计划', 1, '08:00', product, work, 'high', { tags: ['计划'] }),
    sample('参加每周例会', 3, '10:00', product, work, 'high', { repeat: 'weekly', tags: ['会议'] }),
    sample('回复客户电话', 0, '13:00', product, work, 'medium', { tags: ['客户'] }),
    sample('处理工作邮件', 1, '14:00', product, work, 'medium', { tags: ['沟通'] }),
    sample('预定机票', 2, '22:00', operations, memo, 'low', { tags: ['出行'] }),
    sample('玩游戏', 1, '22:00', operations, life, 'none', { tags: ['娱乐'] }),
    sample('整理办公室桌面', 3, '20:00', operations, memo, 'none', { tags: ['整理'] }),
    sample('鸡蛋', 0, '09:30', operations, life, 'none', { tags: ['购物'] }),
    sample('牛奶', 0, '09:30', operations, life, 'none', { tags: ['购物'] }),
    sample('面包', 0, '09:30', operations, life, 'none', { tags: ['购物'] }),
    sample('纸巾', 0, '09:30', operations, life, 'none', { tags: ['购物'] }),
    sample('沐浴露', 0, '09:30', operations, life, 'none', { tags: ['购物'] })
  ];
  const current = await loadTasks();
  const existingTitles = new Set(current.tasks.map((item) => item.title));
  const created = [];
  for (const sampleTask of samples) {
    if (!existingTitles.has(sampleTask.title)) {
      created.push(await createTask(sampleTask));
      existingTitles.add(sampleTask.title);
    }
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
        const result = await runObsidian(['tasks', 'verbose', 'format=json']);
        const allTasks = parseTasksOutput(result.stdout);
        jsonResponse(response, 200, { connected: true, vault: VAULT, taskFile: TASK_FILE, total: tasksForDisplay(allTasks).length, vaultTotal: allTasks.length, includeUndated: INCLUDE_UNDATED });
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
  console.log(`Undated tasks: ${INCLUDE_UNDATED ? 'included' : 'hidden (use --include-undated to show)'}`);
});
