#include "chat_view.hpp"

#include "chafa_element.hpp"
#include "coord_admin.hpp"

#include <ftxui/component/component.hpp>
#include <ftxui/component/component_options.hpp>
#include <ftxui/component/event.hpp>
#include <ftxui/component/mouse.hpp>
#include <ftxui/dom/elements.hpp>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <iomanip>
#include <sstream>

namespace gnd {
namespace {

using namespace ftxui;

std::string Trim(const std::string& s) {
  size_t b = 0;
  while (b < s.size() && std::isspace(static_cast<unsigned char>(s[b]))) {
    ++b;
  }
  size_t e = s.size();
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) {
    --e;
  }
  return s.substr(b, e - b);
}

std::vector<std::string> SplitOnce(const std::string& s, char delim) {
  const auto pos = s.find(delim);
  if (pos == std::string::npos) {
    return {s};
  }
  return {s.substr(0, pos), s.substr(pos + 1)};
}

}  // namespace

ChatView::ChatView(CoordBus& bus, std::function<void()> on_quit)
    : bus_(bus), on_quit_(std::move(on_quit)) {
  last_heartbeat_ = std::chrono::steady_clock::now();
  last_poll_ = last_heartbeat_;

  auto input_opt = InputOption();
  input_opt.on_enter = [this] { HandleInputSubmit(); };
  input_component_ = Input(&input_, "> ", input_opt);

  auto message_panel = Renderer([this] { return RenderMessages(); });

  auto container = Container::Vertical({
      message_panel,
      input_component_,
  });

  root_ = CatchEvent(
      Renderer(container, [this, message_panel] {
        const std::string title = "#" + std::string(CoordBus::kDefaultRoom) +
                                  " · " + bus_.AgentId();
        return vbox({
            text(title) | bold | center,
            text("PgUp/PgDn · wheel scroll") | dim | center,
            separator(),
            message_panel->Render() | flex,
            separator(),
            input_component_->Render(),
        });
      }),
      [this](Event event) { return HandleMessageScroll(std::move(event)); });
}

void ChatView::LoadHistory(const std::vector<ChatMessage>& history) {
  for (auto m : history) {
    MaybeAttachImage(m);
    messages_.push_back(std::move(m));
  }
  scroll_y_ = 1.f;
  follow_tail_ = true;
}

void ChatView::AppendMessage(ChatMessage msg) {
  MaybeAttachImage(msg);
  messages_.push_back(std::move(msg));
  if (follow_tail_) {
    scroll_y_ = 1.f;
  }
}

void ChatView::MaybeAttachImage(ChatMessage& msg) {
  if (auto path = ExtractImagePath(msg.text)) {
    if (auto ansi = RenderImageSymbols(*path, 40, 12)) {
      msg.image_ansi = *ansi;
    }
  }
}

void ChatView::AppendSystemLines(const std::vector<std::string>& lines) {
  for (const auto& line : lines) {
    ChatMessage m;
    m.kind = MessageKind::System;
    m.from = "coord-admin";
    m.text = line;
    m.ts = CoordBus::NowMs();
    AppendMessage(std::move(m));
  }
}

void ChatView::HandleInputSubmit() {
  const std::string line = Trim(input_);
  input_.clear();
  if (line.empty()) {
    return;
  }

  if (line == "/quit" || line == "/exit") {
    bus_.Unregister();
    should_quit_ = true;
    if (on_quit_) {
      on_quit_();
    }
    return;
  }

  if (line == "/help") {
    ChatMessage m;
    m.kind = MessageKind::System;
    m.from = "gnd-client";
    m.text =
        "commands: /help /quit /whoami /list /invite <model>@<id> /invite @all "
        "/invited /uninvite <id|@all> /kick <id> /dm <id> <text> /img <path> "
        "![alt](path)";
    m.ts = CoordBus::NowMs();
    AppendMessage(std::move(m));
    return;
  }

  if (line == "/whoami") {
    ChatMessage m;
    m.kind = MessageKind::System;
    m.from = "gnd-client";
    m.text = "id=" + bus_.AgentId() + " transport=" + CoordBus::kTransport +
             " dir=" + bus_.Root().string() + " repo=" + bus_.Repo().string();
    m.ts = CoordBus::NowMs();
    AppendMessage(std::move(m));
    return;
  }

  if (line == "/list" || line == "/who") {
    AppendSystemLines(RunCoordAdmin(bus_.Repo(), bus_.Root(), bus_.AgentId(),
                                    {"list"}));
    return;
  }

  if (line == "/invited") {
    AppendSystemLines(RunCoordAdmin(bus_.Repo(), bus_.Root(), bus_.AgentId(),
                                    {"invited"}));
    return;
  }

  if (line == "/invite" || line.rfind("/invite ", 0) == 0) {
    const std::string arg =
        line.size() > 8 ? Trim(line.substr(8)) : std::string{};
    if (line.rfind("/invite ", 0) == 0 && arg.empty()) {
      ChatMessage m;
      m.kind = MessageKind::System;
      m.from = "gnd-client";
      m.text = "usage: /invite <model>@<agentId> or /invite @all";
      m.ts = CoordBus::NowMs();
      AppendMessage(std::move(m));
      return;
    }
    std::vector<std::string> admin_args = {"invite"};
    if (!arg.empty()) {
      admin_args.push_back(arg);
    }
    AppendSystemLines(RunCoordAdmin(bus_.Repo(), bus_.Root(), bus_.AgentId(),
                                    admin_args));
    return;
  }

  if (line == "/uninvite" || line.rfind("/uninvite ", 0) == 0) {
    const std::string arg =
        line.size() > 10 ? Trim(line.substr(11)) : std::string{};
    if (arg.empty()) {
      ChatMessage m;
      m.kind = MessageKind::System;
      m.from = "gnd-client";
      m.text = "usage: /uninvite <agentId|@all>";
      m.ts = CoordBus::NowMs();
      AppendMessage(std::move(m));
      return;
    }
    AppendSystemLines(RunCoordAdmin(bus_.Repo(), bus_.Root(), bus_.AgentId(),
                                    {"uninvite", arg}));
    return;
  }

  if (line.rfind("/kick ", 0) == 0) {
    const std::string arg = Trim(line.substr(6));
    if (arg.empty()) {
      ChatMessage m;
      m.kind = MessageKind::System;
      m.from = "gnd-client";
      m.text = "usage: /kick <agentId>";
      m.ts = CoordBus::NowMs();
      AppendMessage(std::move(m));
      return;
    }
    AppendSystemLines(RunCoordAdmin(bus_.Repo(), bus_.Root(), bus_.AgentId(),
                                    {"kick", arg}));
    return;
  }

  if (line.rfind("/dm ", 0) == 0) {
    const auto rest = Trim(line.substr(4));
    const auto sp = rest.find(' ');
    if (sp == std::string::npos) {
      ChatMessage m;
      m.kind = MessageKind::System;
      m.from = "gnd-client";
      m.text = "usage: /dm <id> <text>";
      m.ts = CoordBus::NowMs();
      AppendMessage(std::move(m));
      return;
    }
    const std::string to = rest.substr(0, sp);
    const std::string body = Trim(rest.substr(sp + 1));
    bus_.SendDm(to, body);
    ChatMessage m;
    m.kind = MessageKind::Dm;
    m.from = bus_.AgentId();
    m.to = to;
    m.text = body;
    m.ts = CoordBus::NowMs();
    AppendMessage(std::move(m));
    return;
  }

  bus_.SendRoom(line);
  ChatMessage m;
  m.kind = MessageKind::Room;
  m.from = bus_.AgentId();
  m.room = CoordBus::kDefaultRoom;
  m.text = line;
  m.model = "human";
  m.ts = CoordBus::NowMs();
  AppendMessage(std::move(m));
}

Component ChatView::Build() { return root_; }

void ChatView::Poll() {
  const auto now = std::chrono::steady_clock::now();
  if (now - last_poll_ < std::chrono::milliseconds(500)) {
    return;
  }
  last_poll_ = now;
  for (auto& m : bus_.DrainNewMessages()) {
    AppendMessage(std::move(m));
  }
}

void ChatView::TickHeartbeat() {
  const auto now = std::chrono::steady_clock::now();
  if (now - last_heartbeat_ < std::chrono::seconds(30)) {
    return;
  }
  last_heartbeat_ = now;
  bus_.TouchHeartbeat();
}

std::string ChatView::RelTime(int64_t ts) const {
  const int64_t now =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count();
  const int64_t mins = (now - ts) / 60000;
  if (mins < 1) {
    return "now";
  }
  if (mins < 60) {
    return std::to_string(mins) + "m";
  }
  const std::time_t t = static_cast<std::time_t>(ts / 1000);
  std::tm tm{};
#ifdef _WIN32
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  std::ostringstream oss;
  oss << std::setfill('0') << std::setw(2) << tm.tm_hour << ':' << std::setw(2)
      << tm.tm_min;
  return oss.str();
}

Element ChatView::RenderOne(const ChatMessage& m) const {
  if (m.kind == MessageKind::System || m.kind == MessageKind::Dice) {
    return paragraph("  — " + m.from + " " + m.text + " —") | dim | italic;
  }

  Color who_color = Color::GreenLight;
  if (m.kind == MessageKind::Dm) {
    who_color = Color::CyanLight;
  }

  std::string badge;
  if (m.kind == MessageKind::Dm) {
    badge = "DM ";
  }

  const std::string header = badge + m.from + " · " +
                             (m.model.empty() ? "—" : m.model) + " · " +
                             RelTime(m.ts);

  Elements body;
  body.push_back(text("▎ " + header) | color(who_color) | bold);
  body.push_back(paragraph("▎ " + m.text));
  if (!m.image_ansi.empty()) {
    body.push_back(text(m.image_ansi));
  }
  return vbox(std::move(body));
}

bool ChatView::HandleMessageScroll(Event event) {
  constexpr float kLineStep = 0.04f;
  constexpr float kPageStep = 0.35f;

  auto apply = [this](float delta) {
    scroll_y_ = std::clamp(scroll_y_ + delta, 0.f, 1.f);
    follow_tail_ = scroll_y_ >= 0.995f;
    return true;
  };

  // Do not bind ArrowUp/Down or Home/End — reserved for focus nav and input editing.
  if (event == Event::PageUp) {
    return apply(-kPageStep);
  }
  if (event == Event::PageDown) {
    return apply(kPageStep);
  }
  if (event.is_mouse()) {
    const auto mouse = event.mouse();
    if (mouse.button == Mouse::WheelUp) {
      return apply(-kLineStep * 3.f);
    }
    if (mouse.button == Mouse::WheelDown) {
      return apply(kLineStep * 3.f);
    }
  }
  return false;
}

Element ChatView::RenderMessages() const {
  Elements rows;
  if (messages_.empty()) {
    rows.push_back(text("(no messages)") | dim | center);
  } else {
    for (const auto& m : messages_) {
      rows.push_back(RenderOne(m));
      rows.push_back(filler() | size(HEIGHT, EQUAL, 0));
    }
  }

  return vbox(std::move(rows)) | focusPositionRelative(0.f, scroll_y_) | yframe |
         vscroll_indicator;
}

}  // namespace gnd
