IDF_ROOT="${IDF_PATH:-$HOME/esp/esp-idf}"

if [[ ! -f "$IDF_ROOT/export.sh" ]]; then
  echo "esp-idf not found at $IDF_ROOT; run scripts/setup-idf.sh" >&2
  return 1
fi

. "$(dirname "${BASH_SOURCE[0]}")/idf-python.sh"
idf_export_log=$(mktemp)
. "$IDF_ROOT/export.sh" >"$idf_export_log" 2>&1 || { cat "$idf_export_log" >&2; return 1; }
