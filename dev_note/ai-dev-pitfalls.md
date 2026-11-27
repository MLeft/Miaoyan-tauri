# AI 开发反复踩坑记录

> 本文档记录 AI 辅助开发过程中反复出现的问题，避免后续再犯。

---

## 1. Tailwind 动态 class 不生效

**问题**：在组件中使用 Tailwind class（如 `px-5`、`px-8`）调整内边距，HTML 中可见 class 已应用，但样式无变化。

**根因**：Tailwind 在构建时扫描源码生成 CSS，动态拼接或在运行时条件渲染的 class 可能未被扫描到，导致 CSS 文件中不存在对应规则。

**解决方案**：
- **优先使用内联 style** 处理需要精确控制的样式（如 `padding: '5px 12px'`）
- 确保 Tailwind class 在源码中以完整字符串出现，不要用变量拼接
- 如需动态 class，使用 `safelist` 配置或在 `tailwind.config.js` 中预定义

**案例**：TabBar 右键菜单文字缩进，从 `px-3` → `px-5` → `px-8` 均不生效，最终改用内联 `padding: '5px 12px'` 解决。

---

## 2. Write 工具追加而非覆盖文件

**问题**：使用 Write 工具写入文件时，内容被追加到文件末尾而非覆盖，导致文件出现重复代码。

**根因**：Write 工具在某些情况下（如文件较大或内容较长）会追加内容而非覆盖。

**解决方案**：
- 写入后**必须立即检查**文件是否出现重复内容
- 如出现重复，使用 SearchReplace 删除多余部分
- 对于小文件优先使用 SearchReplace 而非 Write

**案例**：`watcher.rs` 重写时旧代码未清除，Rust 编译报 `name is defined multiple times`。

---

## 3. 异步状态更新导致首次渲染空白

**问题**：先设置 `activeNote` 再异步加载 `activeContent`，导致 Editor/Preview 组件挂载时内容为空。

**根因**：状态分两步设置，第一个 render 周期 `activeNote` 已存在但 `activeContent` 还是旧值/空值。

**解决方案**：
- **原子更新**：`activeNote` 和 `activeContent` 必须在同一个 `set()` 调用中更新
- 加载过程中只设置 `isLoading: true`，不提前设置 `activeNote`
- 确保组件挂载时所需的 state 已就绪

**案例**：`selectNote` 先 `set({ activeNote })` 再 `await readNote()` 再 `set({ activeContent })`，首次打开文件空白。

---

## 4. ESM 循环依赖

**问题**：在 `editor-store.ts` 中 import `notes-store` 导致循环依赖。

**根因**：两个 store 互相引用，Vite/ESM 模式下无法解析。

**解决方案**：
- 避免 store 之间直接 import
- 在 action 中通过 `useXxxStore.getState()` 动态获取
- 将共享逻辑提升到更高层的组件或 hook 中

**案例**：`editor-store` 尝试 import `notes-store` 同步 viewMode，Vite 报错。

---

## 5. Set vs Array 状态类型

**问题**：将 `Set<string>` 存入 zustand store，序列化/比较时行为异常。

**根因**：`Set` 不是 plain object，zustand 的浅比较和 devtools 不友好。

**解决方案**：
- store 中使用 `string[]` 而非 `Set<string>`
- 需要去重时用 `includes()` 或手动 `[...new Set(arr)]`
- 组件层需要 Set 时可自行转换

---

## 6. React key 导致组件状态丢失

**问题**：组件使用 `key={dynamicValue}` 导致 key 变化时整个组件树卸载重建，状态丢失。

**根因**：React 的 key 机制——key 变化 = 组件实例销毁 + 新建。

**解决方案**：
- 不要对需要保持状态的容器组件使用动态 key
- 如需强制刷新，用 `useEffect` 监听变化而非 key
- 将需要持久化的状态提升到 zustand store

**案例**：`<Allotment key={String(config.show_sidebar)}>` 导致侧边栏隐藏/恢复时展开状态丢失。

---

## 7. UI 样式硬编码颜色，不用设计系统 token

**问题**：Toast 用硬编码浅绿（绿底 + 绿字），与应用整体 macOS 风调性脱节，深色模式下尤其突兀。

**根因**：`globals.css` 设计系统早已定义原版墨言的 Toast token（`--toast-bg: rgba(25,25,25,.95)` 深色半透明 + `--toast-text` 白字，明暗主题齐备），但组件写时没查 token、自造颜色。

**解决方案**：
- 写样式前先查 `globals.css` 的 `:root` / `.dark` token（`--toast-*`、`--success-*`、`--shadow-*`、`--border` 等），禁止硬编码颜色
- 弹窗/浮层统一规格：`0.5px` 发丝边 + `var(--shadow-*)` + `backdrop-blur`，圆角 6-8px
- 语义状态点用 `--success-color` 等变量，明暗主题自动取色

**案例**：Toast 改为深色半透明 HUD + 成功绿点/白色 spinner 后与应用调性一致（截图验证明暗两态）。

---

## 8. 移除操作触发全库重扫，两段式更新卡顿

**问题**：点 ✕ 移除额外文件夹后，总数与文件行先消失、父文件夹行数秒后才消失，全程卡顿。

**根因**：移除链路走 `loadProjects + reloadAllNotes` 两次全库扫描；allNotes 与 projects 由两个独立慢扫描更新、返回时机不同 → 两段式更新；全扫本身耗时数秒。

**解决方案**：
- 移除语义明确、**零全扫**：本地立即过滤（projects 递归剔除节点 + allNotes 按路径前缀过滤），行与计数同帧消失
- extra_folders 纯新增/纯移除均跳过全扫，仅混合变更才全量刷新
- **迟到保护必须双向**：权威结果按当前配置裁剪（新增行保留、移除行过滤）；所有合并入口（notes-chunk / project-chunk / fs 增量）按当前根（storage_path + extra_folders）有效性过滤，防在途扫描复活已移除行

**案例**：修复后 CDP 50ms 采样：点 ✕ 后 `t=+1ms` 文件夹行与计数同帧消失，2s 内无复活、无迟到更新。

## 9. 新建/重命名文件触发全量刷新，目录树收起又展开

**问题**：侧栏新建文件、重命名（含编辑器标题栏提交、拖拽移动）后，展开的文件夹树先收起再展开。

**根因**：这些入口复用 `handleRefreshAll + loadProjects` 全量刷新；Rust `get_projects` 对每个顶层目录先发**空壳 project-chunk**（children: Vec::new()），扫描完再发完整 chunk → `mergeProjectChunk` 原地替换，展开子树的 children 瞬间清空 → 收起，完整 chunk 到达后再展开。

**解决方案**：
- 新建（工具栏/侧栏右键/Cmd+D/deep-link）→ `notes-store registerCreatedNote`：`markRecentWrite` 吞掉 watcher 对自家写入的回环事件，再广播 `note-created` → `UnifiedTree insertNoteLocal` 本地插行（同步 `setNotesFromCache`）
- 重命名/移动 → 复用 `note-path-changed` 本地换行（v1.0.38 已建立）
- 均零全扫；目录结构变化另走 `fs-structure` 增量路径（见 §11），不再保留 dir 级 needsFull 全扫

---

## 10. Windows 文件监听句柄锁住父目录

**问题**：笔记库设在代码/工作目录（如 `D:\code_for_task`）时，资源管理器里重命名或删除 `docs`、`docs\superpowers` 报“需要来自 ... 的权限”（错误码 5），但更深层没有子目录的 `specs` 可以正常改名；退出妙言后立即恢复。

**根因**：watcher 对根下每个子目录单独注册非递归监听，notify 的每个 watch 都持有目录句柄。Windows 重命名目录时要求其**后代目录都没有打开的句柄**——即使句柄带 `FILE_SHARE_DELETE` 也一样；被监听目录自身可改名（共享删除），但它的父目录会报 `ERROR_ACCESS_DENIED`。因此 `specs`（没有子目录被监听）可改名，`superpowers`/`docs` 被锁。

**解决方案**：
- 每个监听根只注册一条 `RecursiveMode::Recursive` 监听，根下所有层级由同一条句柄覆盖，不再逐目录持有句柄
- 忽略目录（`.git`/`node_modules`/`dist` 等）继续在事件回调用 `under_ignored_relative` 过滤；代价是这些目录的事件会先由系统投递再丢弃
- 回归测试：`services::watcher::tests::recursive_watch_keeps_subdirectories_renameable`（退回逐目录监听会立即失败）

---

## 11. 任意文件变更触发父目录全量重扫（目录树整块刷新）

**问题**：新建/删除/重命名任意一个笔记，甚至外部脚本每 10 分钟往库里写一条笔记，左侧目录树都会整块刷新；大库实测每次全量 `get_all_notes` 耗时 4–6 秒（7338 条笔记），日志里 `[perf] scan-notes` 一天出现 130+ 次。

**根因**：Windows 的 `ReadDirectoryChangesW` 对目录内**任意子项**的新增/删除/重命名都会额外上报一条**父目录** `Modify(Any)` 事件。旧回调把「路径是目录」一律当作结构变化，前端 `needsFull` → `reloadAllNotes + loadProjects` 全量重扫。用 notify 探针实测事件形状：
- 写文件内容：只有文件 `Modify`，无父目录事件
- 新建/重命名/删除文件：文件事件 + `Modify(Any) path=<父目录> is_dir=true`
- 删除目录：`Remove` 的路径已不存在（`is_dir=false`），只有父目录 `Modify` 能感知

**解决方案**：
- `watcher.rs` 用 `is_child_change_noise` 丢弃「已存在目录的普通 Modify」——子项自己的事件已单独上报
- 真结构变化拆成独立 `fs-structure` 事件：`dir-create` / `dir-rename` / `path-remove`；Windows 把重命名拆成 `Name(From)`+`Name(To)` 两条事件，watcher 内用 1s 挂起队列配对
- 前端 `UnifiedTree` 本地增量应用：`dirCreateLocal` 插节点、`dirRenameLocal` 按前缀换项目树与笔记路径（含标签）、`dirRemoveLocal` 按前缀摘除；**不再有 needsFull 全扫分支**
- 文件 `modify` 原位替换元数据、**不重排父目录**（只有新增行参与排序）；自身写入回环在 5s 窗口内持续压制（不再命中一次就删标记）
- 监听/全量扫描都要做迟到保护：扫描期间新增的笔记与目录，不能被晚到（可能耗时 20s+）的权威结果抹掉
- 回归测试：`services::watcher::tests::child_entry_changes_on_directory_are_not_structure_events`

**验证**：真实运行时（CDP）外部新建/修改/改名/删除笔记与目录，`scan-notes` 计数保持不变；仅 App 启动的两次全扫计入。

---

## 12. 旧库扫描结果覆盖新库（扫描源无身份隔离）

**问题**：A→B→A 切换笔记库后，旧库迟到的扫描回包/事件会覆盖或混入当前库，目录树短暂显示上个库的内容。

**根因**：扫描请求没有身份标签；前端只按「最后一次请求」判断，无法区分同路径不同轮次的扫描，也无法拒绝已退役根的事件。

**解决方案**：
- 每次扫描携带 `scan_id + session_id + lane + generation`，Rust 侧 `ScanState` 按窗口/lane 保存代际，旧代际在启动前即被取消（协作式 `AtomicBool`）
- 前端 `isCurrentScan(scan_id, domain, root, extras)` 同时校验事件标签、根集合与存储修订号；不匹配的分块/回包直接丢弃
- 根切换时立即按当前根剪枝已加载数据，不等新扫描返回；测试覆盖 A/B/A、迟到回包、旧事件重放

**案例**：`tests/scan-sources.test.mjs`、`tests/library-scans.browser.mjs`（`testLibraryScanScopes`）。

---

## 13. 批注边车被外部修改后静默覆盖

**问题**：应用打开笔记期间，批注文件（`*.annotations.json`）被外部（同步工具/另一实例/git checkout）修改，应用内再保存批注会无提示覆盖外部内容。

**根因**：批注读写只带文档身份（document_id），未带边车内容版本；watcher 不监听批注文件，前端也无从得知磁盘已变。

**解决方案**：
- `read_annotations` 返回边车 `disk_version`（sha256，无文件为空串）；`write/delete_annotations` 必须携带 `expected_version`，不一致返回 `Conflict` 并保留磁盘内容
- 前端 `Preview` 在读取时记录版本、每次成功写入后链式更新；保存失败后重试会先重新读取最新版本，避免死循环
- 回归：`persistence_tests::annotation_writes_cas_against_external_sidecar_changes`（含加密变体，红绿验证过）

---

## 14. 沙箱预览 iframe 的字体被资源协议 CORS 拒绝

**问题**：预览 iframe 加 `sandbox="allow-scripts"`（不透明源）后，安装版正文回退系统字体；开发模式与浏览器测试正常。

**根因**：Web 字体按规范以 CORS 模式请求；不透明源发出 `Origin: null`。Tauri 2 资源协议的 `Access-Control-Allow-Origin` 只回「主窗口 Origin」（`tauri-2.x/src/protocol/asset.rs` 的 `window_origin`），因此字体被拒；Vite 开发服务器发 `*`，测试测不出来。

**解决方案**：
- 子集字体（430KB woff2）内联为 data URI 写进 `preview.html` 的 `@font-face`，无需跨源请求；源文件留在 `public/fonts/` 供重新生成
- 回归用例 `tests/preview.browser.mjs` → `body-font-loads-in-sandbox`：在沙箱内断言 `document.fonts` 状态为 loaded 且 src 为 data URI
- 一般原则：给预览 iframe 收紧沙箱时，逐一检查依赖 CORS 的子资源（字体、fetch/XHR）；no-cors 的 CSS/JS/图片不受影响
