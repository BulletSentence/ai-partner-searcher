#!/usr/bin/env bash
set -euo pipefail

model_name="${1:-large-v3-turbo}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
whisper_source_dir="${WHISPER_CPP_DIR:-$repo_root/.cache/whisper.cpp}"
models_dir="${WHISPER_MODELS_DIR:-$repo_root/models}"

if [ ! -f "$whisper_source_dir/models/download-ggml-model.sh" ]; then
  echo "Whisper.cpp não encontrado. Execute primeiro: npm run whisper:build" >&2
  exit 1
fi

mkdir -p "$models_dir"
bash "$whisper_source_dir/models/download-ggml-model.sh" "$model_name"
cp "$whisper_source_dir/models/ggml-$model_name.bin" "$models_dir/"
echo "Modelo pronto em $models_dir/ggml-$model_name.bin"
