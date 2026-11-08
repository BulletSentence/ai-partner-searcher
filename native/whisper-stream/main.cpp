#include "whisper.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {
constexpr int kSampleRate = 16000;
constexpr size_t kSamplesPerWindow = kSampleRate * 3;

std::string escape_json(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (const char character : value) {
    switch (character) {
      case '\\': escaped += "\\\\"; break;
      case '"': escaped += "\\\""; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default: escaped += character;
    }
  }
  return escaped;
}

void print_result(whisper_context* context) {
  std::string text;
  const int segments = whisper_full_n_segments(context);
  for (int index = 0; index < segments; ++index) text += whisper_full_get_segment_text(context, index);
  const auto first = text.find_first_not_of(" \t\n\r");
  if (first == std::string::npos) return;
  const auto last = text.find_last_not_of(" \t\n\r");
  std::cout << "{\"type\":\"final\",\"text\":\""
            << escape_json(text.substr(first, last - first + 1)) << "\"}" << std::endl;
}
}  // namespace

int main(int argc, char* argv[]) {
  if (argc < 2) {
    std::cerr << "Usage: whisper-stream MODEL_PATH [LANGUAGE]" << std::endl;
    return 2;
  }
  whisper_context_params context_params = whisper_context_default_params();
  whisper_context* context = whisper_init_from_file_with_params(argv[1], context_params);
  if (context == nullptr) {
    std::cerr << "Could not load Whisper model: " << argv[1] << std::endl;
    return 1;
  }
  whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  params.print_progress = false;
  params.print_special = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.translate = false;
  params.no_context = true;
  params.language = argc >= 3 ? argv[2] : "pt";

  std::vector<int16_t> pcm16(kSamplesPerWindow);
  std::vector<float> pcmf32(kSamplesPerWindow);
  while (std::cin.read(reinterpret_cast<char*>(pcm16.data()), pcm16.size() * sizeof(int16_t)) || std::cin.gcount() > 0) {
    const size_t samples_read = static_cast<size_t>(std::cin.gcount()) / sizeof(int16_t);
    if (samples_read == 0) continue;
    std::transform(pcm16.begin(), pcm16.begin() + samples_read, pcmf32.begin(), [](int16_t sample) {
      return static_cast<float>(sample) / 32768.0F;
    });
    if (whisper_full(context, params, pcmf32.data(), static_cast<int>(samples_read)) == 0) print_result(context);
    else std::cerr << "Whisper could not transcribe the audio window" << std::endl;
  }
  whisper_free(context);
  return 0;
}
