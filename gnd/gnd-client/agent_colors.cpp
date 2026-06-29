#include "agent_colors.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <fstream>
#include <set>
#include <vector>

#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

namespace gnd {
namespace {

constexpr int kPaletteSize = AgentColors::kPaletteSize;
constexpr int kRgb[kPaletteSize][3] = {
    {95, 175, 255},  {255, 120, 95},  {130, 210, 125}, {255, 210, 75},
    {200, 130, 255}, {255, 130, 200}, {75, 220, 210},  {255, 170, 90},
    {180, 180, 255}, {220, 220, 120},
};

std::string ToLower(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

std::string Trim(std::string s) {
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front()))) {
    s.erase(s.begin());
  }
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) {
    s.pop_back();
  }
  return s;
}

nlohmann::json ReadJsonSafe(const std::filesystem::path& file) {
  if (!std::filesystem::exists(file)) {
    return nlohmann::json::object();
  }
  try {
    std::ifstream in(file);
    nlohmann::json j;
    in >> j;
    return j;
  } catch (...) {
    return nlohmann::json::object();
  }
}

void WriteJsonAtomic(const std::filesystem::path& file, const nlohmann::json& data) {
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
       ));
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

}  // namespace

AgentColors::AgentColors(std::filesystem::path coord_root)
    : color_map_file_(coord_root / "chat-colors.json"),
      agents_file_(coord_root / "agents.json") {
  ReconcileColorMap();
}

std::string AgentColors::NormalizeKey(std::string id) {
  id = ToLower(Trim(id));
  if (id.rfind("gm:", 0) == 0) {
    id.erase(0, 3);
  }
  while (!id.empty()) {
    const char c = id.back();
    if (c == '.' || c == ',' || c == ';' || c == ':' || c == '!' || c == '?') {
      id.pop_back();
    } else {
      break;
    }
  }
  return id;
}

ftxui::Color AgentColors::PaletteAt(int idx) {
  const int i = ((idx % kPaletteSize) + kPaletteSize) % kPaletteSize;
  return ftxui::Color::RGB(static_cast<uint8_t>(kRgb[i][0]),
                           static_cast<uint8_t>(kRgb[i][1]),
                           static_cast<uint8_t>(kRgb[i][2]));
}

ftxui::Color AgentColors::HashColor(const std::string& key) {
  uint32_t h = 0;
  for (unsigned char c : key) {
    h = (h * 31u + c);
  }
  return PaletteAt(static_cast<int>(h % kPaletteSize));
}

bool AgentColors::IsRegistered(const std::string& key) const {
  if (key.empty() || key == "all") {
    return false;
  }
  const auto reg = ReadJsonSafe(agents_file_);
  if (reg.contains(key)) {
    return true;
  }
  for (const auto& [id, _] : reg.items()) {
    if (NormalizeKey(id) == key) {
      return true;
    }
  }
  return false;
}

int AgentColors::LookupColorMapIndex(const std::string& key) const {
  const auto map = ReadJsonSafe(color_map_file_);
  if (map.contains(key) && map[key].is_number_integer()) {
    const int idx = map[key].get<int>();
    if (idx >= 0 && idx < kPaletteSize) {
      return idx;
    }
  }
  for (const auto& [id, val] : map.items()) {
    if (NormalizeKey(id) != key) {
      continue;
    }
    if (val.is_number_integer()) {
      const int idx = val.get<int>();
      if (idx >= 0 && idx < kPaletteSize) {
        return idx;
      }
    }
  }
  return -1;
}

void AgentColors::ReconcileColorMap() {
  const auto reg = ReadJsonSafe(agents_file_);
  std::vector<std::string> agent_ids;
  agent_ids.reserve(reg.size());
  for (const auto& [id, _] : reg.items()) {
    agent_ids.push_back(id);
  }
  std::sort(agent_ids.begin(), agent_ids.end());

  const auto old = ReadJsonSafe(color_map_file_);
  nlohmann::json next = nlohmann::json::object();
  std::set<int> used;

  for (const auto& id : agent_ids) {
    const std::string norm = NormalizeKey(id);
    int prev = -1;
    if (old.contains(id) && old[id].is_number_integer()) {
      prev = old[id].get<int>();
    } else {
      for (const auto& [k, val] : old.items()) {
        if (NormalizeKey(k) == norm && val.is_number_integer()) {
          prev = val.get<int>();
          break;
        }
      }
    }
    if (prev >= 0 && prev < kPaletteSize && !used.count(prev)) {
      next[id] = prev;
      used.insert(prev);
    }
  }

  for (const auto& id : agent_ids) {
    if (next.contains(id)) {
      continue;
    }
    int idx = -1;
    for (int i = 0; i < kPaletteSize; ++i) {
      if (!used.count(i)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      idx = static_cast<int>(
          std::find(agent_ids.begin(), agent_ids.end(), id) - agent_ids.begin());
      idx %= kPaletteSize;
      for (int off = 0; off < kPaletteSize; ++off) {
        const int try_idx = (idx + off) % kPaletteSize;
        if (!used.count(try_idx)) {
          idx = try_idx;
          break;
        }
      }
    }
    next[id] = idx;
    used.insert(idx);
  }

  if (old.dump() != next.dump()) {
    WriteJsonAtomic(color_map_file_, next);
  }
}

int AgentColors::ResolveIndex(const std::string& key) const {
  return LookupColorMapIndex(key);
}

ftxui::Color AgentColors::ColorFor(const std::string& agent_id) const {
  const std::string key = NormalizeKey(agent_id);
  if (key.empty()) {
    return ftxui::Color::White;
  }
  if (key == "all") {
    return ftxui::Color::Yellow;
  }
  const int idx = ResolveIndex(key);
  if (idx >= 0) {
    return PaletteAt(idx);
  }
  return HashColor(key);
}

std::array<uint8_t, 3> AgentColors::BaseRgb(const std::string& agent_id) const {
  const std::string key = NormalizeKey(agent_id);
  int idx = ResolveIndex(key);
  if (idx < 0) {
    uint32_t h = 0;
    for (unsigned char c : key) {
      h = (h * 31u + c);
    }
    idx = static_cast<int>(h % kPaletteSize);
  }
  const int i = ((idx % kPaletteSize) + kPaletteSize) % kPaletteSize;
  return {static_cast<uint8_t>(kRgb[i][0]), static_cast<uint8_t>(kRgb[i][1]),
          static_cast<uint8_t>(kRgb[i][2])};
}

ftxui::Color AgentColors::ShimmerColor(const std::string& agent_id,
                                       int tick) const {
  const auto [r0, g0, b0] = BaseRgb(agent_id);
  const double t = (std::sin(tick * 0.7) + 1.0) / 2.0;
  const auto mix = [t](uint8_t base) {
    return static_cast<uint8_t>(std::lround(base + (255.0 - base) * t));
  };
  return ftxui::Color::RGB(mix(r0), mix(g0), mix(b0));
}

std::string AgentColors::AnsiFg(const std::string& agent_id) const {
  const auto [r, g, b] = BaseRgb(agent_id);
  return "\x1b[38;2;" + std::to_string(r) + ";" + std::to_string(g) + ";" +
         std::to_string(b) + "m";
}

}  // namespace gnd
