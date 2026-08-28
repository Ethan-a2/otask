# Taskbase

一个以 Obsidian Vault 为数据源的任务工作台，交互参考滴答清单：总览、列表、看板、时间线、项目、状态、优先级、日期、截止时间、循环、标签、进度和快速新建。

## 运行

```bash
npm start
```

浏览器打开 `http://localhost:3000`。

默认使用：

- Obsidian Vault：`base`
- 任务文件：`Tasks.md`
- 读取：`obsidian vault=base tasks verbose format=json`（保留文件路径和行号，便于修改/删除）
- 新建：通过 `append` 写入带日期、截止时间、状态和隐藏元数据的 Markdown checklist
- 修改/删除：读取任务来源文件后，通过 `create ... overwrite` 回写对应行

只展示带日期的任务；任务的状态、项目、循环、截止时间、优先级和备注会写入任务行的隐藏 `taskbase` 元数据，日期等信息也会保留为可读文本，例如：

```md
- [/] 梳理下周迭代范围 📅 2026-08-29 09:30 ⏳ 2026-08-29 12:00 🟠 #计划 #工作
```

## 配置

```bash
OBSIDIAN_VAULT=base OBSIDIAN_TASK_FILE=Tasks.md PORT=3000 npm start
```

如果 Obsidian CLI 暂时不可用，页面会进入演示模式，方便先体验界面；演示模式的修改不会写入 Vault。连接恢复后点击“刷新”即可重新读取 Obsidian。
