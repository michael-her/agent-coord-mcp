#include "chafa_element.hpp"

#include <chafa.h>

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>

#include <regex>

namespace gnd {
namespace {

std::optional<std::string> RenderPixelsSymbols(const unsigned char* pixels,
                                               int width, int height,
                                               int channels, int cols,
                                               int rows) {
  if (!pixels || width <= 0 || height <= 0) {
    return std::nullopt;
  }
  const int rowstride = width * channels;

  ChafaTermInfo* term_info =
      chafa_term_db_get_fallback_info(chafa_term_db_get_default());
  chafa_term_info_set_quirks(term_info, CHAFA_TERM_QUIRK_SIXEL_OVERSHOOT);

  ChafaCanvasConfig* config = chafa_canvas_config_new();
  chafa_canvas_config_set_geometry(config, cols, rows);
  chafa_canvas_config_set_canvas_mode(config, CHAFA_CANVAS_MODE_TRUECOLOR);
  chafa_canvas_config_set_pixel_mode(config, CHAFA_PIXEL_MODE_SYMBOLS);

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

  GString* gs = chafa_canvas_print(canvas, term_info);
  std::optional<std::string> result;
  if (gs && gs->str) {
    result = std::string(gs->str, gs->len);
  }

  if (gs) {
    g_string_free(gs, TRUE);
  }
  chafa_canvas_unref(canvas);
  chafa_canvas_config_unref(config);
  chafa_term_info_unref(term_info);
  return result;
}

}  // namespace

std::optional<std::string> RenderImageSymbols(const std::string& path, int cols,
                                              int rows) {
  int width = 0;
  int height = 0;
  int channels = 0;
  unsigned char* pixels = stbi_load(path.c_str(), &width, &height, &channels, 4);
  if (!pixels) {
    return std::nullopt;
  }
  auto out = RenderPixelsSymbols(pixels, width, height, 4, cols, rows);
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
