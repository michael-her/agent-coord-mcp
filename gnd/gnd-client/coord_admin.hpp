#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace gnd {

/** Ensure coord-chat --backend is running (spawn if needed). */
bool StartCoordChatBackend(const std::filesystem::path& repo_root,
                           const std::filesystem::path& coord_dir,
                           const std::string& agent_id);

/** Ask backend to shutdown and stop managed hook stacks. */
void StopCoordChatBackend();

/** Run admin slash command via coord-chat IPC (/list, /invite, …). */
std::vector<std::string> RunCoordAdmin(
    const std::filesystem::path& repo_root,
    const std::filesystem::path& coord_dir,
    const std::string& agent_id,
    const std::vector<std::string>& args);

}  // namespace gnd
