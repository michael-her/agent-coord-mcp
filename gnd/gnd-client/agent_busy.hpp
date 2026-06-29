#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

namespace gnd {

/** Poll coord-wake-busy-*.json (mirrors coord-chat responding headers). */
class AgentBusyTracker {
 public:
  AgentBusyTracker(std::filesystem::path repo_root,
                   std::filesystem::path coord_root,
                   std::string self_id);

  std::vector<std::string> RespondingAgents(
      const std::function<int64_t(const std::string& agent_id)>&
          last_message_ts) const;

  std::string ResolveDisplayModel(const std::string& agent_id) const;

 private:
  std::filesystem::path wake_logs_dir_;
  std::filesystem::path coord_root_;
  std::filesystem::path transport_dir_;
  std::filesystem::path agents_file_;
  std::filesystem::path models_file_;
  std::string self_id_;

  static bool PidAlive(int pid);
  bool IsAgentBusy(const std::string& agent_id) const;
  int64_t BusySince(const std::string& agent_id) const;
  static std::string SanitizeId(const std::string& id);
};

}  // namespace gnd
