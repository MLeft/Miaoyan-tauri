# .md 默认编辑器注册 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让 MiaoYan 支持注册为 .md/.markdown 默认编辑器（双击打开 + 右键"Open with MiaoYan"），安装包与应用内开关双通道注册。

**Architecture:** 安装包层走 `bundle.fileAssociations`（NSIS 自动注册）；运行时层用 `winreg` 写 HKCU 注册表（ProgID / OpenWithProgids / Capabilities / SystemFileAssociations 右键菜单）；文件路径通过 `tauri-plugin-single-instance` + 启动 argv 收集到 `PendingOpenFiles` state，前端拉取后复用拖拽的"纳入文库"逻辑打开。

**Tech Stack:** Tauri 2.x（Rust，winreg 0.56、tauri-plugin-single-instance 2）、React 19 + TypeScript、Zustand、i18next

**Spec:** `docs/superpowers/specs/2026-08-27-md-default-editor-design.md`

**项目约束（来自 dev_note，必须遵守）：**
- 构建只用 `npx tauri build --no-bundle`，禁止裸 `cargo build --release`（§2.1）
- Rust 改动提交前必须 `cargo check` 同步 Cargo.lock（§3-2）
- 设置面板样式用内联 style，不用动态 Tailwind class（坑点 #1）
- Write 工具写文件后立即检查是否出现重复内容（坑点 #2）
- Windows 路径注意反斜杠兼容（坑点 #9），本计划在 Rust 侧统一归一化为 `/`
- 提交前 `git status --short` 排查临时产物（坑点 #6）
- 本项目无前端测试框架；Rust 侧用 `cargo test` 做单测，其余靠构建 + 手工验证

---

## Task 1: 配置与依赖

**Files:**
- Modify: `src-tauri/tauri.conf.json`（bundle 节点）
- Modify: `src-tauri/Cargo.toml`（dependencies）

- [x] **Step 1: tauri.conf.json 增加 fileAssociations**

在 `bundle` 节点内、`"targets": "all"` 之后插入：

```json
    "fileAssociations": [
      {
        "ext": ["md", "markdown"],
        "mimeType": "text/markdown",
        "name": "MiaoYan Markdown",
        "description": "Markdown Document",
        "role": "Editor"
      }
    ],
```

即 bundle 变为：

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "fileAssociations": [
      {
        "ext": ["md", "markdown"],
        "mimeType": "text/markdown",
        "name": "MiaoYan Markdown",
        "description": "Markdown Document",
        "role": "Editor"
      }
    ],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
```

- [x] **Step 2: Cargo.toml 增加依赖**

在 `tauri-plugin-process = "2"` 行后追加：

```toml
tauri-plugin-single-instance = "2"
```

在文件末尾（最后一个依赖之后）追加 Windows 专属依赖：

```toml

[target.'cfg(windows)'.dependencies]
winreg = "0.56"
```

- [x] **Step 3: cargo check 验证依赖可解析**

Run: `Set-Location d:\code\Miaoyan-tauri\src-tauri; cargo check`
Expected: 编译报错仅来自尚未创建的模块引用（本任务不改代码则应直接通过）；winreg / single-instance 依赖成功下载（走 rsproxy 镜像）。此步同时同步 Cargo.lock。

- [x] **Step 4: Commit**

```powershell
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: add fileAssociations config + single-instance/winreg deps"
```

---

## Task 2: Rust 文件关联模块（commands/file_association.rs）

**Files:**
- Create: `src-tauri/src/commands/file_association.rs`
- Modify: `src-tauri/src/commands/mod.rs`（文件开头加两行）

- [x] **Step 1: 创建 `src-tauri/src/commands/file_association.rs`，完整内容如下**

```rust
use std::sync::Mutex;

/// 待打开文件路径（文件关联双击冷启动 / 单实例转发）
pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

const MARKDOWN_EXTS: &[&str] = &[".md", ".markdown"];

fn is_markdown_path(p: &str) -> bool {
    let lower = p.to_lowercase();
    MARKDOWN_EXTS.iter().any(|ext| lower.ends_with(ext))
}

/// 从启动参数中提取 .md/.markdown 文件：跳过 argv[0]，反斜杠归一化为 /，只保留存在的文件
pub fn collect_markdown_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| is_markdown_path(a))
        .map(|a| a.replace('\\', "/"))
        .filter(|a| std::path::Path::new(a).exists())
        .collect()
}

#[tauri::command]
pub fn get_pending_open_files(state: tauri::State<PendingOpenFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
pub fn get_md_association_status() -> bool {
    #[cfg(windows)]
    {
        win::is_registered()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub fn set_md_association(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            win::register()
        } else {
            win::unregister()
        }
    }
    #[cfg(not(windows))]
    {
        Err("File association registration is only supported on Windows".to_string())
    }
}

#[cfg(windows)]
mod win {
    use winreg::enums::*;
    use winreg::RegKey;

    const PROG_ID: &str = "MiaoYan.md";
    const EXTS: &[&str] = &[".md", ".markdown"];
    const CAPABILITIES_KEY: &str = "Software\\MiaoYan\\Capabilities";

    fn exe_command(exe: &str) -> String {
        format!("\"{}\" \"%1\"", exe)
    }

    fn current_exe() -> Result<String, String> {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| format!("Failed to get exe path: {}", e))
    }

    pub fn is_registered() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let prog_ok = hkcu
            .open_subkey(format!("Software\\Classes\\{}", PROG_ID))
            .is_ok();
        let openwith_ok = hkcu
            .open_subkey("Software\\Classes\\.md\\OpenWithProgids")
            .and_then(|k| k.open_subkey(PROG_ID))
            .is_ok();
        prog_ok && openwith_ok
    }

    pub fn register() -> Result<(), String> {
        let exe = current_exe()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let io = |e: std::io::Error, ctx: &str| format!("{}: {}", ctx, e);

        // ProgID：MiaoYan.md
        let (prog, _) = hkcu
            .create_subkey(format!("Software\\Classes\\{}", PROG_ID))
            .map_err(|e| io(e, "Failed to create ProgID"))?;
        prog.set_value("", &"Markdown Document")
            .map_err(|e| io(e, "Failed to set ProgID default value"))?;
        let (cmd, _) = hkcu
            .create_subkey(format!("Software\\Classes\\{}\\shell\\open\\command", PROG_ID))
            .map_err(|e| io(e, "Failed to create open command"))?;
        cmd.set_value("", &exe_command(&exe))
            .map_err(|e| io(e, "Failed to set open command"))?;
        let (icon, _) = hkcu
            .create_subkey(format!("Software\\Classes\\{}\\DefaultIcon", PROG_ID))
            .map_err(|e| io(e, "Failed to create DefaultIcon"))?;
        icon.set_value("", &format!("{},0", exe))
            .map_err(|e| io(e, "Failed to set DefaultIcon"))?;

        for ext in EXTS {
            // "打开方式"候选列表
            let (ow, _) = hkcu
                .create_subkey(format!("Software\\Classes\\{}\\OpenWithProgids", ext))
                .map_err(|e| io(e, "Failed to create OpenWithProgids"))?;
            ow.create_subkey(PROG_ID)
                .map_err(|e| io(e, "Failed to register OpenWithProgids entry"))?;
            // 右键菜单直接项 "Open with MiaoYan"
            let shell_key = format!(
                "Software\\Classes\\SystemFileAssociations\\{}\\shell\\MiaoYan",
                ext
            );
            let (shell, _) = hkcu
                .create_subkey(&shell_key)
                .map_err(|e| io(e, "Failed to create context menu key"))?;
            shell
                .set_value("", &"Open with MiaoYan")
                .map_err(|e| io(e, "Failed to set context menu label"))?;
            shell
                .set_value("Icon", &format!("{},0", exe))
                .map_err(|e| io(e, "Failed to set context menu icon"))?;
            let (scmd, _) = hkcu
                .create_subkey(format!("{}\\command", shell_key))
                .map_err(|e| io(e, "Failed to create context menu command"))?;
            scmd.set_value("", &exe_command(&exe))
                .map_err(|e| io(e, "Failed to set context menu command"))?;
        }

        // Capabilities + RegisteredApplications → 出现在 Windows 设置 → 默认应用
        let (caps, _) = hkcu
            .create_subkey(CAPABILITIES_KEY)
            .map_err(|e| io(e, "Failed to create Capabilities"))?;
        caps.set_value("ApplicationName", &"MiaoYan")
            .map_err(|e| io(e, "Failed to set ApplicationName"))?;
        caps.set_value("ApplicationDescription", &"Markdown Editor")
            .map_err(|e| io(e, "Failed to set ApplicationDescription"))?;
        let (fa, _) = hkcu
            .create_subkey(format!("{}\\FileAssociations", CAPABILITIES_KEY))
            .map_err(|e| io(e, "Failed to create FileAssociations"))?;
        for ext in EXTS {
            fa.set_value(*ext, &PROG_ID)
                .map_err(|e| io(e, "Failed to set FileAssociations entry"))?;
        }
        let (ra, _) = hkcu
            .create_subkey("Software\\RegisteredApplications")
            .map_err(|e| io(e, "Failed to open RegisteredApplications"))?;
        ra.set_value("MiaoYan", &CAPABILITIES_KEY)
            .map_err(|e| io(e, "Failed to register in RegisteredApplications"))?;

        Ok(())
    }

    pub fn unregister() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        // 逐项删除，单个键不存在时忽略；只清理本应用写入的内容
        let _ = hkcu.delete_subkey_all(format!("Software\\Classes\\{}", PROG_ID));
        for ext in EXTS {
            if let Ok(ow) = hkcu.open_subkey_with_flags(
                format!("Software\\Classes\\{}\\OpenWithProgids", ext),
                KEY_WRITE,
            ) {
                let _ = ow.delete_subkey(PROG_ID);
            }
            let _ = hkcu.delete_subkey_all(format!(
                "Software\\Classes\\SystemFileAssociations\\{}\\shell\\MiaoYan",
                ext
            ));
        }
        let _ = hkcu.delete_subkey_all("Software\\MiaoYan");
        if let Ok(ra) =
            hkcu.open_subkey_with_flags("Software\\RegisteredApplications", KEY_WRITE)
        {
            let _ = ra.delete_value("MiaoYan");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_markdown_path_matches_extensions() {
        assert!(is_markdown_path("note.md"));
        assert!(is_markdown_path("NOTE.MARKDOWN"));
        assert!(is_markdown_path("D:\\docs\\a.Md"));
        assert!(!is_markdown_path("a.txt"));
        assert!(!is_markdown_path("a.mdx"));
        assert!(!is_markdown_path("md"));
    }

    #[test]
    fn collect_markdown_args_filters_and_normalizes() {
        let dir = std::env::temp_dir().join("miaoyan_test_collect");
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("note.md");
        std::fs::write(&md, "# hi").unwrap();
        let txt = dir.join("note.txt");
        std::fs::write(&txt, "x").unwrap();

        let args = vec![
            "miaoyan.exe".to_string(),
            md.to_string_lossy().to_string(),
            txt.to_string_lossy().to_string(),
            dir.join("missing.md").to_string_lossy().to_string(),
        ];
        let result = collect_markdown_args(&args);
        assert_eq!(
            result,
            vec![md.to_string_lossy().to_string().replace('\\', "/")]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [x] **Step 2: commands/mod.rs 开头挂载子模块**

在 `src-tauri/src/commands/mod.rs` 第一行之前插入：

```rust
pub mod file_association;
pub use file_association::*;
```

- [x] **Step 3: cargo test 验证**

Run: `Set-Location d:\code\Miaoyan-tauri\src-tauri; cargo test file_association`
Expected: 2 个测试 PASS。若报 `winreg` 相关编译错误，检查 Task 1 的 `[target.'cfg(windows)'.dependencies]` 是否写对。

- [x] **Step 4: Commit**

```powershell
git add src-tauri/src/commands/file_association.rs src-tauri/src/commands/mod.rs
git commit -m "feat: add file association module (pending files + HKCU registry)"
```

---

## Task 3: lib.rs 接线（单实例 + 冷启动收集 + 命令注册）

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: 修改 lib.rs**

将 `use tauri::Manager;` 一行改为：

```rust
use tauri::{Emitter, Manager};
```

在 `.plugin(tauri_plugin_opener::init())` 之前（即 `tauri::Builder::default()` 之后的第一个 plugin 位置）插入：

```rust
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = file_association::collect_markdown_args(&args);
            if !paths.is_empty() {
                let state = app.state::<file_association::PendingOpenFiles>();
                state.0.lock().unwrap().extend(paths);
                let _ = app.emit("miaoyan://open-files", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
```

在 `.plugin(tauri_plugin_process::init())` 之后、`.setup(...)` 之前插入：

```rust
        .manage(file_association::PendingOpenFiles(std::sync::Mutex::new(Vec::new())))
```

在 `setup` 闭包开头（`#[cfg(desktop)]` 块之前）插入：

```rust
            // 冷启动：由文件关联拉起时，从启动参数收集 .md/.markdown 路径
            let args: Vec<String> = std::env::args().collect();
            let paths = file_association::collect_markdown_args(&args);
            if !paths.is_empty() {
                let state = app.state::<file_association::PendingOpenFiles>();
                *state.0.lock().unwrap() = paths;
            }
```

在 `invoke_handler` 的命令列表末尾（`delete_annotations,` 之后）追加：

```rust
            get_pending_open_files,
            get_md_association_status,
            set_md_association,
```

- [x] **Step 2: cargo check + cargo test**

Run: `Set-Location d:\code\Miaoyan-tauri\src-tauri; cargo check; cargo test file_association`
Expected: check 通过、测试 2 PASS。

- [x] **Step 3: Commit**

```powershell
git add src-tauri/src/lib.rs
git commit -m "feat: wire single-instance forwarding and cold-start file args"
```

---

## Task 4: 前端 tauri-bridge 封装

**Files:**
- Modify: `src/services/tauri-bridge.ts`（文件末尾追加）

- [x] **Step 1: 追加封装函数**

在 `tauri-bridge.ts` 末尾（`deleteAnnotations` 之后）追加：

```ts
/* ── File association / open-with (Windows) ── */

export async function getPendingOpenFiles(): Promise<string[]> {
  return invoke<string[]>('get_pending_open_files');
}

export async function getMdAssociationStatus(): Promise<boolean> {
  return invoke<boolean>('get_md_association_status');
}

export async function setMdAssociation(enabled: boolean): Promise<void> {
  return invoke('set_md_association', { enabled });
}
```

- [x] **Step 2: 类型检查**

Run: `Set-Location d:\code\Miaoyan-tauri; npx tsc --noEmit`
Expected: 无错误。

- [x] **Step 3: Commit**

```powershell
git add src/services/tauri-bridge.ts
git commit -m "feat: add tauri-bridge wrappers for file association commands"
```

---

## Task 5: App.tsx —— openExternalFile 抽取 + 待打开文件处理

**Files:**
- Modify: `src/App.tsx`

- [x] **Step 1: 增加 import**

在 App.tsx 第 4 行 `import { stat } from '@tauri-apps/plugin-fs';` 之后插入：

```ts
import { listen } from '@tauri-apps/api/event';
```

将第 20 行的 tauri-bridge import 改为：

```ts
import { createNote, createFolder, setAlwaysOnTop, writeNote, getPendingOpenFiles } from './services/tauri-bridge';
```

- [x] **Step 2: 在 App 组件定义之前（`export default function App()` 上方）新增模块级函数**

```tsx
// 外部 .md 文件打开：不在文库内时自动把父文件夹加入额外文件夹（复用拖拽逻辑）
async function openExternalFile(path: string) {
  const folder = path.substring(0, path.lastIndexOf('/'));
  const current = useSettingsStore.getState().config;
  if (!folder.startsWith(current.storage_path) && !current.extra_folders.includes(folder)) {
    await useSettingsStore.getState().updateConfig({
      extra_folders: [...current.extra_folders, folder],
    });
  }
  await useNotesStore.getState().refreshNotes(current.storage_path);
  useNotesStore.getState().setActiveFolder(folder, current.storage_path);
  useNotesStore.getState().openTemporaryFile(path);
}
```

- [x] **Step 3: 拖拽处理复用新函数**

将 `onDragDropEvent` 处理中文件分支（约 505-517 行，`} else {` 内 `const folder = ...` 到 `log(\`Added folder ...\`)`）替换为：

```ts
                await openExternalFile(path);
                log(`Opened dropped file: ${path}`);
```

即整个 `} else {` 分支变为：

```ts
              } else {
                await openExternalFile(path);
                log(`Opened dropped file: ${path}`);
              }
```

（保留前面的 `BINARY_EXTENSIONS` 判断与 toast 分支不变。）

- [x] **Step 4: 新增"文件关联打开" effect**

在拖拽 effect（`}...}, []);`）之后、Deep-link handler 注释之前插入：

```tsx
  // 文件关联打开：冷启动参数 + 单实例转发（双击 .md 文件）
  useEffect(() => {
    if (!loaded) return;
    let unlisten: (() => void) | undefined;
    const processPending = async () => {
      try {
        const paths = await getPendingOpenFiles();
        for (const path of paths) {
          try {
            const info = await stat(path);
            if (info.isDirectory) continue;
            await openExternalFile(path);
            log(`Opened file from association: ${path}`);
          } catch (e) {
            log(`Failed to open associated file ${path}: ${e}`);
          }
        }
      } catch (e) {
        console.error('Failed to get pending open files:', e);
      }
    };
    processPending();
    listen('miaoyan://open-files', processPending)
      .then((fn) => { unlisten = fn; })
      .catch((e) => console.error('Failed to listen open-files event:', e));
    return () => { unlisten?.(); };
  }, [loaded]);
```

（`stat` 与 `log` 均已在 App.tsx 现有 import 中，拖拽处理里已在用。）

- [x] **Step 5: 类型检查**

Run: `Set-Location d:\code\Miaoyan-tauri; npx tsc --noEmit`
Expected: 无错误。

- [x] **Step 6: Commit**

```powershell
git add src/App.tsx
git commit -m "feat: open .md from file association, reuse drop logic for external files"
```

---

## Task 6: 设置面板开关 + i18n

**Files:**
- Modify: `src/components/settings/SettingsDialog.tsx`
- Modify: `src/i18n/zh-Hans.json`、`zh-Hant.json`、`en.json`、`ja.json`、`es.json`

- [x] **Step 1: SettingsDialog import 与状态**

将文件第 5 行的 import 扩展：

```ts
import { setAlwaysOnTop, detectCloudSync, getMdAssociationStatus, setMdAssociation, type CloudSyncInfo } from '../../services/tauri-bridge';
```

在 `const [cloudInfo, setCloudInfo] = useState<CloudSyncInfo | null>(null);` 之后插入：

```tsx
  const isWindows = navigator.userAgent.includes('Windows');
  const [mdAssociated, setMdAssociated] = useState(false);
```

在现有 `useEffect(() => { detectCloudSync()... }, []);` 之后插入：

```tsx
  useEffect(() => {
    if (!isWindows) return;
    getMdAssociationStatus().then(setMdAssociated).catch(() => {});
  }, [isWindows]);
```

- [x] **Step 2: interface 标签页新增开关行**

在 `quickLaunch` 的 Row 结束处（`</Row>` 之后、interface 面板收尾的 `</div>\n            )}` 之前）插入：

```tsx
                {isWindows && (
                  <Row label={`${t('settings.fileAssociation')}:`}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <MacSelect
                        value={mdAssociated ? 'yes' : 'no'}
                        onChange={async (v) => {
                          const enabled = v === 'yes';
                          try {
                            await setMdAssociation(enabled);
                            setMdAssociated(enabled);
                          } catch (e) {
                            console.error('Failed to set file association:', e);
                          }
                        }}
                        options={[
                          { value: 'yes', label: t('settings.yes') },
                          { value: 'no', label: t('settings.no') },
                        ]}
                      />
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', maxWidth: CONTROL_WIDTH, lineHeight: '16px' }}>
                        {t('settings.fileAssociationHint')}
                      </span>
                    </div>
                  </Row>
                )}
```

（遵循坑点 #1：样式全部内联。）

- [x] **Step 3: 五个语言文件加键**

每个文件的 `settings` 段，在 `"alwaysOnTop": "...",` + `"yes": "...",` 两行之后插入（锚点两行保留，追加在其后）：

`zh-Hans.json`：
```json
    "alwaysOnTop": "置顶显示",
    "yes": "是",
    "fileAssociation": "关联 Markdown 文件",
    "fileAssociationHint": "注册后右键菜单出现 Open with MiaoYan；设为默认应用需在 Windows 设置中确认一次",
```

`zh-Hant.json`：
```json
    "alwaysOnTop": "置頂顯示",
    "yes": "是",
    "fileAssociation": "關聯 Markdown 檔案",
    "fileAssociationHint": "註冊後右鍵選單出現 Open with MiaoYan；設為預設應用需在 Windows 設定中確認一次",
```

`en.json`：
```json
    "alwaysOnTop": "Always on Top",
    "yes": "Yes",
    "fileAssociation": "Markdown File Association",
    "fileAssociationHint": "Adds 'Open with MiaoYan' to the right-click menu. Setting as default app requires one confirmation in Windows Settings.",
```

`ja.json`：
```json
    "alwaysOnTop": "最前面表示",
    "yes": "はい",
    "fileAssociation": "Markdown ファイルの関連付け",
    "fileAssociationHint": "登録すると右クリックメニューに Open with MiaoYan が表示されます。既定のアプリにするには Windows の設定で一度確認が必要です。",
```

`es.json`：
```json
    "alwaysOnTop": "Siempre encima",
    "yes": "Sí",
    "fileAssociation": "Asociación de archivos Markdown",
    "fileAssociationHint": "Añade 'Open with MiaoYan' al menú contextual. Establecer como predeterminada requiere una confirmación en Configuración de Windows.",
```

- [x] **Step 4: 验证**

Run: `Set-Location d:\code\Miaoyan-tauri; npx tsc --noEmit; node -e "['zh-Hans','zh-Hant','en','ja','es'].forEach(l=>JSON.parse(require('fs').readFileSync('src/i18n/'+l+'.json','utf8')));console.log('i18n OK')"`
Expected: tsc 无错误；输出 `i18n OK`。

- [x] **Step 5: Commit**

```powershell
git add src/components/settings/SettingsDialog.tsx src/i18n
git commit -m "feat: settings toggle for .md file association + i18n"
```

---

## Task 7: 构建、部署与手工验证

**Files:** 无新增代码

- [x] **Step 1: 完整构建（禁止裸 cargo build，dev_note §2.1）**

Run: `Set-Location d:\code\Miaoyan-tauri; npx tauri build --no-bundle`
Expected: 构建成功。若秒级"完成"，按 §2.2 检查 `src-tauri\target\release\miaoyan.exe` 的 LastWriteTime 晚于 `dist\index.html`，否则删除 `target\release\.fingerprint\miaoyan*` 重编。

- [x] **Step 2: 部署到安装目录（§2.3）**

```powershell
taskkill /IM miaoyan.exe /F
Copy-Item src-tauri\target\release\miaoyan.exe "$env:LOCALAPPDATA\MiaoYan\miaoyan.exe" -Force
Start-Process "$env:LOCALAPPDATA\MiaoYan\miaoyan.exe"
```

- [x] **Step 3: 验证三件套（§2.3）**

1. `Get-Process miaoyan | Select-Object Path` → 指向 `$env:LOCALAPPDATA\MiaoYan`
2. 窗口加载 `tauri.localhost`（非 localhost:1420）
3. 手工功能验证（见 Step 4）

- [ ] **Step 4: 功能手工验证清单（请用户人工确认）**

1. 设置 → 界面 → "关联 Markdown 文件"选"是"；
2. 注册表核验：`reg query "HKCU\Software\Classes\MiaoYan.md\shell\open\command"` 输出含当前 exe 路径；
3. 资源管理器右键任一 .md 文件 → 出现 "Open with MiaoYan" 菜单项，点击后用 MiaoYan 打开该文件；
4. 文库外的 .md 文件：打开后其父文件夹自动出现在目录树（额外文件夹）；
5. MiaoYan 已运行时，再次通过右键菜单/命令行打开另一个 .md → 同一实例新标签打开，窗口置前；
6. 设置里选"否" → 右键菜单项消失（`reg query "HKCU\Software\Classes\SystemFileAssociations\.md\shell\MiaoYan"` 报找不到）；
7. "设为默认应用"路径：右键 .md → 打开方式 → 选择其他应用 → 列表中出现 MiaoYan（来自 OpenWithProgids）；用户确认"始终"后双击 .md 直接拉起（冷启动与已运行两种都验证）。

- [ ] **Step 5: 最终提交（如有验证中微调）**

```powershell
git status --short   # 排查临时产物（坑点 #6）
git add -A; git commit -m "fix: adjustments from manual verification"   # 仅在确有改动时
```

> 版本发布不在本计划范围；用户说"TAG新版本"时按 dev_note §3 流程执行。
