const state = {
  tasks: [],
  connected: false,
  fallback: false,
  vault: 'base',
  taskFile: 'Tasks.md',
  view: 'overview',
  layout: 'list',
  filter: 'all',
  specialFilter: 'all',
  dateFilter: 'all',
  query: '',
  selectedId: null,
  sortAscending: true,
  customProjects: [],
  customLists: []
};

const statusInfo = {
  todo: { label: '待处理', short: '待处理' },
  'in-progress': { label: '进行中', short: '进行中' },
  blocked: { label: '阻塞', short: '阻塞' },
  done: { label: '已完成', short: '完成' }
};

const priorityInfo = { urgent: '紧急', high: '高', medium: '中', low: '低', none: '' };
const repeatInfo = { none: '', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' };
const projectColors = ['#8a76e5', '#ed956d', '#60ad89', '#dfad4f', '#7b9fd6', '#c780ad', '#7fa8a4'];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return dateKey(date);
}

function formatDate(value, style = 'short') {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  if (style === 'group') return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
}

function dayLabel(value) {
  if (value === dateKey()) return '今天';
  if (value === shiftDate(1)) return '明天';
  if (value === shiftDate(-1)) return '昨天';
  return formatDate(value, 'group');
}

function todayLabel() {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function showToast(message, type = '') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.className = 'toast'; }, 2600);
}

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function setConnection(connected, fallback) {
  state.connected = Boolean(connected);
  state.fallback = Boolean(fallback);
  const card = $('#connection-card');
  card.classList.toggle('connected', state.connected && !state.fallback);
  card.classList.toggle('offline', !state.connected);
  $('#connection-label').textContent = state.fallback ? '演示模式' : state.connected ? '已连接 Obsidian' : 'Obsidian 未连接';
  $('#connection-meta').textContent = state.fallback ? '可先体验，连接后自动同步' : `vault=${state.vault} · ${state.taskFile}`;
  $('#seed-button').textContent = state.connected ? '写入真实示例任务 →' : '需要 Obsidian 才能写入 →';
  $('#sync-pill').classList.toggle('offline', !state.connected || state.fallback);
  $('#sync-pill').innerHTML = `<span class="sync-dot"></span>${state.fallback ? '演示数据' : state.connected ? '已同步' : '未连接'}`;
}

async function loadTasks() {
  try {
    const data = await request('/api/tasks');
    state.tasks = data.tasks || [];
    state.vault = data.vault || state.vault;
    state.taskFile = data.taskFile || state.taskFile;
    setConnection(data.connected, data.fallback);
  } catch (error) {
    state.tasks = fallbackTasks();
    setConnection(false, true);
    showToast(error.message, 'error');
  }
  render();
}

function fallbackTasks() {
  const task = (id, title, offset, time, project, priority, status, repeat, deadlineTime, tags, note = '') => ({ id, title, dueDate: shiftDate(offset), dueTime: time, deadlineDate: shiftDate(offset), deadlineTime, project, list: project, priority, status, completed: status === 'done', repeat, tags, note, source: 'demo', path: state.taskFile, line: 1 });
  return [
    task('demo-1', '整理本周产品反馈', 0, '09:30', '产品升级', 'high', 'in-progress', 'none', '11:30', ['反馈', '工作']),
    task('demo-2', '完成首页信息架构', 0, '13:00', '产品升级', 'urgent', 'todo', 'none', '17:30', ['设计', '工作']),
    task('demo-3', '午休散步 20 分钟', 0, '12:30', '个人生活', 'low', 'done', 'daily', '13:00', ['健康']),
    task('demo-4', '发布 v1.4.0 更新说明', 1, '10:00', '产品升级', 'urgent', 'blocked', 'none', '18:00', ['发布']),
    task('demo-5', '预约周末羽毛球场', 2, '18:30', '个人生活', 'none', 'todo', 'weekly', '20:00', ['运动']),
    task('demo-6', '整理季度 OKR 复盘材料', 3, '09:00', '团队协作', 'medium', 'todo', 'none', '12:00', ['复盘', '工作']),
    task('demo-7', '提交差旅报销', -1, '16:00', '团队协作', 'medium', 'done', 'monthly', '18:00', ['行政'])
  ];
}

function allProjects() {
  return [...new Set(['未归档', ...state.tasks.map((task) => task.project).filter(Boolean), ...state.customProjects])];
}

function allLists() {
  return [...new Set(['收件箱', ...state.tasks.map((task) => task.list).filter(Boolean), ...state.customLists])];
}

function projectView() {
  return state.view.startsWith('project|') ? state.view.slice(8) : '';
}

function currentViewCopy() {
  const project = projectView();
  if (project) return { title: project, heading: `${project} 项目`, subtitle: '围绕同一个目标，推进每一个下一步。' };
  const copies = {
    overview: { title: '总览', heading: '今天的节奏', subtitle: '先看全局，再决定下一步。' },
    inbox: { title: '收件箱', heading: '收件箱', subtitle: '还没归档的任务，都先放在这里。' },
    today: { title: '今天', heading: '今天要完成什么', subtitle: '让重要的事情在截止之前完成。' },
    upcoming: { title: '即将到来', heading: '即将到来', subtitle: '提前看见接下来几天的节奏。' },
    completed: { title: '已完成', heading: '已完成', subtitle: '回看已经完成的每一件小事。' }
  };
  return copies[state.view] || copies.overview;
}

function isOverdue(task) {
  const deadline = task.deadlineDate || task.dueDate;
  if (!deadline || task.status === 'done') return false;
  if (deadline < dateKey()) return true;
  if (deadline === dateKey() && task.deadlineTime) {
    const now = new Date();
    const [hour, minute] = task.deadlineTime.split(':').map(Number);
    return now.getHours() * 60 + now.getMinutes() > hour * 60 + minute;
  }
  return false;
}

function visibleTasks() {
  const today = dateKey();
  let tasks = [...state.tasks];
  const project = projectView();
  if (project) tasks = tasks.filter((task) => task.project === project);
  if (state.view === 'inbox') tasks = tasks.filter((task) => task.list === '收件箱' || task.project === '未归档');
  if (state.view === 'today') tasks = tasks.filter((task) => task.dueDate === today);
  if (state.view === 'upcoming') tasks = tasks.filter((task) => task.dueDate >= today && task.status !== 'done');
  if (state.view === 'completed') tasks = tasks.filter((task) => task.status === 'done');
  if (state.filter !== 'all') tasks = tasks.filter((task) => task.status === state.filter);
  if (state.specialFilter === 'priority') tasks = tasks.filter((task) => ['urgent', 'high'].includes(task.priority));
  if (state.specialFilter === 'overdue') tasks = tasks.filter(isOverdue);
  if (state.specialFilter === 'recurring') tasks = tasks.filter((task) => task.repeat !== 'none');
  if (state.dateFilter === 'today') tasks = tasks.filter((task) => task.dueDate === today);
  if (state.dateFilter === 'next7') tasks = tasks.filter((task) => task.dueDate >= today && task.dueDate <= shiftDate(6));
  if (state.dateFilter === 'overdue') tasks = tasks.filter(isOverdue);
  if (state.query) {
    const query = state.query.toLowerCase();
    tasks = tasks.filter((task) => `${task.title} ${task.note} ${task.project} ${task.list} ${(task.tags || []).join(' ')}`.toLowerCase().includes(query));
  }
  tasks.sort((left, right) => {
    const leftKey = `${left.dueDate} ${left.dueTime || '23:59'}`;
    const rightKey = `${right.dueDate} ${right.dueTime || '23:59'}`;
    return state.sortAscending ? leftKey.localeCompare(rightKey) : rightKey.localeCompare(leftKey);
  });
  return tasks;
}

function updateSidebar() {
  const active = state.tasks.filter((task) => task.status !== 'done');
  const today = state.tasks.filter((task) => task.dueDate === dateKey());
  $('#priority-count').textContent = active.filter((task) => ['urgent', 'high'].includes(task.priority)).length;
  $('#overdue-count').textContent = active.filter(isOverdue).length;
  $('#recurring-count').textContent = active.filter((task) => task.repeat !== 'none').length;
  $('[data-count="inbox"]').textContent = active.filter((task) => task.list === '收件箱' || task.project === '未归档').length;
  $('[data-count="today"]').textContent = today.filter((task) => task.status !== 'done').length;
  $('[data-count="upcoming"]').textContent = active.filter((task) => task.dueDate >= dateKey()).length;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === state.view));
  $$('.quick-filter').forEach((item) => item.classList.toggle('active', item.dataset.quickFilter === state.specialFilter));
  const nav = $('#project-nav');
  nav.innerHTML = allProjects().map((project, index) => {
    const count = active.filter((task) => task.project === project).length;
    return `<button class="project-button ${projectView() === project ? 'active' : ''}" data-project-view="${escapeHtml(project)}"><span class="project-color" style="background:${projectColors[index % projectColors.length]}"></span><span>${escapeHtml(project)}</span><span class="list-count">${count}</span></button>`;
  }).join('');
  nav.querySelectorAll('[data-project-view]').forEach((button) => button.addEventListener('click', () => { state.view = `project|${button.dataset.projectView}`; state.filter = 'all'; state.specialFilter = 'all'; state.dateFilter = 'all'; render(); }));
}

function updateSelect(select, values, selected) {
  select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  select.value = values.includes(selected) ? selected : values[0];
}

function renderHeader() {
  const copy = currentViewCopy();
  $('#view-title').textContent = copy.title;
  $('#page-heading').textContent = copy.heading;
  $('#page-subheading').textContent = copy.subtitle;
  $('#today-label').textContent = todayLabel();
  $('#task-section-title').textContent = state.view === 'overview' ? '全部任务' : copy.title;
  $('#date-filter-button').innerHTML = `${state.dateFilter === 'today' ? '⌗ 今天' : state.dateFilter === 'next7' ? '⌗ 未来 7 天' : state.dateFilter === 'overdue' ? '⌗ 已逾期' : '⌗ 日期'} <span>⌄</span>`;
  $('#sort-button').textContent = state.sortAscending ? '↕ 按时间' : '↕ 倒序排列';
  $$('.filter-chip').forEach((button) => button.classList.toggle('active', button.dataset.filter === state.filter));
  $$('.view-tab').forEach((button) => button.classList.toggle('active', button.dataset.layout === state.layout));
}

function renderMetrics() {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.status === 'done').length;
  const todayTasks = state.tasks.filter((task) => task.dueDate === dateKey());
  const todayDone = todayTasks.filter((task) => task.status === 'done').length;
  const upcomingDeadlines = state.tasks.filter((task) => task.deadlineDate && task.deadlineDate >= dateKey() && task.deadlineDate <= shiftDate(7) && task.status !== 'done');
  const overdue = state.tasks.filter(isOverdue).length;
  const completion = total ? Math.round((done / total) * 100) : 0;
  $('#metric-total').textContent = total;
  $('#metric-today').innerHTML = `${todayDone}<span class="metric-denominator"> / ${todayTasks.length}</span>`;
  $('#metric-today-copy').textContent = todayTasks.length ? `${Math.round((todayDone / todayTasks.length) * 100)}% 今日完成` : '暂无今日安排';
  $('#metric-deadline').textContent = upcomingDeadlines.length;
  $('#metric-deadline-copy').textContent = overdue ? `${overdue} 个已逾期` : '未来 7 天';
  $('#metric-completion').textContent = `${completion}%`;
  $('#metric-completion-copy').textContent = completion >= 70 ? '节奏很好' : completion >= 40 ? '继续推进' : '从最重要的开始';
}

function renderProgress() {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.status === 'done').length;
  const actual = total ? Math.round((done / total) * 100) : 0;
  const dueByToday = state.tasks.filter((task) => task.dueDate <= dateKey()).length;
  const expected = total ? Math.round((dueByToday / total) * 100) : 0;
  const gap = actual - expected;
  const trend = $('#trend-chip');
  trend.className = `trend-chip ${gap < -12 ? 'behind' : gap > 8 ? 'ahead' : ''}`;
  trend.textContent = gap < -12 ? '需要加速' : gap > 8 ? '领先计划' : '稳定推进';
  $('#donut-value').textContent = `${actual}%`;
  $('#progress-donut').style.background = `conic-gradient(var(--purple) ${actual * 3.6}deg, #eeeef5 0deg)`;
  $('#big-progress').textContent = `${done} / ${total}`;
  $('#expected-value').textContent = `${expected}%`;
  $('#gap-value').textContent = `${gap > 0 ? '+' : ''}${gap}%`;
  $('#progress-value').style.width = `${actual}%`;
  $('#expected-marker').style.left = `${Math.min(expected, 99)}%`;
  $('#progress-tip').textContent = gap < 0 ? `比预期落后 ${Math.abs(gap)}%` : gap > 0 ? `比预期领先 ${gap}%` : '刚好跟上计划';
}

function renderProjectProgress() {
  const projects = allProjects().filter((project) => state.tasks.some((task) => task.project === project));
  const element = $('#project-progress-list');
  if (!projects.length) {
    element.innerHTML = '<div class="project-empty">创建任务时选择一个项目，这里会自动形成结构。</div>';
    return;
  }
  element.innerHTML = projects.map((project, index) => {
    const tasks = state.tasks.filter((task) => task.project === project);
    const done = tasks.filter((task) => task.status === 'done').length;
    const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    return `<button class="project-progress-row" data-project-progress="${escapeHtml(project)}"><span class="project-progress-name"><i class="project-color" style="background:${projectColors[index % projectColors.length]}"></i>${escapeHtml(project)}</span><span class="project-progress-bar"><span style="width:${percent}%"></span></span><span class="project-progress-percent">${percent}%</span></button>`;
  }).join('');
  element.querySelectorAll('[data-project-progress]').forEach((button) => button.addEventListener('click', () => { state.view = `project|${button.dataset.projectProgress}`; state.filter = 'all'; state.specialFilter = 'all'; state.dateFilter = 'all'; render(); }));
}

function priorityBadge(task) {
  return task.priority !== 'none' ? `<span class="priority-badge priority-${escapeHtml(task.priority)}">${priorityInfo[task.priority]}</span>` : '';
}

function taskMeta(task) {
  const due = `<span class="task-date"><span class="calendar-mini"></span>${escapeHtml(task.dueTime ? `${formatDate(task.dueDate)} · ${task.dueTime}` : formatDate(task.dueDate))}</span>`;
  const deadline = task.deadlineDate ? `<span class="deadline-meta">⌁ ${escapeHtml(task.deadlineTime ? `${formatDate(task.deadlineDate)} · ${task.deadlineTime}` : formatDate(task.deadlineDate))}</span>` : '';
  const repeat = task.repeat !== 'none' ? `<span class="repeat-meta">↻ ${repeatInfo[task.repeat]}</span>` : '';
  const project = task.project ? `<span class="project-badge">${escapeHtml(task.project)}</span>` : '';
  const tag = task.tags?.[0] ? `<span class="tag-badge">#${escapeHtml(task.tags[0])}</span>` : '';
  return `${due}${deadline ? '<span class="meta-divider">·</span>' + deadline : ''}${repeat ? '<span class="meta-divider">·</span>' + repeat : ''}${project}${tag}${priorityBadge(task)}<span class="status-badge status-${escapeHtml(task.status)}">${statusInfo[task.status]?.short || '待处理'}</span>`;
}

function taskCard(task, compact = false) {
  return `<article class="task-card status-${escapeHtml(task.status)} ${task.id === state.selectedId ? 'selected' : ''} ${compact ? 'compact' : ''}" data-task-id="${escapeHtml(task.id)}"><button class="task-checkbox status-${escapeHtml(task.status)}" data-toggle-id="${escapeHtml(task.id)}" aria-label="切换任务完成状态"></button><div class="task-main" data-select-id="${escapeHtml(task.id)}"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-meta">${taskMeta(task)}</div></div><select class="task-status-select" data-status-id="${escapeHtml(task.id)}" aria-label="任务状态">${Object.entries(statusInfo).map(([key, info]) => `<option value="${key}" ${task.status === key ? 'selected' : ''}>${info.label}</option>`).join('')}</select><button class="task-more" data-select-id="${escapeHtml(task.id)}" aria-label="查看任务详情">···</button></article>`;
}

function groupTasks(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.dueDate)) groups.set(task.dueDate, []);
    groups.get(task.dueDate).push(task);
  }
  return groups;
}

function bindTaskElements(container) {
  container.querySelectorAll('[data-toggle-id]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); toggleTask(button.dataset.toggleId); }));
  container.querySelectorAll('[data-select-id]').forEach((button) => button.addEventListener('click', () => selectTask(button.dataset.selectId)));
  container.querySelectorAll('[data-status-id]').forEach((select) => select.addEventListener('change', () => changeStatus(select.dataset.statusId, select.value)));
}

function renderListView(tasks) {
  const element = document.createElement('div');
  element.className = 'task-list';
  for (const [date, group] of groupTasks(tasks)) {
    const section = document.createElement('section');
    section.className = 'task-group';
    section.innerHTML = `<div class="group-heading ${date === dateKey() ? 'today-heading' : ''}"><span class="group-marker"></span><span>${escapeHtml(dayLabel(date))}</span><span class="group-count">${formatDate(date)} · ${group.length}</span></div>${group.map((task) => taskCard(task)).join('')}`;
    element.appendChild(section);
  }
  bindTaskElements(element);
  return element;
}

function renderBoardView(tasks) {
  const element = document.createElement('div');
  element.className = 'board-view';
  for (const status of Object.keys(statusInfo)) {
    const statusTasks = tasks.filter((task) => task.status === status);
    const column = document.createElement('section');
    column.className = `board-column column-${status}`;
    column.innerHTML = `<div class="board-column-header"><span class="board-status-dot ${status}"></span><span>${statusInfo[status].label}</span><span>${statusTasks.length}</span></div>${statusTasks.map((task) => taskCard(task, true)).join('')}`;
    element.appendChild(column);
  }
  bindTaskElements(element);
  return element;
}

function renderTimelineView(tasks) {
  const element = document.createElement('div');
  element.className = 'timeline-view';
  const days = [...new Set([...Array(7)].map((_, index) => shiftDate(index)).concat(tasks.map((task) => task.dueDate)))].sort();
  for (const date of days) {
    const dayTasks = tasks.filter((task) => task.dueDate === date);
    if (!dayTasks.length && date < dateKey()) continue;
    const row = document.createElement('section');
    row.className = 'timeline-day';
    row.innerHTML = `<div class="timeline-date ${date === dateKey() ? 'today' : ''}">${escapeHtml(dayLabel(date))}<strong>${escapeHtml(formatDate(date))}</strong></div><div class="timeline-tasks">${dayTasks.length ? dayTasks.map((task) => `<button class="timeline-task" data-select-id="${escapeHtml(task.id)}"><time>${escapeHtml(task.dueTime || '全天')}</time><strong>${escapeHtml(task.title)}</strong><span class="status-badge status-${escapeHtml(task.status)}">${statusInfo[task.status].short}</span></button>`).join('') : '<div class="timeline-placeholder">暂无安排</div>'}</div>`;
    element.appendChild(row);
  }
  bindTaskElements(element);
  return element;
}

function renderTaskView() {
  const tasks = visibleTasks();
  const view = $('#task-view');
  const empty = $('#empty-state');
  view.innerHTML = '';
  if (!tasks.length) {
    empty.classList.remove('hidden');
    $('#empty-title').textContent = state.query ? '没有匹配的任务' : state.view === 'completed' ? '还没有完成的任务' : '这里还没有任务';
    $('#empty-description').textContent = state.query ? '试试换个关键词，或者清空搜索。' : '创建一个带日期的任务，让计划开始有形。';
    return;
  }
  empty.classList.add('hidden');
  view.appendChild(state.layout === 'board' ? renderBoardView(tasks) : state.layout === 'timeline' ? renderTimelineView(tasks) : renderListView(tasks));
  $('#all-count').textContent = tasks.length;
}

function renderDetail() {
  const task = state.tasks.find((item) => item.id === state.selectedId);
  const empty = $('#detail-empty');
  const content = $('#detail-content');
  if (!task) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.classList.remove('hidden');
  $('#detail-title').value = task.title;
  $('#detail-date').value = task.dueDate;
  $('#detail-time').value = task.dueTime || '';
  $('#detail-deadline-date').value = task.deadlineDate || '';
  $('#detail-deadline-time').value = task.deadlineTime || '';
  $('#detail-repeat').value = task.repeat || 'none';
  $('#detail-priority').value = task.priority || 'none';
  $('#detail-note').value = task.note || '';
  $('#detail-tags').value = (task.tags || []).join(', ');
  updateSelect($('#detail-project'), allProjects(), task.project);
  updateSelect($('#detail-list'), allLists(), task.list);
  $$('#status-selector button').forEach((button) => button.classList.toggle('active', button.dataset.status === task.status));
  $('#source-note').textContent = `${task.source === 'demo' ? '演示任务' : '同步到 Obsidian'} · ${task.path || state.taskFile}${task.line ? `:${task.line}` : ''}`;
}

function render() {
  renderHeader();
  updateSidebar();
  renderMetrics();
  renderProgress();
  renderProjectProgress();
  renderTaskView();
  renderDetail();
}

function openModal() {
  $('#task-modal').classList.remove('hidden');
  $('#new-date').value = dateKey();
  $('#new-time').value = '09:00';
  $('#new-deadline-date').value = dateKey();
  $('#new-deadline-time').value = '18:00';
  $('#new-repeat').value = 'none';
  $('#new-priority').value = 'medium';
  updateSelect($('#new-project'), allProjects(), projectView() || allProjects()[0]);
  updateSelect($('#new-list'), allLists(), '收件箱');
  window.setTimeout(() => $('#new-title').focus(), 50);
}

function closeModal() { $('#task-modal').classList.add('hidden'); }

function selectTask(taskId) {
  state.selectedId = taskId;
  render();
  if (window.innerWidth <= 980) $('#detail-panel').classList.add('mobile-open');
}

function taskPayloadFromForm(prefix) {
  const selectedStatus = prefix === 'detail' ? $$('#status-selector button').find((button) => button.classList.contains('active'))?.dataset.status : 'todo';
  return {
    title: $(`#${prefix}-title`).value.trim(), dueDate: $(`#${prefix}-date`).value, dueTime: $(`#${prefix}-time`).value,
    deadlineDate: $(`#${prefix}-deadline-date`).value, deadlineTime: $(`#${prefix}-deadline-time`).value,
    repeat: $(`#${prefix}-repeat`).value, project: $(`#${prefix}-project`).value, list: $(`#${prefix}-list`).value,
    priority: $(`#${prefix}-priority`).value, status: selectedStatus,
    tags: $(`#${prefix}-tags`).value.split(',').map((tag) => tag.trim()).filter(Boolean), note: $(`#${prefix}-note`).value
  };
}

async function toggleTask(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  await changeStatus(taskId, task.status === 'done' ? 'todo' : 'done');
}

async function changeStatus(taskId, status) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || !statusInfo[status]) return;
  const updated = { ...task, status, completed: status === 'done' };
  try {
    if (task.source === 'demo') state.tasks = state.tasks.map((item) => item.id === taskId ? updated : item);
    else {
      const data = await request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(updated) });
      state.tasks = state.tasks.map((item) => item.id === taskId ? { ...item, ...data.task } : item);
    }
    showToast(status === 'done' ? '任务已完成' : `状态已更新为「${statusInfo[status].label}」`);
    render();
  } catch (error) { showToast(error.message, 'error'); }
}

async function createTask(event) {
  event.preventDefault();
  const payload = taskPayloadFromForm('new');
  if (!payload.title || !payload.dueDate) { showToast('请填写任务标题和日期', 'error'); return; }
  try {
    if (state.connected) {
      await request('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      await loadTasks();
      showToast('任务已写入 Obsidian');
    } else {
      state.tasks.push({ ...payload, id: `demo-${Date.now()}`, completed: false, source: 'demo', path: state.taskFile, line: 1 });
      render();
      showToast('任务已添加到演示列表');
    }
    closeModal();
    $('#new-task-form').reset();
  } catch (error) { showToast(error.message, 'error'); }
}

async function saveTask() {
  const task = state.tasks.find((item) => item.id === state.selectedId);
  if (!task) return;
  const payload = { ...task, ...taskPayloadFromForm('detail') };
  try {
    if (task.source === 'demo') state.tasks = state.tasks.map((item) => item.id === task.id ? payload : item);
    else {
      const data = await request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      state.tasks = state.tasks.map((item) => item.id === task.id ? { ...item, ...data.task } : item);
    }
    showToast(task.source === 'demo' ? '演示任务已更新' : '修改已同步到 Obsidian');
    render();
  } catch (error) { showToast(error.message, 'error'); }
}

async function deleteTask() {
  const task = state.tasks.find((item) => item.id === state.selectedId);
  if (!task || !window.confirm(`确定删除「${task.title}」吗？`)) return;
  try {
    if (task.source !== 'demo') await request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE', body: JSON.stringify(task) });
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    state.selectedId = null;
    showToast('任务已删除');
    render();
  } catch (error) { showToast(error.message, 'error'); }
}

async function seedTasks() {
  if (!state.connected) { showToast('请先启动 Obsidian，并确认 vault=base', 'error'); return; }
  try {
    const data = await request('/api/seed', { method: 'POST' });
    await loadTasks();
    showToast(data.created ? `已写入 ${data.created} 个真实示例任务` : '示例任务已经存在');
  } catch (error) { showToast(error.message, 'error'); }
}

function cycleDateFilter() {
  const values = ['all', 'today', 'next7', 'overdue'];
  state.specialFilter = 'all';
  state.dateFilter = values[(values.indexOf(state.dateFilter) + 1) % values.length];
  render();
}

function addProject() {
  const project = window.prompt('新项目名称');
  if (!project?.trim()) return;
  if (!allProjects().includes(project.trim())) state.customProjects.push(project.trim());
  state.view = `project|${project.trim()}`;
  state.filter = 'all';
  state.specialFilter = 'all';
  state.dateFilter = 'all';
  render();
  openModal();
}

function bindEvents() {
  $('#new-task-button').addEventListener('click', openModal);
  $('#heading-new-button').addEventListener('click', openModal);
  $('#empty-create-button').addEventListener('click', openModal);
  $('#close-modal-button').addEventListener('click', closeModal);
  $('#task-modal').addEventListener('click', (event) => { if (event.target === $('#task-modal')) closeModal(); });
  $('#new-task-form').addEventListener('submit', createTask);
  $('#save-task-button').addEventListener('click', saveTask);
  $('#delete-task-button').addEventListener('click', deleteTask);
  $('#seed-button').addEventListener('click', seedTasks);
  $('#refresh-button').addEventListener('click', () => { showToast('正在从 Obsidian 刷新…'); loadTasks(); });
  $('#close-detail-button').addEventListener('click', () => { state.selectedId = null; $('#detail-panel').classList.remove('mobile-open'); render(); });
  $('#manage-projects-button').addEventListener('click', addProject);
  $('#add-project-button').addEventListener('click', addProject);
  $('#settings-button').addEventListener('click', () => showToast(`当前连接：vault=${state.vault} · ${state.taskFile}`));
  $('#date-filter-button').addEventListener('click', cycleDateFilter);
  $('#sort-button').addEventListener('click', () => { state.sortAscending = !state.sortAscending; render(); });
  $('#search-input').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderTaskView(); });
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => { state.view = item.dataset.view; state.filter = 'all'; state.specialFilter = 'all'; state.dateFilter = 'all'; render(); }));
  $$('.quick-filter').forEach((item) => item.addEventListener('click', () => { state.view = 'overview'; state.filter = 'all'; state.specialFilter = item.dataset.quickFilter; state.dateFilter = 'all'; render(); }));
  $$('.filter-chip').forEach((item) => item.addEventListener('click', () => { state.filter = item.dataset.filter; render(); }));
  $$('.view-tab').forEach((button) => button.addEventListener('click', () => { state.layout = button.dataset.layout; render(); }));
  $$('#status-selector button').forEach((button) => button.addEventListener('click', () => { $$('#status-selector button').forEach((item) => item.classList.remove('active')); button.classList.add('active'); }));
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); }
    if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) openModal();
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search-input').focus(); }
    if (event.key === 'Escape') { closeModal(); $('#detail-panel').classList.remove('mobile-open'); }
  });
}

bindEvents();
loadTasks();
