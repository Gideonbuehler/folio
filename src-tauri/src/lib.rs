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
        .invoke_handler(tauri::generate_handler![
            startup_files,
            read_file,
            write_file,
            paths_exist,
            data_read,
            data_write,
            data_remove,
            data_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
}
