#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
whisper_source_dir="${WHISPER_CPP_DIR:-$repo_root/.cache/whisper.cpp}"
build_dir="$repo_root/.cache/whisper-stream-build"
output_dir="$repo_root/bin"

if ! command -v cmake >/dev/null 2>&1; then
  echo "CMake é necessário. Instale-o e execute este comando novamente." >&2
  exit 1
fi

if [ ! -d "$whisper_source_dir/.git" ]; then
  mkdir -p "$(dirname "$whisper_source_dir")"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$whisper_source_dir"
fi

cmake_args=(
  -S "$repo_root/native/whisper-stream"
  -B "$build_dir"
  -DWHISPER_CPP_DIR="$whisper_source_dir"
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
)

if [ "$(uname -s)" = "Darwin" ]; then
  cmake_args+=(-DGGML_METAL=ON)
fi

cmake "${cmake_args[@]}"
cmake --build "$build_dir" --config Release --parallel
mkdir -p "$output_dir"
cp "$build_dir/whisper-stream" "$output_dir/whisper-stream"
chmod +x "$output_dir/whisper-stream"
echo "Adaptador Whisper pronto em $output_dir/whisper-stream"
