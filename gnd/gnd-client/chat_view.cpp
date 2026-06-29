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
#include <cstdlib>
#include <cmath>
#include <iomanip>
#include <regex>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace gnd {
namespace {

using namespace ftxui;

constexpr int kDefaultWrapWidth = 80;

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

struct TextToken {
  std::string text;
  bool mention = false;
  std::string mention_name;
};

struct WordPiece {
  std::string text;
  bool mention = false;
  std::string mention_name;
};

std::vector<TextToken> TokenizeMentions(const std::string& text) {
  static const std::regex re(R"(@([A-Za-z0-9._-]+))");
  std::vector<TextToken> out;
  std::sregex_iterator it(text.begin(), text.end(), re);
  const std::sregex_iterator end;
  size_t pos = 0;
  for (; it != end; ++it) {
    const std::smatch& m = *it;
    if (static_cast<size_t>(m.position()) > pos) {
      out.push_back({text.substr(pos, static_cast<size_t>(m.position()) - pos)});
    }
    out.push_back({m.str(0), true, m.str(1)});
    pos = static_cast<size_t>(m.position() + m.length());
  }
  if (pos < text.size()) {
    out.push_back({text.substr(pos)});
  }
  if (out.empty()) {
    out.push_back({text});
  }
  return out;
}

std::vector<WordPiece> ExplodeToWords(const std::vector<TextToken>& tokens) {
  std::vector<WordPiece> words;
  for (const auto& tok : tokens) {
    if (tok.mention) {
      words.push_back({tok.text, true, tok.mention_name});
      continue;
    }
    size_t i = 0;
    while (i < tok.text.size()) {
      while (i < tok.text.size() &&
             std::isspace(static_cast<unsigned char>(tok.text[i]))) {
        ++i;
      }
      if (i >= tok.text.size()) {
        break;
      }
      size_t j = i;
      while (j < tok.text.size() &&
             !std::isspace(static_cast<unsigned char>(tok.text[j]))) {
        ++j;
      }
      words.push_back({tok.text.substr(i, j - i)});
      i = j;
    }
  }
  return words;
}

Element MakeWordElement(const WordPiece& w, const AgentColors& colors,
                        const std::string& self_key) {
  if (!w.mention) {
    return text(w.text);
  }
  const std::string key = AgentColors::NormalizeKey(w.mention_name);
  if (key == "all") {
    return text(w.text) | bold | color(Color::Yellow);
  }
  Element el = text(w.text) | color(colors.ColorFor(w.mention_name));
  if (key == self_key) {
    el = el | bold;
  }
  return el;
}

Element GutterBar(const AgentColors& colors, const std::string& agent_id) {
  return text("▎ ") | color(colors.ColorFor(agent_id));
}

}  // namespace

ChatView::ChatView(CoordBus& bus, std::function<void()> on_quit)
    : bus_(bus),
      colors_(bus.Root()),
      completer_(bus.Root(), bus.AgentId()),
      busy_tracker_(bus.Repo(), bus.Root(), bus.AgentId()),
      on_quit_(std::move(on_quit)) {
  last_heartbeat_ = std::chrono::steady_clock::now();
  last_poll_ = last_heartbeat_;
  last_busy_poll_ = last_heartbeat_;

  auto input_opt = InputOption();
  input_opt.cursor_position = &input_cursor_;
  input_opt.on_enter = [this] { HandleInputSubmit(); };
  input_opt.on_change = [this] { OnInputChanged(); };
  input_opt.transform = [this](InputState state) {
    return RenderInputPrompt(state.element);
  };

  auto raw_input = Input(&input_, "", input_opt);
  input_component_ = CatchEvent(raw_input, [this](Event event) {
    if (event == Event::Tab) {
      ApplyTabComplete();
      return true;
    }
    if (event == Event::Escape) {
      input_hint_tokens_.clear();
      tab_hint_lock_ = false;
      return true;
    }
    return false;
  });

  auto message_panel = Renderer([this] { return RenderMessages(); });

  auto container = Container::Vertical({
      message_panel,
      input_component_,
  });

  root_ = CatchEvent(
      Renderer(container, [this, message_panel] {
        const auto self_color = colors_.ColorFor(bus_.AgentId());
        Elements chrome;
        chrome.push_back(
            hbox({
                text("#") | color(Color::Cyan),
                text(current_room_) | color(Color::Cyan) | bold,
                text(" · ") | dim,
                text(bus_.AgentId()) | color(self_color) | bold,
            }) |
            center);
        if (!auto_mention_.empty()) {
          const std::string label =
              auto_mention_ == "all" ? "@all" : "@" + auto_mention_;
          chrome.push_back(text(label) | color(Color::Yellow) | bold | center);
        }
        chrome.push_back(separator());
        chrome.push_back(message_panel->Render() | flex);
        chrome.push_back(separator());
        for (const auto& id : busy_agents_) {
          chrome.push_back(RenderRespondingHeader(id));
        }
        if (!input_hint_tokens_.empty()) {
          chrome.push_back(RenderHintTokens(input_hint_tokens_));
        }
        chrome.push_back(input_component_->Render());
        return vbox(std::move(chrome));
      }),
      [this](Event event) { return HandleMessageScroll(std::move(event)); });
}

int ChatView::TerminalWidth() const {
#ifdef _WIN32
  CONSOLE_SCREEN_BUFFER_INFO info{};
  if (GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &info)) {
    return std::max(40, static_cast<int>(info.srWindow.Right -
                                          info.srWindow.Left + 1));
  }
#endif
  if (const char* cols = std::getenv("COLUMNS")) {
    try {
      return std::max(40, std::stoi(cols));
    } catch (...) {
    }
  }
  return kDefaultWrapWidth;
}

int ChatView::SpinnerTick() const {
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now().time_since_epoch())
                      .count();
  return static_cast<int>((ms / 120) % 5);
}

void ChatView::TrackAgentMessage(const ChatMessage& msg) {
  if (msg.from.empty() || msg.from == bus_.AgentId()) {
    return;
  }
  if (msg.kind == MessageKind::System) {
    return;
  }
  const int64_t ts = msg.ts > 0 ? msg.ts : CoordBus::NowMs();
  auto it = last_agent_message_ts_.find(msg.from);
  if (it == last_agent_message_ts_.end() || ts > it->second) {
    last_agent_message_ts_[msg.from] = ts;
  }
}

void ChatView::RefreshBusyAgents() {
  busy_agents_ = busy_tracker_.RespondingAgents(
      [this](const std::string& id) -> int64_t {
        const auto it = last_agent_message_ts_.find(id);
        return it != last_agent_message_ts_.end() ? it->second : 0;
      });
}

Element ChatView::RenderHintToken(const HintToken& token) const {
  switch (token.kind) {
    case HintKind::Command:
      return text(token.text) | color(Color::Cyan);
    case HintKind::Agent:
      return text(token.text) | color(colors_.ColorFor(token.agent_id)) | bold;
    case HintKind::Mention:
      return text(token.text) | color(colors_.ColorFor(token.agent_id));
    case HintKind::OnlineDot:
      return text(token.text) | color(Color::GreenLight);
    case HintKind::Plain:
    default:
      return text(token.text) | dim;
  }
}

Element ChatView::RenderHintTokens(
    const std::vector<HintToken>& tokens) const {
  Elements parts;
  for (const auto& token : tokens) {
    parts.push_back(RenderHintToken(token));
  }
  return hbox(std::move(parts));
}

Element ChatView::RenderRespondingHeader(const std::string& agent_id) const {
  static constexpr const char* kFrames[] = {"|", "/", "-", "\\", "|"};
  const int tick = SpinnerTick();
  const Color who = colors_.ColorFor(agent_id);
  const Color spin = colors_.ShimmerColor(agent_id, tick);
  const std::string model = busy_tracker_.ResolveDisplayModel(agent_id);
  return hbox({
      GutterBar(colors_, agent_id),
      text(agent_id) | color(who) | bold,
      text(" · " + model + " · ") | dim,
      text(kFrames[tick % 5]) | color(spin) | bold,
  });
}

void ChatView::OnInputChanged() {
  if (tab_hint_lock_) {
    tab_hint_lock_ = false;
    return;
  }
  input_hint_tokens_ = completer_.MentionPickerHint(input_, input_cursor_);
}

void ChatView::ApplyTabComplete() {
  const auto result = completer_.Complete(input_, input_cursor_);
  if (!result.hint_tokens.empty()) {
    input_hint_tokens_ = result.hint_tokens;
    tab_hint_lock_ = true;
  }
  if (result.modified) {
    input_ = result.line;
    input_cursor_ = result.cursor;
    tab_hint_lock_ = true;
  }
}

Element ChatView::RenderInputPrompt(Element field) const {
  const auto self_color = colors_.ColorFor(bus_.AgentId());
  Elements prefix;
  prefix.push_back(text(bus_.AgentId()) | color(self_color) | bold);
  prefix.push_back(text(" ") | color(Color::Cyan) | bold);
  prefix.push_back(text("#" + current_room_) | color(Color::Cyan) | bold);
  if (!auto_mention_.empty()) {
    const std::string label =
        auto_mention_ == "all" ? "@all" : "@" + auto_mention_;
    prefix.push_back(text(" ") | color(Color::Yellow));
    prefix.push_back(text(label) | color(Color::Yellow) | bold);
  }
  prefix.push_back(text(" > ") | dim);
  prefix.push_back(field);
  return hbox(std::move(prefix));
}

bool ChatView::MentionsSelf(const std::string& text) const {
  const std::string self_key = AgentColors::NormalizeKey(bus_.AgentId());
  static const std::regex re(R"(@([A-Za-z0-9._-]+))");
  std::sregex_iterator it(text.begin(), text.end(), re);
  const std::sregex_iterator end;
  for (; it != end; ++it) {
    const std::string key = AgentColors::NormalizeKey((*it)[1].str());
    if (key == "all" || key == self_key) {
      return true;
    }
  }
  return false;
}

void ChatView::LoadHistory(const std::vector<ChatMessage>& history) {
  for (auto m : history) {
    TrackAgentMessage(m);
    MaybeAttachImage(m);
    messages_.push_back(std::move(m));
  }
  scroll_y_ = 1.f;
  follow_tail_ = true;
  RefreshBusyAgents();
}

void ChatView::AppendMessage(ChatMessage msg) {
  TrackAgentMessage(msg);
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

void ChatView::AppendCoordChatLines(const std::vector<std::string>& lines,
                                    const std::string& from) {
  for (const auto& line : lines) {
    if (line.empty()) {
      continue;
    }
    ChatMessage m;
    m.kind = MessageKind::System;
    m.from = from;
    m.text = line;
    m.ts = CoordBus::NowMs();
    AppendMessage(std::move(m));
  }
}

void ChatView::ApplyCoordChatResponse(const CoordChatResponse& resp) {
  input_hint_tokens_.clear();
  tab_hint_lock_ = false;
  AppendCoordChatLines(resp.lines);

  if (!resp.current_room.empty()) {
    current_room_ = resp.current_room;
  }
  auto_mention_ = resp.auto_mention;

  if (resp.action == "clear") {
    messages_.clear();
    scroll_y_ = 1.f;
    follow_tail_ = true;
    return;
  }

  if (resp.action == "quit") {
    StopCoordChatBackend();
    bus_.Unregister();
    should_quit_ = true;
    if (on_quit_) {
      on_quit_();
    }
  }
}

void ChatView::HandleInputSubmit() {
  const std::string line = Trim(input_);
  input_.clear();
  input_cursor_ = 0;
  input_hint_tokens_.clear();
  tab_hint_lock_ = false;
  if (line.empty()) {
    return;
  }

  const auto resp =
      RunCoordChatLine(bus_.Repo(), bus_.Root(), bus_.AgentId(), line);
  ApplyCoordChatResponse(resp);

  if (should_quit_) {
    return;
  }

  for (auto& m : bus_.DrainNewMessages()) {
    AppendMessage(std::move(m));
  }
  RefreshBusyAgents();
}

Component ChatView::Build() { return root_; }

void ChatView::Poll() {
  const auto now = std::chrono::steady_clock::now();
  if (now - last_poll_ >= std::chrono::milliseconds(500)) {
    last_poll_ = now;
    for (auto& m : bus_.DrainNewMessages()) {
      AppendMessage(std::move(m));
    }
  }
  if (now - last_busy_poll_ >= std::chrono::milliseconds(200)) {
    last_busy_poll_ = now;
    RefreshBusyAgents();
  }
}

void ChatView::TickHeartbeat() {
  const auto now = std::chrono::steady_clock::now();
  if (now - last_heartbeat_ < std::chrono::seconds(30)) {
    return;
  }
  last_heartbeat_ = now;
  bus_.TouchHeartbeat();
  colors_.ReconcileColorMap();
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

Element ChatView::RenderMessageBody(const std::string& body_text,
                                    const std::string& agent_id) const {
  if (body_text.find('@') == std::string::npos) {
    return hbox({
        GutterBar(colors_, agent_id),
        paragraph(body_text),
    });
  }

  const std::string self_key = AgentColors::NormalizeKey(bus_.AgentId());
  const auto tokens = TokenizeMentions(body_text);
  const auto words = ExplodeToWords(tokens);
  const int wrap_width = std::max(40, TerminalWidth() - 2);

  Elements lines;
  Elements current;
  int line_width = 0;

  auto flush = [&]() {
    if (current.empty()) {
      return;
    }
    Elements row;
    row.push_back(GutterBar(colors_, agent_id));
    row.insert(row.end(), current.begin(), current.end());
    lines.push_back(hbox(std::move(row)));
    current.clear();
    line_width = 0;
  };

  for (const auto& w : words) {
    const int word_len = static_cast<int>(w.text.size());
    const int max_line = wrap_width - 2;
    if (line_width > 0 && line_width + 1 + word_len > max_line) {
      flush();
    }
    if (line_width > 0) {
      current.push_back(text(" "));
      ++line_width;
    }
    current.push_back(MakeWordElement(w, colors_, self_key));
    line_width += word_len;
  }
  flush();

  if (lines.empty()) {
    return GutterBar(colors_, agent_id);
  }
  return vbox(std::move(lines));
}

Element ChatView::RenderOne(const ChatMessage& m) const {
  const Color who_color = colors_.ColorFor(m.from);
  const bool pinged = m.kind == MessageKind::Room && MentionsSelf(m.text);

  if (m.kind == MessageKind::System || m.kind == MessageKind::Dice) {
    std::string prefix = "  — ";
    if (!m.room.empty() && m.room != CoordBus::kDefaultRoom) {
      prefix += "#" + m.room + " ";
    }
    if (m.kind == MessageKind::Dice) {
      return hbox({
                 GutterBar(colors_, m.from),
                 text(m.text) | color(who_color),
             }) |
             dim;
    }
    return paragraph(prefix + m.from + " " + m.text + " —") | dim | italic;
  }

  std::string badge;
  if (m.kind == MessageKind::Dm) {
    badge = "DM ";
  } else if (!m.room.empty() && m.room != CoordBus::kDefaultRoom) {
    badge = "#" + m.room + " ";
  }

  const std::string meta = (m.model.empty() ? "—" : m.model) + " · " +
                           RelTime(m.ts);

  Elements header_row;
  if (!badge.empty()) {
    header_row.push_back(text(badge) | color(Color::CyanLight) | bold);
  }
  header_row.push_back(GutterBar(colors_, m.from));
  if (pinged) {
    header_row.push_back(text("► ") | bold | color(Color::Yellow));
  }
  header_row.push_back(text(m.from) | color(who_color) | bold);
  header_row.push_back(text(" · " + meta) | dim);

  Elements body;
  body.push_back(hbox(std::move(header_row)));
  body.push_back(RenderMessageBody(m.text, m.from));
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
    rows.push_back(text("(no messages — type /help)") | dim | center);
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
