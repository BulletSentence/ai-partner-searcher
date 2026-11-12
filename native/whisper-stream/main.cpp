// Adapter between the Electron app and Whisper.cpp.
//
// Live mode (default)
//   Input (stdin): framed PCM. Each frame is [1 byte channel][4 bytes little-endian payload size]
//   followed by 16 kHz mono signed-16-bit samples. Channel 0 is the system audio (the client),
//   channel 1 is the microphone (the meeting owner).
//   Output (stdout), one JSON object per line:
//     {"type":"ready","vad":"silero"}
//     {"type":"partial","channel":0,"text":"..."}                      while someone is speaking
//     {"type":"final","channel":0,"text":"...","t0":1234,"t1":5678,"nsp":0.01,"p":0.93,"ms":210}
//
// Offline mode (--file RECORDING)
//   A second, unhurried pass over a saved recording; see run_offline below.
//
// How audio is cut into blocks
//   A voice detector marks every 32 ms frame as speech or not: the Silero neural detector when its
//   model is given (--vad-model), otherwise loudness relative to the background noise. An utterance
//   starts shortly before the first speech frame and ends at the first real pause. Someone who talks
//   without pausing is cut at the quietest instant of the last seconds, never in the middle of a word.

#include "whisper.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr int kSampleRate = 16000;
constexpr int kChannels = 2;
constexpr int kFrameSamples = 512;  // 32 ms, the window the Silero detector works on

constexpr int frames_for_ms(int ms) { return (ms * kSampleRate / 1000 + kFrameSamples - 1) / kFrameSamples; }

constexpr int kPrerollFrames = frames_for_ms(300);       // audio kept before the detected start
constexpr int kStartWindowFrames = 5;                    // speech starts when 3 of the last 5 frames are voiced
constexpr int kStartVoicedFrames = 3;
constexpr int kEndSilenceFrames = frames_for_ms(640);    // a pause this long closes an utterance
constexpr int kLongEndSilenceFrames = frames_for_ms(250);  // a short pause is enough once it is long
constexpr int kMinVoicedFrames = frames_for_ms(240);     // less voice than this is a click, not speech
constexpr int kCutSearchFrames = frames_for_ms(5000);    // where to look for the quietest instant
constexpr int kCutGuardFrames = frames_for_ms(500);      // never cut this close to either end
constexpr int kCutSmoothFrames = 2;                      // energy is averaged over 5 frames (160 ms)
constexpr int kPartialStepSamples = kSampleRate * 3 / 2;
constexpr int kPartialBacklogSamples = kSampleRate * 2;
constexpr float kMinThreshold = 0.0035F;  // about -49 dBFS
constexpr float kNoiseRatio = 3.0F;
constexpr int kNoiseWindowFrames = frames_for_ms(1600);
constexpr float kVadStartProbability = 0.5F;
constexpr float kVadContinueProbability = 0.35F;

struct Options {
  std::string model;
  std::string language = "pt";
  std::string prompt;
  std::string vad_model;
  std::string file;  // offline mode: transcribe this recording instead of stdin
  int beam_size = 5;
  int threads = 0;
};

/** How long an utterance may grow before it is cut, which differs between live and offline use. */
struct SegmentLimits {
  size_t long_samples;  // from here on a short pause is enough to close it
  size_t max_samples;   // from here on it is cut at the quietest instant
};
constexpr SegmentLimits kLiveLimits = {kSampleRate * 12, kSampleRate * 22};
constexpr SegmentLimits kOfflineLimits = {kSampleRate * 20, kSampleRate * 28};

std::string escape_json(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 8);
  for (const unsigned char character : value) {
    switch (character) {
      case '\\': escaped += "\\\\"; break;
      case '"': escaped += "\\\""; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (character < 0x20) {
          char buffer[8];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", character);
          escaped += buffer;
        } else {
          escaped += static_cast<char>(character);
        }
    }
  }
  return escaped;
}

std::string trim(const std::string& text) {
  const auto first = text.find_first_not_of(" \t\n\r");
  if (first == std::string::npos) return "";
  const auto last = text.find_last_not_of(" \t\n\r");
  return text.substr(first, last - first + 1);
}

void silent_log(ggml_log_level, const char*, void*) {}

float frame_rms(const float* frame) {
  double sum = 0.0;
  for (int index = 0; index < kFrameSamples; ++index) sum += static_cast<double>(frame[index]) * frame[index];
  return static_cast<float>(std::sqrt(sum / kFrameSamples));
}

// ---------------------------------------------------------------------------------------------
// Voice detection
// ---------------------------------------------------------------------------------------------

struct VadDeleter {
  void operator()(whisper_vad_context* context) const { whisper_vad_free(context); }
};
using VadContext = std::unique_ptr<whisper_vad_context, VadDeleter>;

VadContext load_vad(const std::string& path) {
  if (path.empty()) return nullptr;
  whisper_vad_context_params params = whisper_vad_default_context_params();
  params.n_threads = 1;
  params.use_gpu = false;  // the model is tiny; the GPU stays free for Whisper
  VadContext context(whisper_vad_init_from_file_with_params(path.c_str(), params));
  if (!context) std::cerr << "whisper-stream: could not load the VAD model, using loudness instead" << std::endl;
  return context;
}

/** Decides, frame by frame, whether someone is speaking on one audio track. */
class VoiceDetector {
 public:
  explicit VoiceDetector(VadContext vad) : vad_(std::move(vad)) {}

  bool is_neural() const { return vad_ != nullptr; }

  /** Speech probability of each whole frame in `samples`; empty when the neural detector is off. */
  std::vector<float> probabilities(const float* samples, size_t frames) {
    std::vector<float> result;
    if (!vad_ || frames == 0) return result;
    // One call for all pending frames: the detector keeps its state between calls.
    if (!whisper_vad_detect_speech_no_reset(vad_.get(), samples, static_cast<int>(frames * kFrameSamples))) return result;
    const int count = whisper_vad_n_probs(vad_.get());
    const float* probs = whisper_vad_probs(vad_.get());
    if (count >= static_cast<int>(frames)) result.assign(probs, probs + frames);
    return result;
  }

  /** `probability` is negative when the neural detector did not produce one for this frame. */
  bool voiced(float rms, float probability, bool in_speech) {
    const bool loud = update_noise_floor(rms, in_speech);
    if (probability < 0.0F) return loud;
    // Digital silence can never be speech, whatever the model thinks of it.
    return rms > kMinThreshold / 4 && probability >= (in_speech ? kVadContinueProbability : kVadStartProbability);
  }

 private:
  bool update_noise_floor(float rms, bool in_speech) {
    recent_.push_back(rms);
    if (recent_.size() > static_cast<size_t>(kNoiseWindowFrames)) recent_.pop_front();
    if (!in_speech) {
      // The floor follows quiet audio quickly and loud audio slowly.
      noise_floor_ += (rms - noise_floor_) * (rms < noise_floor_ ? 0.2F : 0.01F);
    } else if (recent_.size() == static_cast<size_t>(kNoiseWindowFrames)) {
      // Speech always dips between syllables; if even the quietest recent frame is above the
      // floor, the background got louder (a fan, a keyboard) and the floor must follow it.
      const float quietest = *std::min_element(recent_.begin(), recent_.end());
      if (quietest > noise_floor_) noise_floor_ += (quietest - noise_floor_) * 0.05F;
    }
    return rms > std::max(kMinThreshold, noise_floor_ * kNoiseRatio);
  }

  VadContext vad_;
  std::deque<float> recent_;
  float noise_floor_ = 0.0F;
};

// ---------------------------------------------------------------------------------------------
// Cutting audio into utterances
// ---------------------------------------------------------------------------------------------

struct Utterance {
  std::vector<float> samples;
  int64_t start = 0;  // position of the first sample on this track
};

/** Groups the frames of one track into utterances, shared by the live and the offline path. */
class Segmenter {
 public:
  Segmenter(SegmentLimits limits, VadContext vad) : limits_(limits), detector_(std::move(vad)) {}

  VoiceDetector& detector() { return detector_; }
  bool in_speech() const { return in_speech_; }
  const std::vector<float>& current() const { return samples_; }

  /** Adds one frame. Returns true when it closed an utterance, which is then left in `closed`. */
  bool push(const float* frame, float probability, Utterance& closed) {
    const float rms = frame_rms(frame);
    const bool voiced = detector_.voiced(rms, probability, in_speech_);
    position_ += kFrameSamples;

    if (!in_speech_) {
      preroll_.insert(preroll_.end(), frame, frame + kFrameSamples);
      preroll_frames_.push_back({rms, voiced});
      if (preroll_frames_.size() > static_cast<size_t>(kPrerollFrames)) {
        preroll_.erase(preroll_.begin(), preroll_.begin() + kFrameSamples);
        preroll_frames_.pop_front();
      }
      int recent_voiced = 0;
      const size_t window = std::min(preroll_frames_.size(), static_cast<size_t>(kStartWindowFrames));
      for (size_t index = preroll_frames_.size() - window; index < preroll_frames_.size(); ++index) {
        recent_voiced += preroll_frames_[index].voiced ? 1 : 0;
      }
      if (recent_voiced < kStartVoicedFrames) return false;

      in_speech_ = true;
      silence_ = 0;
      samples_.assign(preroll_.begin(), preroll_.end());
      frames_.assign(preroll_frames_.begin(), preroll_frames_.end());
      start_ = position_ - static_cast<int64_t>(samples_.size());
      preroll_.clear();
      preroll_frames_.clear();
      return false;
    }

    samples_.insert(samples_.end(), frame, frame + kFrameSamples);
    frames_.push_back({rms, voiced});
    silence_ = voiced ? 0 : silence_ + 1;

    const int needed_silence = samples_.size() >= limits_.long_samples ? kLongEndSilenceFrames : kEndSilenceFrames;
    if (silence_ >= needed_silence) return close(frames_.size(), closed);
    if (samples_.size() >= limits_.max_samples) return close(quietest_cut(), closed);
    return false;
  }

  /** Closes whatever is being spoken when the audio ends. */
  bool flush(Utterance& closed) { return in_speech_ && close(frames_.size(), closed); }

 private:
  struct Frame {
    float rms;
    bool voiced;
  };

  /** The frame, within the last seconds, around which the audio is quietest. */
  size_t quietest_cut() const {
    const size_t last = frames_.size() - kCutGuardFrames;
    const size_t first = frames_.size() > static_cast<size_t>(kCutSearchFrames) ? frames_.size() - kCutSearchFrames : kCutGuardFrames;
    size_t best = last;
    float best_energy = -1.0F;
    for (size_t index = first; index <= last; ++index) {
      float energy = 0.0F;
      for (int offset = -kCutSmoothFrames; offset <= kCutSmoothFrames; ++offset) energy += frames_[index + offset].rms;
      // A frame the detector calls silence is always preferred over a merely quiet one.
      if (frames_[index].voiced) energy += 1000.0F;
      if (best_energy < 0.0F || energy < best_energy) {
        best_energy = energy;
        best = index;
      }
    }
    return best;
  }

  /** Emits the first `cut` frames; anything after them carries on as the next utterance. */
  bool close(size_t cut, Utterance& closed) {
    const size_t cut_samples = cut * kFrameSamples;
    const auto voiced_frames =
        std::count_if(frames_.begin(), frames_.begin() + static_cast<std::ptrdiff_t>(cut), [](const Frame& frame) { return frame.voiced; });
    closed.samples.assign(samples_.begin(), samples_.begin() + static_cast<std::ptrdiff_t>(cut_samples));
    closed.start = start_;

    samples_.erase(samples_.begin(), samples_.begin() + static_cast<std::ptrdiff_t>(cut_samples));
    frames_.erase(frames_.begin(), frames_.begin() + static_cast<std::ptrdiff_t>(cut));
    start_ += static_cast<int64_t>(cut_samples);
    in_speech_ = !frames_.empty();
    silence_ = 0;
    return voiced_frames >= kMinVoicedFrames;
  }

  SegmentLimits limits_;
  VoiceDetector detector_;
  std::vector<float> preroll_;
  std::deque<Frame> preroll_frames_;
  std::vector<float> samples_;
  std::vector<Frame> frames_;
  bool in_speech_ = false;
  int silence_ = 0;
  int64_t position_ = 0;  // samples analysed so far: this track's clock
  int64_t start_ = 0;
};

// ---------------------------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------------------------

struct Result {
  std::string text;
  float no_speech_prob = 0.0F;
  float confidence = 0.0F;  // mean probability of the decoded text tokens
  long long elapsed_ms = 0;
};

enum class Quality { kPartial, kFinal };

Result transcribe(whisper_context* context, const Options& options, const std::vector<float>& speech,
                  const std::string& prompt, Quality quality) {
  // Trailing silence lets the decoder finish the last word; very short audio is padded to 1 s.
  std::vector<float> audio(speech);
  audio.resize(std::max(audio.size() + kSampleRate * 3 / 10, static_cast<size_t>(kSampleRate)), 0.0F);

  const bool is_final = quality == Quality::kFinal;
  whisper_full_params params =
      whisper_full_default_params(is_final && options.beam_size > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
  params.print_progress = false;
  params.print_special = false;
  params.print_realtime = false;
  params.print_timestamps = false;
  params.translate = false;
  params.no_context = true;
  params.no_timestamps = true;
  params.suppress_blank = true;
  params.suppress_nst = true;
  params.language = options.language.c_str();
  params.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
  params.n_threads = options.threads;
  if (is_final) {
    params.beam_search.beam_size = options.beam_size;
  } else {
    // Partials are disposable: never retry them, and let the encoder look only at the audio
    // there is instead of a full 30 s window, which makes short ones several times cheaper.
    params.temperature_inc = 0.0F;
    params.audio_ctx = std::min(1500, static_cast<int>(audio.size() / 320) + 64);
  }

  Result result;
  const auto started = std::chrono::steady_clock::now();
  if (whisper_full(context, params, audio.data(), static_cast<int>(audio.size())) != 0) {
    std::cerr << "whisper-stream: could not transcribe an utterance" << std::endl;
    return result;
  }
  std::string text;
  double probability_sum = 0.0;
  int text_tokens = 0;
  const whisper_token first_special = whisper_token_eot(context);
  const int segments = whisper_full_n_segments(context);
  for (int index = 0; index < segments; ++index) {
    text += whisper_full_get_segment_text(context, index);
    result.no_speech_prob = std::max(result.no_speech_prob, whisper_full_get_segment_no_speech_prob(context, index));
    const int tokens = whisper_full_n_tokens(context, index);
    for (int token = 0; token < tokens; ++token) {
      if (whisper_full_get_token_id(context, index, token) >= first_special) continue;
      probability_sum += whisper_full_get_token_p(context, index, token);
      text_tokens += 1;
    }
  }
  result.text = trim(text);
  result.confidence = text_tokens > 0 ? static_cast<float>(probability_sum / text_tokens) : 0.0F;
  result.elapsed_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  return result;
}

long long to_ms(int64_t samples) { return static_cast<long long>(samples) * 1000 / kSampleRate; }

// ---------------------------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------------------------

struct Channel {
  explicit Channel(VadContext vad) : segmenter(kLiveLimits, std::move(vad)) {}
  std::vector<float> pending;  // filled by the reader thread
  std::vector<float> samples;  // owned by the worker
  Segmenter segmenter;
  size_t last_partial_size = 0;
};

std::mutex g_mutex;
std::condition_variable g_wakeup;
std::vector<Channel> g_channels;
bool g_eof = false;

bool read_exact(char* buffer, size_t size) {
  std::cin.read(buffer, static_cast<std::streamsize>(size));
  return static_cast<size_t>(std::cin.gcount()) == size;
}

/** Reads framed PCM from stdin so the pipe never stalls while Whisper is busy. */
void reader_loop() {
  std::vector<int16_t> pcm;
  while (true) {
    unsigned char header[5];
    if (!read_exact(reinterpret_cast<char*>(header), sizeof(header))) break;
    const int channel = header[0];
    const uint32_t bytes = static_cast<uint32_t>(header[1]) | (static_cast<uint32_t>(header[2]) << 8) |
                           (static_cast<uint32_t>(header[3]) << 16) | (static_cast<uint32_t>(header[4]) << 24);
    if (bytes > 16U * 1024U * 1024U) {
      std::cerr << "whisper-stream: invalid frame size, stopping" << std::endl;
      break;
    }
    pcm.resize(bytes / sizeof(int16_t));
    if (!read_exact(reinterpret_cast<char*>(pcm.data()), pcm.size() * sizeof(int16_t))) break;
    if (bytes % sizeof(int16_t) != 0) {
      char padding;
      if (!read_exact(&padding, 1)) break;
    }
    if (channel < 0 || channel >= kChannels) continue;
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      auto& pending = g_channels[channel].pending;
      pending.reserve(pending.size() + pcm.size());
      for (const int16_t sample : pcm) pending.push_back(static_cast<float>(sample) / 32768.0F);
    }
    g_wakeup.notify_one();
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_eof = true;
  }
  g_wakeup.notify_one();
}

void emit_final(whisper_context* context, const Options& options, int channel_index, const Utterance& utterance) {
  const Result result = transcribe(context, options, utterance.samples, options.prompt, Quality::kFinal);
  if (result.text.empty()) return;
  std::cout << "{\"type\":\"final\",\"channel\":" << channel_index << ",\"text\":\"" << escape_json(result.text)
            << "\",\"t0\":" << to_ms(utterance.start)
            << ",\"t1\":" << to_ms(utterance.start + static_cast<int64_t>(utterance.samples.size()))
            << ",\"nsp\":" << result.no_speech_prob << ",\"p\":" << result.confidence
            << ",\"ms\":" << result.elapsed_ms << "}" << std::endl;
}

void emit_partial(whisper_context* context, const Options& options, int channel_index, Channel& channel) {
  channel.last_partial_size = channel.segmenter.current().size();
  const Result result = transcribe(context, options, channel.segmenter.current(), options.prompt, Quality::kPartial);
  if (result.text.empty() || result.no_speech_prob > 0.6F) return;
  std::cout << "{\"type\":\"partial\",\"channel\":" << channel_index << ",\"text\":\"" << escape_json(result.text)
            << "\"}" << std::endl;
}

/** Runs the voice detector over the buffered audio and transcribes every utterance it closes. */
void process_channel(whisper_context* context, const Options& options, int channel_index, Channel& channel) {
  const size_t frames = channel.samples.size() / kFrameSamples;
  if (frames == 0) return;
  const std::vector<float> probabilities = channel.segmenter.detector().probabilities(channel.samples.data(), frames);
  Utterance utterance;
  for (size_t frame = 0; frame < frames; ++frame) {
    const float probability = probabilities.empty() ? -1.0F : probabilities[frame];
    if (channel.segmenter.push(channel.samples.data() + frame * kFrameSamples, probability, utterance)) {
      channel.last_partial_size = 0;
      emit_final(context, options, channel_index, utterance);
    }
  }
  channel.samples.erase(channel.samples.begin(), channel.samples.begin() + static_cast<std::ptrdiff_t>(frames * kFrameSamples));
}

int run_live(whisper_context* context, const Options& options) {
  for (int index = 0; index < kChannels; ++index) g_channels.emplace_back(load_vad(options.vad_model));
  std::cout << "{\"type\":\"ready\",\"vad\":\""
            << (g_channels[0].segmenter.detector().is_neural() ? "silero" : "energy") << "\"}" << std::endl;

  std::thread reader(reader_loop);
  bool finished = false;
  while (!finished) {
    size_t backlog = 0;
    {
      std::unique_lock<std::mutex> lock(g_mutex);
      g_wakeup.wait(lock, [] {
        if (g_eof) return true;
        for (const auto& channel : g_channels) {
          if (channel.pending.size() >= static_cast<size_t>(kFrameSamples)) return true;
        }
        return false;
      });
      for (auto& channel : g_channels) {
        channel.samples.insert(channel.samples.end(), channel.pending.begin(), channel.pending.end());
        channel.pending.clear();
      }
      finished = g_eof;
    }
    for (int index = 0; index < kChannels; ++index) process_channel(context, options, index, g_channels[index]);
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      for (const auto& channel : g_channels) backlog += channel.pending.size();
    }
    // Partials keep the screen live, but only when Whisper is keeping up with the audio.
    if (!finished && backlog < static_cast<size_t>(kPartialBacklogSamples)) {
      for (int index = 0; index < kChannels; ++index) {
        Channel& channel = g_channels[index];
        if (channel.segmenter.in_speech() &&
            channel.segmenter.current().size() >= channel.last_partial_size + kPartialStepSamples) {
          emit_partial(context, options, index, channel);
        }
      }
    }
  }
  for (int index = 0; index < kChannels; ++index) {
    Utterance utterance;
    if (g_channels[index].segmenter.flush(utterance)) emit_final(context, options, index, utterance);
  }
  reader.join();
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Offline mode: a second, unhurried pass over a saved recording.
//
// Unlike the live path it hears whole stretches of speech at once (up to 28 s, cut only at a
// pause) and starts each one knowing how the previous one ended. Silence is skipped so the model
// is never asked to transcribe nothing.
//
// Output: {"type":"segment","t0":ms,"t1":ms,"voiced":ms,"text":"...","nsp":x,"p":y} per block,
// {"type":"progress",...}, and a closing {"type":"done"}.
// ---------------------------------------------------------------------------------------------
constexpr int64_t kMergeGapSamples = kSampleRate * 3;      // pauses up to 3 s stay in the same block
constexpr int64_t kCarryMaxGapSamples = kSampleRate * 10;  // only continue the previous text across short gaps
constexpr size_t kCarryChars = 160;
constexpr size_t kVadBatchFrames = 512;

struct Block {
  int64_t start;
  int64_t end;
  int64_t voiced;  // speech inside the block, the pauses between utterances excluded
};

bool load_recording(const std::string& path, std::vector<float>& audio) {
  FILE* file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) return false;
  char magic[4] = {0, 0, 0, 0};
  const size_t magic_read = std::fread(magic, 1, sizeof(magic), file);
  // The app writes plain 44-byte-header PCM WAV files; anything else is treated as raw PCM.
  const bool is_wav = magic_read == sizeof(magic) && std::memcmp(magic, "RIFF", 4) == 0;
  std::fseek(file, is_wav ? 44 : 0, SEEK_SET);
  std::vector<int16_t> buffer(1 << 16);
  size_t read = 0;
  while ((read = std::fread(buffer.data(), sizeof(int16_t), buffer.size(), file)) > 0) {
    for (size_t index = 0; index < read; ++index) audio.push_back(static_cast<float>(buffer[index]) / 32768.0F);
  }
  std::fclose(file);
  return true;
}

/** Finds the utterances of a recording and joins the ones separated by short pauses. */
std::vector<Block> find_blocks(const std::vector<float>& audio, const Options& options) {
  Segmenter segmenter(kOfflineLimits, load_vad(options.vad_model));
  std::vector<Block> blocks;
  const auto add = [&blocks](const Utterance& utterance) {
    const int64_t end = utterance.start + static_cast<int64_t>(utterance.samples.size());
    if (!blocks.empty() && utterance.start - blocks.back().end <= kMergeGapSamples &&
        end - blocks.back().start <= static_cast<int64_t>(kOfflineLimits.max_samples)) {
      blocks.back().end = end;
      blocks.back().voiced += static_cast<int64_t>(utterance.samples.size());
    } else {
      blocks.push_back({utterance.start, end, static_cast<int64_t>(utterance.samples.size())});
    }
  };

  Utterance utterance;
  const size_t frames = audio.size() / kFrameSamples;
  for (size_t first = 0; first < frames; first += kVadBatchFrames) {
    const size_t count = std::min(kVadBatchFrames, frames - first);
    const float* samples = audio.data() + first * kFrameSamples;
    const std::vector<float> probabilities = segmenter.detector().probabilities(samples, count);
    for (size_t frame = 0; frame < count; ++frame) {
      const float probability = probabilities.empty() ? -1.0F : probabilities[frame];
      if (segmenter.push(samples + frame * kFrameSamples, probability, utterance)) add(utterance);
    }
  }
  if (segmenter.flush(utterance)) add(utterance);
  return blocks;
}

std::string tail_at_word(const std::string& text, size_t max_chars) {
  if (text.size() <= max_chars) return text;
  const size_t cut = text.find(' ', text.size() - max_chars);
  return cut == std::string::npos ? "" : text.substr(cut + 1);
}

int run_offline(whisper_context* context, const Options& options) {
  std::vector<float> audio;
  if (!load_recording(options.file, audio)) {
    std::cerr << "whisper-stream: could not read " << options.file << std::endl;
    return 1;
  }
  std::cout << "{\"type\":\"ready\"}" << std::endl;
  const std::vector<Block> blocks = find_blocks(audio, options);
  const long long total_ms = to_ms(static_cast<int64_t>(audio.size()));
  std::string previous_text;
  int64_t previous_end = 0;

  for (const Block& block : blocks) {
    const std::vector<float> speech(audio.begin() + block.start, audio.begin() + block.end);

    // The vocabulary comes first and the end of the previous block last: when the prompt is too
    // long Whisper keeps its tail, which is the part that helps continuity.
    std::string prompt = options.prompt;
    if (!previous_text.empty() && block.start - previous_end <= kCarryMaxGapSamples) {
      prompt += (prompt.empty() ? "" : " ") + tail_at_word(previous_text, kCarryChars);
    }

    const Result result = transcribe(context, options, speech, prompt, Quality::kFinal);
    if (!result.text.empty()) {
      std::cout << "{\"type\":\"segment\",\"t0\":" << to_ms(block.start) << ",\"t1\":" << to_ms(block.end)
                << ",\"voiced\":" << to_ms(block.voiced) << ",\"text\":\"" << escape_json(result.text)
                << "\",\"nsp\":" << result.no_speech_prob << ",\"p\":" << result.confidence << "}" << std::endl;
      previous_text = result.text;
      previous_end = block.end;
    }
    std::cout << "{\"type\":\"progress\",\"done\":" << to_ms(block.end) << ",\"total\":" << total_ms << "}" << std::endl;
  }
  std::cout << "{\"type\":\"done\",\"total\":" << total_ms << "}" << std::endl;
  return 0;
}

bool parse_options(int argc, char* argv[], Options& options) {
  for (int index = 1; index < argc; ++index) {
    const std::string name = argv[index];
    const bool has_value = index + 1 < argc;
    if (name == "--model" && has_value) options.model = argv[++index];
    else if (name == "--language" && has_value) options.language = argv[++index];
    else if (name == "--prompt" && has_value) options.prompt = argv[++index];
    else if (name == "--beam" && has_value) options.beam_size = std::atoi(argv[++index]);
    else if (name == "--threads" && has_value) options.threads = std::atoi(argv[++index]);
    else if (name == "--vad-model" && has_value) options.vad_model = argv[++index];
    else if (name == "--file" && has_value) options.file = argv[++index];
    else return false;
  }
  if (options.threads <= 0) {
    options.threads = static_cast<int>(std::min(8U, std::max(1U, std::thread::hardware_concurrency())));
  }
  return !options.model.empty();
}
}  // namespace

int main(int argc, char* argv[]) {
  Options options;
  if (!parse_options(argc, argv, options)) {
    std::cerr << "Usage: whisper-stream --model PATH [--language pt] [--prompt TEXT] [--vad-model PATH] [--beam 5]"
                 " [--threads N] [--file RECORDING]"
              << std::endl;
    return 2;
  }
  if (std::getenv("WHISPER_STREAM_VERBOSE") == nullptr) whisper_log_set(silent_log, nullptr);

  whisper_context_params context_params = whisper_context_default_params();
  context_params.use_gpu = true;
  context_params.flash_attn = true;
  whisper_context* context = whisper_init_from_file_with_params(options.model.c_str(), context_params);
  if (context == nullptr) {
    std::cerr << "Could not load Whisper model: " << options.model << std::endl;
    return 1;
  }

  const int status = options.file.empty() ? run_live(context, options) : run_offline(context, options);
  g_channels.clear();
  whisper_free(context);
  return status;
}
