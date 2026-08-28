use std::sync::Mutex;

/// 待打开文件路径（文件关联双击冷启动 / 单实例转发）
pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

const MARKDOWN_EXTS: &[&str] = &[".md", ".markdown"];

fn is_markdown_path(p: &str) -> bool {
    let lower = p.to_lowercase();
    MARKDOWN_EXTS.iter().any(|ext| lower.ends_with(ext))
}

/// 从启动参数中提取 .md/.markdown 文件：跳过 argv[0]，反斜杠归一化为 /，只保留存在的文件。
/// 保持资源管理器传入的原始长路径，不做 canonicalize（本机环境下会退回 8.3 短路径）。
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
        if let Ok(ra) = hkcu.open_subkey_with_flags("Software\\RegisteredApplications", KEY_WRITE)
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

    // 真实注册表回环验证，会写入当前用户 HKCU；手工运行：
    // cargo test file_association -- --ignored registry_roundtrip
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn registry_roundtrip() {
        win::register().expect("register should succeed");
        assert!(win::is_registered(), "should be registered after register()");
        win::unregister().expect("unregister should succeed");
        assert!(!win::is_registered(), "should be unregistered after unregister()");
    }
}
