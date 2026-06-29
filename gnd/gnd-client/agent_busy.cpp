#include "agent_busy.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <fstream>
#include <regex>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <signal.h>
#include <unistd.h>
#endif

namespace gnd {
namespace {

constexpr int64_t kBusyMaxMs = 10 * 60 * 1000;

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

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

AgentBusyTracker::AgentBusyTracker(std::filesystem::path repo_root,
                                   std::filesystem::path coord_root,
                                   std::string self_id)
    : wake_logs_dir_(repo_root / ".cursor" / "hooks" / "logs"),
      coord_root_(std::move(coord_root)),
      transport_dir_(coord_root_ / "transports"),
      agents_file_(coord_root_ / "agents.json"),
      models_file_(coord_root_ / "agent-models.json"),
      self_id_(std::move(self_id)) {}

std::string AgentBusyTracker::SanitizeId(const std::string& id) {
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
  return out.empty() ? "human" : out;
}

bool AgentBusyTracker::PidAlive(int pid) {
  if (pid <= 0) {
    return false;
  }
#ifdef _WIN32
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                            static_cast<DWORD>(pid));
  if (!proc) {
    return false;
  }
  DWORD code = 0;
  const BOOL ok = GetExitCodeProcess(proc, &code);
  CloseHandle(proc);
  return ok && code == STILL_ACTIVE;
#else
  return kill(pid, 0) == 0;
#endif
}

int64_t AgentBusyTracker::BusySince(const std::string& agent_id) const {
  const auto file = wake_logs_dir_ / ("coord-wake-busy-" + agent_id + ".json");
  if (!std::filesystem::exists(file)) {
    return 0;
  }
  try {
    const auto j = ReadJsonSafe(file);
    if (j.contains("since") && j["since"].is_number_integer()) {
      return j["since"].get<int64_t>();
    }
  } catch (...) {
  }
  return 0;
}

bool AgentBusyTracker::IsAgentBusy(const std::string& agent_id) const {
  const auto file = wake_logs_dir_ / ("coord-wake-busy-" + agent_id + ".json");
  if (!std::filesystem::exists(file)) {
    return false;
  }
  try {
    const auto j = ReadJsonSafe(file);
    const int64_t since =
        j.contains("since") && j["since"].is_number_integer()
            ? j["since"].get<int64_t>()
            : 0;
    const int64_t age = NowMs() - since;
    if (age > kBusyMaxMs) {
      return false;
    }
    if (j.contains("pid") && j["pid"].is_number_integer()) {
      if (!PidAlive(j["pid"].get<int>())) {
        return false;
      }
    }
    return true;
  } catch (...) {
    return false;
  }
}

std::vector<std::string> AgentBusyTracker::RespondingAgents(
    const std::function<int64_t(const std::string& agent_id)>& last_message_ts)
    const {
  std::vector<std::string> out;
  if (!std::filesystem::exists(wake_logs_dir_)) {
    return out;
  }
  for (const auto& entry : std::filesystem::directory_iterator(wake_logs_dir_)) {
    if (!entry.is_regular_file()) {
      continue;
    }
    const std::string name = entry.path().filename().string();
    static const std::regex re(R"(^coord-wake-busy-(.+)\.json$)");
    std::smatch m;
    if (!std::regex_match(name, m, re)) {
      continue;
    }
    const std::string id = m[1].str();
    if (id == self_id_ || !IsAgentBusy(id)) {
      continue;
    }
    const int64_t since = BusySince(id);
    const int64_t last_ts = last_message_ts ? last_message_ts(id) : 0;
    if (since > 0 && last_ts > 0 && last_ts >= since) {
      continue;
    }
    out.push_back(id);
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::string AgentBusyTracker::ResolveDisplayModel(
    const std::string& agent_id) const {
  const auto models = ReadJsonSafe(models_file_);
  if (models.contains(agent_id) && models[agent_id].is_string()) {
    return models[agent_id].get<std::string>();
  }
  const auto reg = ReadJsonSafe(agents_file_);
  if (reg.contains(agent_id) && reg[agent_id].is_object()) {
    const auto& entry = reg[agent_id];
    if (entry.contains("model") && entry["model"].is_string()) {
      return entry["model"].get<std::string>();
    }
  }
  const auto marker =
      ReadJsonSafe(transport_dir_ / (SanitizeId(agent_id) + ".json"));
  if (marker.contains("model") && marker["model"].is_string()) {
    return marker["model"].get<std::string>();
  }
  return "—";
}

}  // namespace gnd
