#include "chafa_element.hpp"

#include <chafa.h>

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>

#include <cmath>
#include <regex>
#include <string>

namespace gnd {
namespace {

using namespace ftxui;

constexpr int kCellWidth = 8;
constexpr int kCellHeight = 16;
constexpr float kFontRatio =
    static_cast<float>(kCellWidth) / static_cast<float>(kCellHeight);

ChafaCanvas* BuildCanvas(const unsigned char* pixels, int width, int height,
                         int channels, int cols, int rows) {
  if (!pixels || width <= 0 || height <= 0 || cols <= 0 || rows <= 0) {
    return nullptr;
  }
  const int rowstride = width * channels;

  ChafaCanvasConfig* config = chafa_canvas_config_new();
  chafa_canvas_config_set_geometry(config, cols, rows);
  chafa_canvas_config_set_cell_geometry(config, kCellWidth, kCellHeight);
  chafa_canvas_config_set_canvas_mode(config, CHAFA_CANVAS_MODE_TRUECOLOR);
  chafa_canvas_config_set_pixel_mode(config, CHAFA_PIXEL_MODE_SYMBOLS);
  chafa_canvas_config_set_transparency_threshold(config, 0.1f);

  ChafaSymbolMap* symbol_map = chafa_symbol_map_new();
  chafa_symbol_map_add_by_tags(symbol_map, CHAFA_SYMBOL_TAG_BLOCK);
  chafa_canvas_config_set_symbol_map(config, symbol_map);
  chafa_canvas_config_set_bg_color(config, 0x000000);
  chafa_canvas_config_set_color_extractor(config, CHAFA_COLOR_EXTRACTOR_AVERAGE);
  chafa_canvas_config_set_work_factor(config, 1.0f);
  chafa_canvas_config_set_preprocessing_enabled(config, TRUE);
  chafa_canvas_config_set_dither_mode(config, CHAFA_DITHER_MODE_NONE);
  chafa_canvas_config_set_optimizations(config, CHAFA_OPTIMIZATION_NONE);

  ChafaCanvas* canvas = chafa_canvas_new(config);
  chafa_canvas_draw_all_pixels(canvas, CHAFA_PIXEL_RGBA8_PREMULTIPLIED, pixels,
                               width, height, rowstride);

  chafa_symbol_map_unref(symbol_map);
  chafa_canvas_config_unref(config);
  return canvas;
}

Color PackedRgb(int packed) {
  if (packed < 0) {
    return Color::Default;
  }
  return Color::RGB(static_cast<uint8_t>((packed >> 16) & 0xff),
                    static_cast<uint8_t>((packed >> 8) & 0xff),
                    static_cast<uint8_t>(packed & 0xff));
}

std::string GunicharToUtf8(gunichar ch) {
  gchar buf[8]{};
  const gint len = g_unichar_to_utf8(ch, buf);
  if (len <= 0) {
    return " ";
  }
  return std::string(buf, static_cast<size_t>(len));
}

Element CanvasToElement(ChafaCanvas* canvas) {
  if (!canvas) {
    return filler();
  }

  const ChafaCanvasConfig* config = chafa_canvas_peek_config(canvas);
  gint width = 0;
  gint height = 0;
  chafa_canvas_config_get_geometry(config, &width, &height);
  if (width <= 0 || height <= 0) {
    return filler();
  }

  Elements rows;
  for (gint y = 0; y < height; ++y) {
    Elements cells;
    for (gint x = 0; x < width; ++x) {
      const gunichar ch = chafa_canvas_get_char_at(canvas, x, y);
      gint fg = -1;
      gint bg = -1;
      chafa_canvas_get_raw_colors_at(canvas, x, y, &fg, &bg);

      if (ch == 0 || (ch == ' ' && fg < 0 && bg < 0)) {
        cells.push_back(text(" "));
        continue;
      }

      Element cell = text(GunicharToUtf8(ch));
      if (fg >= 0) {
        cell = cell | color(PackedRgb(fg));
      }
      if (bg >= 0) {
        cell = cell | bgcolor(PackedRgb(bg));
      }
      cells.push_back(std::move(cell));
    }
    rows.push_back(hbox(std::move(cells)));
  }
  return vbox(std::move(rows));
}

std::optional<std::string> RenderPixelsAnsi(const unsigned char* pixels,
                                            int width, int height,
                                            int channels, int cols,
                                            int rows) {
  ChafaCanvas* canvas =
      BuildCanvas(pixels, width, height, channels, cols, rows);
  if (!canvas) {
    return std::nullopt;
  }

  ChafaTermInfo* term_info =
      chafa_term_db_get_fallback_info(chafa_term_db_get_default());
  chafa_term_info_set_quirks(term_info, CHAFA_TERM_QUIRK_SIXEL_OVERSHOOT);

  GString* gs = chafa_canvas_print(canvas, term_info);
  std::optional<std::string> result;
  if (gs && gs->str) {
    result = std::string(gs->str, gs->len);
  }

  if (gs) {
    g_string_free(gs, TRUE);
  }
  chafa_canvas_unref(canvas);
  chafa_term_info_unref(term_info);
  return result;
}

std::optional<Element> RenderPixelsElement(const unsigned char* pixels,
                                           int width, int height,
                                           int channels, int cols, int rows) {
  ChafaCanvas* canvas =
      BuildCanvas(pixels, width, height, channels, cols, rows);
  if (!canvas) {
    return std::nullopt;
  }
  Element element = CanvasToElement(canvas);
  chafa_canvas_unref(canvas);
  return element;
}

}  // namespace

std::optional<std::string> RenderImageSymbols(const std::string& path, int cols,
                                              int rows) {
  int width = 0;
  int height = 0;
  int channels = 0;
  unsigned char* pixels =
      stbi_load(path.c_str(), &width, &height, &channels, 4);
  if (!pixels) {
    return std::nullopt;
  }
  auto out = RenderPixelsAnsi(pixels, width, height, 4, cols, rows);
  stbi_image_free(pixels);
  return out;
}

std::optional<Element> RenderImageElement(const std::string& path, int cols,
                                          int rows) {
  int width = 0;
  int height = 0;
  int channels = 0;
  unsigned char* pixels =
      stbi_load(path.c_str(), &width, &height, &channels, 4);
  if (!pixels) {
    return std::nullopt;
  }
  auto out = RenderPixelsElement(pixels, width, height, 4, cols, rows);
  stbi_image_free(pixels);
  return out;
}

std::optional<Element> RenderImageElementFitHeight(const std::string& path,
                                                   int target_rows) {
  int width = 0;
  int height = 0;
  int channels = 0;
  unsigned char* pixels =
      stbi_load(path.c_str(), &width, &height, &channels, 4);
  if (!pixels || width <= 0 || height <= 0) {
    stbi_image_free(pixels);
    return std::nullopt;
  }
  if (target_rows <= 0) {
    target_rows = height;
  }

  gint cols = -1;
  gint rows = target_rows;
  chafa_calc_canvas_geometry(width, height, &cols, &rows, kFontRatio, FALSE,
                             FALSE);
  if (rows <= 0) {
    stbi_image_free(pixels);
    return std::nullopt;
  }
  cols = static_cast<gint>(std::lround(
      static_cast<double>(width) * rows / static_cast<double>(height) *
      static_cast<double>(kCellHeight) / static_cast<double>(kCellWidth) * 2.0));
  if (cols <= 0) {
    stbi_image_free(pixels);
    return std::nullopt;
  }

  auto out = RenderPixelsElement(pixels, width, height, 4, cols, rows);
  stbi_image_free(pixels);
  return out;
}

std::optional<std::string> ExtractImagePath(const std::string& text) {
  static const std::regex img_cmd(R"(^\s*/img\s+(\S+)\s*$)");
  static const std::regex md_img(R"(!\[[^\]]*\]\(([^)]+)\))");
  std::smatch m;
  if (std::regex_search(text, m, img_cmd) && m.size() >= 2) {
    return m[1].str();
  }
  if (std::regex_search(text, m, md_img) && m.size() >= 2) {
    return m[1].str();
  }
  return std::nullopt;
}

}  // namespace gnd
