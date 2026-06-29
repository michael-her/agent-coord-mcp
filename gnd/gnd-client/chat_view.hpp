#pragma once

#include "agent_busy.hpp"
#include "agent_colors.hpp"
#include "chat_completer.hpp"
#include "coord_bus.hpp"
#include "coord_admin.hpp"
#include "chat_model.hpp"

#include <ftxui/component/component.hpp>

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
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
  void ApplyCoordChatResponse(const CoordChatResponse& resp);
  void AppendCoordChatLines(const std::vector<std::string>& lines,
                            const std::string& from = "coord-chat");
  void OnInputChanged();
  void ApplyTabComplete();
  void RefreshBusyAgents();
  void TrackAgentMessage(const ChatMessage& msg);

  ftxui::Element RenderMessages() const;
  ftxui::Element RenderOne(const ChatMessage& m) const;
  ftxui::Element RenderMessageBody(const std::string& body_text,
                                   const std::string& agent_id) const;
  ftxui::Element RenderInputPrompt(ftxui::Element field) const;
  ftxui::Element RenderHintTokens(const std::vector<HintToken>& tokens) const;
  ftxui::Element RenderRespondingHeader(const std::string& agent_id) const;
  ftxui::Element RenderHintToken(const HintToken& token) const;

  std::string RelTime(int64_t ts) const;
  int TerminalWidth() const;
  int SpinnerTick() const;
  void MaybeAttachImage(ChatMessage& msg);
  bool HandleMessageScroll(ftxui::Event event);
  bool MentionsSelf(const std::string& text) const;

  CoordBus& bus_;
  AgentColors colors_;
  ChatCompleter completer_;
  AgentBusyTracker busy_tracker_;
  std::function<void()> on_quit_;
  std::vector<ChatMessage> messages_;
  std::map<std::string, int64_t> last_agent_message_ts_;
  std::vector<std::string> busy_agents_;
  std::vector<HintToken> input_hint_tokens_;
  std::string input_;
  int input_cursor_ = 0;
  bool tab_hint_lock_ = false;
  bool should_quit_ = false;
  float scroll_y_ = 1.f;
  bool follow_tail_ = true;
  std::string current_room_ = CoordBus::kDefaultRoom;
  std::string auto_mention_;
  std::chrono::steady_clock::time_point last_heartbeat_{};
  std::chrono::steady_clock::time_point last_poll_{};
  std::chrono::steady_clock::time_point last_busy_poll_{};
  ftxui::Component input_component_;
  ftxui::Component root_;
};

}  // namespace gnd
