#pragma once

#include <ftxui/component/component.hpp>

#include <chrono>
#include <deque>
#include <string>
#include <vector>

namespace gnd {

using ftxui::Component;

// 월드 좌표는 캔버스 브라유 픽셀 단위(1 unit == 1 pixel)를 사용한다.
struct Rect {
  float x = 0.f;
  float y = 0.f;
  float w = 0.f;
  float h = 0.f;
};

struct Orb {
  float x = 0.f;
  float y = 0.f;
  bool collected = false;
};

struct Level {
  std::string name;
  float spawn_x = 0.f;
  float spawn_y = 0.f;
  float width = 0.f;   // 레벨 가로 경계(픽셀)
  float height = 0.f;  // 레벨 세로 경계(픽셀). 이 아래로 떨어지면 낙사.
  std::vector<Rect> solids;
  std::vector<Rect> hazards;
  std::vector<Orb> orbs;
  Rect goal;
};

enum class GamePhase {
  Title,
  Playing,
  LevelClear,
  Dead,
  Win,
};

struct TrailPoint {
  float x = 0.f;
  float y = 0.f;
  float life = 0.f;  // 1.0 -> 0.0
};

struct GameState {
  GamePhase phase = GamePhase::Title;
  bool initialized = false;

  // 플레이어 물리(월드 픽셀).
  float px = 0.f;
  float py = 0.f;
  float vx = 0.f;
  float vy = 0.f;
  bool on_ground = false;
  bool facing_right = true;
  int jumps_left = 0;

  // 입력 의도.
  bool move_left = false;
  bool move_right = false;
  bool input_focused = false;  // Game 컴포넌트 포커스 (폴링 게이트)
  bool jump_queued = false;
  bool jump_held = false;     // 점프 키 엣지 검출용 (폴링 모드)
  bool restart_held = false;  // R 재시작 엣지 검출용
  // 터미널 이벤트 폴백(비-Windows): 마지막 키 입력 시각.
  std::chrono::steady_clock::time_point left_pressed{};
  std::chrono::steady_clock::time_point right_pressed{};

  // 카메라/타이밍.
  float cam_x = 0.f;
  float cam_y = 0.f;
  std::chrono::steady_clock::time_point last_tick{};

  // 진행 상황.
  std::vector<Level> levels;
  int level_index = 0;
  int orbs_collected = 0;
  int deaths = 0;
  std::chrono::steady_clock::time_point level_start{};
  std::chrono::steady_clock::time_point phase_changed{};

  // 시각 효과.
  std::deque<TrailPoint> trail;
  long long frame = 0;  // 맥동/애니메이션용 카운터
};

ftxui::Component BuildGameTab(GameState& state);
void GameTick(GameState& state);

}  // namespace gnd
