#include "coord_admin.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>

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

std::string SanitizeId(const std::string& id) {
  std::string out;
  out.reserve(id.size());
  for (char c : id) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-') {
      out.push_back(c);
    } else {
      out.push_back('_');
    }
  }
  return out;
}

std::filesystem::path IpcManifestPath(const std::filesystem::path& coord_dir,
                                      const std::string& agent_id) {
  return coord_dir / "ipc" / (SanitizeId(agent_id) + ".json");
}

std::filesystem::path FindCoordChatScript(
    const std::filesystem::path& repo_root) {
  return repo_root / "scripts" / "coord-chat.mjs";
}

#ifdef _WIN32
std::string FindNodeExecutable() {
  char path[MAX_PATH];
  const DWORD found =
      SearchPathA(nullptr, "node.exe", nullptr, MAX_PATH, path, nullptr);
  if (found == 0 || found >= MAX_PATH) {
    return {};
  }
  return path;
}

bool PidAlive(DWORD pid) {
  if (pid == 0) {
    return false;
  }
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) {
    return false;
  }
  DWORD code = 0;
  const BOOL ok = GetExitCodeProcess(proc, &code);
  CloseHandle(proc);
  return ok && code == STILL_ACTIVE;
}

bool ReadManifestPipe(const std::filesystem::path& manifest,
                      std::string& pipe_out) {
  if (!std::filesystem::exists(manifest)) {
    return false;
  }
  try {
    std::ifstream in(manifest);
    nlohmann::json j;
    in >> j;
    if (!j.contains("pid") || !j.contains("pipe")) {
      return false;
    }
    const DWORD pid = j["pid"].get<DWORD>();
    if (!PidAlive(pid)) {
      return false;
    }
    pipe_out = j["pipe"].get<std::string>();
    return !pipe_out.empty();
  } catch (...) {
    return false;
  }
}

bool WriteAll(HANDLE pipe, const std::string& data) {
  const char* ptr = data.data();
  size_t remaining = data.size();
  while (remaining > 0) {
    DWORD written = 0;
    const DWORD chunk =
        remaining > static_cast<size_t>(MAXDWORD) ? MAXDWORD
                                                    : static_cast<DWORD>(remaining);
    if (!WriteFile(pipe, ptr, chunk, &written, nullptr) || written == 0) {
      return false;
    }
    ptr += written;
    remaining -= written;
  }
  return true;
}

bool ReadLine(HANDLE pipe, std::string& out) {
  out.clear();
  char ch = 0;
  DWORD read = 0;
  while (ReadFile(pipe, &ch, 1, &read, nullptr) && read == 1) {
    if (ch == '\n') {
      return true;
    }
    if (ch != '\r') {
      out.push_back(ch);
    }
  }
  return !out.empty();
}

HANDLE ConnectPipe(const std::string& pipe_name) {
  for (int i = 0; i < 50; ++i) {
    HANDLE h = CreateFileA(pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                           nullptr, OPEN_EXISTING, 0, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
      DWORD mode = PIPE_READMODE_BYTE;
      SetNamedPipeHandleState(h, &mode, nullptr, nullptr);
      return h;
    }
    const DWORD err = GetLastError();
    if (err != ERROR_PIPE_BUSY && err != ERROR_FILE_NOT_FOUND) {
      return INVALID_HANDLE_VALUE;
    }
    WaitNamedPipeA(pipe_name.c_str(), 200);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  return INVALID_HANDLE_VALUE;
}

bool SpawnBackendProcess(const std::filesystem::path& repo_root,
                         const std::filesystem::path& coord_dir,
                         const std::string& agent_id) {
  const auto script = FindCoordChatScript(repo_root);
  if (!std::filesystem::exists(script)) {
    return false;
  }
  const std::string node_exe = FindNodeExecutable();
  if (node_exe.empty()) {
    return false;
  }

  std::ostringstream cmd;
  cmd << QuoteArg(node_exe) << ' ' << QuoteArg(script.string());
  cmd << " --backend";
  cmd << " --dir " << QuoteArg(coord_dir.string());
  cmd << " --id " << QuoteArg(agent_id);

  STARTUPINFOA si{};
  si.cb = sizeof(STARTUPINFOA);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;

  PROCESS_INFORMATION pi{};
  std::string cmdline = cmd.str();
  std::vector<char> mutable_cmd(cmdline.begin(), cmdline.end());
  mutable_cmd.push_back('\0');

  const BOOL ok = CreateProcessA(node_exe.c_str(), mutable_cmd.data(), nullptr,
                                 nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                                 repo_root.string().c_str(), &si, &pi);
  if (!ok) {
    return false;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

struct BackendState {
  bool we_spawned = false;
  std::filesystem::path coord_dir;
  std::string agent_id;
};

BackendState g_backend;
#endif

std::string AdminArgsToLine(const std::vector<std::string>& args) {
  if (args.empty()) {
    return {};
  }
  std::ostringstream line;
  line << '/' << args.front();
  for (size_t i = 1; i < args.size(); ++i) {
    line << ' ' << args[i];
  }
  return line.str();
}

#ifdef _WIN32
std::vector<std::string> IpcRequest(const std::string& pipe_name,
                                    const nlohmann::json& req) {
  HANDLE pipe = ConnectPipe(pipe_name);
  if (pipe == INVALID_HANDLE_VALUE) {
    return {"failed to connect to coord-chat backend (is it running?)"};
  }

  const std::string payload = req.dump() + "\n";
  if (!WriteAll(pipe, payload)) {
    CloseHandle(pipe);
    return {"failed to write to coord-chat backend"};
  }

  std::string response_line;
  if (!ReadLine(pipe, response_line)) {
    CloseHandle(pipe);
    return {"coord-chat backend closed unexpectedly"};
  }
  CloseHandle(pipe);

  try {
    const auto j = nlohmann::json::parse(response_line);
    if (j.value("ok", false)) {
      std::vector<std::string> lines;
      if (j.contains("lines") && j["lines"].is_array()) {
        for (const auto& item : j["lines"]) {
          lines.push_back(item.get<std::string>());
        }
      }
      if (lines.empty()) {
        lines.push_back("(no output)");
      }
      return lines;
    }
    return {j.value("error", "coord-chat backend error")};
  } catch (const std::exception& e) {
    return {std::string("invalid backend response: ") + e.what()};
  }
}
#endif

}  // namespace

bool StartCoordChatBackend(const std::filesystem::path& repo_root,
                           const std::filesystem::path& coord_dir,
                           const std::string& agent_id) {
#ifdef _WIN32
  const auto manifest = IpcManifestPath(coord_dir, agent_id);

  // Always restart backend so /invite uses current hook spawn code (stack mode).
  DWORD old_backend_pid = 0;
  if (std::filesystem::exists(manifest)) {
    try {
      std::ifstream in(manifest);
      nlohmann::json j;
      in >> j;
      if (j.contains("pid")) {
        old_backend_pid = j["pid"].get<DWORD>();
      }
    } catch (...) {
    }
  }
  std::string pipe;
  if (ReadManifestPipe(manifest, pipe)) {
    nlohmann::json req{{"cmd", "shutdown"}};
    (void)IpcRequest(pipe, req);
    for (int i = 0; i < 50; ++i) {
      if (old_backend_pid == 0 || !PidAlive(old_backend_pid)) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }

  if (!SpawnBackendProcess(repo_root, coord_dir, agent_id)) {
    return false;
  }
  g_backend.we_spawned = true;
  g_backend.coord_dir = coord_dir;
  g_backend.agent_id = agent_id;

  for (int i = 0; i < 100; ++i) {
    if (ReadManifestPipe(manifest, pipe)) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  return false;
#else
  (void)repo_root;
  (void)coord_dir;
  (void)agent_id;
  return false;
#endif
}

void StopCoordChatBackend() {
#ifdef _WIN32
  if (g_backend.coord_dir.empty() || g_backend.agent_id.empty()) {
    return;
  }
  const auto manifest =
      IpcManifestPath(g_backend.coord_dir, g_backend.agent_id);
  std::string pipe;
  if (ReadManifestPipe(manifest, pipe)) {
    nlohmann::json req{{"cmd", "shutdown"}};
    (void)IpcRequest(pipe, req);
  }
  g_backend = {};
#else
  (void)0;
#endif
}

std::vector<std::string> RunCoordAdmin(
    const std::filesystem::path& repo_root,
    const std::filesystem::path& coord_dir,
    const std::string& agent_id,
    const std::vector<std::string>& args) {
  if (args.empty()) {
    return {"usage: missing admin command"};
  }

#ifdef _WIN32
  const auto manifest = IpcManifestPath(coord_dir, agent_id);
  std::string pipe;
  if (!ReadManifestPipe(manifest, pipe)) {
    if (!StartCoordChatBackend(repo_root, coord_dir, agent_id)) {
      return {"failed to start coord-chat backend"};
    }
    if (!ReadManifestPipe(manifest, pipe)) {
      return {"coord-chat backend started but ipc manifest missing"};
    }
  }

  nlohmann::json req{{"line", AdminArgsToLine(args)}};
  return IpcRequest(pipe, req);
#else
  (void)repo_root;
  (void)coord_dir;
  (void)agent_id;
  return {"coord-chat backend IPC is Windows-only for now"};
#endif
}

}  // namespace gnd
