#include "coord_admin.hpp"

#include <cstdio>
#include <sstream>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace gnd {
namespace {

std::string QuoteArg(const std::string& s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '"') {
      out += "\\\"";
    } else {
      out += c;
    }
  }
  out += '"';
  return out;
}

std::string TrimCrLf(std::string s) {
  while (!s.empty() && (s.back() == '\r' || s.back() == '\n')) {
    s.pop_back();
  }
  return s;
}

std::filesystem::path FindNodeScript(const std::filesystem::path& repo_root) {
  return repo_root / "scripts" / "coord-admin.mjs";
}

}  // namespace

std::vector<std::string> RunCoordAdmin(
    const std::filesystem::path& repo_root,
    const std::filesystem::path& coord_dir,
    const std::string& agent_id,
    const std::vector<std::string>& args) {
  const auto script = FindNodeScript(repo_root);
  if (!std::filesystem::exists(script)) {
    return {"coord-admin script not found: " + script.string()};
  }

  std::ostringstream cmd;
  cmd << "node " << QuoteArg(script.string());
  for (const auto& a : args) {
    cmd << ' ' << QuoteArg(a);
  }
  cmd << " --dir " << QuoteArg(coord_dir.string());
  cmd << " --repo " << QuoteArg(repo_root.string());
  cmd << " --id " << QuoteArg(agent_id);
  cmd << " 2>&1";

  std::vector<std::string> lines;
#ifdef _WIN32
  FILE* pipe = _popen(cmd.str().c_str(), "r");
#else
  FILE* pipe = popen(cmd.str().c_str(), "r");
#endif
  if (!pipe) {
    lines.push_back("failed to run coord-admin (is node in PATH?)");
    return lines;
  }

  char buffer[512];
  while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
    const std::string line = TrimCrLf(buffer);
    if (!line.empty()) {
      lines.push_back(line);
    }
  }

#ifdef _WIN32
  _pclose(pipe);
#else
  pclose(pipe);
#endif

  if (lines.empty()) {
    lines.push_back("(no output)");
  }
  return lines;
}

}  // namespace gnd
