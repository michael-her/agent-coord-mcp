#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace gnd {

/** Run `node scripts/coord-admin.mjs` and return stdout lines (plain text). */
std::vector<std::string> RunCoordAdmin(
    const std::filesystem::path& repo_root,
    const std::filesystem::path& coord_dir,
    const std::string& agent_id,
    const std::vector<std::string>& args);

}  // namespace gnd
