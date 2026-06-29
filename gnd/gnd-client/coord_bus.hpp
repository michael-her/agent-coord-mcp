#pragma once

#include "chat_model.hpp"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace gnd {

struct CoordBusConfig {
  std::string agent_id;
  std::filesystem::path root;
  std::filesystem::path repo;
};

class CoordBus {
 public:
  static constexpr const char* kDefaultRoom = "general";
  static constexpr const char* kTransport = "gnd-client";

  explicit CoordBus(CoordBusConfig config);

  bool Register();
  void Unregister();
  void TouchHeartbeat();

  void FastForwardCursors();
  std::vector<ChatMessage> RecentMessages(int count);
  std::vector<ChatMessage> DrainNewMessages();

  void SendRoom(const std::string& text);
  void SendDm(const std::string& to, const std::string& text);

  const std::string& AgentId() const { return config_.agent_id; }
  const std::filesystem::path& Root() const { return config_.root; }
  const std::filesystem::path& Repo() const { return config_.repo; }

  static int64_t NowMs();

 private:
  CoordBusConfig config_;
  std::filesystem::path room_file_;
  std::filesystem::path inbox_file_;
  std::filesystem::path cursor_file_;
  std::filesystem::path agents_file_;
  std::filesystem::path rooms_file_;
  std::filesystem::path transport_dir_;

  int64_t room_offset_ = 0;
  int64_t inbox_offset_ = 0;
  std::map<std::string, int64_t> room_offsets_;

  std::vector<std::string> JoinedRooms() const;
  int64_t RoomOffsetFor(const std::string& chan) const;
  void SetRoomOffsetFor(const std::string& chan, int64_t offset);

  static std::string SanitizeId(const std::string& id);
  static std::string NormalizeRoom(const std::string& name);
  static std::string NewMessageId();

  std::filesystem::path RoomFile(const std::string& chan) const;
  void ReadCursorState();
  void SaveCursor();
  int64_t CountJsonlLines(const std::filesystem::path& file) const;
  std::vector<ChatMessage> ReadJsonlSlice(const std::filesystem::path& file,
                                          int64_t from, int64_t to,
                                          MessageKind kind) const;
  void AppendJsonl(const std::filesystem::path& file,
                   const nlohmann::json& entry) const;
  void WriteJsonAtomic(const std::filesystem::path& file,
                       const nlohmann::json& data) const;
  void WithAgentsJsonRetry(const std::function<void(nlohmann::json&)>& mutate);
  void WriteTransportMarker();
  void ClearTransportMarker();
  void UpdateRoomsMembership(bool join);
};

}  // namespace gnd
