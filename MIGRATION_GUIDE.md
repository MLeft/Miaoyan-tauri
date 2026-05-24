# MiaoYan 跨平台迁移技术手册

> 从 Swift/AppKit (macOS) 到 Tauri 2 + React + TypeScript + Rust 的完整迁移实践

---

## 目录

1. [项目概览](#1-项目概览)
2. [技术栈对照](#2-技术栈对照)
3. [架构映射](#3-架构映射)
4. [目录结构对比](#4-目录结构对比)
5. [核心模块迁移详解](#5-核心模块迁移详解)
6. [功能迁移状态总览](#6-功能迁移状态总览)
7. [关键技术决策与踩坑记录](#7-关键技术决策与踩坑记录)
8. [CI/CD 多平台构建](#8-cicd-多平台构建)
9. [给迁移者的建议](#9-给迁移者的建议)

---

## 1. 项目概览

### 原版 MiaoYan

- **定位**：macOS 原生轻量 Markdown 编辑器
- **技术**：Swift 6 + AppKit + WebKit
- **平台**：仅 macOS 11.5+
- **代码量**：~22,000 行 Swift
- **架构**：经典 MVC（AppKit 风格）

### 重构版 MiaoYan-tauri

- **定位**：跨平台轻量 Markdown 编辑器
- **技术**：Tauri 2 + React 19 + TypeScript + Rust
- **平台**：macOS / Windows / Linux
- **代码量**：~4,300 行（前端 + 后端）
- **架构**：MVVM（Zustand store 作为 ViewModel）

---

## 2. 技术栈对照

| 领域 | 原版 (Swift/macOS) | 重构版 (Tauri) | 选型理由 |
|------|-------------------|----------------|----------|
| **UI 框架** | AppKit (NSView/NSViewController) | React 19 + TypeScript | 组件化开发，跨平台 |
| **桌面容器** | 原生 Xcode 项目 | Tauri 2 | Rust 后端 + WebView 前端，体积远小于 Electron |
| **后端语言** | Swift | Rust | Tauri 原生语言，文件 I/O 高性能 |
| **编辑器** | NSTextView (自定义) | CodeMirror 6 | 成熟的 Web 编辑器框架，Markdown 支持好 |
| **Markdown 解析** | CMarkGFM (swift-cmark-gfm) | pulldown-cmark (Rust) | 均为 CommonMark 兼容，Rust 生态对应 |
| **预览渲染** | WKWebView | iframe + postMessage | CSS 隔离，避免编辑器样式污染 |
| **代码高亮** | Highlightr (highlight.js 绑定) | highlight.js (直接在预览中使用) | 原生 Web 生态，无需桥接 |
| **排版格式化** | Prettier (Swift 绑定) | Prettier (JS 原生) | 原生 npm 包，更稳定 |
| **演示模式** | Reveal.js (WKWebView) | Reveal.js 4 (iframe) | 相同方案，Web 环境更自然 |
| **状态管理** | UserDefaults + 单例 | Zustand stores | 轻量响应式，TypeScript 类型安全 |
| **进程间通信** | 直接函数调用 | Tauri invoke IPC | Rust↔JS 桥接，异步调用 |
| **文件监控** | FSEvents API | notify crate (Rust) | 跨平台文件系统事件监听 |
| **国际化** | .lproj 本地化包 | i18next + JSON | 运行时切换，前端生态成熟 |
| **主题** | NSAppearance + Theme.swift | CSS Variables + .dark class | Web 原生主题方案 |
| **配置持久化** | UserDefaults | ~/.config/MiaoYan/config.json | 跨平台标准路径 |
| **版本历史** | ~/Library/Application Support/ | ~/.config/MiaoYan/versions/ | 跨平台标准路径 |
| **构建** | Xcode + xcodebuild | Vite + Cargo | 前后端独立构建 |
| **CI/CD** | 手动发布 | GitHub Actions + tauri-action | 自动化多平台发布 |

---

## 3. 架构映射

### 3.1 整体架构对比

```
原版 (MVC)                          重构版 (MVVM)
┌──────────────┐                    ┌──────────────┐
│   View       │                    │   React UI   │
│ (AppKit)     │                    │ (Components) │
├──────────────┤                    ├──────────────┤
│ Controller   │  ←→ 映射 →        │ Zustand Store│
│ (ViewController)                  │ (ViewModel)  │
├──────────────┤                    ├──────────────┤
│ Model        │                    │ Rust Backend │
│ (Note/Storage)                    │ (Commands)   │
└──────────────┘                    └──────────────┘
```

### 3.2 控制器 → Store/组件映射

| 原版 (Swift) | 重构版 (TS/Rust) | 说明 |
|-------------|-----------------|------|
| `ViewController.swift` | `App.tsx` + `editor-store.ts` | 主界面布局 + 编辑器状态 |
| `ViewController+Action.swift` | `notes-store.ts` + `tauri-bridge.ts` | 新建/删除/重命名等操作 |
| `ViewController+Editor.swift` | `Editor.tsx` + `editor-store.ts` | 预览/分屏/演示模式切换 |
| `ViewController+Layout.swift` | `App.tsx` (Allotment 布局) | 面板显示/隐藏/拖拽 |
| `ViewController+Data.swift` | `notes-store.ts` | 笔记列表加载/搜索/排序 |
| `PrefsWindowController` | `SettingsDialog.tsx` + `settings-store.ts` | 设置界面 |
| `AppDelegate.swift` | `lib.rs` (Tauri builder) | 应用生命周期 |
| `MainWindowController.swift` | `tauri.conf.json` | 窗口配置 |

### 3.3 视图 → 组件映射

| 原版 (AppKit) | 重构版 (React) |
|--------------|----------------|
| `EditTextView.swift` (NSTextView) | `Editor.tsx` (CodeMirror 6) |
| `MPreviewView.swift` (WKWebView) | `Preview.tsx` (iframe) |
| `NotesTableView.swift` (NSTableView) | `CombinedSidebar.tsx` (笔记列表) |
| `SidebarProjectView.swift` (NSOutlineView) | `CombinedSidebar.tsx` (文件夹树) |
| `EditorSplitView.swift` | Allotment 组件 |
| `SidebarSplitView.swift` | Allotment 组件 |
| `Toast.swift` | `Toast.tsx` |
| `SearchTextField.swift` | 搜索 input (CombinedSidebar 内) |
| `TitleTextField.swift` | 笔记标题 (CombinedSidebar 内) |
| `ImagePreviewWindow.swift` | *(尚未迁移)* |
| `OutlineHeaderView.swift` | `TableOfContents.tsx` |

### 3.4 业务逻辑 → Store/Rust 映射

| 原版 (Swift) | 重构版 (TS/Rust) | 所在层 |
|-------------|-----------------|--------|
| `Note.swift` | `types/index.ts` + Rust `models/mod.rs` | 前端类型 + 后端模型 |
| `Storage.swift` (单例) | `storage.rs` (Rust) + `notes-store.ts` | 后端扫描 + 前端缓存 |
| `Project.swift` | `types/index.ts` (Project) | 前端类型 |
| `Markdown.swift` (CMarkGFM) | `commands/mod.rs` (pulldown-cmark) | Rust 后端 |
| `NoteVersionManager.swift` | `commands/mod.rs` (版本历史命令) | Rust 后端 |
| `WikilinkIndex.swift` | `wikilinks.ts` (CM6 插件) | 前端编辑器扩展 |
| `CloudSyncManager.swift` | *(尚未迁移)* | - |
| `HtmlManager.swift` | `formatter.ts` (Prettier) | 前端服务 |
| `Theme.swift` | `globals.css` (CSS Variables) | 前端样式 |

### 3.5 Helper → Service/Extension 映射

| 原版 (Swift) | 重构版 |
|-------------|--------|
| `Theme.swift` | `globals.css` CSS Variables |
| `UserDefaultsManagement.swift` | `settings-store.ts` + `commands/mod.rs` |
| `Localization.swift` | `i18n/index.ts` (i18next) |
| `NotesTextProcessor.swift` | CodeMirror 6 内置 + 自定义扩展 |
| `CodeBlockHighlighter.swift` | highlight.js (预览 HTML 中) |
| `MarkdownRuleHighlighter.swift` | `@codemirror/lang-markdown` |
| `LinkHighlighter.swift` | `wikilinks.ts` (CM6 插件) |
| `FileSystemEventManager.swift` | `watcher.rs` (notify crate) |
| `PdfExportController.swift` | *(尚未迁移)* |
| `TextFormatter.swift` | `formatter.ts` (Prettier) |
| `ShortcutTemplateManager.swift` | `tab-snippets.ts` (CM6 插件) |

---

## 4. 目录结构对比

```
原版 (MiaoYan-main/)                  重构版 (MiaoYan-tauri/)
├── Controllers/ (20 files)           ├── src/
│   ├── ViewController.swift          │   ├── App.tsx                ← 主布局
│   ├── AppDelegate.swift             │   ├── components/
│   └── PrefsWindowController.swift   │   │   ├── editor/            ← 编辑器
├── Views/ (25 files)                 │   │   ├── preview/           ← 预览
│   ├── EditTextView.swift            │   │   ├── sidebar/           ← 侧边栏
│   ├── MPreviewView.swift            │   │   ├── presentation/      ← 演示
│   └── NotesTableView.swift          │   │   ├── settings/          ← 设置
├── Business/ (14 files)              │   │   └── shared/            ← 共享组件
│   ├── Note.swift                    │   ├── stores/                ← 状态管理
│   ├── Storage.swift                 │   │   ├── notes-store.ts
│   └── Markdown.swift                │   │   ├── editor-store.ts
├── Helpers/ (25 files)               │   │   └── settings-store.ts
│   ├── Theme.swift                   │   ├── services/              ← IPC/工具
│   ├── UserDefaultsManagement.swift  │   │   ├── tauri-bridge.ts
│   └── NotesTextProcessor.swift      │   │   └── formatter.ts
├── Extensions/ (14 files)            │   ├── i18n/                  ← 国际化
│   └── NSColor+, String+, URL+...   │   │   ├── en.json
├── Resources/                        │   │   ├── zh-Hans.json
│   ├── Images.xcassets               │   │   ├── zh-Hant.json
│   ├── zh-Hans.lproj/                │   │   └── ja.json
│   ├── en.lproj/                     │   ├── types/
│   └── Fonts/                        │   └── styles/
└── Package.swift                     │       └── globals.css
                                      ├── src-tauri/                 ← Rust 后端
                                      │   ├── src/
                                      │   │   ├── lib.rs             ← Tauri 入口
                                      │   │   ├── commands/mod.rs    ← IPC 命令
                                      │   │   ├── models/mod.rs      ← 数据模型
                                      │   │   └── services/
                                      │   │       ├── storage.rs     ← 文件 I/O
                                      │   │       └── watcher.rs     ← FS 监控
                                      │   ├── Cargo.toml
                                      │   └── tauri.conf.json
                                      ├── .github/workflows/
                                      │   └── build.yml              ← CI/CD
                                      ├── package.json
                                      └── vite.config.ts
```

**关键差异**：

1. 原版按角色分目录（Controller/View/Model），重构版按功能分目录（editor/preview/sidebar）
2. 原版 100+ 个 Swift 文件，重构版 ~20 个核心文件（Web 框架抽象层次更高）
3. 原版单进程直接调用，重构版 IPC 桥接（JS invoke → Rust command）

---

## 5. 核心模块迁移详解

### 5.1 编辑器：NSTextView → CodeMirror 6

**原版方案**：
- 继承 `NSTextView`，自定义 `NSTextStorage`
- 手动实现 Markdown 语法高亮正则匹配
- Highlightr 桥接 highlight.js 做代码块高亮
- 手动管理 undo/redo、光标位置、选区

**重构版方案**：
- CodeMirror 6 作为编辑器核心
- `@codemirror/lang-markdown` 提供 Markdown 语法解析
- 自定义 CM6 扩展实现特色功能
- CM6 内置 undo/redo、搜索替换、括号匹配

**迁移自定义扩展**：

| 原版功能 | CM6 扩展实现 | 文件 |
|---------|-------------|------|
| Wiki-link `[[...]]` 高亮+点击 | `Decoration.widget` + `EditorView.domEventHandlers` | `wikilinks.ts` |
| 列表自动续行 | `keymap.of({ Enter })` 拦截 | `smart-lists.ts` |
| 快捷模板 `/time` `/table` 等 | `keymap.of({ Tab })` 补全 | `tab-snippets.ts` |
| Ctrl+B/I 格式化 | `keymap.of` 快捷键 | `text-formatting.ts` |
| 代码块高亮 | 预览侧 highlight.js | 预览 HTML 中引入 |

**关键经验**：CM6 的 Extension 系统比 NSTextView 的 delegate 模式更解耦，但学习曲线较陡。建议先通读 CM6 官方文档的 [Extension Guide](https://codemirror.net/docs/guide/)。

### 5.2 预览：WKWebView → iframe

**原版方案**：
- `WKWebView` 直接嵌入 AppKit 视图层级
- 通过 `evaluateJavaScript()` 双向通信
- 滚动同步：监听 `scrollViewDidScroll` → `window.scrollTo()`

**重构版方案**：
- `<iframe src="/preview.html">` 嵌入 React 组件树
- 通过 `postMessage` 双向通信
- 滚动同步：`window.postMessage({ type: 'scrollToLine' })`

**核心差异**：
- 原版 WKWebView 是 AppKit 原生视图，直接参与布局
- 重构版 iframe 需要手动管理通信，但 CSS 隔离更彻底
- 滚动同步方案从"像素级同步"改为"标题行级同步"（更可靠）

**踩坑**：预览模式下编辑器隐藏，TOC 点击需要直接向 iframe 发 postMessage，不能只派发事件到 Editor 组件：

```typescript
// 预览模式下直接操作 iframe
const iframe = document.querySelector('iframe') as HTMLIFrameElement;
iframe?.contentWindow?.postMessage({ type: 'scrollToLine', line }, '*');
```

### 5.3 Markdown 解析：CMarkGFM → pulldown-cmark

**原版**（Swift）：
```swift
import CMarkGFM
let node = cmark_parse_document(markdown, len, CMARK_OPT_DEFAULT)
let html = cmark_render_html(node, CMARK_OPT_UNSAFE, nil)
```

**重构版**（Rust）：
```rust
use pulldown_cmark::{Parser, Options, html};

let mut options = Options::empty();
options.insert(Options::ENABLE_TABLES);
options.insert(Options::ENABLE_FOOTNOTES);
options.insert(Options::ENABLE_STRIKETHROUGH);
options.insert(Options::ENABLE_TASKLISTS);

let parser = Parser::new_ext(&content, options);
let mut html_output = String::new();
html::push_html(&mut html_output, parser);
```

**sourcepos 注入**（关键差异）：
原版 CMarkGFM 原生支持 `data-sourcepos`，pulldown-cmark 不支持。重构版在 Rust 侧手动注入：

```rust
// 在 HTML 块级标签上注入 data-sourcepos="N" 属性
// 用于 TOC 点击跳转和预览→编辑器同步
let re = Regex::new(r#"<(p|h[1-6]|blockquote|pre|ul|ol|li|table)([^>]*)>"#)?;
let result = re.replace_all(&html, |caps: &Captures| {
    format!("<{} data-sourcepos=\"{}\"{}>", &caps[1], line_num, &caps[2])
});
```

### 5.4 文件操作：Foundation → Tauri IPC

**原版**（直接调用）：
```swift
// 读取
let content = try String(contentsOf: note.url, encoding: .utf8)
// 写入
try content.write(to: note.url, atomically: true, encoding: .utf8)
// 列出目录
let files = try FileManager.default.contentsOfDirectory(atPath: path)
```

**重构版**（IPC 桥接）：

Rust 侧：
```rust
#[tauri::command]
async fn read_note(path: String) -> Result<NoteContent, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(NoteContent { content, .. })
}

#[tauri::command]
async fn write_note(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| e.to_string())?;
    Ok(())
}
```

TypeScript 桥接：
```typescript
export async function readNote(path: string): Promise<NoteContent> {
  return invoke<NoteContent>('read_note', { path });
}
export async function writeNote(path: string, content: string): Promise<void> {
  return invoke('write_note', { path, content });
}
```

**关键差异**：
- 原版同步调用，重构版异步 IPC（需 await）
- 原版 FileManager 直接操作，重构版通过 Tauri command 桥接
- 重构版所有文件操作集中在 `tauri-bridge.ts`，方便统一错误处理

### 5.5 状态管理：单例+UserDefaults → Zustand

**原版方案**：
```swift
// 全局单例
class Storage { static let shared = Storage() }
class AppContext { static let shared = AppContext() }

// 配置持久化
UserDefaults.standard.set(value, forKey: "storage_path")
let path = UserDefaults.standard.string(forKey: "storage_path")
```

**重构版方案**：
```typescript
// Zustand store
const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  activeNote: null,
  selectNote: async (note) => { /* ... */ set({ activeNote: note }) },
}))

// 配置持久化 → Rust 后端
const useSettingsStore = create<SettingsState>((set) => ({
  config: defaultConfig,
  loadConfig: async () => {
    const config = await invoke<AppConfig>('get_config');
    set({ config, loaded: true });
  },
  updateConfig: async (partial) => {
    const newConfig = { ...get().config, ...partial };
    await invoke('save_config', { config: newConfig });
    set({ config: newConfig });
  },
}))
```

**设计原则**：
- 3 个 Store 职责明确：`notes-store`（数据）、`editor-store`（UI 状态）、`settings-store`（配置）
- Store 间通过 `getState()` 互相访问（避免循环依赖）
- 配置变更立即持久化到 Rust 后端

### 5.6 国际化：.lproj → i18next

**原版方案**：
```swift
// 本地化字符串
label.stringValue = NSLocalizedString("sidebar.allNotes", comment: "")

// 多语言包
Resources/
├── Base.lproj/Localizable.strings
├── zh-Hans.lproj/Localizable.strings
├── ja.lproj/Localizable.strings
```

**重构版方案**：
```typescript
// i18next + JSON
const { t } = useTranslation();
<span>{t('sidebar.allNotes')}</span>

// 语言文件
src/i18n/
├── en.json
├── zh-Hans.json
├── zh-Hant.json
└── ja.json
```

**迁移要点**：
- 原 5 种语言（含西班牙语），重构版暂 4 种
- i18next 支持运行时切换语言（`i18n.changeLanguage()`）
- JSON 格式支持嵌套 key（`toolbar.format`），比 .strings 文件更灵活

### 5.7 主题系统：NSAppearance → CSS Variables

**原版方案**：
```swift
// 基于 NSAppearance 动态颜色
extension NSColor {
    static var textPrimary: NSColor {
        NSApp.effectiveAppearance.isDarkMode ? NSColor(white: 0.9, alpha: 1) : NSColor(white: 0.15, alpha: 1)
    }
}
```

**重构版方案**：
```css
/* CSS Variables + .dark class */
:root {
  --bg-primary: #F5F5F5;
  --text-primary: #262626;
}
.dark {
  --bg-primary: #232832;
  --text-primary: #E8E8EB;
}
```

**迁移要点**：
- 原版 Theme.swift 中 ~30 个语义颜色 → CSS Variables 一一对应
- Dark 模式切换：原版跟随 NSApp.effectiveAppearance，重构版在 `<div>` 上 toggle `.dark` class
- CodeMirror 主题通过 `EditorView.theme()` 定义（非 CSS Variables）

### 5.8 自动保存：Debounced Write

**原版**：
```swift
// NSTextView delegate 回调 + Timer
func textDidChange(_ notification: Notification) {
    saveTimer?.invalidate()
    saveTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { _ in
        self.saveCurrentNote()
    }
}
```

**重构版**：
```typescript
// Zustand store + setTimeout
updateContent: (content, source) => {
  set({ activeContent: content, isDirty: true });
  const state = get();
  if (state.saveTimer) clearTimeout(state.saveTimer);
  const timer = setTimeout(() => {
    get().saveCurrentNote();
  }, 1500);
  set({ saveTimer: timer });
},
```

**设计一致**：两个版本都采用 1.5s 防抖保存策略。

---

## 6. 功能迁移状态总览

### 已迁移 ✓

| 功能 | 原版实现 | 重构版实现 | 备注 |
|------|---------|-----------|------|
| Markdown 编辑 | NSTextView | CodeMirror 6 | 更丰富的扩展生态 |
| 实时预览 | WKWebView | iframe | CSS 隔离更彻底 |
| 分屏视图 | NSSplitView | Allotment 组件 | |
| 演示模式 | Reveal.js | Reveal.js 4 | |
| 目录导航 (TOC) | OutlineHeaderView | TableOfContents | 行级跳转 |
| 自动排版 | Prettier (Swift) | Prettier (JS) | 保护图表代码块 |
| 新建笔记 | Cmd+N | Cmd+N + 工具栏按钮 | |
| 笔记搜索 | NSTableView filter | Rust 模糊搜索 | 评分排序 |
| 文件夹树 | NSOutlineView | React 递归渲染 | |
| 置顶笔记 | xattr .pin | pins.json | 跨平台兼容 |
| 版本历史 | ~/Library/.../Versions/ | ~/.config/MiaoYan/versions/ | |
| Wiki-link | WikilinkIndex | CM6 wikilinks.ts | 编辑器内点击跳转 |
| 智能列表 | NSTextView delegate | CM6 smart-lists.ts | 自动续行 |
| 快捷模板 | ShortcutTemplateManager | CM6 tab-snippets.ts | /time /table 等 |
| 深色模式 | NSAppearance | CSS Variables + .dark | |
| 国际化 | .lproj (5 种) | i18next JSON (4 种) | 暂缺西班牙语 |
| 设置面板 | PrefsWindowController | SettingsDialog | |
| 导出 | HTML/PDF/Image/PPT | HTML/Markdown/PDF/Image | 见 PDF 导出、图片导出行 |
| 文件监控 | FSEvents | notify crate (Rust) | |
| Toast 通知 | NSWindow | Toast.tsx | |
| PDF 导出 | PdfExportController | ExportMenu.tsx (window.print) | 系统打印对话框 |
| 图片导出 | MPreviewView+Export | ExportMenu.tsx (html2canvas) | PNG 截图导出 |
| 图片粘贴保存 | ClipboardManager+ImagesProcessor | image-paste.ts + Rust save_image | 自动保存到 /i/ 目录 |
| 图片悬停预览 | ImagePreviewManager | image-preview.ts (CM6 hoverTooltip) | 300ms 延迟 |
| 反向链接 | ContentViewController+WikilinkIndex | Backlinks.tsx + Rust get_backlinks | Cmd+Opt+I 切换 |
| 新建文件夹快捷键 | Cmd+Shift+N | Cmd+Shift+N | |
| 重命名快捷键 | Cmd+R | Cmd+R | 内联重命名 |
| 复制笔记 | Cmd+D | Cmd+D | |
| 无序列表快捷键 | Cmd+U | Cmd+U | |
| 有序列表快捷键 | Cmd+Shift+O | Cmd+Shift+O | |
| 搜索聚焦快捷键 | Cmd+F | Cmd+F | |

### 未迁移 ○

| 功能 | 原版实现 | 难度 | 优先级 |
|------|---------|------|--------|
| iCloud 同步 | CloudSyncManager | 高 | 低 |
| 加密笔记 | KeychainPasswordItem | 高 | 低 |
| 全局快捷键 | KeyboardShortcuts + Cmd+Opt+M | 中 | 中 |
| 笔记拖拽排序 | Drag & Drop | 低 | 中 |
| 西班牙语 | es.lproj | 低 | 低 |
| Sparkle 自动更新 | Sparkle framework | 中（Tauri 有 updater 插件） | 中 |
| 图片上传服务 | uPic/PicGo/Picsee/PicList | 中 | 中 |

---

## 7. 关键技术决策与踩坑记录

### 7.1 Tauri 2 vs Electron

**选择 Tauri 的原因**：
- 安装包体积：Tauri ~5MB vs Electron ~80MB
- 内存占用：Tauri ~30MB vs Electron ~150MB
- Rust 后端性能：文件扫描、Markdown 解析比 Node.js 快
- 安全模型：Tauri 2 的权限系统更细粒度

**代价**：
- Rust 学习曲线（但 IPC command 层代码量很小）
- 部分 npm 包不能直接用（需走 IPC）
- 社区生态不如 Electron 成熟

### 7.2 CodeMirror 6 vs Monaco Editor

**选择 CM6 的原因**：
- 专为编辑器设计的 Extension 系统
- Markdown 支持开箱即用（`@codemirror/lang-markdown`）
- 体积更小（~200KB vs Monaco ~3MB）
- 更适合 Markdown 编辑器场景

**代价**：
- 不支持多光标编辑（Monaco 支持）
- Extension 学习曲线陡峭
- 调试困难（Functional Reactive 编程模型）

### 7.3 踩坑记录

#### 问题 1：TOC 点击不跳转

**现象**：点击目录条目，编辑器和预览均无反应。

**根因**：
1. `Editor.tsx` 未监听 `editor-scroll-to-line` CustomEvent
2. 预览模式下编辑器隐藏，需直接向 iframe 发 postMessage

**修复**：
```typescript
// Editor.tsx - 监听事件
useEffect(() => {
  const handler = (e: Event) => {
    const line = (e as CustomEvent).detail.line;
    view.dispatch({ effects: EditorView.scrollIntoView(lineInfo.from) });
  };
  window.addEventListener('editor-scroll-to-line', handler);
  return () => window.removeEventListener('editor-scroll-to-line', handler);
}, []);

// App.tsx - 预览模式直接操作 iframe
const iframe = document.querySelector('iframe') as HTMLIFrameElement;
iframe?.contentWindow?.postMessage({ type: 'scrollToLine', line }, '*');
```

#### 问题 2：GitHub Actions CI 构建失败

**现象**：`dtolnay/rust-action` not found。

**根因**：Action 名称错误，应为 `dtolnay/rust-toolchain`。

**修复**：
```yaml
- uses: dtolnay/rust-toolchain@stable  # 正确
# - uses: dtolnay/rust-action@stable   # 错误
```

#### 问题 3：GITHUB_TOKEN 无权创建 Release

**现象**：`403 Resource not accessible by integration`。

**根因**：Tauri Action 需要显式 `contents: write` 权限。

**修复**：
```yaml
jobs:
  build-windows:
    permissions:
      contents: write  # 必须显式声明
```

#### 问题 4：Tauri 启动报旧路径错误

**现象**：启动时报 `MiaoYan-new` 路径相关错误。

**根因**：Rust 编译缓存中残留旧项目名。

**修复**：`rm -rf src-tauri/target` 清除编译缓存后重新构建。

#### 问题 5：排版功能保护图表代码块

**现象**：Prettier 格式化会破坏 mermaid/plantuml/markmap 代码块的缩进和格式。

**修复**：格式化前替换为占位符，格式化后恢复：
```typescript
let protectedContent = content.replace(
  /```(?:mermaid|plantuml|markmap)[\s\S]*?```/g,
  (match) => { protectedBlocks.push(match); return `___DIAGRAM_BLOCK_${n}___`; }
);
const formatted = await prettier.format(protectedContent, { parser: 'markdown', proseWrap: 'preserve' });
// 恢复图表块
```

#### 问题 6：排版按钮应为图标而非文字

**现象**：初版使用文字按钮"排版"，原版为 SVG 图标。

**修复**：从原版 `MiaoYan-main/Resources/Images.xcassets/icon_format.imageset/icon_format.svg` 提取 SVG path，用 `<svg>` 内联渲染。

#### 问题 7：工具栏按钮顺序

**原版顺序**（ViewController.swift 注释）：
```swift
// Recommended Order: List -> Format -> Split -> Preview -> Presentation
```

**重构版调整**：
```
Sidebar(List) → NewNote → Format → Edit → Split → Preview | TOC → Presentation → Export → Settings
```

### 7.4 IPC 通信模式

Tauri 2 的 IPC 采用 `invoke` 模式：

```typescript
// 前端调用
const result = await invoke<ReturnType>('command_name', { param1, param2 });

// Rust 接收
#[tauri::command]
async fn command_name(param1: String, param2: String) -> Result<ReturnType, String> {
    // ...
}
```

**注意事项**：
- Rust 侧参数名必须与 JS 侧 key 完全匹配（含 snake_case ↔ camelCase 转换）
- 所有 IPC 调用都是异步的，需要 await
- 错误通过 `Result<T, String>` 的 Err 变体返回
- 大文件传输避免走 IPC（使用 Tauri 的 asset protocol 或文件路径传递）

---

## 8. CI/CD 多平台构建

### 8.1 GitHub Actions 配置

```yaml
name: Build
on:
  push:
    tags: ['v*']      # 打 tag 触发
  workflow_dispatch:   # 手动触发

jobs:
  build-windows:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm run build
      - uses: tauri-apps/tauri-action@v0
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'MiaoYan ${{ github.ref_name }}'
          releaseDraft: true
          prerelease: false
          args: '--target x86_64-pc-windows-msvc'

  build-macos:
    runs-on: macos-latest
    # ... 同样步骤 ...
    # 两次 tauri-action 调用：
    # 1. args: '--target aarch64-apple-darwin'  (Apple Silicon)
    # 2. args: '--target x86_64-apple-darwin'  (Intel)

  build-linux:
    runs-on: ubuntu-latest
    # ... 额外步骤 ...
    - name: Install Linux dependencies
      run: |
        sudo apt-get update
        sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
          librsvg2-dev patchelf libgtk-3-dev libayatana-appindicator3-dev
```

### 8.2 发布流程

```bash
# 1. 提交代码
git add . && git commit -m "feat: xxx"

# 2. 打 tag
git tag v1.0.6

# 3. 推送
git push origin main --tags

# 4. GitHub Actions 自动构建三个平台
# 5. 产物自动上传到 GitHub Release (Draft)
# 6. 手动编辑 Release notes 后 Publish
```

### 8.3 产物清单

| 平台 | 产物 | 架构 |
|------|------|------|
| macOS | `.dmg` | aarch64 (Apple Silicon) |
| macOS | `.dmg` | x86_64 (Intel) |
| Windows | `.msi` + `.exe` | x86_64 |
| Linux | `.deb` + `.AppImage` | x86_64 |

---

## 9. 给迁移者的建议

### 9.1 迁移前的准备

1. **彻底理解原版架构**：不要急于写代码。先画出原版的模块依赖图、数据流图。
2. **确定迁移范围**：不是所有功能都要迁移。优先迁移核心功能，次要功能可后续迭代。
3. **选择技术栈**：根据团队技术储备和目标平台选择。Tauri 适合 Rust 友好团队，Electron 适合纯 JS 团队。
4. **设计 IPC 边界**：明确哪些逻辑放在前端，哪些放在后端。原则：文件 I/O、CPU 密集型放后端，UI 交互、轻量逻辑放前端。

### 9.2 迁移策略

1. **先骨架后血肉**：先搭好主布局、路由、状态管理框架，再逐个填充功能。
2. **按功能垂直切片**：不要按层迁移（先做完所有 Controller，再做所有 View），而是按功能（先做完编辑器，再做预览）。
3. **保持接口兼容**：原版的数据模型（Note、Project、Config）尽量保持相同字段名，减少认知负担。
4. **IPC 集中管理**：所有 Tauri invoke 调用放在 `tauri-bridge.ts`，方便统一错误处理和类型声明。

### 5.3 逐步验证

1. **每个功能迁移后立即测试**：不要攒一堆再验证。
2. **对照原版截图**：UI 还原度、交互一致性。
3. **关注边界情况**：空文件、大文件、特殊字符、文件被外部修改等。
4. **CI 尽早配置**：不要等最后再配，本地能跑不代表 CI 能跑。

### 9.4 常见陷阱

| 陷阱 | 说明 | 对策 |
|------|------|------|
| IPC 性能瓶颈 | 大文件通过 IPC 传输延迟高 | 传文件路径而非内容，或使用 asset protocol |
| CSS 隔离不足 | 编辑器样式污染预览 | 使用 iframe 隔离预览 |
| 异步陷阱 | 忘记 await IPC 调用 | TypeScript strict 模式 + ESLint 规则 |
| 路径差异 | macOS `/Users/` vs Windows `C:\` vs Linux `/home/` | Rust `dirs` crate 获取标准路径 |
| 字体缺失 | 原版内嵌字体，跨平台可能不存在 | 打包字体到 public/fonts/，CSS @font-face |
| 编译缓存 | 改项目名后 Rust 缓存残留旧名 | `rm -rf src-tauri/target` |
| macOS 权限 | 文件系统沙盒限制 | Tauri 2 capabilities 配置 |

### 9.5 性能优化建议

1. **大目录延迟加载**：笔记列表 >1000 时使用虚拟滚动（`@tanstack/react-virtual`）
2. **Markdown 解析缓存**：相同内容不重复解析
3. **文件监控节流**：避免短时间内多次重新扫描
4. **图片懒加载**：预览中图片使用 `loading="lazy"`
5. **Rust 侧并行**：文件扫描使用 `walkdir` + 并行过滤

### 9.6 代码量参考

| 模块 | 原版 (Swift) | 重构版 (TS+Rust) | 比率 |
|------|-------------|-----------------|------|
| 编辑器 | ~800 行 | ~300 行 | 37% |
| 预览 | ~600 行 | ~200 行 | 33% |
| 侧边栏 | ~500 行 | ~350 行 | 70% |
| 文件 I/O | ~400 行 | ~200 行 (Rust) | 50% |
| Markdown 解析 | ~200 行 | ~150 行 (Rust) | 75% |
| 设置 | ~600 行 | ~500 行 | 83% |
| 主题 | ~300 行 | ~200 行 (CSS) | 67% |
| **总计** | **~22,000 行** | **~4,300 行** | **20%** |

Web 框架抽象层次更高，代码量显著减少，但需要熟悉 React/Zustand/CM6 等生态。

---

## 附录：快捷键对照

| 快捷键 | 原版功能 | 重构版功能 |
|--------|---------|-----------|
| Cmd+1 | 切换文件夹侧边栏 | 切换侧边栏 |
| Cmd+2 | 切换笔记列表 | *(未映射)* |
| Cmd+3 | 切换预览模式 | 切换预览/分屏 |
| Cmd+4 | 演示模式 | 演示模式 |
| Cmd+N | 新建笔记 | 新建笔记 |
| Cmd+Shift+N | 新建文件夹 | 新建文件夹 |
| Cmd+Shift+L | 自动排版 | 自动排版 |
| Cmd+, | 设置 | 设置 |
| Cmd+Shift+E | *(未映射)* | 导出菜单 |
| Cmd+\\ | *(未映射)* | 循环视图模式 |
| Cmd+Opt+M | 全局唤起 | *(未迁移)* |
| Cmd+Opt+I | 文档属性/回链 | 反向链接面板 |
| Cmd+R | 重命名 | 重命名笔记 |
| Cmd+D | 复制笔记 | 复制笔记 |
| Cmd+F | 搜索 | 聚焦搜索框 |
