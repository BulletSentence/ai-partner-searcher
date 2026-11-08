cmake_minimum_required(VERSION 3.16)
project(ai_assistant_whisper_stream LANGUAGES CXX)

if(NOT DEFINED WHISPER_CPP_DIR)
  message(FATAL_ERROR "Pass -DWHISPER_CPP_DIR=/absolute/path/to/whisper.cpp")
endif()

add_subdirectory(${WHISPER_CPP_DIR} whisper.cpp)

add_executable(whisper-stream main.cpp)
target_compile_features(whisper-stream PRIVATE cxx_std_17)
target_link_libraries(whisper-stream PRIVATE whisper)
