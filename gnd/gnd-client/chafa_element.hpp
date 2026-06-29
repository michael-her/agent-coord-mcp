#pragma once

#include <optional>
#include <string>

namespace gnd {

// Render image file to Chafa SYMBOLS ANSI string for FTXUI text().
std::optional<std::string> RenderImageSymbols(const std::string& path, int cols,
                                              int rows);

// Extract image path from /img <path> or markdown ![alt](path).
std::optional<std::string> ExtractImagePath(const std::string& text);

}  // namespace gnd
