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
