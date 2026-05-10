//! macOS native notifications via `UNUserNotificationCenter`.
//!
//! Replaces the previous `mac-notification-sys` integration that spawned one
//! OS thread per toast and never reaped them — see issue #736. Each
//! `Notification::send` ran an `NSRunLoop` polling loop that only completed
//! on a `Click` / `ActionButton` delegate event. Close-button / swipe /
//! auto-clear emit a different delegate event, so threads leaked
//! indefinitely. With N pending toasts they convoyed on
//! `_CFRunLoopGet2`'s process-global `os_unfair_lock`, costing ~N² CPU.
//!
//! `UNUserNotificationCenter` is delegate-based. We register a single
//! persistent delegate at app launch, store the `AppHandle` in a static so
//! it can be reached from the delegate callbacks, and post each toast as a
//! non-blocking `UNNotificationRequest`. The OS owns the toast lifecycle
//! and plays the sound out-of-process in `usernoted` — no in-process
//! threads, no runloop polling.
//!
//! On click, macOS calls
//! `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:`
//! on the main thread. We pull `workspace_id` from the response's
//! `userInfo` dict and emit `tray-select-workspace` / focus the window —
//! the exact UX the previous direct integration provided.
//!
//! `block = "0.1"` is used for the authorization callback (the only
//! UN API call here whose completion handler is non-nullable).

#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use block::{Block, ConcreteBlock};
use objc::declare::ClassDecl;
use objc::runtime::{BOOL, Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use tauri::{AppHandle, Emitter, Manager};

// Force the `UserNotifications` framework to be linked at process
// startup. We rely on runtime class lookups (`Class::get` / `class!()`)
// — the `class!` macro panics if a class isn't registered, so we want
// loading to be deterministic and not depend on transitive linking
// from another crate (e.g. tauri-plugin-notification on macOS uses the
// deprecated `NSUserNotification` path, not UserNotifications). Listing
// it here adds `-framework UserNotifications` to the linker invocation
// at zero runtime cost.
#[link(name = "UserNotifications", kind = "framework")]
unsafe extern "C" {}

/// Shared `AppHandle` reachable from the delegate callbacks. Set once at
/// startup. Subsequent `init` calls are no-ops.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Guards the runtime class registration. `ClassDecl::new` returns `None`
/// if the class already exists (e.g. across hot reloads in dev) — we treat
/// that as success.
static DELEGATE_REGISTERED: OnceLock<()> = OnceLock::new();

const DELEGATE_CLASS_NAME: &str = "ClaudetteNotificationDelegate";

// `UNAuthorizationOptions` bits we care about. Notably absent: BADGE.
// We never call `setBadge:` anywhere in `src-tauri`, so requesting badge
// capability would broaden the system permission prompt for a feature
// we don't use.
const UN_AUTH_SOUND: usize = 1 << 1;
const UN_AUTH_ALERT: usize = 1 << 2;

// `UNNotificationPresentationOptions` bits — used in
// `willPresentNotification:` to keep toasts visible while the app is
// foregrounded (matching the previous `mac-notification-sys` behavior).
const UN_PRESENT_SOUND: usize = 1 << 1;
const UN_PRESENT_BANNER: usize = 1 << 3;
const UN_PRESENT_LIST: usize = 1 << 4;

// `NSUTF8StringEncoding` constant.
const NS_UTF8: usize = 4;

/// One-shot init. Stores the `AppHandle`, registers the delegate class,
/// installs an instance as `UNUserNotificationCenter.current.delegate`,
/// and requests notification authorization.
///
/// Calling more than once is harmless — the second call is a no-op.
pub fn init(app: AppHandle) {
    if APP_HANDLE.set(app).is_err() {
        return;
    }
    unsafe {
        register_delegate_class();
        install_delegate();
        request_authorization();
    }
}

/// Post a `UNNotificationRequest`. Returns immediately. No threads are
/// spawned; the toast and its sound are owned by the OS notification
/// daemon. Click routing carries `workspace_id` through `userInfo` so the
/// delegate can emit `tray-select-workspace` for the exact session.
///
/// Both call sites (`tray::notify_attention` and SCM PR auto-archive)
/// reach this function from Tokio worker threads — Foundation `alloc/init`
/// without an autorelease pool leaks, and UNUserNotificationCenter's
/// own contracts assume main-thread access for delegate setup. We
/// dispatch to the main runloop via `AppHandle::run_on_main_thread`
/// (the same pattern used elsewhere in `tray.rs`) so the work runs
/// under the main thread's existing pool.
pub fn send(workspace_id: &str, title: &str, body: &str, sound: &str) {
    let Some(app) = APP_HANDLE.get() else {
        // `init` hasn't run yet — happens only if a notification fires
        // during early setup before `notification_macos::init`. Drop it
        // rather than racing.
        tracing::debug!(
            target: "claudette::notify",
            "send() called before init — dropping notification",
        );
        return;
    };

    let workspace_id = workspace_id.to_string();
    let title = title.to_string();
    let body = body.to_string();
    let sound = sound.to_string();

    let _ = app.run_on_main_thread(move || {
        // SAFETY: dispatched onto the main runloop, which always has an
        // autorelease pool installed by AppKit. All Foundation /
        // UserNotifications calls inside `post` are safe here.
        unsafe {
            post(&workspace_id, &title, &body, &sound);
        }
    });
}

// ---- delegate class --------------------------------------------------------

unsafe fn register_delegate_class() {
    DELEGATE_REGISTERED.get_or_init(|| {
        let superclass = class!(NSObject);
        let Some(mut decl) = ClassDecl::new(DELEGATE_CLASS_NAME, superclass) else {
            // Already registered in this process. Nothing to do.
            return;
        };

        // SAFETY: each `add_method` matches the Objective-C selector's
        // ABI. Block parameters are received as `*mut Object` (encoded
        // `@`); we cast them to typed `Block<…>` pointers internally.
        unsafe {
            decl.add_method(
                sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:),
                will_present as extern "C" fn(&Object, Sel, *mut Object, *mut Object, *mut Object),
            );
            decl.add_method(
                sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:),
                did_receive as extern "C" fn(&Object, Sel, *mut Object, *mut Object, *mut Object),
            );
        }
        decl.register();
    });
}

extern "C" fn will_present(
    _self_: &Object,
    _sel: Sel,
    _center: *mut Object,
    _notification: *mut Object,
    completion: *mut Object,
) {
    // Show banner + play sound + add to Notification Center even when
    // the app is foregrounded. Matches the previous behavior where
    // `mac-notification-sys` toasts always appeared regardless of focus.
    let options = UN_PRESENT_BANNER | UN_PRESENT_SOUND | UN_PRESENT_LIST;
    if !completion.is_null() {
        let block = completion as *mut Block<(usize,), ()>;
        // SAFETY: AppKit hands us a non-null block pointer with the
        // documented `void(^)(UNNotificationPresentationOptions)`
        // signature.
        unsafe {
            (*block).call((options,));
        }
    }
}

extern "C" fn did_receive(
    _self_: &Object,
    _sel: Sel,
    _center: *mut Object,
    response: *mut Object,
    completion: *mut Object,
) {
    // `didReceiveNotificationResponse:` fires for *every* user
    // interaction the system reports back to the app, not just
    // clicks. We only want to navigate on the default action (the
    // user clicked the toast body). Skip:
    //   - `UNNotificationDismissActionIdentifier` — explicit dismiss
    //     (only fires if a category opts in via
    //     `UNNotificationCategoryOptionCustomDismissAction`, which
    //     we don't currently use, but guarding keeps intent explicit
    //     for future maintainers).
    //   - any custom action button identifiers — none today, but
    //     this is the right place to branch when we add them.
    let is_default_action = !response.is_null()
        // SAFETY: `response` is a non-null `UNNotificationResponse`
        // owned by AppKit for the duration of this callback.
        && unsafe { is_default_action(response) };

    if is_default_action && let Some(app) = APP_HANDLE.get() {
        // SAFETY: `response` is non-null per the check above; AppKit
        // retains it for the lifetime of this callback.
        let workspace_id = unsafe { extract_workspace_id(response) };

        // Mirror the previous `tray::send_notification` macOS branch:
        // restore + focus the window, then emit selection for the
        // exact workspace whose toast was clicked.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        if let Some(ws) = workspace_id
            && !ws.is_empty()
        {
            let _ = app.emit("tray-select-workspace", ws);
        }
    }

    if !completion.is_null() {
        let block = completion as *mut Block<(), ()>;
        // SAFETY: AppKit hands us a non-null block pointer with the
        // documented `void(^)(void)` signature.
        unsafe {
            (*block).call(());
        }
    }
}

/// `true` iff this response represents the default action (toast body
/// click). False for `UNNotificationDismissActionIdentifier` or any
/// custom action button.
unsafe fn is_default_action(response: *mut Object) -> bool {
    let action_id: *mut Object = unsafe { msg_send![response, actionIdentifier] };
    let Some(s) = (unsafe { ns_string_to_rust(action_id) }) else {
        return false;
    };
    // Apple-defined constant string. We compare by value rather than
    // pulling in the symbol so this stays a one-file integration.
    s == "com.apple.UNNotificationDefaultActionIdentifier"
}

unsafe fn extract_workspace_id(response: *mut Object) -> Option<String> {
    let notification: *mut Object = unsafe { msg_send![response, notification] };
    if notification.is_null() {
        return None;
    }
    let request: *mut Object = unsafe { msg_send![notification, request] };
    if request.is_null() {
        return None;
    }
    let content: *mut Object = unsafe { msg_send![request, content] };
    if content.is_null() {
        return None;
    }
    let user_info: *mut Object = unsafe { msg_send![content, userInfo] };
    if user_info.is_null() {
        return None;
    }
    let key = unsafe { nsstring("workspace_id") };
    let value: *mut Object = unsafe { msg_send![user_info, objectForKey: key] };
    unsafe { ns_string_to_rust(value) }
}

// ---- delegate install + auth ----------------------------------------------

unsafe fn install_delegate() {
    let center = unsafe { current_center() };
    if center.is_null() {
        tracing::warn!(
            target: "claudette::notify",
            "UNUserNotificationCenter unavailable — native notifications disabled (unsigned dev build?)",
        );
        return;
    }
    let Some(cls) = Class::get(DELEGATE_CLASS_NAME) else {
        return;
    };
    // Intentionally retained for the lifetime of the process — the
    // delegate must outlive every notification it might receive.
    let delegate: *mut Object = unsafe { msg_send![cls, new] };
    let _: () = unsafe { msg_send![center, setDelegate: delegate] };
}

unsafe fn request_authorization() {
    let center = unsafe { current_center() };
    if center.is_null() {
        return;
    }
    let options = UN_AUTH_ALERT | UN_AUTH_SOUND;

    let handler = ConcreteBlock::new(|granted: BOOL, error: *mut Object| {
        // `objc::runtime::BOOL` is the platform's native bool — `bool` on
        // arm64 / modern x86_64 macOS. Just pass it through.
        if !error.is_null() {
            tracing::debug!(
                target: "claudette::notify",
                granted = ?granted,
                "UNUserNotificationCenter authorization returned an error",
            );
        } else {
            tracing::debug!(
                target: "claudette::notify",
                granted = ?granted,
                "UNUserNotificationCenter authorization completed",
            );
        }
    });
    // `copy()` heap-allocates and retains the block so it survives past
    // this stack frame; AppKit calls it asynchronously on a background
    // queue. The returned `RcBlock` releases on drop, but the block is
    // already retained by AppKit at that point.
    let handler = handler.copy();
    let _: () = unsafe {
        msg_send![center,
            requestAuthorizationWithOptions: options
            completionHandler: &*handler]
    };
}

// ---- post -----------------------------------------------------------------

unsafe fn post(workspace_id: &str, title: &str, body: &str, sound: &str) {
    let center = unsafe { current_center() };
    if center.is_null() {
        return;
    }

    // `[UNMutableNotificationContent new]` returns +1 retained. Cocoa
    // factory methods named with `new`/`alloc`/`copy`/`mutableCopy`
    // transfer ownership to the caller — unlike e.g.
    // `[UNNotificationRequest requestWith…]` which returns autoreleased.
    // `addNotificationRequest:` copies the content internally, so we own
    // the original retain and must release it. Autorelease immediately
    // so every early-return path below is leak-safe; the main thread's
    // runloop autorelease pool reaps it on this iteration.
    let content_cls = class!(UNMutableNotificationContent);
    let content: *mut Object = unsafe { msg_send![content_cls, new] };
    if content.is_null() {
        return;
    }
    let _: *mut Object = unsafe { msg_send![content, autorelease] };

    let _: () = unsafe { msg_send![content, setTitle: nsstring(title)] };
    let _: () = unsafe { msg_send![content, setBody: nsstring(body)] };

    // `threadIdentifier` lets Notification Center coalesce repeated
    // toasts for the same workspace into a single group — a free
    // upgrade over `mac-notification-sys` behavior.
    if !workspace_id.is_empty() {
        let _: () = unsafe { msg_send![content, setThreadIdentifier: nsstring(workspace_id)] };
    }

    // userInfo carries workspace_id for click routing.
    let user_info = unsafe { make_user_info_dict(workspace_id) };
    let _: () = unsafe { msg_send![content, setUserInfo: user_info] };

    // Sound matrix — same surface as the old code:
    //   "None"    → no sound (content.sound stays nil)
    //   "Default" → UNNotificationSound.defaultSound
    //   custom    → UNNotificationSound.soundNamed:<name>
    //              (resolves /Library/Sounds and /System/Library/Sounds)
    match sound {
        "None" => {}
        "Default" => {
            let cls = class!(UNNotificationSound);
            let s: *mut Object = unsafe { msg_send![cls, defaultSound] };
            let _: () = unsafe { msg_send![content, setSound: s] };
        }
        custom => {
            let cls = class!(UNNotificationSound);
            let name = unsafe { nsstring(custom) };
            let s: *mut Object = unsafe { msg_send![cls, soundNamed: name] };
            let _: () = unsafe { msg_send![content, setSound: s] };
        }
    }

    // Identifier must be unique per pending request. A repeated id
    // *replaces* the existing toast in Notification Center, which is
    // not what we want for sequential per-workspace alerts.
    let identifier = format!(
        "{}-{}",
        if workspace_id.is_empty() {
            "claudette"
        } else {
            workspace_id
        },
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );

    let request_cls = class!(UNNotificationRequest);
    let request: *mut Object = unsafe {
        msg_send![request_cls,
            requestWithIdentifier: nsstring(&identifier)
            content: content
            trigger: ptr::null_mut::<Object>()]
    };
    if request.is_null() {
        return;
    }

    // `addNotificationRequest:withCompletionHandler:` accepts a nil
    // handler per Apple's docs — saves us building a one-shot block per
    // post.
    let _: () = unsafe {
        msg_send![center,
            addNotificationRequest: request
            withCompletionHandler: ptr::null_mut::<Object>()]
    };
}

// ---- helpers ---------------------------------------------------------------

unsafe fn current_center() -> *mut Object {
    let Some(cls) = Class::get("UNUserNotificationCenter") else {
        return ptr::null_mut();
    };
    unsafe { msg_send![cls, currentNotificationCenter] }
}

unsafe fn nsstring(s: &str) -> *mut Object {
    let cls = class!(NSString);
    let bytes = s.as_ptr() as *const c_void;
    let len = s.len();
    let alloc: *mut Object = unsafe { msg_send![cls, alloc] };
    let inited: *mut Object = unsafe {
        msg_send![alloc,
            initWithBytes: bytes
            length: len
            encoding: NS_UTF8]
    };
    // Autorelease so callers don't have to track the retain.
    let _: *mut Object = unsafe { msg_send![inited, autorelease] };
    inited
}

unsafe fn make_user_info_dict(workspace_id: &str) -> *mut Object {
    let cls = class!(NSDictionary);
    let key = unsafe { nsstring("workspace_id") };
    let value = unsafe { nsstring(workspace_id) };
    unsafe { msg_send![cls, dictionaryWithObject: value forKey: key] }
}

unsafe fn ns_string_to_rust(s: *mut Object) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let utf8: *const c_char = unsafe { msg_send![s, UTF8String] };
    if utf8.is_null() {
        return None;
    }
    let cstr = unsafe { CStr::from_ptr(utf8) };
    Some(cstr.to_string_lossy().into_owned())
}

// No unit tests in this module: every helper either calls into
// `UNUserNotificationCenter` (which raises an Objective-C exception when
// invoked from a non-bundled `cargo test` binary) or builds Foundation
// objects whose lifecycle assumes an autorelease pool that the test
// harness doesn't always provide. Coverage comes from the manual UAT
// checklist in PR / issue #736: post 5+ unanswered toasts and confirm
// `claudette-app` idles below ~50 % CPU with zero
// `mac_notification_sys` frames in `sample`.
