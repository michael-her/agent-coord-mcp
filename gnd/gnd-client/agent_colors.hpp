#pragma once

#include <ftxui/screen/color.hpp>

#include <array>
#include <cstdint>
#include <filesystem>
#include <string>

namespace gnd {

/** Stable per-agent colors matching scripts/coord-chat.mjs (chat-colors.json). */
class AgentColors {
 public:
  static constexpr int kPaletteSize = 10;

  explicit AgentColors(std::filesystem::path coord_root);

  /** Rebuild chat-colors.json with unique palette slots (coord-chat reconcileColorMap). */
  void ReconcileColorMap();

  ftxui::Color ColorFor(const std::string& agent_id) const;
  std::array<uint8_t, 3> BaseRgb(const std::string& agent_id) const;
  ftxui::Color ShimmerColor(const std::string& agent_id, int tick) const;

  /** ANSI 24-bit foreground for text() nodes (gutter bar). */
  std::string AnsiFg(const std::string& agent_id) const;
  static constexpr const char* kAnsiReset = "\x1b[0m";

  static std::string NormalizeKey(std::string id);

 private:
  std::filesystem::path color_map_file_;
  std::filesystem::path agents_file_;

  static ftxui::Color PaletteAt(int idx);
  static ftxui::Color HashColor(const std::string& key);
  int ResolveIndex(const std::string& key) const;
  bool IsRegistered(const std::string& key) const;
  int LookupColorMapIndex(const std::string& key) const;
};

}  // namespace gnd
