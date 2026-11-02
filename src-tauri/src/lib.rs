use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_window_state::StateFlags;

/// PDF paths on a command line: double-clicking a PDF or "Open with Folio"
/// starts the app with the file's path as an argument.
fn pdf_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".pdf") && Path::new(a).is_file())
        .collect()
}

/// Files Folio was launched with.
#[tauri::command]
fn startup_files() -> Vec<String> {
    pdf_args(std::env::args())
}

/// Reads a file the user chose; returned as raw bytes rather than JSON.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

/// Writes raw bytes to the path in the `x-path` header (hex-encoded UTF-8).
/// The data goes to a temporary file first and is then moved into place, so a
/// failed save never leaves a half-written PDF behind.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected file contents".into());
    };
    let hex = request
        .headers()
        .get("x-path")
        .ok_or("missing path")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = PathBuf::from(decode_hex(hex)?);
    let mut tmp: OsString = path.clone().into_os_string();
    tmp.push(".folio-tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, data).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save {} (is it open in another program?): {e}", path.display())
    })
}

/// Which of these files still exist (recent files skip the ones that don't).
#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}

/// A file of Folio's own (autosaves, the recent files list) inside the app
/// data folder. Names are relative paths of plain segments like
/// `recovery/abc.json`, so nothing outside that folder can be reached.
fn data_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let plain = |seg: &str| {
        !seg.is_empty() && seg != "." && seg != ".." && seg.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    };
    if !name.split('/').all(plain) {
        return Err(format!("bad name {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
fn data_read(app: AppHandle, name: String) -> Result<Response, String> {
    let path = data_path(&app, &name)?;
    std::fs::read(&path).map(Response::new).map_err(|e| format!("{name}: {e}"))
}

/// Writes raw bytes to the app data file named in the `x-name` header.
#[tauri::command]
fn data_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected file contents".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .ok_or("missing name")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = data_path(&app, name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp: OsString = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, data).map_err(|e| format!("{name}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{name}: {e}")
    })
}

#[tauri::command]
fn data_remove(app: AppHandle, name: String) -> Result<(), String> {
    match std::fs::remove_file(data_path(&app, &name)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{name}: {e}")),
        _ => Ok(()),
    }
}

/// File names in an app data folder; empty if it doesn't exist yet.
#[tauri::command]
fn data_list(app: AppHandle, dir: String) -> Result<Vec<String>, String> {
    let Ok(entries) = std::fs::read_dir(data_path(&app, &dir)?) else {
        return Ok(Vec::new());
    };
    Ok(entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.ends_with(".tmp"))
        .collect())
}

/// Full path of a file in the app data folder (email attachments are written there first).
#[tauri::command]
fn data_file_path(app: AppHandle, name: String) -> Result<String, String> {
    Ok(data_path(&app, &name)?.to_string_lossy().into_owned())
}

/// The mail program that handles mailto links, and whether Folio can hand it
/// a message with an attachment (Simple MAPI, e.g. classic Outlook or
/// Thunderbird). Returned as `[name, attachments]`.
#[tauri::command]
fn mail_client() -> (String, bool) {
    mail::client()
}

/// Opens a new message in the mail program with the file attached, for the
/// user to review and send. Recipients are `[name, address]` pairs. Resolves
/// to "opened" or "cancelled"; fails when the mail program can't take it.
#[tauri::command]
async fn compose_mail(
    to: Vec<(String, String)>,
    cc: Vec<(String, String)>,
    subject: String,
    body: String,
    attachment: Option<(String, String)>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || mail::compose(&to, &cc, &subject, &body, attachment.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod mail {
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(key: isize, sub_key: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut c_void, len: *mut u32) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }

    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x2;

    fn reg_string(root: isize, key: &str, value: Option<&str>) -> Option<String> {
        let key = wide(key);
        let value = value.map(wide);
        let value_ptr = value.as_ref().map_or(null(), |v| v.as_ptr());
        let mut buf = vec![0u16; 512];
        let mut len = (buf.len() * 2) as u32;
        // SAFETY: the buffers outlive the call and `len` is the buffer size in bytes.
        let status = unsafe { RegGetValueW(root, key.as_ptr(), value_ptr, RRF_RT_REG_SZ, null_mut(), buf.as_mut_ptr().cast(), &mut len) };
        if status != 0 {
            return None;
        }
        let chars = (len as usize / 2).saturating_sub(1);
        let s = String::from_utf16_lossy(&buf[..chars.min(buf.len())]);
        (!s.is_empty()).then_some(s)
    }

    /// The default Simple MAPI client and whether it is also the program
    /// that handles mailto links (so the message opens where the user reads mail).
    pub fn client() -> (String, bool) {
        let mapi = reg_string(HKEY_CURRENT_USER, r"Software\Clients\Mail", None)
            .or_else(|| reg_string(HKEY_LOCAL_MACHINE, r"SOFTWARE\Clients\Mail", None))
            .unwrap_or_default();
        let prog = reg_string(
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice",
            Some("ProgId"),
        )
        .unwrap_or_default()
        .to_lowercase();
        let same = !mapi.is_empty()
            && mapi
                .to_lowercase()
                .split_whitespace()
                .filter(|w| w.len() >= 4 && *w != "microsoft" && *w != "mozilla")
                .any(|w| prog.contains(w));
        (if same { mapi } else { String::new() }, same)
    }

    #[repr(C)]
    struct MapiRecipDescW {
        reserved: u32,
        recip_class: u32,
        name: *const u16,
        address: *const u16,
        eid_size: u32,
        entry_id: *mut c_void,
    }

    #[repr(C)]
    struct MapiFileDescW {
        reserved: u32,
        flags: u32,
        position: u32,
        path_name: *const u16,
        file_name: *const u16,
        file_type: *mut c_void,
    }

    #[repr(C)]
    struct MapiMessageW {
        reserved: u32,
        subject: *const u16,
        note_text: *const u16,
        message_type: *const u16,
        date_received: *const u16,
        conversation_id: *const u16,
        flags: u32,
        originator: *mut MapiRecipDescW,
        recip_count: u32,
        recips: *mut MapiRecipDescW,
        file_count: u32,
        files: *mut MapiFileDescW,
    }

    type SendMailW = unsafe extern "system" fn(usize, usize, *mut MapiMessageW, u32, u32) -> u32;

    const MAPI_TO: u32 = 1;
    const MAPI_CC: u32 = 2;
    const MAPI_LOGON_UI: u32 = 0x1;
    const MAPI_DIALOG: u32 = 0x8;
    const MAPI_DIALOG_MODELESS: u32 = 0x4 | MAPI_DIALOG;
    const MAPI_USER_ABORT: u32 = 1;

    pub fn compose(
        to: &[(String, String)],
        cc: &[(String, String)],
        subject: &str,
        body: &str,
        attachment: Option<&(String, String)>,
    ) -> Result<String, String> {
        // SAFETY: plain Win32 calls with NUL-terminated strings.
        let send: SendMailW = unsafe {
            let module = LoadLibraryW(wide("mapi32.dll").as_ptr());
            if module.is_null() {
                return Err("no MAPI".into());
            }
            let f = GetProcAddress(module, b"MAPISendMailW\0".as_ptr());
            if f.is_null() {
                return Err("no MAPISendMailW".into());
            }
            std::mem::transmute::<*mut c_void, SendMailW>(f)
        };
        // Keep every string alive until the call returns.
        let people: Vec<(u32, Vec<u16>, Vec<u16>)> = to
            .iter()
            .map(|r| (MAPI_TO, r))
            .chain(cc.iter().map(|r| (MAPI_CC, r)))
            .map(|(class, (name, addr))| (class, wide(if name.is_empty() { addr } else { name }), wide(&format!("SMTP:{addr}"))))
            .collect();
        let mut recips: Vec<MapiRecipDescW> = people
            .iter()
            .map(|(class, name, addr)| MapiRecipDescW {
                reserved: 0,
                recip_class: *class,
                name: name.as_ptr(),
                address: addr.as_ptr(),
                eid_size: 0,
                entry_id: null_mut(),
            })
            .collect();
        let file = attachment.map(|(path, name)| (wide(path), wide(name)));
        let mut files: Vec<MapiFileDescW> = file
            .iter()
            .map(|(path, name)| MapiFileDescW {
                reserved: 0,
                flags: 0,
                position: u32::MAX,
                path_name: path.as_ptr(),
                file_name: name.as_ptr(),
                file_type: null_mut(),
            })
            .collect();
        let subject = wide(subject);
        // MAPI wants CRLF line breaks.
        let body = wide(&body.replace("\r\n", "\n").replace('\n', "\r\n"));
        let mut msg = MapiMessageW {
            reserved: 0,
            subject: subject.as_ptr(),
            note_text: body.as_ptr(),
            message_type: null(),
            date_received: null(),
            conversation_id: null(),
            flags: 0,
            originator: null_mut(),
            recip_count: recips.len() as u32,
            recips: if recips.is_empty() { null_mut() } else { recips.as_mut_ptr() },
            file_count: files.len() as u32,
            files: if files.is_empty() { null_mut() } else { files.as_mut_ptr() },
        };
        // SAFETY: `msg` and everything it points to live until the call returns.
        let code = unsafe { send(0, 0, &mut msg, MAPI_LOGON_UI | MAPI_DIALOG_MODELESS, 0) };
        match code {
            0 => Ok("opened".into()),
            MAPI_USER_ABORT => Ok("cancelled".into()),
            n => Err(format!("MAPI error {n}")),
        }
    }
}

#[cfg(not(windows))]
mod mail {
    pub fn client() -> (String, bool) {
        (String::new(), false)
    }

    pub fn compose(
        _to: &[(String, String)],
        _cc: &[(String, String)],
        _subject: &str,
        _body: &str,
        _attachment: Option<&(String, String)>,
    ) -> Result<String, String> {
        Err("not supported".into())
    }
}

fn decode_hex(hex: &str) -> Result<String, String> {
    if hex.len() % 2 != 0 {
        return Err("bad path".into());
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| "bad path".to_string())?;
    String::from_utf8(bytes).map_err(|_| "bad path".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch (e.g. double-clicking another PDF) hands its files to
        // the window that is already open instead of starting a new instance.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let files = pdf_args(argv);
            if !files.is_empty() {
                let _ = app.emit("open-files", files);
            }
        }))
        // Reopens the window where it was left: size, position and maximized state.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Signing services whose APIs don't allow calls from a web page (CORS).
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            startup_files,
            read_file,
            write_file,
            paths_exist,
            data_read,
            data_write,
            data_remove,
            data_list,
            data_file_path,
            mail_client,
            compose_mail
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
