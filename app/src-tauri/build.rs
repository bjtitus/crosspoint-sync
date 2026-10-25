fn main() {
  // The iOS app links libapp.a together with WidgetReload.swift, which defines this
  // symbol; the cdylib cargo also builds never sees that Swift, so let it stay undefined.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
    println!("cargo:rustc-cdylib-link-arg=-Wl,-U,_crosspoint_reload_widgets");
  }
  tauri_build::build()
}
