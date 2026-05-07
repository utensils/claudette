#!/usr/bin/env bash
# Exercise Claudette window bounds persistence across every attached macOS display.
#
# The script dynamically reads NSScreen layout, moves/resizes the dev app to
# medium and large bounds on each display, waits for app_settings persistence,
# restarts the app, and compares restored Accessibility bounds against the
# expected bounds. It is intentionally macOS-only because it uses AppKit and
# System Events accessibility automation.
set -euo pipefail

repo_root="${PRJ_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repo_root"

python3 - "$@" <<'PY'
import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(os.environ.get("PRJ_ROOT", Path.cwd()))
DEFAULT_APP = ROOT / "target/debug/Claudette Dev.app"
DEFAULT_BINARY = ROOT / "target/debug/claudette-app"
DEFAULT_DB = Path.home() / "Library/Application Support/claudette/claudette.db"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="window-restore-matrix",
        description=(
            "Move/resize Claudette across every macOS monitor, restart between "
            "cases, and verify restored bounds against app_settings."
        )
    )
    parser.add_argument("--app", type=Path, default=DEFAULT_APP, help="Path to Claudette Dev.app")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to claudette.db")
    parser.add_argument(
        "--build",
        action="store_true",
        help="Build claudette-app and refresh the dev .app bundle before testing",
    )
    parser.add_argument(
        "--features",
        default="devtools,server",
        help="Features for --build (default: devtools,server)",
    )
    parser.add_argument(
        "--settle",
        type=float,
        default=1.8,
        help="Seconds to wait after restart before reading restored bounds",
    )
    parser.add_argument(
        "--save-timeout",
        type=float,
        default=8.0,
        help="Seconds to wait for window:main to match a moved case",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=12,
        help="Allowed pixel/point delta between expected and restored bounds",
    )
    parser.add_argument(
        "--restore-original",
        action="store_true",
        help="Restore the original window:main row after the matrix completes",
    )
    parser.add_argument(
        "--leave-closed",
        action="store_true",
        help="Leave Claudette closed after the matrix completes",
    )
    return parser.parse_args()


def run(cmd, *, check=True, env=None, cwd=ROOT):
    proc = subprocess.run(
        [str(part) for part in cmd],
        text=True,
        capture_output=True,
        check=check,
        env=env,
        cwd=cwd,
    )
    return proc


def require_macos():
    if sys.platform != "darwin":
        raise SystemExit("window-restore-matrix is macOS-only")


def screen_info():
    swift = r'''
import AppKit
import Foundation
let screens = NSScreen.screens.enumerated().map { index, screen in
  let frame = screen.frame
  let visible = screen.visibleFrame
  return [
    "index": index,
    "name": screen.localizedName,
    "scale": screen.backingScaleFactor,
    "x": frame.origin.x,
    "y": frame.origin.y,
    "width": frame.size.width,
    "height": frame.size.height,
    "visibleX": visible.origin.x,
    "visibleY": visible.origin.y,
    "visibleWidth": visible.size.width,
    "visibleHeight": visible.size.height
  ] as [String : Any]
}
let data = try! JSONSerialization.data(withJSONObject: screens, options: [])
print(String(data: data, encoding: .utf8)!)
'''
    out = run(["swift", "-e", swift]).stdout
    screens = json.loads(out)
    if not screens:
        raise RuntimeError("NSScreen returned no monitors")
    return screens


def generated_cases(screens):
    cases = []
    for screen in screens:
        vx = float(screen["visibleX"])
        vy = float(screen["visibleY"])
        vw = float(screen["visibleWidth"])
        vh = float(screen["visibleHeight"])
        for mode, wf, hf in (("medium", 0.52, 0.62), ("large", 0.78, 0.78)):
            width = int(round(min(max(900, vw * wf), max(900, vw - 80))))
            height = int(round(min(max(650, vh * hf), max(650, vh - 80))))
            width = min(width, int(vw))
            height = min(height, int(vh))
            x = int(round(vx + max(20, (vw - width) * 0.34)))
            y = int(round(vy + max(20, (vh - height) * 0.22)))
            cases.append(
                {
                    "name": f"{int(screen['index'])}:{screen['name']}:{mode}",
                    "screen": screen,
                    "mode": mode,
                    "x": x,
                    "y": y,
                    "w": width,
                    "h": height,
                }
            )
    return cases


def executable_path(app: Path) -> Path:
    return app / "Contents/MacOS/claudette-app"


def app_pids(app: Path):
    exe = str(executable_path(app))
    out = run(["pgrep", "-f", exe], check=False).stdout.strip()
    return [int(pid) for pid in out.splitlines() if pid.strip()]


def terminate_app(app: Path, timeout=12.0):
    pids = app_pids(app)
    for pid in pids:
        run(["kill", "-TERM", str(pid)], check=False)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not app_pids(app):
            return
        time.sleep(0.15)
    for pid in app_pids(app):
        run(["kill", "-9", str(pid)], check=False)
    deadline = time.time() + 3
    while time.time() < deadline:
        if not app_pids(app):
            return
        time.sleep(0.1)
    raise RuntimeError("failed to terminate Claudette app")


def wait_app_running(app: Path, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        pids = app_pids(app)
        if pids:
            return pids[0]
        time.sleep(0.2)
    raise RuntimeError("Claudette app did not start")


def launch_app(app: Path):
    env_args = [
        "--env",
        f"VITE_PORT={os.environ.get('VITE_PORT', '14253')}",
        "--env",
        f"CLAUDETTE_DEBUG_PORT={os.environ.get('CLAUDETTE_DEBUG_PORT', '19432')}",
    ]
    run(["open", "-n", "-a", str(app), *env_args])
    wait_app_running(app)
    wait_ax_ready()


def wait_ax_ready(timeout=20.0):
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        proc = run(["osascript", "-e", ax_get_script()], check=False)
        if proc.returncode == 0:
            return proc.stdout.strip()
        last = proc.stderr.strip()
        time.sleep(0.25)
    raise RuntimeError(
        "System Events could not read Claudette bounds. "
        "Grant Accessibility access to the terminal running this script. "
        f"Last error: {last}"
    )


def ax_get_script():
    return (
        'tell application "System Events" to tell process "claudette-app" '
        'to tell front window to get {position, size, value of attribute "AXFullScreen"}'
    )


def ax_bounds():
    vals = [value.strip() for value in wait_ax_ready().split(",")]
    return {
        "x": int(vals[0]),
        "y": int(vals[1]),
        "w": int(vals[2]),
        "h": int(vals[3]),
        "fullscreen": vals[4],
    }


def set_ax_bounds(case):
    script = f'''
tell application "System Events"
  tell process "claudette-app"
    set position of front window to {{{case["x"]}, {case["y"]}}}
    set size of front window to {{{case["w"]}, {case["h"]}}}
  end tell
end tell
'''
    run(["osascript", "-e", script])


def saved_state(db: Path):
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("select value from app_settings where key='window:main'").fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return json.loads(row[0])


def raw_window_state(db: Path):
    conn = sqlite3.connect(db)
    try:
        row = conn.execute("select value from app_settings where key='window:main'").fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def write_raw_window_state(db: Path, raw):
    conn = sqlite3.connect(db)
    try:
        if raw is None:
            conn.execute("delete from app_settings where key='window:main'")
        else:
            conn.execute(
                "insert into app_settings(key, value) values('window:main', ?) "
                "on conflict(key) do update set value=excluded.value",
                (raw,),
            )
        conn.commit()
    finally:
        conn.close()


def wait_saved_matches(db: Path, case, timeout: float):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        state = saved_state(db)
        last = state
        if state and all(
            abs(float(state[key]) - expected) <= 3
            for key, expected in (
                ("logical_x", case["x"]),
                ("logical_y", case["y"]),
                ("logical_width", case["w"]),
                ("logical_height", case["h"]),
            )
        ):
            return state
        time.sleep(0.25)
    raise RuntimeError(f"window:main did not match {case['name']}; last={last}")


def close_enough(actual, expected, tolerance: int):
    return all(
        abs(actual[key] - expected[key]) <= tolerance
        for key in ("x", "y", "w", "h")
    )


def build_and_prepare_bundle(args):
    run(
        [
            "cargo",
            "build",
            "--manifest-path",
            ROOT / "src-tauri/Cargo.toml",
            "--no-default-features",
            "--features",
            args.features,
        ]
    )
    runner = ROOT / "scripts/macos-dev-app-runner.sh"
    proc = subprocess.Popen(
        [str(runner), str(DEFAULT_BINARY)],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=os.environ.copy(),
    )
    try:
        wait_app_running(args.app)
    finally:
        terminate_app(args.app)
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait(timeout=3)


def print_monitor_table(screens):
    print("Monitors")
    print("| # | Name | Scale | Frame | Visible |")
    print("|---:|---|---:|---|---|")
    for screen in screens:
        frame = f'{int(screen["x"])},{int(screen["y"])} {int(screen["width"])}x{int(screen["height"])}'
        visible = (
            f'{int(screen["visibleX"])},{int(screen["visibleY"])} '
            f'{int(screen["visibleWidth"])}x{int(screen["visibleHeight"])}'
        )
        print(f'| {int(screen["index"])} | {screen["name"]} | {screen["scale"]} | {frame} | {visible} |')
    print()


def print_result_table(results):
    print("Results")
    print("| Case | Expected | Saved before | Restored | Saved after | Delta | Status |")
    print("|---|---|---|---|---|---|---|")
    for result in results:
        case = result["case"]
        requested = f'{case["x"]},{case["y"]} {case["w"]}x{case["h"]}'
        expected_bounds = result["expected"]
        expected = (
            f'{expected_bounds["x"]},{expected_bounds["y"]} '
            f'{expected_bounds["w"]}x{expected_bounds["h"]}'
        )
        before_state = result["persisted_before"]
        after_state = result["persisted_after"]
        saved_before = (
            f'{int(before_state["logical_x"])},{int(before_state["logical_y"])} '
            f'{int(before_state["logical_width"])}x{int(before_state["logical_height"])}'
        )
        restored = result["after_restart"]
        restored_text = f'{restored["x"]},{restored["y"]} {restored["w"]}x{restored["h"]}'
        saved_after = (
            f'{int(after_state["logical_x"])},{int(after_state["logical_y"])} '
            f'{int(after_state["logical_width"])}x{int(after_state["logical_height"])}'
        )
        delta = (
            f'dx={restored["x"] - case["x"]} dy={restored["y"] - case["y"]} '
            f'dw={restored["w"] - case["w"]} dh={restored["h"] - case["h"]}'
        )
        status = "PASS" if result["ok"] else "FAIL"
        print(f'| {case["name"]} | requested {requested}<br>expected {expected} | {saved_before} | {restored_text} | {saved_after} | {delta} | {status} |')
    print()


def main():
    require_macos()
    args = parse_args()
    if args.build:
        build_and_prepare_bundle(args)
    if not executable_path(args.app).exists():
        raise SystemExit(
            f"{executable_path(args.app)} does not exist. Run with --build or start dev once."
        )
    if not args.db.exists():
        raise SystemExit(f"{args.db} does not exist")

    screens = screen_info()
    cases = generated_cases(screens)
    original_state = raw_window_state(args.db)
    results = []

    print_monitor_table(screens)
    terminate_app(args.app)

    try:
        for case in cases:
            launch_app(args.app)
            set_ax_bounds(case)
            time.sleep(0.6)
            before = ax_bounds()
            expected = {
                "x": before["x"],
                "y": before["y"],
                "w": before["w"],
                "h": before["h"],
            }
            persisted_before = wait_saved_matches(args.db, expected, args.save_timeout)
            terminate_app(args.app)
            time.sleep(0.5)

            launch_app(args.app)
            time.sleep(args.settle)
            after = ax_bounds()
            persisted_after = saved_state(args.db)
            ok = close_enough(after, expected, args.tolerance)
            results.append(
                {
                    "case": case,
                    "expected": expected,
                    "before": before,
                    "after_restart": after,
                    "persisted_before": persisted_before,
                    "persisted_after": persisted_after,
                    "ok": ok,
                }
            )
            status = "PASS" if ok else "FAIL"
            print(
                f'[{status}] {case["name"]}: expected '
                f'{expected["x"]},{expected["y"]} {expected["w"]}x{expected["h"]}; restored '
                f'{after["x"]},{after["y"]} {after["w"]}x{after["h"]}'
            )
            terminate_app(args.app)
            time.sleep(0.35)
    finally:
        if args.restore_original:
            write_raw_window_state(args.db, original_state)
        if not args.leave_closed:
            launch_app(args.app)

    print()
    print_result_table(results)
    failures = [result for result in results if not result["ok"]]
    if failures:
        print(f"FAIL: {len(failures)} of {len(results)} cases failed", file=sys.stderr)
        raise SystemExit(1)
    print(f"PASS: {len(results)} of {len(results)} cases restored correctly")


if __name__ == "__main__":
    main()
PY
