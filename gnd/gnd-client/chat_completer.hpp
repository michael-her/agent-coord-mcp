#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace gnd {

enum class HintKind { Plain, Command, Agent, Mention, OnlineDot };

struct HintToken {
  HintKind kind = HintKind::Plain;
  std::string text;
  std::string agent_id;
};

struct CompletionResult {
  std::string line;
  int cursor = 0;
  std::vector<HintToken> hint_tokens;
  bool modified = false;
};

/** Tab completion mirroring scripts/coord-chat.mjs completer(). */
class ChatCompleter {
 public:
  ChatCompleter(std::filesystem::path coord_root, std::string self_id);

  CompletionResult Complete(const std::string& line, int cursor) const;
  std::vector<HintToken> MentionPickerHint(const std::string& line,
                                           int cursor) const;

 private:
  std::filesystem::path coord_root_;
  std::filesystem::path agents_file_;
  std::filesystem::path rooms_file_;
  std::filesystem::path transport_dir_;
  std::string self_id_;

  std::vector<std::string> RegisteredAgentIds() const;
  std::vector<std::string> OnlineAgentIds() const;
  std::vector<std::string> RoomNames() const;
  std::vector<std::string> AvilityNames() const;

  static std::vector<HintToken> HintFromHits(
      const std::vector<std::string>& hits);
  static std::vector<HintToken> MentionListHint(
      const std::vector<std::string>& agent_ids);
  static std::string CommonPrefix(const std::vector<std::string>& strs);
  static std::string SanitizeId(const std::string& id);
  static bool PidAlive(int pid);
};

}  // namespace gnd
