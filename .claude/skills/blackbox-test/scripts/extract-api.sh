#!/usr/bin/env bash
# extract-api.sh — Extract public API signatures from Rust source files.
#
# Outputs pub fn/struct/enum/type declarations WITHOUT function bodies,
# preserving doc comments and type definitions that tests need. Model
# files (pure data) are included verbatim.
#
# Usage:
#   extract-api.sh [module]    Extract a single module
#   extract-api.sh all         Extract all modules (default)
#
# Modules: db, git, diff, agent, config, mcp, names, permissions,
#          snapshot, slash_commands, file_expand

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PROJECT_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
MODULE="${1:-all}"

# ---------------------------------------------------------------------------
# Resolve module name to source file path(s)
# ---------------------------------------------------------------------------
# Uses a case statement instead of associative arrays for compatibility
# with macOS's default Bash 3.2 (declare -A requires Bash 4+).

ALL_FILES="src/db.rs src/git.rs src/diff.rs src/agent.rs src/config.rs src/mcp.rs src/names/mod.rs src/permissions.rs src/snapshot.rs src/slash_commands.rs src/file_expand.rs"

resolve_module() {
  case "$1" in
    db)             echo "src/db.rs" ;;
    git)            echo "src/git.rs" ;;
    diff)           echo "src/diff.rs" ;;
    agent)          echo "src/agent.rs" ;;
    config)         echo "src/config.rs" ;;
    mcp)            echo "src/mcp.rs" ;;
    names)          echo "src/names/mod.rs" ;;
    permissions)    echo "src/permissions.rs" ;;
    snapshot)       echo "src/snapshot.rs" ;;
    slash_commands) echo "src/slash_commands.rs" ;;
    file_expand)    echo "src/file_expand.rs" ;;
    all)            echo "$ALL_FILES" ;;
    *)              return 1 ;;
  esac
}

resolved=$(resolve_module "$MODULE") || {
  echo "Unknown module: $MODULE" >&2
  echo "Available: db git diff agent config mcp names permissions snapshot slash_commands file_expand all" >&2
  exit 1
}
read -ra files <<< "$resolved"

# ---------------------------------------------------------------------------
# Helper: print a section banner
# ---------------------------------------------------------------------------

banner() {
  echo "// ================================================================="
  echo "// $1"
  echo "// ================================================================="
}

# ---------------------------------------------------------------------------
# Extract public API from a single Rust source file
# ---------------------------------------------------------------------------
# The awk program below walks each source file and emits only:
#   - pub fn / pub async fn signatures (body stripped at the opening brace)
#   - pub struct / pub enum declarations (with fields)
#   - pub type / pub use / pub const / pub static declarations
#   - pub trait blocks
#   - impl blocks (header + pub method signatures only)
#   - /// doc comments preceding public items
#   - Top-level use statements (for import context)
#
# It skips:
#   - Function bodies (core black-box constraint)
#   - #[cfg(test)] items and mod tests { ... } blocks
#   - Private functions, structs, and helpers
# ---------------------------------------------------------------------------

extract_public_api() {
  local file="$1"

  awk '
    BEGIN {
      # State flags
      skip_cfg_test_item = 0     # Next item is #[cfg(test)] -- skip it
      in_test_block      = 0     # Inside a #[cfg(test)] mod tests { ... }
      test_depth         = 0     # Brace depth for test block

      in_fn_body         = 0     # Skipping a function body
      fn_depth           = 0     # Brace depth for function body

      collecting_sig     = 0     # Collecting a multi-line fn signature
      sig_buf            = ""    # Buffer for multi-line signature

      in_impl            = 0     # Inside an impl block
      impl_depth         = 0     # Brace depth for impl block

      doc_buf            = ""    # Buffered doc comments / attributes
    }

    # -----------------------------------------------------------------------
    # Helper: count braces on current line, update a depth variable
    # Returns the new depth via the global "counted_depth" variable.
    # -----------------------------------------------------------------------
    function count_braces(line, start_depth,    i, c) {
      counted_depth = start_depth
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "{") counted_depth++
        if (c == "}") counted_depth--
      }
    }

    # -----------------------------------------------------------------------
    # Skip: #[cfg(test)] mod tests { ... } blocks
    # -----------------------------------------------------------------------

    # When we see #[cfg(test)], flag the next item for skipping
    /^[[:space:]]*#\[cfg\(test\)\]/ {
      skip_cfg_test_item = 1
      doc_buf = ""
      next
    }

    # #[cfg(test)] followed by a single pub fn -- skip that function
    skip_cfg_test_item && /^[[:space:]]*pub (async )?fn / {
      skip_cfg_test_item = 0
      count_braces($0, 0)
      if (index($0, "{") > 0 && counted_depth <= 0) next  # one-liner
      in_fn_body = 1
      fn_depth = counted_depth
      next
    }

    # #[cfg(test)] followed by mod -- skip the entire module block
    skip_cfg_test_item && /^[[:space:]]*mod / {
      skip_cfg_test_item = 0
      in_test_block = 1
      count_braces($0, 0)
      test_depth = counted_depth
      if (test_depth <= 0 && index($0, "{") > 0) in_test_block = 0
      next
    }

    # #[cfg(test)] followed by something else -- reset flag
    skip_cfg_test_item { skip_cfg_test_item = 0 }

    # While inside a test block, count braces until we exit
    in_test_block {
      count_braces($0, test_depth)
      test_depth = counted_depth
      if (test_depth <= 0) in_test_block = 0
      next
    }

    # -----------------------------------------------------------------------
    # Skip: function bodies (already identified by pub fn handlers below)
    # -----------------------------------------------------------------------

    in_fn_body {
      count_braces($0, fn_depth)
      fn_depth = counted_depth
      if (fn_depth <= 0) in_fn_body = 0
      next
    }

    # -----------------------------------------------------------------------
    # Collect: multi-line function signatures
    # -----------------------------------------------------------------------

    collecting_sig {
      sig_buf = sig_buf "\n" $0
      if (index($0, "{") > 0) {
        # Signature complete -- strip the opening brace and print
        sub(/ *\{.*/, "", sig_buf)
        print sig_buf
        print ""
        collecting_sig = 0
        sig_buf = ""
        # Now skip the body
        count_braces($0, 0)
        fn_depth = counted_depth
        in_fn_body = (fn_depth > 0)
      }
      next
    }

    # -----------------------------------------------------------------------
    # Track: impl blocks (emit header + pub method signatures)
    # -----------------------------------------------------------------------

    /^impl / || /^impl</ {
      in_impl = 1
      line = $0; sub(/ *\{.*/, " {", line)
      print ""
      print line
      count_braces($0, 0)
      impl_depth = counted_depth
      doc_buf = ""
      next
    }

    in_impl {
      count_braces($0, impl_depth)
      impl_depth = counted_depth
      if (impl_depth <= 0) {
        print "}"
        print ""
        in_impl = 0
        doc_buf = ""
        next
      }
      # Fall through to pub fn / doc comment handlers below
    }

    # -----------------------------------------------------------------------
    # Buffer: doc comments (///) and attributes (#[...])
    # -----------------------------------------------------------------------

    /^[[:space:]]*\/\/\// { doc_buf = doc_buf $0 "\n"; next }
    /^[[:space:]]*#\[/    { doc_buf = doc_buf $0 "\n"; next }

    # -----------------------------------------------------------------------
    # Emit: pub fn / pub async fn (signature only, body skipped)
    # -----------------------------------------------------------------------

    /^[[:space:]]*pub (async )?fn / || /^[[:space:]]*pub (unsafe )?fn / {
      if (doc_buf != "") { printf "%s", doc_buf; doc_buf = "" }

      if (index($0, "{") > 0) {
        # Single-line signature -- strip body, skip rest
        line = $0; sub(/ *\{.*/, "", line)
        print line
        print ""
        count_braces($0, 0)
        fn_depth = counted_depth
        in_fn_body = (fn_depth > 0)
      } else {
        # Multi-line signature -- start collecting
        collecting_sig = 1
        sig_buf = $0
      }
      next
    }

    # -----------------------------------------------------------------------
    # Emit: pub struct / pub enum (with fields)
    # -----------------------------------------------------------------------

    /^[[:space:]]*pub struct / || /^[[:space:]]*pub enum / {
      if (doc_buf != "") { printf "%s", doc_buf; doc_buf = "" }
      print $0

      # Capture the full body (fields / variants)
      if (index($0, "{") > 0 && index($0, "}") == 0) {
        count_braces($0, 0)
        while (counted_depth > 0 && (getline line) > 0) {
          print line
          count_braces(line, counted_depth)
        }
      }
      print ""
      next
    }

    # -----------------------------------------------------------------------
    # Emit: pub type / pub use / pub const / pub static
    # -----------------------------------------------------------------------

    /^[[:space:]]*pub (type|use|const|static) / {
      if (doc_buf != "") { printf "%s", doc_buf; doc_buf = "" }
      print $0
      print ""
      next
    }

    # -----------------------------------------------------------------------
    # Emit: pub trait (with method signatures)
    # -----------------------------------------------------------------------

    /^[[:space:]]*pub trait / {
      if (doc_buf != "") { printf "%s", doc_buf; doc_buf = "" }
      print $0
      if (index($0, "{") > 0) {
        count_braces($0, 0)
        while (counted_depth > 0 && (getline line) > 0) {
          print line
          count_braces(line, counted_depth)
        }
      }
      print ""
      next
    }

    # -----------------------------------------------------------------------
    # Emit: top-level use statements (for import context)
    # -----------------------------------------------------------------------

    /^use / { print $0; next }

    # -----------------------------------------------------------------------
    # Default: clear doc buffer on non-public, non-doc lines
    # -----------------------------------------------------------------------

    { doc_buf = "" }

  ' "$file"
}

# ---------------------------------------------------------------------------
# Output: lib.rs (crate re-exports, signatures only)
# ---------------------------------------------------------------------------

banner "src/lib.rs -- Crate re-exports (signatures only)"
extract_public_api "$PROJECT_ROOT/src/lib.rs"
echo ""

# ---------------------------------------------------------------------------
# Output: model/ files -- signatures only (preserve black-box methodology)
# ---------------------------------------------------------------------------

banner "src/model/ -- Data types (signatures only)"
for f in "$PROJECT_ROOT"/src/model/*.rs; do
  echo ""
  echo "// --- model/$(basename "$f") ---"
  extract_public_api "$f"
done
echo ""

# ---------------------------------------------------------------------------
# Output: requested module(s)
# ---------------------------------------------------------------------------

for f in "${files[@]}"; do
  full_path="$PROJECT_ROOT/$f"
  if [[ ! -f "$full_path" ]]; then
    echo "Warning: $f not found, skipping" >&2
    continue
  fi
  banner "$f -- Public API signatures only (bodies stripped)"
  extract_public_api "$full_path"
  echo ""
done
