#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace gnd {

enum class MessageKind { Room, Dm, System, Dice };

struct ChatMessage {
  MessageKind kind = MessageKind::Room;
  std::string id;
  int64_t ts = 0;
  std::string from;
  std::string to;
  std::string room;
  std::string text;
  std::string model;
  bool history = false;
  std::string image_ansi;  // optional Chafa SYMBOLS output
};

}  // namespace gnd
