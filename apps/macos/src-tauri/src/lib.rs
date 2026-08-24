mod menu_bar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(menu_bar::MenuBarState::default())
        .setup(|app| {
            menu_bar::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            menu_bar::update_menu_bar,
            menu_bar::get_menu_bar,
            menu_bar::submit_menu_intent
        ])
        .run(tauri::generate_context!())
        .expect("Agent OS macOS shell failed to start");
}
