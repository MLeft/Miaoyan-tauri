# MiaoYan Tauri Agent 开发最佳实践与指引

> 面向接手本项目的 AI Agent。读完本文可直接上手开发，避免重复踩坑。
> 配套文档：`dev_note/ai-dev-pitfalls.md`（具体踩坑案例库）。
> 最后更新：2026-08-30（v1.0.32 发布后；增量导入/移除 + Toast 样式对齐设计系统）

---

## 1. 项目速览

- **定位**：跨平台 Markdown 桌面编辑器（秒言移植版），仓库 `MLeft/Miaoyan-tauri`
- **技术栈**：Tauri 2.x（Rust）+ React 19 + TypeScript + Vite + Zustand v5 + CodeMirror 6 + Tailwind（部分，见坑点 §7.1）
- **关键目录**：
  - `src/` 前端（组件 / stores / services）
  - `src-tauri/` Rust 侧（commands / services: storage、watcher、cloud_sync、encryption）
  - `public/preview.html` 预览 iframe 宿主（重型库按需加载在此实现）
  - `dev_note/` 开发知识沉淀（本文档所在地）
- **环境约定**：
  - 用户存储路径 `<storage> = D:\code_for_task\workloop`，额外文件夹 `D:\code_for_task\ai-share` + `C:\Users\xudong2.zhang\.multica`
  - 遥测日志 `<storage>/.log/<日期>.log`，`[perf]` 前缀（历史任务中一直为空，性能结论不能依赖它）
  - Rust 环境需 `rsproxy.cn` 镜像源 + VS Build Tools（PATH 可能失效，编译报错先检查）

---

## 2. 构建与部署（最高优先级红线）

### 2.1 必须用 `npx tauri build`，禁止裸 `cargo build --release`

裸 `cargo build --release` 不会启用 `custom-protocol` feature，产物处于 dev 模式，启动后导航到
`tauri.conf.json` 的 `devUrl`（localhost:1420）→ **应用窗口显示 ERR_CONNECTION_REFUSED**。

```powershell
# 唯一正确的构建命令（自动跑 beforeBuildCommand、启用 feature、嵌入 dist）
Set-Location d:\code\Miaoyan-tauri
npx tauri build --no-bundle     # 约 1m17s~1m30s
```

### 2.2 Tauri 前端改动可能"假构建"

Tauri 二进制在**编译期嵌入** `frontendDist`（dist 目录）。cargo 不追踪 dist 内容变化，
dist 更新后 cargo 可能秒级"假成功"。判断标准：**最终 exe 的 LastWriteTime 晚于
dist/index.html 的 mtime** 才算真嵌入。必要时手动删除 `target/<profile>/.fingerprint/miaoyan*`
强制重编。注意 package 拆成 bin + lib 两个 target（miaoyan / miaoyan_lib），嵌入在 lib。

### 2.3 标准部署链

用户实际运行的是**安装版**（桌面快捷方式指向它），不是 `target/release` 下的产物。
任何"用户验证"前必须同步：

```powershell
taskkill /IM miaoyan.exe /F                          # 沙箱拦截时需提权（权限不足）
Copy-Item src-tauri\target\release\miaoyan.exe "$env:LOCALAPPDATA\MiaoYan\miaoyan.exe" -Force
Start-Process "$env:LOCALAPPDATA\MiaoYan\miaoyan.exe"
```

**部署后验证三件套**：
1. `Get-Process miaoyan | Select-Object Path` 确认进程路径指向安装目录
2. 窗口加载的应是 `tauri.localhost` 协议（不是 localhost:1420）
3. 功能验证（请用户人工确认，或用桌面自动化截屏；用户可能按 Escape 中止自动化，做好被中止的准备）

### 2.4 性能结论的前提

- 验证优化效果前先确认用户运行的二进制就是最新构建（历史上曾连续 5 轮部署坏二进制，全部优化白做）
- release 才有真实性能；debug 构建 Rust 侧未优化

### 2.5 CDP 运行时验证方法论

无需用户人工操作即可端到端验证 UI 行为：

```powershell
# 进程级环境变量启动（User 级环境变量不被 Start-Process 子进程继承，必须进程级）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
Start-Process "$env:LOCALAPPDATA\MiaoYan\miaoyan.exe"
```

- Node 原生 WebSocket 连 `http://localhost:9222/json` 取 `webSocketDebuggerUrl`（项目未装 ws 依赖）
- `Runtime.evaluate` 可派发任意事件（如 `show-toast` CustomEvent 触发 Toast 两态）+ `Page.captureScreenshot` 截图验样式
- **状态同步性验证**：操作后 50ms 高频采样 DOM 指标（行存在性/计数），输出变化时间线，断言同帧更新（案例：移除文件夹行与计数 t=+1ms 同帧消失）
- 验证毕清理：删脚本/截图、taskkill、不带调试变量正常重启

---

## 3. 版本发布流程（用户说 "TAG新版本" 即触发）

1. **三处版本号同步**（缺一不可）：
   - `package.json` → `"version"`
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
2. `cd src-tauri; cargo check` 同步 Cargo.lock（提交前必须）
3. **同步 dev_note**（必须）：
   - `dev_note/CHANGES.md` 补新版本条目（Unreleased 节改名为新版本号 + 日期，新特性面向用户感知）
   - 本文件 §3 历史版本行追加一句摘要；本次如有新机制/新坑同步 §5/§7 与 `ai-dev-pitfalls.md`
4. `git add -A` → 检查 `git status --short` 有无**临时产物误入**（截图、调试脚本），有则剔除
5. `git commit`
6. 推送（见 §4，本地 `git push` 不通）
7. **tag 触发 CI**：GitHub Actions `.github/workflows/build.yml` 监听 `v*` tag，CI 产出安装包到 Releases
8. `gh api` 查询 CI 状态：`gh api 'repos/MLeft/Miaoyan-tauri/actions/runs?per_page=2' --jq '...'`
9. 清理临时脚本

> 注意：通过 API 直接创建的 tag 只存在于远端，本地 `git tag --list` 看不到，属正常。
> 历史版本：v1.0.29（性能优化大包）、v1.0.30（批注侧边栏 + 按钮常显）、v1.0.31（.md 默认编辑器注册：双击/右键打开 + 设置开关）、v1.0.32（渐进加载：逐目录分块渲染 + 扫描分数进度 + 导入进度 Toast；日志迁至 ~/.miaoyan/log）、v1.0.33（外部文件夹增量导入/移除：零全扫、行与计数同帧更新、在途扫描双向迟到保护；Toast 样式对齐设计系统；dev_note CHANGES.md 启用）、v1.0.34（Toast 升级毛玻璃通知卡片：主题自适应磨砂表面 + 语义三态图标；设计方案 demo-toast.html 存档）。

---

## 4. 网络阻断与 Git Database API 推送

### 4.1 现象

`github.com:443` 被阻断（`git push` 报 `schannel: server closed abruptly` / 连接失败），
但 `api.github.com` 可用（`gh api` 正常工作）。

### 4.2 推送方案：临时 Node 脚本走 Git Database API

流程：远端 HEAD → 本地 diff → 逐文件建 blob → 新 tree → 新 commit → 更新 main ref → 创建 tag。
每次发布复制上一版脚本改 TAG 名，跑完即删。关键校验规范：

| 坑 | 正确做法 |
|---|---|
| `GET /git/refs/heads/main` 的 sha | 在 **`object.sha`**，不是顶层 sha |
| commits/trees/blobs 接口 | sha 在顶层 |
| 每个 sha | 显式校验长度 40，否则后续调用 422 |
| 更新 ref | `force` 必须是 **JSON body 布尔值**（`--input` 文件），`-f "force=true"` 报 422 |
| 更新 ref（fast-forward） | 新 commit 以远端当前 HEAD 为 parent 时 `force: false` 即可；`force: true` 可能被权限策略拦截 |
| Node 执行子命令 | `execFileSync('gh', argv数组)`，禁止 `execSync` 拼字符串（壳注入告警） |
| 删除文件 | tree entry `{ path, mode:'100644', type:'blob', sha: null }` |
| diff 基准 | 用**远端实际 sha**（非本地 HEAD），本地/远端 commit sha 不同步属正常 |

---

## 5. 已建立的性能机制（不要破坏，改动前先读）

| 机制 | 位置 | 要点 |
|---|---|---|
| 重型库按需加载 | `public/preview.html` | `ensureLibs` + `loadScriptChain` **链式** onload 注入，保证依赖顺序（d3→markmap、katex→auto-render），禁止并行注入 |
| 字体子集 | `public/fonts/*.woff2` | 18MB 原字体已子集为 0.43MB；原字体在 `fonts-src/`（已 gitignore） |
| Vendor 分包 | `vite.config.ts` | `manualChunks`：vendor-codemirror / vendor-react / vendor-i18n |
| parse 防抖 | `Preview.tsx` | `activeContent.length > 100_000 ? 600 : 250` ms；renderSeq 丢弃过期渲染 |
| 窄订阅 | 各组件 | 只订阅需要的 store 字段（如 `editorScrollLine`、`viewMode`），禁止全量订阅 |
| 增量导入/移除 | `mod.rs scan_folder` + `App.tsx importExternalFolder` + `UnifiedTree removeFolderLocal` | 导入只扫新目录（chunk 自动合并）、移除本地立即过滤（行与计数同帧消失），均零全扫；extra_folders 纯新增/纯移除跳过全扫；bridge 去重键含参数；loadProjects/reloadAllNotes 迟到双向保护（新增行保留、移除行裁剪）；notes-chunk/project-chunk/fs 增量按当前根有效性过滤，防移除行复活 |
| 批注高亮防抖 | `Preview.tsx` | 250ms；`annotations.length === 0` 时直接跳过 |

---

## 6. 关键架构与 UI 约定

### 6.1 批注系统

- 技术路径：`Preview.tsx` 的 iframe（preview.html）内注入选区监听 → `postMessage` 回主窗口 →
  `AnnotationPanel.tsx` 面板；数据持久化于 localStorage（按笔记路径索引）
- **侧边栏布局**（v1.0.30 起）：面板是 flex 兄弟列（`shrink-0`、280px、`borderLeft`），
  预览区 `flex-1 min-w-0`，**挤压式、禁止遮挡式悬浮**
- **操作按钮常显规范**：元信息行标题必须 `truncate` + `minWidth:0` + `flex:'1 1 auto'`，
  按钮容器 `shrink-0`，行加 `gap-1`——防止长章节标题把 编辑/已解决/删除 挤出可视区
- 批注编辑、持久化、高度自适应等细节见长期记忆与 `AnnotationPanel.tsx` 内注释

### 6.2 其他既有规范（改动相关组件前先查）

- TabBar：VS Code 风格，标题视觉居中右移，右键菜单五种关闭操作，dirty tab 自动保存
- 目录树：层级缩进视觉层次规范、显示文件后缀名
- 右键菜单文字缩进用内联 `padding: '5px 12px'`（Tailwind 动态 class 不生效）
- Toast：毛玻璃通知卡片（方案 B）：`var(--toast-surface)` 浅白磨砂/深深磨砂 + `backdrop-filter: blur(20px) saturate(1.6)` + 0.5px 发丝边 `var(--border)` + `shadow-lg` + 圆角 12；圆角方图标语义底色三态——success `--success-bg`+`--success-color` 勾、warning `--warning-bg`+`--warning-color` 叹号、busy `--accent-light`+accent spinner；`type` 经 `show-toast` 事件 `detail.type` / Toast prop 传入；禁止硬编码颜色（见 ai-dev-pitfalls.md #7）
- TOC：初始化时序双保险刷新；文件监听带防抖
- 侧边栏展开状态持久化

---

## 7. 高频踩坑速查（新任务前先过一遍）

1. **Tailwind 动态 class 不生效** → 用内联 style（详见 ai-dev-pitfalls.md #1）
2. **Write 工具可能追加而非覆盖** → 写后立即检查重复内容
3. **store 循环依赖** → action 内 `useXxxStore.getState()` 动态获取
4. **zustand 存 Set** → 改用 `string[]`
5. **动态 key 导致状态丢失** → 不用动态 key 强制刷新
6. **临时产物混入提交**：桌面自动化截图 `miaoyan-window-screenshot.png` 会反复重生，
   已加 .gitignore；提交前必查 `git status --short`；误入则
   `git rm --cached` + `git commit --amend`
7. **DeleteFile 工具不可靠**：报成功但文件可能仍在，用 `Test-Path` 复核
8. **pulldown-cmark**：`push_html` 拆分多次调用会丢渲染器状态，一次性渲染
9. **Windows 兼容**：Markdown CRLF 换行、反斜杠路径分隔符需专门处理
10. **PowerShell 坑**：`--jq` 选择器必须单引号包裹（双引号内 `\(...)` 被插值）；
    沙箱终端执行部分 git 命令会卡死，改用 `required_permissions='all'`
11. **CRLF/LF**：提交时警告 "LF will be replaced by CRLF" 属正常；
    注意本地提交（LF 规范化）与 API 上传（磁盘原始内容）可能导致无实质差异的重复文件出现在远端提交中，无害
12. **样式硬编码颜色** → 先查 `globals.css` token（`--toast-*`/`--success-*`/`--shadow-*`）；见 ai-dev-pitfalls.md #7
13. **配置增删操作走全扫** → 增量（导入扫新目录/移除本地过滤）+ 迟到双向保护 + 当前根有效性过滤；见 ai-dev-pitfalls.md #8

---

## 8. 给新 Agent 的任务模板

```
1. 读本文档 + dev_note/ai-dev-pitfalls.md
2. 改动前：查相关组件既有规范（§6）；Rust 侧改动先确认 cargo 环境
3. 改动后：
   - 前端：npx tauri build --no-bundle（禁止裸 cargo build）
   - Rust：cargo check 过 → 同上构建
4. 部署链（§2.3）→ 验证三件套（§2.3）→ 请用户人工确认
5. 用户说"TAG新版本" → §3 发布流程 → §4 推送 → 确认 CI
6. 新踩的坑 → 追加到 dev_note/ai-dev-pitfalls.md
```
