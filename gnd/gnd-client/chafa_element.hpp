#pragma once

#include <ftxui/dom/elements.hpp>

#include <optional>
#include <string>

namespace gnd {

// Render image file to Chafa SYMBOLS ANSI string (legacy; FTXUI cannot display).
std::optional<std::string> RenderImageSymbols(const std::string& path, int cols,
                                              int rows);

// Render image file to an FTXUI element via Chafa canvas cells.
std::optional<ftxui::Element> RenderImageElement(const std::string& path,
                                                 int cols, int rows);

// Render image scaled to fit target_rows height (aspect ratio preserved).
// brightness: 1.0 = original, 0.5 = half brightness.
// bg_only: emit spaces with bgcolor only (for dbox overlays; keeps image in bg).
std::optional<ftxui::Element> RenderImageElementFitHeight(const std::string& path,
                                                          int target_rows,
                                                          float brightness = 1.0f,
                                                          bool bg_only = false);

// Extract image path from /img <path> or markdown ![alt](path).
std::optional<std::string> ExtractImagePath(const std::string& text);

}  // namespace gnd
