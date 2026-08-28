# MiaoYan 注册为 .md 默认编辑器 — 设计文档

日期：2026-08-27
状态：已确认（用户已批准方案 A）

## 需求

1. MiaoYan 支持注册为 `.md`（及 `.markdown`）文件的默认编辑器：双击文件用 MiaoYan 打开。
2. 右键 .md 文件时菜单中直接出现"使用 MiaoYan 打开"。
3. 注册途径两者都要：NSIS 安装包注册 + 应用内设置面板开关（运行时注册，仅手动触发）。
4. 双击打开的文件若不在当前文库（项目 / 额外文件夹）内，自动将其父文件夹加入 `extra_folders` 后打开（复用现有拖拽逻辑）。

### Windows 机制约束（已知限制）

Windows 10/11 不允许任何程序静默设置自己为默认应用。因此"双击即用"需要用户确认一次（"打开方式 → 始终使用"或"设置 → 默认应用"）。本设计保证：

- MiaoYan 出现在"打开方式"候选列表与"默认应用"设置页中；
- 右键菜单项"使用 MiaoYan 打开"无需任何确认、注册后直接可用。

## 方案概览（方案 A）

| 层 | 手段 |
|---|---|
| 安装包 | `bundle.fileAssociations`，NSIS bundler 自动注册 ProgID / OpenWithProgids，卸载自动清理 |
| 单实例 | `tauri-plugin-single-instance`，已运行时把文件路径转发给主实例 |
| 路径接收 | 拉取式：Rust 暂存待打开路径，前端初始化完成后 `invoke` 取走 |
| 运行时注册 | `winreg`（HKCU，无需管理员），设置面板开关控制注册/注销 |
| 前端 | 抽取 `openExternalFile(path)` 复用拖拽的"纳入文库"逻辑；设置面板新增开关 |

## 详细设计

### 1. 安装包注册（tauri.conf.json）

`src-tauri/tauri.conf.json` 的 `bundle` 节点新增：

```json
"fileAssociations": [
  {
    "ext": ["md", "markdown"],
    "mimeType": "text/markdown",
    "name": "MiaoYan Markdown",
    "description": "Markdown Document",
    "role": "Editor"
  }
]
```

- Tauri NSIS bundler 据此写入 ProgID 与 `.md/.markdown` 的 `OpenWithProgids`，卸载时清理。
- MSI 不支持 fileAssociations（Tauri 限制），以 NSIS 为安装包主力；不影响功能，仅 MSI 安装后需依赖应用内开关注册。

### 2. 单实例与文件路径接收（Rust）

依赖新增：

```toml
tauri-plugin-single-instance = "2"

[target.'cfg(windows)'.dependencies]
winreg = "0.56"
```

`lib.rs`：

- 注册 `tauri_plugin_single_instance`，回调中解析 `args`，筛选以 `.md` / `.markdown` 结尾的路径，写入 `ManagedState`。
- 冷启动（由文件关联直接拉起）：`setup` 中解析 `std::env::args`，同样写入 `ManagedState`。

`ManagedState` 结构：

```rust
pub struct PendingOpenFiles(Mutex<Vec<String>>);
```

新增命令：

```rust
#[tauri::command]
fn get_pending_open_files(state: State<PendingOpenFiles>) -> Vec<String> // 返回并清空
```

采用拉取式而非事件推送：避免 webview 未就绪时事件丢失；前端初始化完成后调用即可，时序确定。

### 3. 运行时注册（services/file_association.rs，`#[cfg(windows)]`）

新增两个命令：

- `get_md_association_status() -> bool`：检查 `HKCU\Software\Classes\MiaoYan.md` 与 `.md\OpenWithProgids\MiaoYan.md` 是否存在。
- `set_md_association(enabled: bool)`：注册或注销。
- 非 Windows 平台：提供空实现（返回 `false` / no-op），前端按平台隐藏开关。

注册写入的键（全部 HKCU，exe 路径取 `std::env::current_exe()`）：

| 键 | 内容 | 作用 |
|---|---|---|
| `Software\Classes\MiaoYan.md` | `shell\open\command = "<exe>" "%1"`、`DefaultIcon = "<exe>,0"` | ProgID 定义 |
| `Software\Classes\.md\OpenWithProgids\MiaoYan.md`（.markdown 同理） | 空值 | 出现在"打开方式"列表 |
| `Software\MiaoYan\Capabilities` | `ApplicationName`、`ApplicationDescription`、`FileAssociations\.md = MiaoYan.md` | 能力声明 |
| `Software\RegisteredApplications\MiaoYan` | `= Software\MiaoYan\Capabilities` | 出现在 Windows 默认应用设置页 |
| `Software\Classes\SystemFileAssociations\.md\shell\MiaoYan`（.markdown 同理） | `(默认) = 使用 MiaoYan 打开`、`command = "<exe>" "%1"`、`Icon` | 右键菜单直接出现菜单项 |

注销：删除上述由本应用写入的键（`Software\Classes\MiaoYan.md`、两个 `SystemFileAssociations` shell 项、`RegisteredApplications` 值、`OpenWithProgids` 值、`Capabilities`），不触碰其他应用的注册项。

### 4. 前端

**App.tsx**

- 初始化完成后（配置加载后）调用 `get_pending_open_files`；对每个路径调用 `openExternalFile(path)`。
- 将现有 `onDragDropEvent` 处理中"外部文件纳入文库 + 打开"的逻辑抽取为共享函数 `openExternalFile(path)`：
  - 文件已属于当前项目或某个 `extra_folder` → 直接打开（走 `selectNote` / `switchTab`）；
  - 否则把其父文件夹加入 `config.extra_folders`、`saveConfig`、`refreshNotes`、`setActiveFolder`、`openTemporaryFile(path)`（与拖拽行为一致）；
  - 路径不存在或后缀不符 → `write_log` 记日志并跳过；
  - 文件已在标签页中 → 仅激活该标签。
- 监听 single-instance 转发场景：Rust 在回调中对已运行实例同样以 `emit` + 写 state 双通道；前端在已有拉取逻辑外，额外 `listen('miaoyan://open-files')` 事件触发再次拉取，保证已运行时即时打开。

**SettingsDialog.tsx**

- 新增开关"关联 .md / .markdown 文件（注册为默认编辑器）"，仅 `platform === 'win32'` 时显示；
- 打开设置时调用 `get_md_association_status` 显示当前状态；
- 切换时调用 `set_md_association`，失败时 `console.error` 记录且开关不更新（设置对话框无 toast 基础设施）。

**i18n**

5 个语言文件（zh-Hans / zh-Hant / en / ja / es）新增键：开标题、说明文案、设为默认应用的提示文案。

### 5. 错误处理

| 场景 | 处理 |
|---|---|
| 文件路径不存在 | 记日志，跳过 |
| 后缀非 .md/.markdown | 忽略 |
| 文件已在标签页打开 | 激活标签，不重复打开 |
| 注册表写入失败（权限等） | 命令返回错误，前端 `console.error` 记录、开关保持原状态（设置对话框无 toast 基础设施） |
| 便携版被移动/重命名 | 注册表中 exe 路径失效；开关打开时以 `current_exe()` 重写覆盖修复 |

## 测试计划

1. `cargo check`（Windows 目标）通过。
2. `npm run build` 通过。
3. 本地构建 NSIS 安装包，手动验证：
   - 安装后右键 .md → "打开方式"列表出现 MiaoYan；
   - 设置面板打开关联开关 → 右键菜单直接出现"使用 MiaoYan 打开"；
   - 设为默认后双击 .md：冷启动与已运行两种情况均打开该文件；
   - 文库外文件：自动纳入额外文件夹并打开；
   - 关闭开关 → 右键菜单项消失。

## 假设与约束

- 仅 Windows 平台实现运行时注册；macOS 依赖安装包 fileAssociations（CFBundleDocumentTypes 由 Tauri 自动处理）。
- 用户确认默认应用的一次性操作由 Windows 系统完成，应用不模拟。
- `.txt` 等其他后缀不在本次范围。
