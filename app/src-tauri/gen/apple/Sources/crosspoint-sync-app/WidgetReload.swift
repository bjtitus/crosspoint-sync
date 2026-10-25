import WidgetKit

// WidgetCenter has no Objective-C API, so Rust (src/widget.rs) calls this after
// writing new widget data, and the home screen widget redraws right away.
@_cdecl("crosspoint_reload_widgets")
public func reloadWidgets() {
  WidgetCenter.shared.reloadAllTimelines()
}
