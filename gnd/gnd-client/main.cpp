#include "chat_view.hpp"
#include "coord_admin.hpp"
#include "coord_bus.hpp"
#include "demo_tab.hpp"
#include "game_tab.hpp"

#include <ftxui/component/app.hpp>
#include <ftxui/component/component.hpp>
#include <ftxui/component/component_options.hpp>
#include <ftxui/component/loop.hpp>
#include <ftxui/component/event.hpp>
#include <ftxui/dom/elements.hpp>
#include <ftxui/screen/terminal.hpp>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

using namespace ftxui;

struct CliArgs {
  std::string id;
  std::filesystem::path dir;
  std::filesystem::path repo;
  bool selftest = false;
};

void EnableVteProcessing() {
#ifdef _WIN32
  SetConsoleOutputCP(65001);
  SetConsoleCP(65001);
  HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
  if (hOut == INVALID_HANDLE_VALUE) {
    return;
  }
  DWORD mode = 0;
  if (!GetConsoleMode(hOut, &mode)) {
    return;
  }
  mode |= ENABLE_VIRTUAL_TERMINAL_PROCESSING;
  SetConsoleMode(hOut, mode);
#endif
}

std::string DefaultAgentId() {
#ifdef _WIN32
  if (const char* user = std::getenv("USERNAME")) {
    return user;
  }
#endif
  if (const char* user = std::getenv("USER")) {
    return user;
  }
  return "human";
}

std::filesystem::path DefaultCoordDir() {
#ifdef _WIN32
  if (const char* home = std::getenv("USERPROFILE")) {
    return std::filesystem::path(home) / "agent-coord";
  }
#endif
  if (const char* home = std::getenv("HOME")) {
    return std::filesystem::path(home) / "agent-coord";
  }
  return std::filesystem::path("agent-coord");
}

std::filesystem::path DefaultRepoRoot() {
  if (const char* proj = std::getenv("CURSOR_PROJECT_DIR")) {
    return proj;
  }
  return std::filesystem::current_path();
}

CliArgs ParseArgs(int argc, char** argv) {
  CliArgs args{DefaultAgentId(), DefaultCoordDir(), DefaultRepoRoot()};
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if ((a == "--id" || a == "-i") && i + 1 < argc) {
      args.id = argv[++i];
    } else if ((a == "--dir" || a == "-d") && i + 1 < argc) {
      args.dir = argv[i + 1];
      ++i;
    } else if (a == "--repo" && i + 1 < argc) {
      args.repo = argv[i + 1];
      ++i;
    } else if (a == "--selftest") {
      args.selftest = true;
    } else if (a == "--help" || a == "-h") {
      std::cout << "gnd-client — agent-coord human TUI\n"
                << "usage: gnd-client [--id <name>] [--dir <agent-coord-path>] "
                   "[--repo <project-root>]\n";
      std::exit(0);
    }
  }
  if (const char* env_dir = std::getenv("AGENT_COORD_DIR")) {
    if (args.dir == DefaultCoordDir()) {
      args.dir = env_dir;
    }
  }
  return args;
}

}  // namespace

int main(int argc, char** argv) {
  EnableVteProcessing();
  ftxui::Terminal::SetColorSupport(ftxui::Terminal::TrueColor);
  const CliArgs args = ParseArgs(argc, argv);

  gnd::CoordBus bus({args.id, args.dir, args.repo});

  if (args.selftest) {
    if (!bus.Register()) {
      std::cerr << "selftest: register failed\n";
      return 1;
    }
    bus.SendRoom("gnd-client selftest");
    const auto transport =
        args.dir / "transports" / (args.id + ".json");
    const auto agents = args.dir / "agents.json";
    if (!std::filesystem::exists(transport)) {
      std::cerr << "selftest: missing transport marker\n";
      bus.Unregister();
      return 1;
    }
    if (!std::filesystem::exists(agents)) {
      std::cerr << "selftest: missing agents.json\n";
      bus.Unregister();
      return 1;
    }
    bus.Unregister();
    if (std::filesystem::exists(transport)) {
      std::cerr << "selftest: transport not cleared\n";
      return 1;
    }
    std::cout << "selftest ok\n";
    return 0;
  }

  if (!bus.Register()) {
    std::cerr << "failed to register as " << args.id << "\n";
    return 1;
  }
  if (!gnd::StartCoordChatBackend(args.repo, args.dir, args.id)) {
    std::cerr << "warning: coord-chat backend failed to start (admin commands unavailable)\n";
  }
  bus.FastForwardCursors();

  auto screen = App::Fullscreen();

  gnd::DemoState demo_state;
  auto demo_tab = gnd::BuildDemoTab(demo_state);
  auto game_tab = gnd::BuildGameTab();

  gnd::ChatView chat_view(bus, [&] { screen.Exit(); });
  chat_view.LoadHistory(bus.RecentMessages(3));

  int tab_index = 0;
  std::vector<std::string> tab_entries = {"Chat", "Game", "Demo"};
  auto tab_menu = Menu(&tab_entries, &tab_index, MenuOption::Horizontal());

  auto tab_content =
      Container::Tab({chat_view.Build(), game_tab, demo_tab}, &tab_index);

  bool quitting = false;
  ButtonOption exit_opt = ButtonOption::Simple();
  exit_opt.transform = [](const EntryState& s) {
    Element label = text(" " + s.label + " ");
    if (s.focused) {
      label = label | bold | color(Color::RedLight);
    } else {
      label = label | color(Color::GrayLight);
    }
    return label | size(HEIGHT, EQUAL, 1);
  };
  auto exit_button = Button("Exit", [&] {
    quitting = true;
    bus.Unregister();
    screen.Exit();
  }, exit_opt);

  // Container tree and Renderer output must match — never Render() children
  // individually in a different layout than the focus tree (causes tab crashes).
  auto tab_row_spacer = Renderer([] { return filler(); });
  auto body = Container::Vertical({
      Container::Horizontal({tab_menu, tab_row_spacer, exit_button}),
      tab_content,
  });

  auto renderer = Renderer(body, [&] {
    return vbox({
        text("gnd-client") | bold | center | size(HEIGHT, EQUAL, 1),
        body->Render() | flex,
    }) | flex;
  });

  Loop loop(&screen, renderer);

  while (!loop.HasQuitted()) {
    chat_view.Poll();
    chat_view.TickHeartbeat();
    if (tab_index == 2) {
      gnd::DemoTick(demo_state);
    }
    if (chat_view.ShouldQuit()) {
      break;
    }

    screen.RequestAnimationFrame();
    loop.RunOnce();
    std::this_thread::sleep_for(std::chrono::milliseconds(16));
  }

  if (!quitting && !chat_view.ShouldQuit()) {
    bus.Unregister();
  }

  gnd::StopCoordChatBackend();

  return 0;
}
