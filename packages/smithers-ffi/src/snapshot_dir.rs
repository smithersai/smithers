//! Directory handles for snapshot output. On Unix each component is opened
//! relative to a held descriptor with O_NOFOLLOW, so a symlink placed in the
//! checkout before or during a snapshot cannot redirect a removal or a write
//! outside it (#5380). Other platforms keep path checks.
use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::Path;

use crate::JjError;

/// A real directory that snapshot output is written below.
pub(crate) struct SnapshotDir {
    #[cfg(unix)]
    handle: File,
    #[cfg(not(unix))]
    path: std::path::PathBuf,
}

fn not_real_directory(name: &OsStr) -> JjError {
    JjError::BadRequest(format!(
        "snapshot storage is not a real directory: {}",
        name.to_string_lossy()
    ))
}

fn internal(action: &str, err: io::Error) -> JjError {
    JjError::Internal(format!("failed to {action}: {err}"))
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;

    fn cstring(name: &OsStr) -> io::Result<CString> {
        CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "NUL in path"))
    }

    fn check(rc: libc::c_int) -> io::Result<()> {
        if rc < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(super) fn open_at(
        dir: RawFd,
        name: &OsStr,
        flags: libc::c_int,
        mode: u32,
    ) -> io::Result<File> {
        let name = cstring(name)?;
        let fd = unsafe {
            libc::openat(
                dir,
                name.as_ptr(),
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                mode as libc::c_uint,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    pub(super) fn open_dir_at(dir: RawFd, name: &OsStr) -> io::Result<File> {
        open_at(dir, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
    }

    pub(super) fn mkdir_at(dir: &File, name: &OsStr) -> io::Result<()> {
        let name = cstring(name)?;
        check(unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o777) })
    }

    pub(super) fn symlink_at(dir: &File, name: &OsStr, target: &str) -> io::Result<()> {
        let name = cstring(name)?;
        let target = cstring(OsStr::new(target))?;
        check(unsafe { libc::symlinkat(target.as_ptr(), dir.as_raw_fd(), name.as_ptr()) })
    }

    /// Removes `name` below `dir` without following any link: a link is
    /// unlinked itself and a directory is emptied through its own descriptor.
    pub(super) fn remove_at(dir: &File, name: &OsStr) -> io::Result<()> {
        let cname = cstring(name)?;
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        check(unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                cname.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        })?;
        if unsafe { stat.assume_init() }.st_mode & libc::S_IFMT != libc::S_IFDIR {
            return check(unsafe { libc::unlinkat(dir.as_raw_fd(), cname.as_ptr(), 0) });
        }
        let child = open_dir_at(dir.as_raw_fd(), name)?;
        for entry in entries(&child)? {
            remove_at(&child, OsStr::from_bytes(&entry))?;
        }
        check(unsafe { libc::unlinkat(dir.as_raw_fd(), cname.as_ptr(), libc::AT_REMOVEDIR) })
    }

    fn entries(dir: &File) -> io::Result<Vec<Vec<u8>>> {
        let fd = unsafe { libc::dup(dir.as_raw_fd()) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let err = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(err);
        }
        let mut names = Vec::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name != b"." && name != b".." {
                names.push(name.to_vec());
            }
        }
        unsafe { libc::closedir(stream) };
        Ok(names)
    }
}

impl SnapshotDir {
    /// Opens the host-chosen `path` itself; links inside it are never followed.
    pub(crate) fn open(path: &Path) -> Result<Self, JjError> {
        let metadata =
            std::fs::metadata(path).map_err(|err| internal("inspect snapshot directory", err))?;
        if !metadata.is_dir() {
            return Err(JjError::BadRequest(
                "snapshot output must be a real directory".into(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let handle = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY)
                .open(path)
                .map_err(|err| internal("open snapshot directory", err))?;
            Ok(Self { handle })
        }
        #[cfg(not(unix))]
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    /// Opens the real child directory `name`, creating it when missing. A
    /// link or file in its place is refused, never followed.
    pub(crate) fn child(&self, name: &OsStr) -> Result<Self, JjError> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let open = || unix::open_dir_at(self.handle.as_raw_fd(), name);
            let handle = match open() {
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    match unix::mkdir_at(&self.handle, name) {
                        Err(err) if err.kind() != io::ErrorKind::AlreadyExists => {
                            return Err(internal("create snapshot directory", err))
                        }
                        _ => open(),
                    }
                }
                result => result,
            };
            match handle {
                Ok(handle) => Ok(Self { handle }),
                Err(err) if matches!(err.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) => {
                    Err(not_real_directory(name))
                }
                Err(err) => Err(internal("open snapshot directory", err)),
            }
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Ok(_) => return Err(not_real_directory(name)),
                Err(err) if err.kind() == io::ErrorKind::NotFound => std::fs::create_dir(&path)
                    .map_err(|err| internal("create snapshot directory", err))?,
                Err(err) => return Err(internal("inspect snapshot directory", err)),
            }
            Ok(Self { path })
        }
    }

    /// Replaces whatever is at `name` with a new empty directory. Removal
    /// unlinks links themselves and never leaves this directory.
    pub(crate) fn reset_child(&self, name: &OsStr) -> Result<Self, JjError> {
        #[cfg(unix)]
        match unix::remove_at(&self.handle, name) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => {
                return Err(internal("reset snapshot path", err))
            }
            _ => {}
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            let removed = match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_dir() => std::fs::remove_dir_all(&path),
                Ok(_) => std::fs::remove_file(&path),
                Err(err) => Err(err),
            };
            match removed {
                Err(err) if err.kind() != io::ErrorKind::NotFound => {
                    return Err(internal("reset snapshot path", err))
                }
                _ => {}
            }
        }
        self.child(name)
    }

    /// Creates the new file `name`; an existing entry, including a link, fails.
    pub(crate) fn create_file(&self, name: &OsStr) -> io::Result<File> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unix::open_at(
                self.handle.as_raw_fd(),
                name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o666,
            )
        }
        #[cfg(not(unix))]
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path.join(name))
    }

    /// Creates the link `name` pointing at `target`.
    #[cfg(unix)]
    pub(crate) fn symlink(&self, name: &OsStr, target: &str) -> io::Result<()> {
        unix::symlink_at(&self.handle, name, target)
    }
}
