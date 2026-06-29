#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace gnd {

/** Response from coord-chat --backend IPC for a single input line. */
struct CoordChatResponse {
  std::vector<std::string> lines;
  std::string action;        // "", "quit", "clear"
  std::string current_room;  // focused channel (e.g. general)
  std::string auto_mention;  // empty = off, "all", or agent id
};

/** Ensure coord-chat --backend is running (spawn if needed). */
bool StartCoordChatBackend(const std::filesystem::path& repo_root,
                           const std::filesystem::path& coord_dir,
                           const std::string& agent_id);

/** Ask backend to shutdown and stop managed hook stacks. */
void StopCoordChatBackend();

/** Run any coord-chat input line (commands + room chat) via backend IPC. */
CoordChatResponse RunCoordChatLine(
    const std::filesystem::path& repo_root,
    const std::filesystem::path& coord_dir,
    const std::string& agent_id,
    const std::string& line);

/** Run admin slash command via coord-chat IPC (/list, /invite, …). */
inline std::vector<std::string> RunCoordAdmin(
    const std::filesystem::path& repo_root,
    const std::filesystem::path& coord_dir,
    const std::string& agent_id,
    const std::vector<std::string>& args) {
  if (args.empty()) {
    return {"usage: missing admin command"};
  }
  std::string cmd_line = "/" + args.front();
  for (size_t i = 1; i < args.size(); ++i) {
    cmd_line += " " + args[i];
  }
  return RunCoordChatLine(repo_root, coord_dir, agent_id, cmd_line).lines;
}

}  // namespace gnd
