#include "chat_completer.hpp"

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

constexpr int64_t kStaleMs = 5 * 60 * 1000;

const char* kSlashCommands[] = {
    "/dm",           "/msg",          "/list",         "/who",
    "/whoami",       "/whois",        "/last",         "/find",
    "/clear",        "/cls",          "/me",           "/status",
    "/away",         "/back",         "/ignore",       "/unignore",
    "/nick",         "/join",         "/part",          "/leave",
    "/rooms",        "/channels",     "/topic",        "/motd",
    "/rules",        "/prune",        "/kick",         "/wipe-room",
    "/rollover",     "/invite",       "/uninvite",     "/invited",
    "/d",            "/d4",           "/d6",           "/d8",
    "/d10",          "/d12",          "/d20",          "/d100",
    "/d%",           "/roll",         "/dice",         "/gm",
    "/saveinv",      "/con",          "/inv",          "/avil",
    "/@",            "/@all",         "/help",         "/?",
    "/quit",         "/exit",
};

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

std::string ToLower(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

int64_t NowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

ChatCompleter::ChatCompleter(std::filesystem::path coord_root,
                             std::string self_id)
    : coord_root_(std::move(coord_root)),
      agents_file_(coord_root_ / "agents.json"),
      rooms_file_(coord_root_ / "rooms.json"),
      transport_dir_(coord_root_ / "transports"),
      self_id_(std::move(self_id)) {}

std::string ChatCompleter::SanitizeId(const std::string& id) {
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

bool ChatCompleter::PidAlive(int pid) {
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

std::vector<std::string> ChatCompleter::RegisteredAgentIds() const {
  const auto reg = ReadJsonSafe(agents_file_);
  std::vector<std::string> out;
  out.reserve(reg.size());
  for (const auto& [id, _] : reg.items()) {
    out.push_back(id);
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<std::string> ChatCompleter::OnlineAgentIds() const {
  const auto reg = ReadJsonSafe(agents_file_);
  const int64_t now = NowMs();
  std::vector<std::string> out;
  for (const auto& [id, entry] : reg.items()) {
    if (id == self_id_) {
      out.push_back(id);
      continue;
    }
    const auto marker =
        ReadJsonSafe(transport_dir_ / (SanitizeId(id) + ".json"));
    const bool live =
        marker.contains("pid") && marker["pid"].is_number_integer() &&
        PidAlive(marker["pid"].get<int>());
    int64_t hb = 0;
    if (entry.is_object() && entry.contains("lastHeartbeat") &&
        entry["lastHeartbeat"].is_number_integer()) {
      hb = entry["lastHeartbeat"].get<int64_t>();
    }
    if (live || (now - hb) < kStaleMs) {
      out.push_back(id);
    }
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<std::string> ChatCompleter::RoomNames() const {
  const auto reg = ReadJsonSafe(rooms_file_);
  std::vector<std::string> out;
  for (const auto& [name, _] : reg.items()) {
    out.push_back(ToLower(name));
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<std::string> ChatCompleter::AvilityNames() const {
  const auto reg = ReadJsonSafe(agents_file_);
  if (!reg.contains(self_id_) || !reg[self_id_].is_object()) {
    return {};
  }
  const auto& self = reg[self_id_];
  if (!self.contains("avilities") || !self["avilities"].is_array()) {
    return {};
  }
  std::vector<std::string> out;
  for (const auto& item : self["avilities"]) {
    if (item.is_object() && item.contains("name") && item["name"].is_string()) {
      out.push_back(item["name"].get<std::string>());
    }
  }
  std::sort(out.begin(), out.end());
  return out;
}

std::string ChatCompleter::CommonPrefix(const std::vector<std::string>& strs) {
  if (strs.empty()) {
    return "";
  }
  std::string prefix = strs.front();
  for (size_t i = 1; i < strs.size(); ++i) {
    const std::string& s = strs[i];
    while (!prefix.empty() && s.compare(0, prefix.size(), prefix) != 0) {
      prefix.pop_back();
    }
  }
  return prefix;
}

std::vector<HintToken> ChatCompleter::HintFromHits(
    const std::vector<std::string>& hits) {
  std::vector<HintToken> tokens;
  tokens.push_back({HintKind::Plain, "  ┄ "});
  for (size_t i = 0; i < hits.size(); ++i) {
    if (i > 0) {
      tokens.push_back({HintKind::Plain, "  "});
    }
    std::string trimmed = hits[i];
    while (!trimmed.empty() &&
           std::isspace(static_cast<unsigned char>(trimmed.back()))) {
      trimmed.pop_back();
    }

    if (!trimmed.empty() && trimmed[0] == '@') {
      const std::string id = trimmed.substr(1);
      tokens.push_back({HintKind::Mention, trimmed, id});
      continue;
    }

    auto push_agent_hit = [&](const std::string& prefix, const std::string& id) {
      tokens.push_back({HintKind::Command, prefix});
      tokens.push_back({HintKind::Agent, id, id});
    };

    if (trimmed.rfind("/dm ", 0) == 0) {
      std::string rest = trimmed.substr(4);
      while (!rest.empty() &&
             std::isspace(static_cast<unsigned char>(rest.back()))) {
        rest.pop_back();
      }
      if (!rest.empty()) {
        push_agent_hit("/dm ", rest);
      } else {
        tokens.push_back({HintKind::Command, trimmed});
      }
      continue;
    }
    if (trimmed.rfind("/whois ", 0) == 0) {
      std::string rest = trimmed.substr(7);
      while (!rest.empty() &&
             std::isspace(static_cast<unsigned char>(rest.back()))) {
        rest.pop_back();
      }
      if (!rest.empty()) {
        push_agent_hit("/whois ", rest);
      } else {
        tokens.push_back({HintKind::Command, trimmed});
      }
      continue;
    }
    if (trimmed.rfind("/inv ", 0) == 0) {
      std::string rest = trimmed.substr(5);
      while (!rest.empty() &&
             std::isspace(static_cast<unsigned char>(rest.back()))) {
        rest.pop_back();
      }
      if (!rest.empty()) {
        push_agent_hit("/inv ", rest);
      } else {
        tokens.push_back({HintKind::Command, trimmed});
      }
      continue;
    }
    if (trimmed.size() >= 5 && trimmed.rfind("/avil", 0) == 0 &&
        (trimmed.size() == 5 ||
         std::isspace(static_cast<unsigned char>(trimmed[5])))) {
      std::string rest = trimmed.size() > 6 ? trimmed.substr(6) : std::string{};
      while (!rest.empty() &&
             std::isspace(static_cast<unsigned char>(rest.back()))) {
        rest.pop_back();
      }
      tokens.push_back({HintKind::Command, "/avil "});
      if (!rest.empty()) {
        tokens.push_back({HintKind::Plain, rest});
      }
      continue;
    }

    if (!trimmed.empty() && trimmed[0] == '/') {
      tokens.push_back({HintKind::Command, trimmed});
    } else {
      tokens.push_back({HintKind::Plain, trimmed});
    }
  }
  tokens.push_back({HintKind::Plain, "   · Tab to complete"});
  return tokens;
}

std::vector<HintToken> ChatCompleter::MentionListHint(
    const std::vector<std::string>& agent_ids) {
  std::vector<HintToken> tokens;
  tokens.push_back({HintKind::Plain, "  ┄ "});
  bool first = true;
  for (const auto& id : agent_ids) {
    if (!first) {
      tokens.push_back({HintKind::Plain, "  "});
    }
    first = false;
    tokens.push_back({HintKind::OnlineDot, "●"});
    tokens.push_back({HintKind::Mention, "@" + id, id});
  }
  tokens.push_back({HintKind::Plain, "   · Tab to complete"});
  return tokens;
}

CompletionResult ChatCompleter::Complete(const std::string& line,
                                         int cursor) const {
  CompletionResult out;
  out.line = line;
  out.cursor = cursor;

  const int safe_cursor = std::clamp(cursor, 0, static_cast<int>(line.size()));
  const std::string before = line.substr(0, static_cast<size_t>(safe_cursor));

  std::vector<std::string> hits;
  std::string substr = before;

  static const std::regex mention_re(R"(@([A-Za-z0-9._-]*)$)");
  std::smatch mention_match;
  if (std::regex_search(before, mention_match, mention_re)) {
    const std::string partial = mention_match[1].str();
    for (const auto& id : OnlineAgentIds()) {
      if (id != self_id_ && id.rfind(partial, 0) == 0) {
        hits.push_back("@" + id + " ");
      }
    }
    substr = mention_match[0].str();
  } else if (before.rfind("/dm ", 0) == 0) {
    const std::string partial = before.substr(4);
    for (const auto& id : OnlineAgentIds()) {
      if (id != self_id_ && id.rfind(partial, 0) == 0) {
        hits.push_back("/dm " + id + " ");
      }
    }
    substr = before;
  } else if (before.rfind("/whois ", 0) == 0) {
    const std::string partial = before.substr(7);
    for (const auto& id : OnlineAgentIds()) {
      if (id.rfind(partial, 0) == 0) {
        hits.push_back("/whois " + id + " ");
      }
    }
    substr = before;
  } else if (std::regex_match(before, std::regex(R"(^/inv(?:\s|$))")) &&
             before.rfind("/invite", 0) != 0) {
    std::string partial = before;
    if (partial.rfind("/inv ", 0) == 0) {
      partial = partial.substr(5);
    } else if (partial == "/inv") {
      partial.clear();
    }
    for (const auto& id : RegisteredAgentIds()) {
      if (partial.empty() || id.rfind(partial, 0) == 0) {
        hits.push_back("/inv " + id + " ");
      }
    }
    if (partial.empty()) {
      hits.insert(hits.begin(), "/inv ");
    }
    substr = before;
  } else if (std::regex_match(before, std::regex(R"(^/avil(?:\s|$))", std::regex::icase))) {
    std::string partial = before;
    if (partial.size() > 6 && (partial[5] == ' ' || partial[5] == '\t')) {
      partial = partial.substr(6);
    } else {
      partial.clear();
    }
    for (const auto& name : AvilityNames()) {
      if (partial.empty() || name.rfind(partial, 0) == 0) {
        hits.push_back("/avil " + name + " ");
      }
    }
    if (partial.empty()) {
      hits.insert(hits.begin(), "/avil ");
    }
    substr = before;
  } else {
    static const std::regex chan_re(R"(^/(join|part|leave|msg)\s+#?(\S*)$)");
    std::smatch chan_match;
    if (std::regex_match(before, chan_match, chan_re)) {
      const std::string cmd = chan_match[1].str();
      const std::string partial = chan_match[2].str();
      for (const auto& chan : RoomNames()) {
        if (partial.empty() || chan.rfind(partial, 0) == 0) {
          hits.push_back("/" + cmd + " #" + chan + " ");
        }
      }
      substr = before;
    } else if (!before.empty() && before[0] == '/') {
      for (const char* cmd : kSlashCommands) {
        if (std::string(cmd).rfind(before, 0) == 0) {
          hits.emplace_back(cmd);
        }
      }
      substr = before;
    }
  }

  if (hits.empty()) {
    return out;
  }

  std::string replacement;
  if (hits.size() > 1) {
    out.hint_tokens = HintFromHits(hits);
    const std::string cp = CommonPrefix(hits);
    replacement = cp.size() >= substr.size() ? cp : substr;
  } else {
    replacement = hits.front();
  }

  const size_t pos = before.rfind(substr);
  if (pos == std::string::npos) {
    return out;
  }

  if (replacement == before.substr(pos, substr.size()) &&
      replacement.size() <= substr.size()) {
    return out;
  }

  out.line = before.substr(0, pos) + replacement + line.substr(safe_cursor);
  out.cursor = static_cast<int>(pos + replacement.size());
  out.modified = true;
  return out;
}

std::vector<HintToken> ChatCompleter::MentionPickerHint(
    const std::string& line, int cursor) const {
  const int safe_cursor = std::clamp(cursor, 0, static_cast<int>(line.size()));
  const std::string before = line.substr(0, static_cast<size_t>(safe_cursor));
  static const std::regex at_token(R"((^|\s)@$)");
  if (!std::regex_search(before, at_token)) {
    return {};
  }
  std::vector<std::string> ids;
  for (const auto& id : OnlineAgentIds()) {
    if (id != self_id_) {
      ids.push_back(id);
    }
  }
  if (ids.empty()) {
    return {};
  }
  return MentionListHint(ids);
}

}  // namespace gnd
