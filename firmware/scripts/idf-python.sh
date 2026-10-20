PYTHON_PIN=3.12

sys_minor=$(python3 -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)
if (( sys_minor < 9 || sys_minor > 13 )); then
  if ! command -v uv >/dev/null 2>&1; then
    echo "system python3 is not 3.9-3.13 and uv is missing; install either" >&2
    return 1
  fi
  uv python install -q "$PYTHON_PIN"
  idf_py_shim=$(mktemp -d)
  ln -s "$(uv python find "$PYTHON_PIN")" "$idf_py_shim/python3"
  ln -s "$idf_py_shim/python3" "$idf_py_shim/python"
  PATH="$idf_py_shim:$PATH"
fi
