#include "coord_bus.hpp"
#include "agent_colors.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <fstream>
#include <random>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <process.h>
#include <windows.h>
#endif

namespace gnd {
namespace {

std::string ToLower(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

nlohmann::json ReadJsonSafe(const std::filesystem::path& file,
                            const nlohmann::json& fallback) {
  if (!std::filesystem::exists(file)) {
    return fallback;
  }
  std::ifstream in(file);
  if (!in) {
    return fallback;
  }
  try {
    nlohmann::json j;
    in >> j;
    return j;
  } catch (...) {
    return fallback;
  }
}

ChatMessage JsonToMessage(const nlohmann::json& j, MessageKind kind) {
  ChatMessage m;
  m.kind = kind;
  if (j.contains("id") && j["id"].is_string()) {
    m.id = j["id"].get<std::string>();
  }
  if (j.contains("ts") && j["ts"].is_number_integer()) {
    m.ts = j["ts"].get<int64_t>();
  }
  if (j.contains("from") && j["from"].is_string()) {
    m.from = j["from"].get<std::string>();
  }
  if (j.contains("to") && j["to"].is_string()) {
    m.to = j["to"].get<std::string>();
  }
  if (j.contains("room") && j["room"].is_string()) {
    m.room = j["room"].get<std::string>();
  }
  if (j.contains("text") && j["text"].is_string()) {
    m.text = j["text"].get<std::string>();
  }
  if (j.contains("model") && j["model"].is_string()) {
    m.model = j["model"].get<std::string>();
  }
  if (j.contains("system") && j["system"].is_boolean()) {
    if (j["system"].get<bool>()) {
      m.kind = MessageKind::System;
    }
  }
  if (j.contains("dice") && j["dice"].is_boolean() && j["dice"].get<bool>()) {
    m.kind = MessageKind::Dice;
  }
  return m;
}

}  // namespace

CoordBus::CoordBus(CoordBusConfig config) : config_(std::move(config)) {
  const auto root = config_.root;
  const auto id = SanitizeId(config_.agent_id);
  room_file_ = root / "room.jsonl";
  inbox_file_ = root / "inbox" / (id + ".jsonl");
  cursor_file_ = root / "cursors" / (id + ".json");
  agents_file_ = root / "agents.json";
  rooms_file_ = root / "rooms.json";
  transport_dir_ = root / "transports";
  std::filesystem::create_directories(root / "inbox");
  std::filesystem::create_directories(root / "cursors");
  std::filesystem::create_directories(transport_dir_);
  ReadCursorState();
}

std::string CoordBus::SanitizeId(const std::string& id) {
  std::string out;
  out.reserve(id.size());
  for (char c : id) {
    if (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' ||
        c == '-') {
      out.push_back(c);
    } else {
      out.push_back('_');
    }
  }
  if (out.empty()) {
    out = "human";
  }
  return out;
}

std::string CoordBus::NormalizeRoom(const std::string& name) {
  if (name.empty()) {
    return kDefaultRoom;
  }
  std::string n = name;
  while (!n.empty() && n.front() == '#') {
    n.erase(n.begin());
  }
  n = ToLower(n);
  std::string out;
  for (char c : n) {
    if (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' ||
        c == '-') {
      out.push_back(c);
    }
  }
  return out.empty() ? kDefaultRoom : out;
}

std::string CoordBus::NewMessageId() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::uniform_int_distribution<uint64_t> dist;
  std::ostringstream oss;
  oss << std::hex << dist(rng) << dist(rng);
  return oss.str();
}

int64_t CoordBus::NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::filesystem::path CoordBus::RoomFile(const std::string& chan) const {
  const auto c = NormalizeRoom(chan);
  if (c == kDefaultRoom) {
    return room_file_;
  }
  return config_.root / "rooms" / (SanitizeId(c) + ".jsonl");
}

void CoordBus::ReadCursorState() {
  const auto cur = ReadJsonSafe(cursor_file_, nlohmann::json::object());
  room_offset_ = cur.value("roomOffset", 0);
  inbox_offset_ = cur.value("inboxOffset", 0);
  room_offsets_.clear();
  if (cur.contains("roomOffsets") && cur["roomOffsets"].is_object()) {
    for (const auto& [key, val] : cur["roomOffsets"].items()) {
      if (val.is_number_integer()) {
        room_offsets_[key] = val.get<int64_t>();
      }
    }
  }
}

void CoordBus::SaveCursor() {
  nlohmann::json cur = ReadJsonSafe(cursor_file_, nlohmann::json::object());
  cur["roomOffset"] = room_offset_;
  cur["inboxOffset"] = inbox_offset_;
  nlohmann::json offsets = nlohmann::json::object();
  for (const auto& [chan, off] : room_offsets_) {
    offsets[chan] = off;
  }
  cur["roomOffsets"] = offsets;
  WriteJsonAtomic(cursor_file_, cur);
}

std::vector<std::string> CoordBus::JoinedRooms() const {
  std::vector<std::string> out;
  const auto reg = ReadJsonSafe(rooms_file_, nlohmann::json::object());
  for (const auto& [name, entry] : reg.items()) {
    if (!entry.is_object() || !entry.contains("members") ||
        !entry["members"].is_array()) {
      continue;
    }
    for (const auto& member : entry["members"]) {
      if (member.is_string() && member.get<std::string>() == config_.agent_id) {
        out.push_back(NormalizeRoom(name));
        break;
      }
    }
  }
  if (out.empty()) {
    out.push_back(kDefaultRoom);
  }
  std::sort(out.begin(), out.end());
  out.erase(std::unique(out.begin(), out.end()), out.end());
  return out;
}

int64_t CoordBus::RoomOffsetFor(const std::string& chan) const {
  const auto c = NormalizeRoom(chan);
  if (c == kDefaultRoom) {
    return room_offset_;
  }
  const auto it = room_offsets_.find(c);
  if (it != room_offsets_.end()) {
    return it->second;
  }
  return 0;
}

void CoordBus::SetRoomOffsetFor(const std::string& chan, int64_t offset) {
  const auto c = NormalizeRoom(chan);
  if (c == kDefaultRoom) {
    room_offset_ = offset;
    return;
  }
  room_offsets_[c] = offset;
}

int64_t CoordBus::CountJsonlLines(const std::filesystem::path& file) const {
  if (!std::filesystem::exists(file)) {
    return 0;
  }
  std::ifstream in(file);
  int64_t count = 0;
  std::string line;
  while (std::getline(in, line)) {
    if (!line.empty()) {
      ++count;
    }
  }
  return count;
}

std::vector<ChatMessage> CoordBus::ReadJsonlSlice(
    const std::filesystem::path& file, int64_t from, int64_t to,
    MessageKind kind) const {
  std::vector<ChatMessage> out;
  if (!std::filesystem::exists(file) || from >= to) {
    return out;
  }
  std::ifstream in(file);
  int64_t idx = 0;
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) {
      continue;
    }
    if (idx >= from && idx < to) {
      try {
        auto j = nlohmann::json::parse(line);
        out.push_back(JsonToMessage(j, kind));
      } catch (...) {
        /* skip malformed */
      }
    }
    ++idx;
    if (idx >= to) {
      break;
    }
  }
  return out;
}

void CoordBus::AppendJsonl(const std::filesystem::path& file,
                           const nlohmann::json& entry) const {
  std::filesystem::create_directories(file.parent_path());
  if (!std::filesystem::exists(file)) {
    std::ofstream create(file);
  }
  std::ofstream out(file, std::ios::app);
  out << entry.dump() << '\n';
}

void CoordBus::WriteJsonAtomic(const std::filesystem::path& file,
                               const nlohmann::json& data) const {
  std::filesystem::create_directories(file.parent_path());
  const auto tmp =
      file.parent_path() /
      (file.filename().string() + ".tmp." +
       std::to_string(
#ifdef _WIN32
           _getpid()
#else
           getpid()
#endif
       ) +
       "." + NewMessageId());
  {
    std::ofstream out(tmp);
    out << data.dump(2);
  }
  std::error_code ec;
  std::filesystem::rename(tmp, file, ec);
  if (ec) {
    std::filesystem::remove(tmp, ec);
    std::ofstream out(file);
    out << data.dump(2);
  }
}

void CoordBus::WithAgentsJsonRetry(
    const std::function<void(nlohmann::json&)>& mutate) {
  for (int attempt = 0; attempt < 5; ++attempt) {
    auto reg = ReadJsonSafe(agents_file_, nlohmann::json::object());
    mutate(reg);
    WriteJsonAtomic(agents_file_, reg);
    return;
  }
}

void CoordBus::WriteTransportMarker() {
  const auto file = transport_dir_ / (SanitizeId(config_.agent_id) + ".json");
  nlohmann::json marker{
      {"transport", kTransport},
      {"pid",
#ifdef _WIN32
       static_cast<int>(_getpid())
#else
       static_cast<int>(getpid())
#endif
      },
      {"daemonPid", nullptr},
      {"parentPid",
#ifdef _WIN32
       static_cast<int>(_getpid())
#else
       static_cast<int>(getpid())
#endif
      },
      {"model", "human"},
      {"ts", NowMs()},
  };
  WriteJsonAtomic(file, marker);
}

void CoordBus::ClearTransportMarker() {
  const auto file = transport_dir_ / (SanitizeId(config_.agent_id) + ".json");
  std::error_code ec;
  std::filesystem::remove(file, ec);
}

void CoordBus::UpdateRoomsMembership(bool join) {
  auto reg = ReadJsonSafe(rooms_file_, nlohmann::json::object());
  if (!reg.contains(kDefaultRoom)) {
    reg[kDefaultRoom] = {{"createdAt", 0}, {"createdBy", "system"},
                         {"members", nlohmann::json::array()}};
  }
  auto& members = reg[kDefaultRoom]["members"];
  if (!members.is_array()) {
    members = nlohmann::json::array();
  }
  const auto& id = config_.agent_id;
  auto it = std::find(members.begin(), members.end(), id);
  if (join && it == members.end()) {
    members.push_back(id);
  } else if (!join && it != members.end()) {
    members.erase(it);
  }
  WriteJsonAtomic(rooms_file_, reg);
}

bool CoordBus::Register() {
  const int64_t now = NowMs();
  WithAgentsJsonRetry([&](nlohmann::json& reg) {
    nlohmann::json existing = reg.value(config_.agent_id, nlohmann::json::object());
    reg[config_.agent_id] = {
        {"agentId", config_.agent_id},
        {"role", existing.value("role", "human")},
        {"registeredAt", existing.value("registeredAt", now)},
        {"lastHeartbeat", now},
    };
    if (existing.contains("away")) {
      reg[config_.agent_id]["away"] = existing["away"];
    }
    if (existing.contains("inventory")) {
      reg[config_.agent_id]["inventory"] = existing["inventory"];
    }
    if (existing.contains("avilities")) {
      reg[config_.agent_id]["avilities"] = existing["avilities"];
    }
  });
  WriteTransportMarker();
  UpdateRoomsMembership(true);
  AgentColors(config_.root).ReconcileColorMap();
  return true;
}

void CoordBus::Unregister() {
  ClearTransportMarker();
  WithAgentsJsonRetry([&](nlohmann::json& reg) { reg.erase(config_.agent_id); });
  UpdateRoomsMembership(false);
}

void CoordBus::TouchHeartbeat() {
  const int64_t now = NowMs();
  WithAgentsJsonRetry([&](nlohmann::json& reg) {
    if (!reg.contains(config_.agent_id)) {
      return;
    }
    reg[config_.agent_id]["lastHeartbeat"] = now;
  });
  WriteTransportMarker();
}

void CoordBus::FastForwardCursors() {
  ReadCursorState();
  for (const auto& chan : JoinedRooms()) {
    SetRoomOffsetFor(chan, CountJsonlLines(RoomFile(chan)));
  }
  inbox_offset_ = CountJsonlLines(inbox_file_);
  SaveCursor();
}

std::vector<ChatMessage> CoordBus::RecentMessages(int count) {
  std::vector<ChatMessage> all;
  if (std::filesystem::exists(inbox_file_)) {
    const int64_t total = CountJsonlLines(inbox_file_);
    const int64_t from = std::max<int64_t>(0, total - count);
    auto inbox = ReadJsonlSlice(inbox_file_, from, total, MessageKind::Dm);
    all.insert(all.end(), inbox.begin(), inbox.end());
  }
  for (const auto& chan : JoinedRooms()) {
    const auto file = RoomFile(chan);
    const int64_t total = CountJsonlLines(file);
    const int64_t from = std::max<int64_t>(0, total - count);
    auto rooms = ReadJsonlSlice(file, from, total, MessageKind::Room);
    for (auto& m : rooms) {
      if (m.room.empty()) {
        m.room = chan;
      }
    }
    all.insert(all.end(), rooms.begin(), rooms.end());
  }
  std::sort(all.begin(), all.end(),
            [](const ChatMessage& a, const ChatMessage& b) { return a.ts < b.ts; });
  if (static_cast<int>(all.size()) > count) {
    all.erase(all.begin(), all.end() - count);
  }
  for (auto& m : all) {
    m.history = true;
  }
  return all;
}

std::vector<ChatMessage> CoordBus::DrainNewMessages() {
  ReadCursorState();
  std::vector<ChatMessage> pending;

  const int64_t inbox_total = CountJsonlLines(inbox_file_);
  if (inbox_total > inbox_offset_) {
    auto msgs =
        ReadJsonlSlice(inbox_file_, inbox_offset_, inbox_total, MessageKind::Dm);
    pending.insert(pending.end(), msgs.begin(), msgs.end());
    inbox_offset_ = inbox_total;
  }

  for (const auto& chan : JoinedRooms()) {
    const auto file = RoomFile(chan);
    const int64_t total = CountJsonlLines(file);
    const int64_t offset = RoomOffsetFor(chan);
    if (total > offset) {
      auto msgs = ReadJsonlSlice(file, offset, total, MessageKind::Room);
      for (auto& m : msgs) {
        if (m.room.empty()) {
          m.room = chan;
        }
        pending.push_back(std::move(m));
      }
      SetRoomOffsetFor(chan, total);
    }
  }

  if (!pending.empty()) {
    SaveCursor();
  }
  std::sort(pending.begin(), pending.end(),
            [](const ChatMessage& a, const ChatMessage& b) { return a.ts < b.ts; });
  return pending;
}

void CoordBus::SendRoom(const std::string& text) {
  nlohmann::json entry{{"id", NewMessageId()},
                       {"ts", NowMs()},
                       {"from", config_.agent_id},
                       {"room", kDefaultRoom},
                       {"text", text},
                       {"model", "human"}};
  AppendJsonl(room_file_, entry);
}

void CoordBus::SendDm(const std::string& to, const std::string& text) {
  const auto target = config_.root / "inbox" / (SanitizeId(to) + ".jsonl");
  nlohmann::json entry{{"id", NewMessageId()},
                       {"ts", NowMs()},
                       {"from", config_.agent_id},
                       {"to", to},
                       {"text", text}};
  AppendJsonl(target, entry);
}

}  // namespace gnd
