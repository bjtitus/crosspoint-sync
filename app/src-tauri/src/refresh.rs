// Native pull-to-refresh. iOS: a UIRefreshControl on the webview's scroll view (the
// same spring and spinner as Mail). Pulling fires a `crosspoint-refresh` window event
// in the page; the page calls `end_refresh` once its data is back. Android does the
// same with a SwipeRefreshLayout in MainActivity.

#[cfg(target_os = "ios")]
mod ios {
  use objc2::{define_class, msg_send, rc::Retained, runtime::AnyObject, runtime::NSObject, sel, ClassType, MainThreadOnly};
  use objc2_ui_kit::{UIControl, UIRefreshControl, UIResponder, UIView};
  use std::sync::OnceLock;
  use tauri::Manager;

  static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

  define_class!(
    #[unsafe(super(NSObject))]
    #[name = "CPRefreshTarget"]
    struct RefreshTarget;

    impl RefreshTarget {
      #[unsafe(method(refresh:))]
      fn refresh(&self, _sender: &AnyObject) {
        if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
          let _ = window.eval("dispatchEvent(new Event('crosspoint-refresh'))");
        }
      }
    }
  );

  // WebKit keeps the scroll view's top inset at 0 (the page draws under the status
  // bar), so a stock UIRefreshControl spins behind the Dynamic Island. This one shifts
  // its contents down by the safe area after each layout.
  define_class!(
    #[unsafe(super(UIRefreshControl, UIControl, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "CPRefreshControl"]
    struct SafeAreaRefreshControl;

    impl SafeAreaRefreshControl {
      #[unsafe(method(layoutSubviews))]
      fn layout_subviews(&self) {
        unsafe {
          let _: () = msg_send![super(self), layoutSubviews];
          let scroll: *mut AnyObject = msg_send![self, superview];
          if scroll.is_null() {
            return;
          }
          // UIEdgeInsets (top, left, bottom, right); CGRect (x, y, width, height).
          let safe: [f64; 4] = msg_send![scroll, safeAreaInsets];
          let b: [f64; 4] = msg_send![self, bounds];
          if b[1] != -safe[0] {
            let _: () = msg_send![self, setBounds: [b[0], -safe[0], b[2], b[3]]];
          }
        }
      }
    }
  );

  pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let _ = APP.set(app.handle().clone());
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    window.with_webview(|webview| unsafe {
      let view = &*(webview.inner() as *const AnyObject);
      let scroll: *mut AnyObject = msg_send![view, scrollView];
      let target: Retained<RefreshTarget> = msg_send![RefreshTarget::class(), new];
      let control: Retained<SafeAreaRefreshControl> = msg_send![SafeAreaRefreshControl::class(), new];
      let _: () = msg_send![&*control, setClipsToBounds: false];
      // UIControlEventValueChanged
      let _: () = msg_send![&*control, addTarget: &*target, action: sel!(refresh:), forControlEvents: 1usize << 12];
      let _: () = msg_send![scroll, setRefreshControl: &*control];
      // Controls don't retain their targets; this one lives as long as the app.
      std::mem::forget(target);
    })
  }

  pub fn end(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| unsafe {
      let view = &*(webview.inner() as *const AnyObject);
      let scroll: *mut AnyObject = msg_send![view, scrollView];
      let control: *mut AnyObject = msg_send![scroll, refreshControl];
      if !control.is_null() {
        let _: () = msg_send![control, endRefreshing];
      }
    })
  }
}

#[cfg(target_os = "ios")]
pub use ios::install;

#[tauri::command]
pub fn end_refresh(window: tauri::WebviewWindow) -> Result<(), String> {
  #[cfg(target_os = "ios")]
  ios::end(&window).map_err(|e| e.to_string())?;
  #[cfg(not(target_os = "ios"))]
  let _ = window;
  Ok(())
}
