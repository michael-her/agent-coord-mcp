#pragma once

#include <ftxui/component/component.hpp>

#include <chrono>
#include <deque>
#include <map>
#include <string>

namespace gnd {

using ftxui::Component;

struct DemoState {
  int shift = 0;
  std::deque<std::map<std::string, float>> statistics_history;
  std::chrono::steady_clock::time_point last_update_time{};
};

ftxui::Component BuildDemoTab(DemoState& state);
void DemoTick(DemoState& state);

}  // namespace gnd
