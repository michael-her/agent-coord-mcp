#include "game_tab.hpp"

#include <ftxui/component/component.hpp>
#include <ftxui/component/component_base.hpp>
#include <ftxui/component/event.hpp>
#include <ftxui/dom/canvas.hpp>
#include <ftxui/dom/elements.hpp>
#include <ftxui/screen/color.hpp>
#include <ftxui/screen/terminal.hpp>

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#ifdef RGB
#undef RGB
#endif
#endif

namespace gnd {

using namespace ftxui;

namespace {

// 물리 상수 (월드 픽셀 / 초). 뷰포트 높이는 대략 120~160px 기준으로 튜닝됨.
constexpr float kGravity = 620.f;
constexpr float kMoveSpeed = 98.f;
constexpr float kAccel = 920.f;
constexpr float kFriction = 780.f;
constexpr float kJumpVel = 236.f;
constexpr float kMaxFall = 480.f;
constexpr float kPlayerW = 7.f;
constexpr float kPlayerH = 9.f;
constexpr int kMaxJumps = 2;
constexpr double kHoldTimeoutMs = 500.0;  // 터미널 폴백: OS 키 반복 간격에 맞춤

using Clock = std::chrono::steady_clock;

#ifdef _WIN32
bool WinKeyDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
#endif

float MsSince(Clock::time_point past) {
  if (past.time_since_epoch().count() == 0) {
    return 1e9f;
  }
  return std::chrono::duration<float, std::milli>(Clock::now() - past).count();
}

bool AabbOverlap(float ax, float ay, float aw, float ah, const Rect& b) {
  return ax < b.x + b.w && ax + aw > b.x && ay < b.y + b.h && ay + ah > b.y;
}

// ---------------------------------------------------------------------------
// 레벨 데이터 (손으로 디자인한 짧은 레벨 3개)
// 좌표계: x는 오른쪽, y는 아래로 증가. py > level.height 이면 낙사.
// ---------------------------------------------------------------------------
std::vector<Level> BuildLevels() {
  std::vector<Level> levels;

  // --- 레벨 1: 튜토리얼 (구덩이 점프 + 스파이크 회피) ---
  {
    Level l;
    l.name = "Silent Woods";
    l.spawn_x = 30.f;
    l.spawn_y = 100.f;
    l.width = 760.f;
    l.height = 200.f;
    l.solids = {
        {0.f, 120.f, 190.f, 80.f},    // 시작 지면
        {250.f, 120.f, 240.f, 80.f},  // 중간 지면
        {300.f, 90.f, 46.f, 8.f},     // 떠 있는 발판
        {560.f, 120.f, 200.f, 80.f},  // 도착 지면
    };
    l.hazards = {
        {410.f, 112.f, 40.f, 8.f},  // 지면 위 가시
    };
    l.orbs = {{150.f, 104.f, false}, {323.f, 78.f, false}, {630.f, 104.f, false}};
    l.goal = {712.f, 92.f, 18.f, 28.f};
    levels.push_back(std::move(l));
  }

  // --- 레벨 2: 더블 점프로 떠 있는 발판 등반 ---
  {
    Level l;
    l.name = "Misty Ascent";
    l.spawn_x = 40.f;
    l.spawn_y = 100.f;
    l.width = 860.f;
    l.height = 210.f;
    l.solids = {
        {0.f, 120.f, 150.f, 90.f},
        {206.f, 106.f, 48.f, 8.f},
        {308.f, 86.f, 48.f, 8.f},
        {418.f, 68.f, 48.f, 8.f},
        {528.f, 90.f, 48.f, 8.f},
        {628.f, 112.f, 70.f, 8.f},
        {720.f, 120.f, 140.f, 90.f},  // 도착 지면
    };
    l.hazards = {
        {662.f, 106.f, 30.f, 6.f},
    };
    l.orbs = {{230.f, 92.f, false},
              {332.f, 72.f, false},
              {442.f, 54.f, false},
              {770.f, 104.f, false}};
    l.goal = {800.f, 92.f, 18.f, 28.f};
    levels.push_back(std::move(l));
  }

  // --- 레벨 3: 좁은 기둥 + 가시 ---
  {
    Level l;
    l.name = "Spirit Spire";
    l.spawn_x = 40.f;
    l.spawn_y = 100.f;
    l.width = 800.f;
    l.height = 220.f;
    l.solids = {
        {0.f, 120.f, 130.f, 100.f},
        {180.f, 100.f, 40.f, 120.f},
        {272.f, 80.f, 40.f, 140.f},
        {364.f, 60.f, 40.f, 160.f},
        {470.f, 84.f, 40.f, 136.f},
        {566.f, 104.f, 40.f, 116.f},
        {650.f, 120.f, 150.f, 100.f},  // 도착 지면
    };
    l.hazards = {
        {364.f, 54.f, 40.f, 6.f},   // 가장 높은 기둥 꼭대기 가시
        {650.f, 114.f, 60.f, 6.f},  // 도착 직전 가시
    };
    l.orbs = {{200.f, 90.f, false},
              {292.f, 70.f, false},
              {384.f, 44.f, false},
              {490.f, 74.f, false},
              {740.f, 108.f, false}};
    l.goal = {760.f, 92.f, 18.f, 28.f};
    levels.push_back(std::move(l));
  }

  return levels;
}

void ResetPlayer(GameState& s) {
  const Level& lv = s.levels[s.level_index];
  s.px = lv.spawn_x;
  s.py = lv.spawn_y;
  s.vx = 0.f;
  s.vy = 0.f;
  s.on_ground = false;
  s.jumps_left = kMaxJumps;
  s.facing_right = true;
  s.trail.clear();
}

void LoadLevel(GameState& s, int idx) {
  s.level_index = std::clamp(idx, 0, static_cast<int>(s.levels.size()) - 1);
  Level& lv = s.levels[s.level_index];
  for (Orb& o : lv.orbs) {
    o.collected = false;
  }
  ResetPlayer(s);
  s.level_start = Clock::now();
}

#ifdef _WIN32
// OS 키 상태를 직접 폴링 → 키를 누르고 있는 동안 연속 이동.
// FTXUI 이벤트는 key-up이 없고 키 반복 간격에 의존하므로 플랫포머에 부적합.
void PollWinKeyboard(GameState& s) {
  const bool left = WinKeyDown(VK_LEFT) || WinKeyDown('A');
  const bool right = WinKeyDown(VK_RIGHT) || WinKeyDown('D');
  const bool jump =
      WinKeyDown(VK_SPACE) || WinKeyDown(VK_UP) || WinKeyDown('W');

  s.move_left = left;
  s.move_right = right;

  if (jump && !s.jump_held) {
    s.jump_queued = true;
  }
  s.jump_held = jump;

  const bool restart = WinKeyDown('R');
  if (restart && !s.restart_held &&
      (s.phase == GamePhase::Playing || s.phase == GamePhase::Dead)) {
    LoadLevel(s, s.level_index);
    s.phase = GamePhase::Playing;
  }
  s.restart_held = restart;

  if (left && !right) {
    s.facing_right = false;
  } else if (right && !left) {
    s.facing_right = true;
  }
}
#endif

void EnsureInit(GameState& s) {
  if (s.initialized) {
    return;
  }
  s.levels = BuildLevels();
  s.level_index = 0;
  s.orbs_collected = 0;
  s.deaths = 0;
  s.phase = GamePhase::Title;
  s.initialized = true;
}

// 한 축으로 이동 후 solid 들과 충돌 해소.
void MoveAxis(GameState& s, const Level& lv, float dx, float dy) {
  s.px += dx;
  s.py += dy;
  for (const Rect& r : lv.solids) {
    if (!AabbOverlap(s.px, s.py, kPlayerW, kPlayerH, r)) {
      continue;
    }
    if (dx > 0.f) {
      s.px = r.x - kPlayerW;
      s.vx = 0.f;
    } else if (dx < 0.f) {
      s.px = r.x + r.w;
      s.vx = 0.f;
    }
    if (dy > 0.f) {  // 아래로 이동 중 착지
      s.py = r.y - kPlayerH;
      s.vy = 0.f;
      s.on_ground = true;
      s.jumps_left = kMaxJumps;
    } else if (dy < 0.f) {  // 위로 이동 중 천장
      s.py = r.y + r.h;
      s.vy = 0.f;
    }
  }
}

// ---------------------------------------------------------------------------
// 커스텀 컴포넌트: 키 입력을 받고 캔버스에 게임을 그린다.
// ---------------------------------------------------------------------------
class GameComponent : public ComponentBase {
 public:
  explicit GameComponent(GameState& state) : state_(state) {}

  bool Focusable() const override { return true; }

  bool OnEvent(Event event) override {
    EnsureInit(state_);

    if (event.is_mouse()) {
      return false;
    }

    // 진행/시작 화면.
    if (state_.phase == GamePhase::Title) {
      if (event == Event::Return) {
        LoadLevel(state_, 0);
        state_.orbs_collected = 0;
        state_.deaths = 0;
        state_.phase = GamePhase::Playing;
        return true;
      }
      return false;
    }
    if (state_.phase == GamePhase::Win) {
      if (event == Event::Return) {
        state_.phase = GamePhase::Title;
        return true;
      }
      return false;
    }

    // 플레이 중 조작 (비-Windows 폴백: 터미널 이벤트).
#ifndef _WIN32
    if (state_.phase == GamePhase::Playing || state_.phase == GamePhase::Dead) {
      if (event == Event::ArrowLeft || event == Event::Character('a')) {
        state_.left_pressed = Clock::now();
        state_.facing_right = false;
        return true;
      }
      if (event == Event::ArrowRight || event == Event::Character('d')) {
        state_.right_pressed = Clock::now();
        state_.facing_right = true;
        return true;
      }
      if (event == Event::ArrowUp || event == Event::Character('w') ||
          event == Event::Character(' ')) {
        state_.jump_queued = true;
        return true;
      }
      if (event == Event::Character('r') || event == Event::Character('R')) {
        LoadLevel(state_, state_.level_index);
        state_.phase = GamePhase::Playing;
        return true;
      }
    }
#endif
    return false;
  }

  Element OnRender() override {
    EnsureInit(state_);
    state_.input_focused = Focused();

    const Dimensions term = Terminal::Size();
    // 외곽 크롬(타이틀/탭 메뉴/HUD)을 제외하고 캔버스 크기를 산정.
    const int cols = std::max(40, term.dimx - 1);
    const int rows = std::max(14, term.dimy - 6);
    const int cw = cols * 2;   // 캔버스 픽셀 너비
    const int ch = rows * 4;   // 캔버스 픽셀 높이

    const Level& lv = state_.levels[state_.level_index];

    // 카메라(플레이어 추적, 레벨 경계 클램프 + 부드러운 추적).
    const float target_cx =
        std::clamp(state_.px + kPlayerW * 0.5f - cw * 0.5f, 0.f,
                   std::max(0.f, lv.width - cw));
    const float target_cy =
        std::clamp(state_.py + kPlayerH * 0.5f - ch * 0.5f, 0.f,
                   std::max(0.f, lv.height + 40.f - ch));
    state_.cam_x += (target_cx - state_.cam_x) * 0.18f;
    state_.cam_y += (target_cy - state_.cam_y) * 0.18f;
    const float cam_x = state_.cam_x;
    const float cam_y = state_.cam_y;

    Canvas c(cw, ch);
    DrawWorld(c, lv, cam_x, cam_y, cw, ch);

    Element scene = canvas(c) | flex |
                    bgcolor(Color::RGB(8, 14, 22));  // 깊은 숲 밤하늘

    scene = AddOverlay(std::move(scene));

    return vbox({
               RenderHud(lv),
               std::move(scene),
           }) |
           flex;
  }

 private:
  // -------------------------------------------------------------------------
  // 그리기 헬퍼
  // -------------------------------------------------------------------------
  static void FillRectClipped(Canvas& c, int x, int y, int w, int h,
                              const Color& col, int ystep = 1) {
    const int x0 = std::max(0, x);
    const int y0 = std::max(0, y);
    const int x1 = std::min(c.width(), x + w);
    const int y1 = std::min(c.height(), y + h);
    for (int yy = y0; yy < y1; yy += ystep) {
      for (int xx = x0; xx < x1; ++xx) {
        c.DrawPoint(xx, yy, true, col);
      }
    }
  }

  void DrawWorld(Canvas& c, const Level& lv, float cam_x, float cam_y, int cw,
                 int ch) {
    const auto sx = [&](float wx) { return static_cast<int>(std::lround(wx - cam_x)); };
    const auto sy = [&](float wy) { return static_cast<int>(std::lround(wy - cam_y)); };

    DrawParallax(c, cam_x, cam_y, cw, ch);

    // 위험지대(가시).
    for (const Rect& r : lv.hazards) {
      const int rx = sx(r.x), ry = sy(r.y);
      FillRectClipped(c, rx, ry, static_cast<int>(r.w), static_cast<int>(r.h),
                      Color::RGB(120, 24, 30));
      // 가시 끝의 밝은 톱니.
      for (int t = 0; t < static_cast<int>(r.w); t += 4) {
        c.DrawPoint(rx + t, ry, true, Color::RGB(220, 70, 70));
        c.DrawPoint(rx + t + 1, ry - 1, true, Color::RGB(255, 120, 110));
      }
    }

    // 플랫폼(이끼 낀 흙).
    for (const Rect& r : lv.solids) {
      const int rx = sx(r.x), ry = sy(r.y);
      const int rw = static_cast<int>(r.w), rh = static_cast<int>(r.h);
      FillRectClipped(c, rx, ry + 3, rw, rh - 3, Color::RGB(26, 30, 40), 2);
      FillRectClipped(c, rx, ry + 1, rw, 2, Color::RGB(40, 60, 52));
      // 윗면 이끼 하이라이트.
      for (int t = 0; t < rw; ++t) {
        c.DrawPoint(rx + t, ry, true, Color::RGB(70, 150, 110));
      }
    }

    // 정령 오브(맥동).
    const float pulse = 0.5f + 0.5f * std::sin(state_.frame * 0.15f);
    for (const Orb& o : lv.orbs) {
      if (o.collected) {
        continue;
      }
      const int ox = sx(o.x), oy = sy(o.y);
      if (ox < -8 || ox > cw + 8) {
        continue;
      }
      const int glow = 1 + static_cast<int>(pulse * 2.f);
      c.DrawPointCircle(ox, oy, 3 + glow,
                        Color::RGB(40, 110 + (int)(pulse * 60), 120));
      c.DrawPointCircleFilled(ox, oy, 2, Color::RGB(180, 245, 220));
      c.DrawPoint(ox, oy, true, Color::RGB(255, 255, 255));
    }

    // 목표 포털(빛 기둥).
    DrawGoal(c, lv.goal, cam_x, cam_y);

    // 플레이어 트레일(빛 잔상).
    for (const TrailPoint& tp : state_.trail) {
      const int tx = sx(tp.x), ty = sy(tp.y);
      const int g = static_cast<int>(120 + 120 * tp.life);
      const int b = static_cast<int>(140 + 90 * tp.life);
      c.DrawPoint(tx, ty, true, Color::RGB(30, g, b));
    }

    // 플레이어(빛나는 정령).
    DrawPlayer(c, cam_x, cam_y);
  }

  void DrawParallax(Canvas& c, float cam_x, float cam_y, int cw, int ch) {
    // 먼 별/정령 모트.
    for (int i = 0; i < 46; ++i) {
      const float fx = static_cast<float>(i * 71 % 233);
      const float fy = static_cast<float>(i * 37 % 89);
      int mx = static_cast<int>(std::fmod(fx * 7.f - cam_x * 0.15f +
                                              state_.frame * 0.05f * (1 + i % 3),
                                          cw + 20.f));
      if (mx < 0) mx += cw + 20;
      mx -= 10;
      int my = static_cast<int>(fy) % std::max(1, ch / 2);
      const int tw = (i % 5 == 0) ? 200 : 90;
      c.DrawPoint(mx, my, true, Color::RGB(60, tw, tw + 30));
    }

    // 먼 언덕(스크롤 0.30).
    DrawHillLayer(c, cam_x, 0.30f, ch - ch / 4, 34, 0.018f, 11,
                  Color::RGB(16, 26, 38), cw, ch);
    // 중간 나무 실루엣(스크롤 0.58).
    DrawHillLayer(c, cam_x, 0.58f, ch - ch / 6, 26, 0.030f, 29,
                  Color::RGB(12, 20, 26), cw, ch);
  }

  void DrawHillLayer(Canvas& c, float cam_x, float factor, int base_y,
                     int amp, float freq, int phase, const Color& col, int cw,
                     int ch) {
    const float off = cam_x * factor;
    for (int x = 0; x < cw; ++x) {
      const float wx = x + off;
      const int top =
          base_y - static_cast<int>(amp * (0.5f + 0.5f * std::sin(wx * freq + phase)));
      for (int y = std::max(0, top); y < ch; y += 2) {
        c.DrawPoint(x, y, true, col);
      }
    }
  }

  void DrawGoal(Canvas& c, const Rect& g, float cam_x, float cam_y) {
    const int gx = static_cast<int>(std::lround(g.x + g.w * 0.5f - cam_x));
    const int gy0 = static_cast<int>(std::lround(g.y - cam_y));
    const int gy1 = static_cast<int>(std::lround(g.y + g.h - cam_y));
    const float pulse = 0.5f + 0.5f * std::sin(state_.frame * 0.12f);
    for (int y = gy0; y < gy1; ++y) {
      const int v = 160 + static_cast<int>(pulse * 80);
      c.DrawPoint(gx, y, true, Color::RGB(v, v, 120));
      c.DrawPoint(gx - 1, y, true, Color::RGB(120, 140, 60));
      c.DrawPoint(gx + 1, y, true, Color::RGB(120, 140, 60));
    }
    c.DrawPointCircle(gx, gy0, 2 + static_cast<int>(pulse * 2),
                      Color::RGB(240, 240, 160));
  }

  void DrawPlayer(Canvas& c, float cam_x, float cam_y) {
    const int cx = static_cast<int>(std::lround(state_.px + kPlayerW * 0.5f - cam_x));
    const int cy = static_cast<int>(std::lround(state_.py + kPlayerH * 0.5f - cam_y));
    const bool dead = state_.phase == GamePhase::Dead;
    const Color glow = dead ? Color::RGB(120, 40, 40) : Color::RGB(60, 150, 200);
    const Color body = dead ? Color::RGB(200, 90, 80) : Color::RGB(170, 230, 255);
    const Color core = dead ? Color::RGB(255, 180, 160) : Color::RGB(255, 255, 255);
    c.DrawPointCircle(cx, cy, 5, glow);
    c.DrawPointCircleFilled(cx, cy, 3, body);
    c.DrawPointCircleFilled(cx, cy, 1, core);
    // 바라보는 방향의 작은 귀/뿔.
    const int dir = state_.facing_right ? 1 : -1;
    c.DrawPoint(cx + dir * 2, cy - 4, true, core);
    c.DrawPoint(cx + dir * 3, cy - 5, true, body);
  }

  Element RenderHud(const Level& lv) {
    int total_orbs = 0;
    int got = 0;
    for (const Orb& o : lv.orbs) {
      ++total_orbs;
      if (o.collected) ++got;
    }
    const float secs = MsSince(state_.level_start) / 1000.f;
    char timebuf[32];
    std::snprintf(timebuf, sizeof(timebuf), "%.1fs", secs);

    return hbox({
               text(" " + lv.name + " ") | bold | color(Color::RGB(150, 230, 200)),
               separator(),
               text(" Orbs " + std::to_string(got) + "/" +
                    std::to_string(total_orbs) + " ") |
                   color(Color::RGB(180, 245, 220)),
               separator(),
               text(" Deaths " + std::to_string(state_.deaths) + " ") |
                   color(Color::RGB(230, 130, 130)),
               separator(),
               text(std::string(" ") + timebuf + " ") | color(Color::GrayLight),
               filler(),
               text("←→/AD move  ↑/W/Space jump(x2)  R restart  Tab menu ") |
                   dim,
           }) |
           size(HEIGHT, EQUAL, 1);
  }

  Element AddOverlay(Element scene) {
    auto panel = [](const std::string& title, const std::string& sub,
                    Color tcol) {
      return vbox({
                 text(title) | bold | center | color(tcol),
                 text("") | size(HEIGHT, EQUAL, 1),
                 text(sub) | center | color(Color::GrayLight),
             }) |
             border | bgcolor(Color::RGB(10, 16, 24)) | clear_under | center;
    };

    switch (state_.phase) {
      case GamePhase::Title:
        return dbox({
            std::move(scene),
            panel("✦  ORI-LIKE  ✦",
                  "빛의 정령이 되어 숲을 가로지르세요.   [Enter] 시작",
                  Color::RGB(170, 240, 255)),
        });
      case GamePhase::LevelClear:
        return dbox({
            std::move(scene),
            panel("Level Clear!", "다음 숲으로...",
                  Color::RGB(180, 245, 200)),
        });
      case GamePhase::Win:
        return dbox({
            std::move(scene),
            panel("✦  모든 숲을 밝혔습니다  ✦",
                  "사망 " + std::to_string(state_.deaths) +
                      "회   [Enter] 처음으로",
                  Color::RGB(255, 240, 170)),
        });
      case GamePhase::Dead:
        return dbox({
            std::move(scene),
            text("...빛이 스러진다...") | bold | center |
                color(Color::RGB(230, 120, 120)),
        });
      default:
        return scene;
    }
  }

  GameState& state_;
};

}  // namespace

// ---------------------------------------------------------------------------
// 물리/게임 진행 (매 프레임, 실제 dt 사용)
// ---------------------------------------------------------------------------
void GameTick(GameState& s) {
  EnsureInit(s);
  ++s.frame;

  const Clock::time_point now = Clock::now();
  if (s.last_tick.time_since_epoch().count() == 0) {
    s.last_tick = now;
  }
  float dt = std::chrono::duration<float>(now - s.last_tick).count();
  s.last_tick = now;
  dt = std::clamp(dt, 0.f, 0.05f);

  // 트레일 수명 감소.
  for (TrailPoint& tp : s.trail) {
    tp.life -= dt * 2.2f;
  }
  while (!s.trail.empty() && s.trail.front().life <= 0.f) {
    s.trail.pop_front();
  }

  // 사망 연출 후 리스폰.
  if (s.phase == GamePhase::Dead) {
    if (MsSince(s.phase_changed) > 650.f) {
      ResetPlayer(s);
      s.phase = GamePhase::Playing;
    }
    return;
  }
  // 레벨 클리어 연출 후 다음 레벨.
  if (s.phase == GamePhase::LevelClear) {
    if (MsSince(s.phase_changed) > 1100.f) {
      if (s.level_index + 1 < static_cast<int>(s.levels.size())) {
        LoadLevel(s, s.level_index + 1);
        s.phase = GamePhase::Playing;
      } else {
        s.phase = GamePhase::Win;
      }
    }
    return;
  }
  if (s.phase != GamePhase::Playing) {
    return;
  }

  Level& lv = s.levels[s.level_index];

#ifdef _WIN32
  if (s.input_focused &&
      (s.phase == GamePhase::Playing || s.phase == GamePhase::Dead)) {
    PollWinKeyboard(s);
  } else {
    s.move_left = false;
    s.move_right = false;
  }
#endif

  // 수평 입력.
  bool want_left = false;
  bool want_right = false;
#ifdef _WIN32
  want_left = s.move_left;
  want_right = s.move_right;
#else
  want_left = MsSince(s.left_pressed) < kHoldTimeoutMs;
  want_right = MsSince(s.right_pressed) < kHoldTimeoutMs;
#endif
  float dir = 0.f;
  if (want_left && !want_right) dir = -1.f;
  else if (want_right && !want_left) dir = 1.f;
  else if (want_left && want_right)
    dir = s.facing_right ? 1.f : -1.f;

  if (dir != 0.f) {
    s.vx += dir * kAccel * dt;
    s.vx = std::clamp(s.vx, -kMoveSpeed, kMoveSpeed);
  } else {
    // 마찰.
    if (s.vx > 0.f) s.vx = std::max(0.f, s.vx - kFriction * dt);
    else if (s.vx < 0.f) s.vx = std::min(0.f, s.vx + kFriction * dt);
  }

  // 점프(더블 점프 포함).
  if (s.jump_queued) {
    if (s.jumps_left > 0) {
      s.vy = -kJumpVel;
      --s.jumps_left;
      s.on_ground = false;
      // 점프 시 작은 반짝임 트레일.
      s.trail.push_back({s.px + kPlayerW * 0.5f, s.py + kPlayerH, 1.f});
    }
    s.jump_queued = false;
  }

  // 중력.
  s.vy += kGravity * dt;
  s.vy = std::min(s.vy, kMaxFall);

  // 충돌(서브스텝으로 터널링 방지).
  s.on_ground = false;
  const float move_x = s.vx * dt;
  const float move_y = s.vy * dt;
  const float dist = std::max(std::fabs(move_x), std::fabs(move_y));
  const int steps = std::max(1, static_cast<int>(std::ceil(dist / 2.5f)));
  for (int i = 0; i < steps; ++i) {
    MoveAxis(s, lv, move_x / steps, 0.f);
    MoveAxis(s, lv, 0.f, move_y / steps);
  }

  // 이동 트레일.
  if (std::fabs(s.vx) > 12.f || std::fabs(s.vy) > 30.f) {
    s.trail.push_back({s.px + kPlayerW * 0.5f, s.py + kPlayerH * 0.5f, 1.f});
    if (s.trail.size() > 40) s.trail.pop_front();
  }

  // 오브 수집.
  const float ccx = s.px + kPlayerW * 0.5f;
  const float ccy = s.py + kPlayerH * 0.5f;
  for (Orb& o : lv.orbs) {
    if (o.collected) continue;
    const float dx = o.x - ccx, dy = o.y - ccy;
    if (dx * dx + dy * dy < 7.f * 7.f) {
      o.collected = true;
      ++s.orbs_collected;
    }
  }

  // 위험지대 접촉 → 사망.
  for (const Rect& h : lv.hazards) {
    if (AabbOverlap(s.px, s.py, kPlayerW, kPlayerH, h)) {
      ++s.deaths;
      s.phase = GamePhase::Dead;
      s.phase_changed = now;
      return;
    }
  }

  // 낙사.
  if (s.py > lv.height) {
    ++s.deaths;
    s.phase = GamePhase::Dead;
    s.phase_changed = now;
    return;
  }

  // 목표 도달 → 클리어.
  if (AabbOverlap(s.px, s.py, kPlayerW, kPlayerH, lv.goal)) {
    s.phase = GamePhase::LevelClear;
    s.phase_changed = now;
    return;
  }
}

Component BuildGameTab(GameState& state) {
  return std::make_shared<GameComponent>(state);
}

}  // namespace gnd
