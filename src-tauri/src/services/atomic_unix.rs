use std::{
    ffi::CString,
    fs::{self, File},
    io,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
    sync::Mutex,
};

// Deliberately serialize atomic saves, including case/symlink aliases, rather
// than maintain an unbounded path-lock registry. This is NOT an external lock.
pub(super) static WRITES: Mutex<()> = Mutex::new(());

fn checked(result: libc::c_int) -> io::Result<()> {
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in file name"))
}

pub(super) fn create_private(path: &Path) -> io::Result<File> {
    let file = platform::create(path)?;
    let result = (|| {
        platform::check_private(&file)?;
        // Some non-POSIX filesystems ignore mode. Do not write private content
        // on a mount that grants group/other access, even if rename is supported.
        if file.metadata()?.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Filesystem cannot create a private temporary file",
            ));
        }
        Ok(())
    })();
    if let Err(error) = result {
        return Err(super::cleanup_failed_write(path, error));
    }
    Ok(file)
}

pub(super) fn move_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    let source = c_path(source)?;
    let target = c_path(target)?;
    // Never fall back to hard links or an overwriting rename on ENOTSUP/EINVAL.
    platform::move_no_replace(&source, &target)
}

pub(super) fn replace(file: &File, source: &Path, target: &Path) -> io::Result<()> {
    // O_WRONLY also supports write-only notes; no truncation. NOFOLLOW rejects
    // newly introduced symlinks, NONBLOCK avoids waiting on a raced FIFO.
    let original = fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(target)?;
    let metadata = original.metadata()?;
    if !metadata.is_file() || metadata.permissions().readonly() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Target is not a writable regular file",
        ));
    }
    platform::copy_permissions(&original, file, &metadata)?;
    let copied = file.metadata()?;
    if (copied.uid(), copied.gid(), copied.mode() & 0o7777)
        != (metadata.uid(), metadata.gid(), metadata.mode() & 0o7777)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Filesystem did not preserve owner, group or mode",
        ));
    }
    file.sync_all()?;
    let current = fs::symlink_metadata(target)?;
    if (current.dev(), current.ino()) != (metadata.dev(), metadata.ino()) {
        return Err(io::Error::other("Target changed before replacement"));
    }
    // WRITES protects cooperating application saves. An external process can
    // still change names/attributes after the check: rename is not inode-CAS.
    fs::rename(source, target)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::os::fd::AsRawFd;

    const ACL: &std::ffi::CStr = c"system.posix_acl_access";

    // Linux POSIX ACL xattr is a kernel UAPI; copy its opaque bytes, not a
    // chmod-derived approximation. No libacl runtime/development dependency.
    // https://man7.org/linux/man-pages/man5/acl.5.html
    fn read_acl(file: &File) -> io::Result<Option<Vec<u8>>> {
        let fd = file.as_raw_fd();
        let size = unsafe { libc::fgetxattr(fd, ACL.as_ptr(), std::ptr::null_mut(), 0) };
        if size == -1 {
            let error = io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(libc::ENODATA | libc::ENOTSUP) => Ok(None),
                _ => Err(error),
            };
        }
        let mut value = vec![0u8; size as usize];
        let read =
            unsafe { libc::fgetxattr(fd, ACL.as_ptr(), value.as_mut_ptr().cast(), value.len()) };
        if read == -1 {
            return Err(io::Error::last_os_error());
        }
        if read != size {
            return Err(io::Error::other("ACL changed while reading"));
        }
        Ok(Some(value))
    }

    fn remove_acl(file: &File) -> io::Result<()> {
        let result = unsafe { libc::fremovexattr(file.as_raw_fd(), ACL.as_ptr()) };
        if result == -1 {
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
                return Err(error);
            }
        }
        Ok(())
    }

    pub(super) fn create(path: &Path) -> io::Result<File> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
    }

    pub(super) fn check_private(file: &File) -> io::Result<()> {
        // Creation mode masks default ACL entries from the first instant.
        // Remove them while still masked, before writing or restoring a mode.
        remove_acl(file)
    }

    pub(super) fn copy_permissions(
        original: &File,
        file: &File,
        meta: &fs::Metadata,
    ) -> io::Result<()> {
        let acl = read_acl(original)?;
        let current = file.metadata()?;
        if (current.uid(), current.gid()) != (meta.uid(), meta.gid()) {
            checked(unsafe { libc::fchown(file.as_raw_fd(), meta.uid(), meta.gid()) })?;
        }
        match &acl {
            Some(value) => {
                // Setting a POSIX ACL sets its corresponding mode bits too.
                // Do this BEFORE chmod: chmod first could expose group access
                // that the original ACL denies. chmod below restores special bits.
                checked(unsafe {
                    libc::fsetxattr(
                        file.as_raw_fd(),
                        ACL.as_ptr(),
                        value.as_ptr().cast(),
                        value.len(),
                        0,
                    )
                })?;
            }
            None => remove_acl(file)?,
        }
        file.set_permissions(meta.permissions())?;
        if read_acl(file)? != acl {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Filesystem did not preserve POSIX ACL",
            ));
        }
        Ok(())
    }

    pub(super) fn move_no_replace(source: &CString, target: &CString) -> io::Result<()> {
        // syscall avoids requiring a newer glibc renameat2 wrapper.
        // Linux fs/exfat/namei.c accepts RENAME_NOREPLACE (no hardlink needed).
        let result = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        os::fd::{AsRawFd, FromRawFd},
        ptr,
    };

    // Verified declarations: Apple Libc include/sys/acl.h, XNU bsd/sys/fcntl.h.
    // Opaque objects only; libc supplies ABI-sensitive integer/mode types.
    const FILESEC_OWNER: libc::c_int = 1;
    const FILESEC_GROUP: libc::c_int = 2;
    const FILESEC_MODE: libc::c_int = 4;
    const FILESEC_ACL: libc::c_int = 5;
    const ACL_FLAG_NO_INHERIT: libc::c_int = 1 << 17;
    extern "C" {
        fn filesec_init() -> *mut c_void;
        fn filesec_free(security: *mut c_void);
        fn filesec_set_property(
            security: *mut c_void,
            property: libc::c_int,
            value: *const c_void,
        ) -> libc::c_int;
        fn openx_np(
            path: *const libc::c_char,
            flags: libc::c_int,
            security: *mut c_void,
        ) -> libc::c_int;
        fn fchmodx_np(fd: libc::c_int, security: *mut c_void) -> libc::c_int;
        fn acl_init(count: libc::c_int) -> *mut c_void;
        fn acl_free(acl: *mut c_void) -> libc::c_int;
        fn acl_get_fd(fd: libc::c_int) -> *mut c_void;
        fn acl_get_flagset_np(acl: *mut c_void, flags: *mut *mut c_void) -> libc::c_int;
        fn acl_add_flag_np(flags: *mut c_void, flag: libc::c_int) -> libc::c_int;
        fn acl_get_entry(
            acl: *mut c_void,
            entry_id: libc::c_int,
            entry: *mut *mut c_void,
        ) -> libc::c_int;
        fn acl_size(acl: *mut c_void) -> libc::ssize_t;
        fn acl_copy_ext(
            buffer: *mut c_void,
            acl: *mut c_void,
            size: libc::ssize_t,
        ) -> libc::ssize_t;
    }

    struct Security(*mut c_void);
    impl Security {
        fn new() -> io::Result<Self> {
            let value = unsafe { filesec_init() };
            if value.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Self(value))
            }
        }
        fn set<T>(&self, property: libc::c_int, value: &T) -> io::Result<()> {
            checked(unsafe { filesec_set_property(self.0, property, (value as *const T).cast()) })
        }
    }
    impl Drop for Security {
        fn drop(&mut self) {
            unsafe { filesec_free(self.0) };
        }
    }
    struct Acl(*mut c_void);
    impl Drop for Acl {
        fn drop(&mut self) {
            unsafe { acl_free(self.0) };
        }
    }

    fn read_acl(file: &File) -> io::Result<Option<Acl>> {
        let value = unsafe { acl_get_fd(file.as_raw_fd()) };
        if !value.is_null() {
            return Ok(Some(Acl(value)));
        }
        let error = io::Error::last_os_error();
        // Libc acl_file.c: filesec_get_property returns ENOENT for no ACL.
        // Do not turn EACCES/ENOTSUP or other read failures into an empty ACL.
        if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(error)
        }
    }

    pub(super) fn create(path: &Path) -> io::Result<File> {
        let path = c_path(path)?;
        let security = Security::new()?;
        security.set(FILESEC_MODE, &(0o600 as libc::mode_t))?;
        let acl = unsafe { acl_init(0) };
        if acl.is_null() {
            return Err(io::Error::last_os_error());
        }
        let acl = Acl(acl);
        let mut flags = ptr::null_mut();
        checked(unsafe { acl_get_flagset_np(acl.0, &mut flags) })?;
        checked(unsafe { acl_add_flag_np(flags, ACL_FLAG_NO_INHERIT) })?;
        security.set(FILESEC_ACL, &acl.0)?;
        // XNU kern_authorization.c kauth_acl_inherit explicitly honors an
        // initial NO_INHERIT ACL. Empty ACL alone would still inherit!
        // FILESEC_REMOVE_ACL is invalid for openx_np (Libc sys/openx_np.c).
        let fd = unsafe {
            openx_np(
                path.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                security.0,
            )
        };
        if fd == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) fn acl_is_empty(file: &File) -> io::Result<bool> {
        let Some(acl) = read_acl(file)? else {
            return Ok(true);
        };
        let mut entry = ptr::null_mut();
        let result = unsafe { acl_get_entry(acl.0, 0, &mut entry) }; // ACL_FIRST_ENTRY
                                                                     // Darwin returns 0 for an entry, -1/EINVAL for end of list.
        if result == 0 {
            return Ok(false);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EINVAL) {
            Ok(true)
        } else {
            Err(error)
        }
    }

    pub(super) fn check_private(file: &File) -> io::Result<()> {
        if acl_is_empty(file)? {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Temporary file inherited an ACL",
            ))
        }
    }

    fn fingerprint(acl: &Option<Acl>) -> io::Result<Option<Vec<u8>>> {
        let Some(acl) = acl else {
            return Ok(None);
        };
        let size = unsafe { acl_size(acl.0) };
        if size == -1 {
            return Err(io::Error::last_os_error());
        }
        // acl_copy_ext writes a native C structure into the caller's buffer.
        let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        let copied = unsafe { acl_copy_ext(storage.as_mut_ptr().cast(), acl.0, size) };
        if copied == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(
            unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), copied as usize) }
                .to_vec(),
        ))
    }

    #[cfg(test)]
    pub(super) fn acl_fingerprint(file: &File) -> io::Result<Option<Vec<u8>>> {
        fingerprint(&read_acl(file)?)
    }

    pub(super) fn copy_permissions(
        original: &File,
        file: &File,
        meta: &fs::Metadata,
    ) -> io::Result<()> {
        let acl = read_acl(original)?;
        let expected = fingerprint(&acl)?;
        let security = Security::new()?;
        security.set(FILESEC_OWNER, &meta.uid())?;
        security.set(FILESEC_GROUP, &meta.gid())?;
        security.set(FILESEC_MODE, &((meta.mode() & 0o7777) as libc::mode_t))?;
        match acl {
            Some(ref acl) => security.set(FILESEC_ACL, &acl.0)?,
            None => checked(unsafe {
                filesec_set_property(security.0, FILESEC_ACL, 1usize as *const c_void)
            })?, // _FILESEC_REMOVE_ACL
        }
        // One extended chmod applies mode/owner/group/ACL together, rather than
        // exposing chmod permissions temporarily before installing deny ACEs.
        checked(unsafe { fchmodx_np(file.as_raw_fd(), security.0) })?;
        if fingerprint(&read_acl(file)?)? != expected {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Filesystem did not preserve extended ACL",
            ));
        }
        Ok(())
    }

    pub(super) fn move_no_replace(source: &CString, target: &CString) -> io::Result<()> {
        checked(unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) })
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(super) fn acl_fingerprint(file: &File) -> io::Result<Option<Vec<u8>>> {
    platform::acl_fingerprint(file)
}

#[cfg(all(test, target_os = "macos"))]
pub(super) fn acl_is_empty(file: &File) -> io::Result<bool> {
    platform::acl_is_empty(file)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use super::*;
    fn unsupported<T>() -> io::Result<T> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Atomic permission-preserving saves require Linux or macOS",
        ))
    }
    pub(super) fn create(_: &Path) -> io::Result<File> {
        unsupported()
    }
    pub(super) fn check_private(_: &File) -> io::Result<()> {
        unsupported()
    }
    pub(super) fn copy_permissions(_: &File, _: &File, _: &fs::Metadata) -> io::Result<()> {
        unsupported()
    }
    pub(super) fn move_no_replace(_: &CString, _: &CString) -> io::Result<()> {
        unsupported()
    }
}
