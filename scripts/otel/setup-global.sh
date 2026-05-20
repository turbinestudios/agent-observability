#!/usr/bin/env bash
# ==============================================================================
# setup-global.sh — VS Code Copilot OTel global environment setup
# ==============================================================================
#
# PURPOSE:
#   Sets persistent environment variables for OTLP authentication and global
#   resource attributes (user.email) in the user's shell rc file.
#
# WHAT IT WRITES:
#   A delimited block in ~/.zshrc, ~/.bashrc, or ~/.bash_profile containing:
#     export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64(otlp:key)>"
#     export OTEL_RESOURCE_ATTRIBUTES_GLOBAL="user.email=<email>"
#
# HOW TO UNDO:
#   Run: bash setup-global.sh --uninstall
#   This removes the delimited block from the shell rc file.
#
# USAGE:
#   bash setup-global.sh --email alice@example.com --api-key "my-secret-key"
#   bash setup-global.sh --uninstall
#
# ==============================================================================
set -euo pipefail

readonly BLOCK_START="# >>> vscode-copilot-otel global setup >>>"
readonly BLOCK_END="# <<< vscode-copilot-otel global setup <<<"

# --- Helpers ------------------------------------------------------------------

die() {
  echo "ERROR: $*" >&2
  exit 1
}

detect_rc_file() {
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/bash}")"

  case "$shell_name" in
    zsh)
      echo "${HOME}/.zshrc"
      ;;
    bash)
      if [[ -f "${HOME}/.bashrc" ]]; then
        echo "${HOME}/.bashrc"
      elif [[ -f "${HOME}/.bash_profile" ]]; then
        echo "${HOME}/.bash_profile"
      else
        echo "${HOME}/.bashrc"
      fi
      ;;
    *)
      # Fallback to bashrc
      echo "${HOME}/.bashrc"
      ;;
  esac
}

remove_block() {
  local rc_file="$1"
  if [[ ! -f "$rc_file" ]]; then
    return 0
  fi
  # Remove the delimited block (inclusive of start/end markers)
  local tmp_file
  tmp_file="$(mktemp)"
  local inside_block=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$BLOCK_START" ]]; then
      inside_block=1
      continue
    fi
    if [[ "$line" == "$BLOCK_END" ]]; then
      inside_block=0
      continue
    fi
    if [[ $inside_block -eq 0 ]]; then
      printf '%s\n' "$line" >> "$tmp_file"
    fi
  done < "$rc_file"
  # Remove trailing blank lines that may have been left
  mv "$tmp_file" "$rc_file"
}

validate_email() {
  local email="$1"
  if [[ -z "$email" ]]; then
    die "--email cannot be empty."
  fi
  if [[ ! "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
    die "Invalid email format: $email"
  fi
}

validate_api_key() {
  local key="$1"
  if [[ -z "$key" ]]; then
    die "--api-key cannot be empty."
  fi
}

format_auth_header() {
  local key="$1"
  local encoded
  encoded="$(printf 'otlp:%s' "$key" | base64 | tr -d '\n')"
  printf 'Authorization=Basic %s' "$encoded"
}

# --- Argument Parsing ---------------------------------------------------------

email=""
api_key=""
uninstall=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      email="${2:-}"
      shift 2
      ;;
    --api-key)
      api_key="${2:-}"
      shift 2
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

# --- Main Logic ---------------------------------------------------------------

rc_file="$(detect_rc_file)"

if [[ $uninstall -eq 1 ]]; then
  echo "Removing OTel global setup block from $rc_file..."
  remove_block "$rc_file"
  echo "Done. The block has been removed."
  echo "Restart your terminal and VS Code for changes to take effect."
  exit 0
fi

# Interactive prompts if args not provided
if [[ -z "$email" ]]; then
  read -rp "Developer email: " email
fi
if [[ -z "$api_key" ]]; then
  echo -n "API key for the OTel collector: "
  read -rs api_key
  echo ""
fi

# Validation
validate_email "$email"
validate_api_key "$api_key"

# Format the auth header: Authorization=Basic base64("otlp:<key>")
auth_header="$(format_auth_header "$api_key")"

# Remove existing block (idempotent)
remove_block "$rc_file"

# Ensure the rc file exists
touch "$rc_file"

# Append the new block
{
  echo ""
  echo "$BLOCK_START"
  echo "export OTEL_EXPORTER_OTLP_HEADERS=\"$auth_header\""
  echo "export OTEL_RESOURCE_ATTRIBUTES_GLOBAL=\"user.email=$email\""
  echo "$BLOCK_END"
} >> "$rc_file"

echo "Done. Updated: $rc_file"
echo "Restart your terminal and VS Code for changes to take effect."
