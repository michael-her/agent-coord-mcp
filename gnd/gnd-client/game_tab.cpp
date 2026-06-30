#include "game_tab.hpp"

#include <ftxui/component/component.hpp>
#include <ftxui/dom/elements.hpp>

namespace gnd {

using namespace ftxui;

Component BuildGameTab() {
  return Renderer([] {
    return vbox({
               text("Game") | bold | center,
               separator(),
               filler(),
               text("(coming soon)") | dim | center,
               filler(),
           }) |
           flex | border;
  });
}

}  // namespace gnd
