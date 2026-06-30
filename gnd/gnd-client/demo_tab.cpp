// Copyright 2020 Arthur Sonzogni. All rights reserved.
// Use of this source code is governed by the MIT license that can be found in
// the LICENSE file.

/**
 * @file main.cpp
 * @brief FTXUI 라이브러리를 활용한 터미널 UI 데모 애플리케이션
 *
 * 이 프로그램은 FTXUI(Functional Terminal (X) User Interface)의 다양한 컴포넌트
 * (그래프, 폼 요소, 스피너, 색상 팔레트, 게이지, 텍스트 레이아웃 등)를 탭 형태로
 * 구성하여 보여주는 종합 데모입니다.
 * 선언적(Declarative) UI 구성 방식과 메인 루프를 통한 애니메이션 구현 방식을 확인할 수 있습니다.
 */

#include "demo_tab.hpp"

#include <algorithm>
#include <array>  // for array
#include <atomic> // for atomic
#include <chrono> // for operator""s, chrono_literals
#include <cmath>  // for sin
#include <deque>  // for deque
#include <ftxui/component/loop.hpp>
#include <functional> // for ref, reference_wrapper, function
#include <iomanip>    // for setprecision, fixed
#include <map>        // for map
#include <memory>     // for allocator, shared_ptr, __shared_ptr_access
#include <sstream>    // for ostringstream
#include <stddef.h>   // for size_t
#include <string>     // for string, basic_string, char_traits, operator+, to_string
#include <thread>     // for sleep_for, thread
#include <utility>    // for move
#include <vector>     // for vector

#define NOMINMAX     // Prevent windows.h from defining min/max macros
#include <windows.h> // for OpenFileMapping, MapViewOfFile

#include "ftxui/component/app.hpp"  // for Component, App
#include "ftxui/component/component.hpp" // for Checkbox, Renderer, Horizontal, Vertical, Input, Menu, Radiobox, ResizableSplitLeft, Tab
#include "ftxui/component/component_base.hpp"    // for ComponentBase, Component
#include "ftxui/component/component_options.hpp" // for MenuOption, InputOption
#include "ftxui/component/event.hpp"             // for Event, Event::Custom
#include "ftxui/dom/elements.hpp" // for text, color, operator|, bgcolor, filler, Element, vbox, size, hbox, separator, flex, window, graph, EQUAL, paragraph, WIDTH, hcenter, Elements, bold, vscroll_indicator, HEIGHT, flexbox, hflow, border, frame, flex_grow, gauge, paragraphAlignCenter, paragraphAlignJustify, paragraphAlignLeft, paragraphAlignRight, dim, spinner, LESS_THAN, center, yframe, GREATER_THAN
#include "ftxui/dom/flexbox_config.hpp" // for FlexboxConfig
#include "ftxui/screen/color.hpp" // for Color, Color::BlueLight, Color::RedLight, Color::Black, Color::Blue, Color::Cyan, Color::CyanLight, Color::GrayDark, Color::GrayLight, Color::Green, Color::GreenLight, Color::Magenta, Color::MagentaLight, Color::Red, Color::White, Color::Yellow, Color::YellowLight, Color::Default, Color::Palette256, ftxui
#include "ftxui/screen/color_info.hpp" // for ColorInfo
#include "ftxui/screen/terminal.hpp"   // for Size, Dimensions

using namespace ftxui;

namespace gnd {

using ftxui::Component;

// ---------------------------------------------------------------------------
// MSI Afterburner Shared Memory Structures
// ---------------------------------------------------------------------------
#pragma pack(push, 1)

struct MAHM_SHARED_MEMORY_HEADER {
  DWORD dwSignature;     // 'MAHM' (0x4D48414D)
  DWORD dwVersion;       // Version
  DWORD dwHeaderSize;    // Header size
  DWORD dwNumEntries;    // Number of entries
  DWORD dwEntrySize;     // Size of a single entry
  DWORD dwTime;          // Last update time
  DWORD dwNumGpuEntries; // Number of GPU entries
  DWORD dwGpuEntrySize;  // Size of a single GPU entry
};

struct MAHM_SHARED_MEMORY_ENTRY {
  char szSrcName[MAX_PATH];           // Data source name (e.g., "Core clock")
  char szSrcUnits[MAX_PATH];          // Units (e.g., "MHz")
  char szLocalizedSrcName[MAX_PATH];  // Localized name
  char szLocalizedSrcUnits[MAX_PATH]; // Localized units
  char szRecommendedFormat[MAX_PATH]; // Recommended output format (e.g., "%.3f")
  float data;                         // Current value
  float minLimit;                     // Graph min limit
  float maxLimit;                     // Graph max limit
  DWORD dwFlags;                      // Status flags
  DWORD dwGpu;                        // GPU index
  DWORD dwSrcId;                      // Source ID
};

#pragma pack(pop)

// ---------------------------------------------------------------------------
// Helper function to read all statistics from MSI Afterburner Shared Memory
// ---------------------------------------------------------------------------
std::map<std::string, float> GetStatisticsFromMSIAfterburner() {
  using namespace std;
  map<string, float> statistics;
  HANDLE hMapFile = OpenFileMappingA(FILE_MAP_READ, FALSE, "MAHMSharedMemory");

  if (hMapFile == NULL)
    return statistics;

  LPVOID pBuf = MapViewOfFile(hMapFile, FILE_MAP_READ, 0, 0, 0);
  if (pBuf != NULL) {
    MAHM_SHARED_MEMORY_HEADER *pHeader = (MAHM_SHARED_MEMORY_HEADER *)pBuf;

    // Check signature 'MAHM'
    if (pHeader->dwSignature == 'MAHM') {
      // Calculate the start address of the entries array
      BYTE *pEntriesStart = (BYTE *)pBuf + pHeader->dwHeaderSize;

      for (DWORD i = 0; i < pHeader->dwNumEntries; ++i) {
        MAHM_SHARED_MEMORY_ENTRY *pEntry = (MAHM_SHARED_MEMORY_ENTRY *)(pEntriesStart + (i * pHeader->dwEntrySize));
        statistics[pEntry->szSrcName] = pEntry->data;
      }
    }
    UnmapViewOfFile(pBuf);
  }
  CloseHandle(hMapFile);

  return statistics;
}

float FindStat(const std::map<std::string, float>& stats,
               std::initializer_list<const char*> keys) {
  for (const char* key : keys) {
    const auto it = stats.find(key);
    if (it != stats.end()) {
      return it->second;
    }
  }
  return 0.f;
}

int ScaleToHeight(float value, float max_value, int height) {
  if (max_value <= 0.f) {
    return 0;
  }
  const float normalized = std::clamp(value / max_value, 0.f, 1.f);
  return static_cast<int>(normalized * height);
}

using GraphFunction = std::function<std::vector<int>(int, int)>;

GraphFunction MakeHistoryGraph(
    const DemoState& state,
    std::function<float(const std::map<std::string, float>&)> extract,
    float max_value) {
  return [&state, extract = std::move(extract),
          max_value](int width, int height) {
    std::vector<int> output(width, 0);
    if (state.statistics_history.empty()) {
      return output;
    }
    const int data_size = static_cast<int>(state.statistics_history.size());
    for (int i = 0; i < width; ++i) {
      const int history_index = data_size - 1 - (width - 1 - i);
      if (history_index < 0 || history_index >= data_size) {
        continue;
      }
      const float value = extract(state.statistics_history[history_index]);
      output[i] = ScaleToHeight(value, max_value, height);
    }
    return output;
  };
}

template <typename Fn>
Element RenderGraphPanel(const std::string& title, Fn graph_fn,
                         const std::string& top, const std::string& mid,
                         const std::string& bot,
                         Color plot_color = Color::Default) {
  GraphFunction fn = graph_fn;
  Element plot = graph(std::move(fn)) | flex;
  if (plot_color != Color::Default) {
    plot = plot | color(plot_color);
  }
  return vbox({
      text(title) | hcenter,
      hbox({
          vbox({
              text(top),
              filler(),
              text(mid),
              filler(),
              text(bot),
          }),
          std::move(plot),
      }) | flex,
  });
}

Component BuildDemoTab(DemoState& state) {
  // ---------------------------------------------------------------------------
  // HTOP 탭 (시스템 모니터링 UI 데모)
  // ---------------------------------------------------------------------------
  const size_t MAX_HISTORY_SIZE = 1000; // 최대 저장할 데이터 개수

  auto my_graph = [&state](int width, int height) {
    std::vector<int> output(width);
    for (int i = 0; i < width; ++i) {
      float v = 0.5f;
      v += 0.1f * sin((i + state.shift) * 0.1f);
      v += 0.2f * sin((i + state.shift + 10) * 0.15f);
      v += 0.1f * sin((i + state.shift) * 0.03f);
      v *= height;
      output[i] = (int)v;
    }
    return output;
  };

  // P-Core 평균 사용률 데이터를 기반으로 그래프를 그리는 람다 함수
  auto cpu_usage_graph = [&state](int width, int height) {
    std::vector<int> output(width, 0);

    // 버퍼에 데이터가 없으면 0으로 채워진 배열 반환
    if (state.statistics_history.empty())
      return output;

    // 그래프의 최대값 설정 (100%)
    const float MAX_USAGE = 100.0f;

    // width만큼의 최신 데이터를 가져와서 그래프 높이에 맞게 스케일링
    int data_size = state.statistics_history.size();
    for (int i = 0; i < width; ++i) {
      // 오른쪽에서 왼쪽으로 최신 데이터부터 채움
      int history_index = data_size - 1 - (width - 1 - i);

      if (history_index >= 0 && history_index < data_size) {
        const auto &stats = state.statistics_history[history_index];

        // Calculate average usage for CPU1 to CPU16
        float total_usage = 0.0f;
        int core_count = 0;

        for (int c = 1; c <= 16; ++c) {
          std::string core_name = "CPU" + std::to_string(c) + " usage";
          auto it = stats.find(core_name);
          if (it != stats.end()) {
            total_usage += it->second;
            core_count++;
          }
        }

        float usage = (core_count > 0) ? (total_usage / core_count) : 0.0f;

        // 0 ~ 100 범위를 0 ~ height 범위로 매핑
        float normalized = usage / MAX_USAGE;
        if (normalized > 1.0f)
          normalized = 1.0f;
        if (normalized < 0.0f)
          normalized = 0.0f;

        output[i] = (int)(normalized * height);
      }
    }
    return output;
  };

  auto cpu_temperature_graph = [&state](int width, int height) {
    std::vector<int> output(width, 0);

    if (state.statistics_history.empty())
      return output;

    const float MAX_TEMP = 100.0f; // 최대 온도 설정

    int data_size = state.statistics_history.size();
    for (int i = 0; i < width; ++i) {
      int history_index = data_size - 1 - (width - 1 - i);

      if (history_index >= 0 && history_index < data_size) {
        const auto &stats = state.statistics_history[history_index];

        // CPU 온도는 "CPU temperature"라는 키로 가정
        auto it = stats.find("CPU temperature");
        float temp = (it != stats.end()) ? it->second : 0.0f;

        float normalized = temp / MAX_TEMP;
        if (normalized > 1.0f)
          normalized = 1.0f;
        if (normalized < 0.0f)
          normalized = 0.0f;

        output[i] = (int)(normalized * height);
      }
    }
    return output;
  };

  // GPU 사용률 그래프 영역 구성 (파란색 적용)
  auto gpu_usage_graph = [&state](int width, int height) {
    std::vector<int> output(width, 0);

    if (state.statistics_history.empty())
      return output;

    const float MAX_USAGE = 100.0f; // 최대 사용률 100% 기준

    int data_size = state.statistics_history.size();
    for (int i = 0; i < width; ++i) {
      int history_index = data_size - 1 - (width - 1 - i);

      if (history_index >= 0 && history_index < data_size) {
        const auto &stats = state.statistics_history[history_index];
        auto it = stats.find("GPU usage");
        float usage = (it != stats.end()) ? it->second : 0.0f;

        float normalized = usage / MAX_USAGE;
        if (normalized > 1.0f)
          normalized = 1.0f;
        if (normalized < 0.0f)
          normalized = 0.0f;

        output[i] = (int)(normalized * height);
      }
    }
    return output;
  };

  auto cpu_clock_graph = MakeHistoryGraph(
      state,
      [](const std::map<std::string, float>& stats) {
        return FindStat(stats, {"CPU clock", "Core clock"});
      },
      6000.f);

  auto ram_usage_graph = MakeHistoryGraph(
      state,
      [](const std::map<std::string, float>& stats) {
        return FindStat(stats, {"RAM usage", "Memory usage",
                                "Physical memory usage"});
      },
      100.f);

  auto gpu_temperature_graph = MakeHistoryGraph(
      state,
      [](const std::map<std::string, float>& stats) {
        return FindStat(stats, {"GPU temperature", "GPU1 temperature"});
      },
      100.f);

  // HTOP 화면: MSI 실시간 그래프 + 원본 FTXUI 사인파 데모 그래프
  auto htop = Renderer([=] {
    const auto msi_row1 = hbox({
        RenderGraphPanel("P-Core Usage [%]", cpu_usage_graph, "100 ", "50 ",
                         "0 ") |
            flex,
        separator(),
        RenderGraphPanel("CPU Temperature [C]", cpu_temperature_graph, "100 ",
                         "50 ", "0 ", Color::RedLight) |
            flex,
        separator(),
        RenderGraphPanel("GPU Usage [%]", gpu_usage_graph, "100 ", "50 ", "0 ",
                         Color::BlueLight) |
            flex,
    }) | flex;

    const auto msi_row2 = hbox({
        RenderGraphPanel("Core Clock [MHz]", cpu_clock_graph, "6000", "3000",
                         "0 ", Color::GreenLight) |
            flex,
        separator(),
        RenderGraphPanel("RAM Usage [%]", ram_usage_graph, "100 ", "50 ", "0 ",
                         Color::CyanLight) |
            flex,
        separator(),
        RenderGraphPanel("GPU Temperature [C]", gpu_temperature_graph, "100 ",
                         "50 ", "0 ", Color::MagentaLight) |
            flex,
    }) | flex;

    const auto wave_row = hbox({
        vbox({
            RenderGraphPanel("Frequency [MHz]", my_graph, "2400 ", "1200 ",
                             "0 ") |
                flex,
            separator(),
            RenderGraphPanel("Utilization [%]", my_graph, "100 ", "50 ", "0 ",
                             Color::RedLight) |
                flex,
        }) | flex,
        separator(),
        RenderGraphPanel("RAM [MB]", my_graph, "8192", "4096 ", "0 ",
                         Color::BlueLight) |
            flex,
    }) | flex;

    return vbox({
        text("MSI Afterburner") | bold | dim,
        msi_row1 | size(HEIGHT, EQUAL, 8),
        separator(),
        msi_row2 | size(HEIGHT, EQUAL, 8),
        separator(),
        text("FTXUI wave demo") | bold | dim,
        wave_row | flex,
    }) | flex | yframe | vscroll_indicator;
  });

  // ---------------------------------------------------------------------------
  // Compiler 탭 (복합 폼 UI 데모)
  // ---------------------------------------------------------------------------

  // 컴파일러 선택을 위한 라디오 버튼 항목들
  const std::vector<std::string> compiler_entries = {
      "gcc",
      "clang",
      "emcc",
      "game_maker",
      "Ada compilers",
      "ALGOL 60 compilers",
      "ALGOL 68 compilers",
      "Assemblers (Intel *86)",
      "Assemblers (Motorola 68*)",
      "Assemblers (Zilog Z80)",
      "Assemblers (other)",
      "BASIC Compilers",
      "BASIC interpreters",
      "Batch compilers",
      "C compilers",
      "Source-to-source compilers",
      "C++ compilers",
      "C# compilers",
      "COBOL compilers",
      "Common Lisp compilers",
      "D compilers",
      "DIBOL/DBL compilers",
      "ECMAScript interpreters",
      "Eiffel compilers",
      "Fortran compilers",
      "Go compilers",
      "Haskell compilers",
      "Java compilers",
      "Pascal compilers",
      "Perl Interpreters",
      "PHP compilers",
      "PL/I compilers",
      "Python compilers",
      "Scheme compilers and interpreters",
      "Smalltalk compilers",
      "Tcl Interpreters",
      "VMS Interpreters",
      "Rexx Interpreters",
      "CLI compilers",
  };

  // 라디오 버튼 컴포넌트 상태 및 생성
  int compiler_selected = 0;
  Component compiler = Radiobox(&compiler_entries, &compiler_selected);

  // 컴파일러 플래그 선택을 위한 체크박스 항목 및 상태
  std::array<std::string, 8> options_label = {
      "-Wall",
      "-Werror",
      "-lpthread",
      "-O3",
      "-Wabi-tag",
      "-Wno-class-conversion",
      "-Wcomma-subscript",
      "-Wno-conversion-null",
  };
  std::array<bool, 8> options_state = {false, false, false, false, false, false, false, false};

  // 입력 파일 목록을 보여주는 메뉴 컴포넌트
  std::vector<std::string> input_entries;
  int input_selected = 0;
  Component input = Menu(&input_entries, &input_selected);

  // 새로운 입력 파일을 추가하는 텍스트 입력 컴포넌트
  auto input_option = InputOption();
  std::string input_add_content;
  // 엔터 키를 누르면 입력된 내용을 input_entries 목록에 추가하고 입력창을 비웁니다.
  input_option.on_enter = [&] {
    input_entries.push_back(input_add_content);
    input_add_content = "";
  };
  Component input_add = Input(&input_add_content, "input files", input_option);

  // 실행 파일 이름을 입력받는 텍스트 입력 컴포넌트
  std::string executable_content_ = "";
  Component executable_ = Input(&executable_content_, "executable");

  // 체크박스들을 수직으로 배치한 컨테이너
  Component flags = Container::Vertical({
      Checkbox(&options_label[0], &options_state[0]),
      Checkbox(&options_label[1], &options_state[1]),
      Checkbox(&options_label[2], &options_state[2]),
      Checkbox(&options_label[3], &options_state[3]),
      Checkbox(&options_label[4], &options_state[4]),
      Checkbox(&options_label[5], &options_state[5]),
      Checkbox(&options_label[6], &options_state[6]),
      Checkbox(&options_label[7], &options_state[7]),
  });

  // 폼 요소들을 논리적으로 그룹화하는 메인 컨테이너
  // 키보드 네비게이션(방향키, 탭)을 처리하기 위해 Container를 사용합니다.
  auto compiler_component = Container::Horizontal({
      compiler,
      flags,
      Container::Vertical({
          executable_,
          Container::Horizontal({
              input_add,
              input,
          }),
      }),
  });

  // 사용자가 선택/입력한 값들을 바탕으로 최종 컴파일 명령어를 문자열로 렌더링하는 함수
  auto render_command = [&] {
    Elements line;
    // 선택된 컴파일러
    line.push_back(text(compiler_entries[compiler_selected]) | bold);
    // 선택된 플래그들
    for (int i = 0; i < 8; ++i) {
      if (options_state[i]) {
        line.push_back(text(" "));
        line.push_back(text(options_label[i]) | dim);
      }
    }
    // 출력 실행 파일명
    if (!executable_content_.empty()) {
      line.push_back(text(" -o ") | bold);
      line.push_back(text(executable_content_) | color(Color::BlueLight) | bold);
    }
    // 입력 파일 목록
    for (auto &it : input_entries) {
      line.push_back(text(" " + it) | color(Color::RedLight));
    }
    return line;
  };

  // 폼 컴포넌트와 렌더링 로직을 결합하는 최종 렌더러
  auto compiler_renderer = Renderer(compiler_component, [&] {
    // 각 영역을 window(테두리와 제목이 있는 박스)로 감싸서 시각적으로 분리합니다.
    auto compiler_win = window(text("Compiler"), compiler->Render() | vscroll_indicator | frame);
    auto flags_win = window(text("Flags"), flags->Render() | vscroll_indicator | frame);
    auto executable_win = window(text("Executable:"), executable_->Render());
    auto input_win = window(text("Input"), hbox({
                                               vbox({
                                                   hbox({
                                                       text("Add: "),
                                                       input_add->Render(),
                                                   }) | size(WIDTH, EQUAL, 20) |
                                                       size(HEIGHT, EQUAL, 1),
                                                   filler(),
                                               }),
                                               separator(),
                                               input->Render() | vscroll_indicator | frame | size(HEIGHT, EQUAL, 3) | flex,
                                           }));

    // 전체 레이아웃 조합
    return vbox({
               hbox({
                   compiler_win,
                   flags_win,
                   vbox({
                       executable_win | size(WIDTH, EQUAL, 20),
                       input_win | size(WIDTH, EQUAL, 60),
                   }),
                   filler(),
               }) | size(HEIGHT, LESS_THAN, 8),
               hflow(render_command()) | flex_grow, // 하단에 생성된 명령어 표시
           }) |
           flex_grow;
  });

  // ---------------------------------------------------------------------------
  // Spinner 탭 (로딩 애니메이션 데모)
  // ---------------------------------------------------------------------------
  auto spinner_tab_renderer = Renderer([&state] {
    Elements entries;
    // FTXUI가 제공하는 22가지의 다양한 스피너 스타일을 렌더링합니다.
    // state.shift 값을 사용하여 애니메이션 프레임을 진행시킵니다.
    for (int i = 0; i < 22; ++i) {
      entries.push_back(spinner(i, state.shift / 5) | bold | size(WIDTH, GREATER_THAN, 2) | border);
    }
    // hflow를 사용하여 공간에 맞게 자동 줄바꿈되도록 배치합니다.
    return hflow(std::move(entries));
  });

  // ---------------------------------------------------------------------------
  // Colors 탭 (터미널 색상 지원 데모)
  // ---------------------------------------------------------------------------
  auto color_tab_renderer = Renderer([] {
    // 1. 기본 16색 팔레트 (전경색 및 배경색)
    auto basic_color_display = vbox({
                                   text("16 color palette:"),
                                   separator(),
                                   hbox({
                                       vbox({
                                           // 전경색 텍스트
                                           color(Color::Default, text("Default")),
                                           color(Color::Black, text("Black")),
                                           color(Color::GrayDark, text("GrayDark")),
                                           color(Color::GrayLight, text("GrayLight")),
                                           color(Color::White, text("White")),
                                           color(Color::Blue, text("Blue")),
                                           color(Color::BlueLight, text("BlueLight")),
                                           color(Color::Cyan, text("Cyan")),
                                           color(Color::CyanLight, text("CyanLight")),
                                           color(Color::Green, text("Green")),
                                           color(Color::GreenLight, text("GreenLight")),
                                           color(Color::Magenta, text("Magenta")),
                                           color(Color::MagentaLight, text("MagentaLight")),
                                           color(Color::Red, text("Red")),
                                           color(Color::RedLight, text("RedLight")),
                                           color(Color::Yellow, text("Yellow")),
                                           color(Color::YellowLight, text("YellowLight")),
                                       }),
                                       vbox({
                                           // 배경색 텍스트
                                           bgcolor(Color::Default, text("Default")),
                                           bgcolor(Color::Black, text("Black")),
                                           bgcolor(Color::GrayDark, text("GrayDark")),
                                           bgcolor(Color::GrayLight, text("GrayLight")),
                                           bgcolor(Color::White, text("White")),
                                           bgcolor(Color::Blue, text("Blue")),
                                           bgcolor(Color::BlueLight, text("BlueLight")),
                                           bgcolor(Color::Cyan, text("Cyan")),
                                           bgcolor(Color::CyanLight, text("CyanLight")),
                                           bgcolor(Color::Green, text("Green")),
                                           bgcolor(Color::GreenLight, text("GreenLight")),
                                           bgcolor(Color::Magenta, text("Magenta")),
                                           bgcolor(Color::MagentaLight, text("MagentaLight")),
                                           bgcolor(Color::Red, text("Red")),
                                           bgcolor(Color::RedLight, text("RedLight")),
                                           bgcolor(Color::Yellow, text("Yellow")),
                                           bgcolor(Color::YellowLight, text("YellowLight")),
                                       }),
                                   }),
                               }) |
                               border;

    // 2. 256색 팔레트
    auto palette_256_color_display = text("256 colors palette:");
    {
      // 사전에 정렬된 256색상 정보를 가져와서 격자 형태로 렌더링합니다.
      std::vector<std::vector<ColorInfo>> info_columns = ftxui::ColorInfoSorted2D();
      Elements columns;
      for (auto &column : info_columns) {
        Elements column_elements;
        for (auto &it : column) {
          column_elements.push_back(text("   ") | bgcolor(Color(Color::Palette256(it.index_256))));
        }
        columns.push_back(hbox(std::move(column_elements)));
      }
      palette_256_color_display = vbox({
                                      palette_256_color_display,
                                      separator(),
                                      vbox(columns),
                                  }) |
                                  border;
    }

    // 3. True Color (24비트 RGB) 디스플레이
    auto true_color_display = text("TrueColors: 24bits:");
    {
      int saturation = 255;
      Elements array;
      // HSV 색상 공간을 순회하며 그라데이션 효과를 렌더링합니다.
      // 상단 절반(전경색)과 하단 절반(배경색)을 특수 문자(▀)를 이용해 동시에 표현합니다.
      for (int value = 0; value < 255; value += 16) {
        Elements line;
        for (int hue = 0; hue < 255; hue += 6) {
          line.push_back(text("▀")                                   //
                         | color(Color::HSV(hue, saturation, value)) //
                         | bgcolor(Color::HSV(hue, saturation, value + 8)));
        }
        array.push_back(hbox(std::move(line)));
      }
      true_color_display = vbox({
                               true_color_display,
                               separator(),
                               vbox(std::move(array)),
                           }) |
                           border;
    }

    // 세 가지 색상 데모를 flexbox를 사용하여 유연하게 배치합니다.
    return flexbox(
        {
            basic_color_display,
            palette_256_color_display,
            true_color_display,
        },
        FlexboxConfig().SetGap(1, 1));
  });

  // ---------------------------------------------------------------------------
  // Gauges 탭 (진행률 표시줄 데모)
  // ---------------------------------------------------------------------------
  // 특정 오프셋(delta)을 받아 현재 진행률을 계산하고 게이지 UI를 반환하는 람다
  auto render_gauge = [&state](int delta) {
    float progress = (state.shift + delta) % 500 / 500.f;
    return hbox({
        text(std::to_string(int(progress * 100)) + "% ") | size(WIDTH, EQUAL, 5),
        gauge(progress), // FTXUI 내장 게이지 컴포넌트
    });
  };

  // 다양한 색상과 시작 오프셋을 가진 게이지들을 수직으로 나열합니다.
  auto gauge_component = Renderer([render_gauge] {
    return vbox({
        render_gauge(0) | color(Color::Black),
        render_gauge(100) | color(Color::GrayDark),
        render_gauge(50) | color(Color::GrayLight),
        render_gauge(6894) | color(Color::White),
        separator(),
        render_gauge(6841) | color(Color::Blue),
        render_gauge(9813) | color(Color::BlueLight),
        render_gauge(98765) | color(Color::Cyan),
        render_gauge(98) | color(Color::CyanLight),
        render_gauge(9846) | color(Color::Green),
        render_gauge(1122) | color(Color::GreenLight),
        render_gauge(84) | color(Color::Magenta),
        render_gauge(645) | color(Color::MagentaLight),
        render_gauge(568) | color(Color::Red),
        render_gauge(2222) | color(Color::RedLight),
        render_gauge(220) | color(Color::Yellow),
        render_gauge(348) | color(Color::YellowLight),
    });
  });

  // ---------------------------------------------------------------------------
  // Paragraph 탭 (텍스트 레이아웃 및 리사이징 데모)
  // ---------------------------------------------------------------------------
  // 지정된 크기의 더미 박스를 생성하는 헬퍼 함수
  auto make_box = [](size_t dimx, size_t dimy) {
    std::string title = std::to_string(dimx) + "x" + std::to_string(dimy);
    return window(text(title) | hcenter | bold, text("content") | hcenter | dim) | size(WIDTH, EQUAL, dimx) |
           size(HEIGHT, EQUAL, dimy);
  };

  // 왼쪽 패널: 다양한 텍스트 정렬 방식과 flexbox 레이아웃을 보여줍니다.
  auto paragraph_renderer_left = Renderer([make_box] {
    std::string str = "Lorem Ipsum is simply dummy text of the printing and typesetting "
                      "industry.\nLorem Ipsum has been the industry's standard dummy text "
                      "ever since the 1500s, when an unknown printer took a galley of type "
                      "and scrambled it to make a type specimen book.";
    return vbox({
               window(text("Align left:"), paragraphAlignLeft(str)),
               window(text("Align center:"), paragraphAlignCenter(str)),
               window(text("Align right:"), paragraphAlignRight(str)),
               window(text("Align justify:"), paragraphAlignJustify(str)),
               window(text("Side by side"), hbox({
                                                paragraph(str),
                                                separator(),
                                                paragraph(str),
                                            })),
               window(text("Elements with different size:"), flexbox({
                                                                 make_box(10, 5),
                                                                 make_box(9, 4),
                                                                 make_box(8, 4),
                                                                 make_box(6, 3),
                                                                 make_box(10, 5),
                                                                 make_box(9, 4),
                                                                 make_box(8, 4),
                                                                 make_box(6, 3),
                                                                 make_box(10, 5),
                                                                 make_box(9, 4),
                                                                 make_box(8, 4),
                                                                 make_box(6, 3),
                                                             })),
           }) |
           vscroll_indicator | yframe | flex;
  }); // 세로 스크롤 지원

  // 오른쪽 패널: 리사이징 핸들러에 대한 안내 텍스트
  auto paragraph_renderer_right = Renderer([] {
    return paragraph("<--- This vertical bar is resizable using the  mouse") | center;
  });

  // 마우스로 드래그하여 크기를 조절할 수 있는 분할 창(Split View) 구성
  int paragraph_renderer_split_position =
      std::max(20, static_cast<int>(Terminal::Size().dimx) / 2);
  auto paragraph_renderer_group =
      ResizableSplitLeft(paragraph_renderer_left, paragraph_renderer_right, &paragraph_renderer_split_position);
  auto paragraph_renderer_group_renderer = Renderer(paragraph_renderer_group, [=] {
    return paragraph_renderer_group->Render();
  });

  // ---------------------------------------------------------------------------
  // Tabs (메인 네비게이션)
  // ---------------------------------------------------------------------------

  int tab_index = 0;
  std::vector<std::string> tab_entries = {
      "htop",
      "color",
      "spinner",
      "gauge",
      "compiler",
      "paragraph",
  };
  // 상단 탭 메뉴 컴포넌트 (가로 방향, 애니메이션 효과 적용)
  auto tab_selection = Menu(&tab_entries, &tab_index, MenuOption::Horizontal());

  // 선택된 탭 인덱스에 따라 해당 컴포넌트를 보여주는 탭 컨테이너
  auto tab_content = Container::Tab(
      {
          htop,
          color_tab_renderer,
          spinner_tab_renderer,
          gauge_component,
          compiler_renderer,
          paragraph_renderer_group_renderer,
      },
      &tab_index);

  auto main_container = Container::Vertical({
      tab_selection,
      tab_content,
  });

  return Renderer(main_container, [=] {
    return vbox({
        text("FTXUI Demo") | bold | hcenter | size(HEIGHT, EQUAL, 1),
        main_container->Render() | flex | yframe,
    }) | flex;
  });
}

void DemoTick(DemoState& state) {
  const size_t MAX_HISTORY_SIZE = 1000;
  const auto UPDATE_INTERVAL = std::chrono::milliseconds(500);

  state.shift++;

  const auto current_time = std::chrono::steady_clock::now();
  if (state.last_update_time.time_since_epoch().count() == 0) {
    state.last_update_time = current_time;
  }
  if (current_time - state.last_update_time >= UPDATE_INTERVAL) {
    auto current_stats = GetStatisticsFromMSIAfterburner();
    state.statistics_history.push_back(current_stats);
    if (state.statistics_history.size() > MAX_HISTORY_SIZE) {
      state.statistics_history.pop_front();
    }
    state.last_update_time = current_time;
  }
}

}  // namespace gnd