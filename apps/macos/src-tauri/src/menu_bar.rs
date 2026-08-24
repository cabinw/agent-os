use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder,
};

const TRAY_ID: &str = "agent-os";
const PANEL_LABEL: &str = "menu-bar";
const MAIN_LABEL: &str = "main";
const MENU_VIEW_EVENT: &str = "agent-os://menu-view";
const MENU_INTENT_EVENT: &str = "agent-os://menu-intent";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuBarPresentation {
    icon: MenuIcon,
    project: Option<String>,
    active_agents: u32,
    active_tasks: u32,
    blocker_count: u32,
    pending_count: u32,
    decisions_enabled: bool,
    approvals: Vec<MenuApproval>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum MenuIcon {
    #[default]
    Normal,
    Attention,
    Waiting,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MenuApproval {
    approval: String,
    action: String,
    requested_by: String,
    risk: MenuRisk,
    menu_action: MenuAction,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum MenuRisk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum MenuAction {
    QuickDecision,
    ReviewInApp,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub enum MenuIntent {
    Grant { approval: String },
    Reject { approval: String, reason: String },
    ReviewInApp { approval: String },
    OpenApp,
    OpenPulse,
}

pub struct MenuBarState(Mutex<MenuBarPresentation>);

impl Default for MenuBarState {
    fn default() -> Self {
        Self(Mutex::new(MenuBarPresentation::default()))
    }
}

fn present_text(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.trim() != value || value.chars().count() > 1_024 {
        return Err(format!(
            "{label} must be trimmed and at most 1024 characters"
        ));
    }
    Ok(())
}

fn validate_view(view: &MenuBarPresentation) -> Result<(), String> {
    if view.approvals.len() > 100 {
        return Err("menu-bar view cannot contain more than 100 approvals".into());
    }
    if let Some(project) = &view.project {
        present_text(project, "project")?;
    }
    for item in &view.approvals {
        present_text(&item.approval, "approval id")?;
        present_text(&item.action, "approval action")?;
        present_text(&item.requested_by, "approval requester")?;
    }
    Ok(())
}

fn tray_title(icon: &MenuIcon) -> &'static str {
    match icon {
        MenuIcon::Normal => "",
        MenuIcon::Attention => "🟠",
        MenuIcon::Waiting => "🟣",
    }
}

fn show_main(app: &AppHandle, pulse: bool) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
        if pulse {
            let _ = app.emit_to(MAIN_LABEL, MENU_INTENT_EVENT, MenuIntent::OpenPulse);
        }
    }
}

fn toggle_panel(app: &AppHandle, position: PhysicalPosition<f64>, width: f64, height: f64) {
    let Some(panel) = app.get_webview_window(PANEL_LABEL) else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    let x = (position.x + width - 400.0).max(0.0);
    let y = position.y + height;
    let _ = panel.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = panel.show();
    let _ = panel.set_focus();
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let panel =
        WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("menu-bar.html".into()))
            .title("Agent OS")
            .inner_size(400.0, 640.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .build()?;
    let panel_for_event = panel.clone();
    panel.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let _ = panel_for_event.hide();
        }
    });

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Agent OS")
        .show_menu_on_left_click(false)
        .icon_as_template(true)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_panel(
                    tray.app_handle(),
                    rect.position.to_physical(1.0),
                    rect.size.to_physical(1.0).width,
                    rect.size.to_physical(1.0).height,
                );
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
pub fn update_menu_bar(
    app: AppHandle,
    state: State<'_, MenuBarState>,
    view: MenuBarPresentation,
) -> Result<(), String> {
    validate_view(&view)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_title(Some(tray_title(&view.icon)))
            .map_err(|error| error.to_string())?;
    }
    *state.0.lock().map_err(|_| "menu-bar state poisoned")? = view.clone();
    app.emit_to(PANEL_LABEL, MENU_VIEW_EVENT, view)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_menu_bar(state: State<'_, MenuBarState>) -> Result<MenuBarPresentation, String> {
    state
        .0
        .lock()
        .map(|view| view.clone())
        .map_err(|_| "menu-bar state poisoned".into())
}

#[tauri::command]
pub fn submit_menu_intent(app: AppHandle, intent: MenuIntent) -> Result<(), String> {
    match &intent {
        MenuIntent::OpenApp => {
            show_main(&app, false);
            Ok(())
        }
        MenuIntent::OpenPulse => {
            show_main(&app, true);
            Ok(())
        }
        _ => {
            show_main(&app, false);
            app.emit_to(MAIN_LABEL, MENU_INTENT_EVENT, intent)
                .map_err(|error| error.to_string())
        }
    }
}
