#pragma once

#include "coord_bus.hpp"
#include "chat_model.hpp"

#include <ftxui/component/component.hpp>

#include <chrono>
#include <functional>
#include <string>
#include <vector>

namespace gnd {

using ftxui::Component;
using ftxui::Element;
using ftxui::Elements;

class ChatView {
 public:
  ChatView(CoordBus& bus, std::function<void()> on_quit);

  ftxui::Component Build();
  void Poll();
  void TickHeartbeat();
  bool ShouldQuit() const { return should_quit_; }

  void LoadHistory(const std::vector<ChatMessage>& history);

 private:
  void AppendMessage(ChatMessage msg);
  void AppendSystemLines(const std::vector<std::string>& lines);
  void HandleInputSubmit();
  ftxui::Element RenderMessages() const;
  ftxui::Element RenderOne(const ChatMessage& m) const;
  std::string RelTime(int64_t ts) const;
  void MaybeAttachImage(ChatMessage& msg);

  CoordBus& bus_;
  std::function<void()> on_quit_;
  std::vector<ChatMessage> messages_;
  std::string input_;
  bool should_quit_ = false;
  int scroll_y_ = 0;
  std::chrono::steady_clock::time_point last_heartbeat_{};
  std::chrono::steady_clock::time_point last_poll_{};
  ftxui::Component input_component_;
  ftxui::Component root_;
};

}  // namespace gnd
