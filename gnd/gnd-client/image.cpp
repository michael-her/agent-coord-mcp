#include <iostream>
#include <chafa.h>

#define STB_IMAGE_IMPLEMENTATION
#include <stb_image.h>
#include <windows.h>

void enable_vte_processing() {
	HANDLE hOut = GetStdHandle(STD_OUTPUT_HANDLE);
	DWORD dwMode = 0;
	GetConsoleMode(hOut, &dwMode);
	dwMode |= ENABLE_VIRTUAL_TERMINAL_PROCESSING;
	SetConsoleMode(hOut, dwMode);
}

int drawImage()
{
	enable_vte_processing();

	// 이미지 로드
	int width, height, channels;
	// stb_image를 사용하여 "tankuku.png" 파일을 로드합니다.
	// 마지막 인자 4는 강제로 4채널(RGBA)로 로드하라는 의미입니다.
	unsigned char* pixels = stbi_load("icon_12.png", &width, &height, &channels, 4);
	if (!pixels)
	{
		// 이미지 로드 실패 시 에러 메시지를 출력하고 프로그램을 종료합니다.
		std::cerr << "Failed to load image: icon_12.png" << std::endl;
		return 1;
	}

	// 강제로 4채널(RGBA)로 로드했으므로 channels 변수 대신 4를 사용
	// rowstride는 이미지의 한 줄(row)이 차지하는 바이트 수입니다. (너비 * 채널 수)
	//channels = 4;
	int rowstride = width * channels;

	// 터미널 정보 설정
	// Chafa가 터미널의 특성을 파악하기 위한 객체를 생성합니다.
	ChafaTermInfo* term_info = chafa_term_db_get_fallback_info(chafa_term_db_get_default());
	//ChafaTermInfo* term_info = chafa_term_info_new();

	// 터미널 DB에서 현재 환경(또는 기본값)을 로드하도록 강제
	// 이 함수가 실행되면서 "아, 24비트 컬러 써도 되겠구나"라고 스스로 판단합니다.
	//chafa_term_info_load_from_db(term_info, CHAFA_TERM_DB_GET_DEFAULT, NULL);
	// 특정 터미널의 버그나 특성(Quirks)을 우회하기 위한 설정을 추가합니다.
	chafa_term_info_set_quirks(term_info, CHAFA_TERM_QUIRK_SIXEL_OVERSHOOT);

	// 캔버스 설정
	// 이미지를 그릴 캔버스의 설정 객체를 생성합니다.
	ChafaCanvasConfig* config = chafa_canvas_config_new();
	// 터미널 크기에 맞게 캔버스의 크기를 설정합니다. (예: 가로 40, 세로 20 문자)
	chafa_canvas_config_set_geometry(config, 40, 20);
	// 터미널 모드 설정 (256색)
	// 캔버스의 색상 모드를 트루컬러(24비트)로 설정합니다.
	chafa_canvas_config_set_canvas_mode(config, CHAFA_CANVAS_MODE_TRUECOLOR);
	// 픽셀을 표현할 방식을 기호(Symbols)로 설정합니다.
	chafa_canvas_config_set_pixel_mode(config, CHAFA_PIXEL_MODE_SYMBOLS);

	// 심볼 맵 설정 (기본값 사용)
	// 이미지를 문자로 변환할 때 사용할 문자(심볼)들의 집합을 생성합니다.
	ChafaSymbolMap* symbol_map = chafa_symbol_map_new();
	// 블록(Block) 형태의 유니코드 문자들을 심볼 맵에 추가합니다.
	chafa_symbol_map_add_by_tags(symbol_map, CHAFA_SYMBOL_TAG_BLOCK);
	// 설정된 심볼 맵을 캔버스 설정에 적용합니다.
	chafa_canvas_config_set_symbol_map(config, symbol_map);

	// 배경색 설정 (투명도 처리)
	// 투명한 픽셀의 배경색을 검은색(0x000000)으로 설정합니다.
	chafa_canvas_config_set_bg_color(config, 0x000000);

	// 색상 추출기 설정
	// 여러 픽셀을 하나의 문자로 압축할 때 색상을 평균내어(AVERAGE) 추출하도록 설정합니다.
	chafa_canvas_config_set_color_extractor(config, CHAFA_COLOR_EXTRACTOR_AVERAGE);

	// 워크 팩터 설정 (품질)
	// 이미지 변환 품질을 설정합니다. (1.0f는 기본 품질)
	chafa_canvas_config_set_work_factor(config, 1.0f);

	// 전처리 활성화
	// 이미지 변환 전 전처리 과정을 활성화하여 품질을 높입니다.
	chafa_canvas_config_set_preprocessing_enabled(config, TRUE);

	// 디더링 설정
	// 디더링(Dithering)을 사용하지 않도록 설정합니다.
	chafa_canvas_config_set_dither_mode(config, CHAFA_DITHER_MODE_NONE);

	// 최적화 설정
	// 추가적인 최적화를 수행하지 않도록 설정합니다.
	chafa_canvas_config_set_optimizations(config, CHAFA_OPTIMIZATION_NONE);

	// 캔버스 생성
	// 위에서 설정한 config를 바탕으로 실제 캔버스 객체를 생성합니다.
	ChafaCanvas* canvas = chafa_canvas_new(config);

	// 콘솔 출력 인코딩을 UTF-8로 설정 (Windows)
#ifdef _WIN32
	// Windows 콘솔에서 UTF-8 문자가 깨지지 않도록 코드 페이지를 65001로 변경합니다.
	// system("chcp 65001 > nul");
#endif

	// 픽셀 데이터 그리기 (RGBA 8bit)
	// 로드한 이미지 픽셀 데이터를 캔버스에 그립니다.
	chafa_canvas_draw_all_pixels(canvas,
		CHAFA_PIXEL_RGBA8_PREMULTIPLIED,
		pixels,
		width,
		height,
		rowstride);

	// 심볼 맵 메모리 해제
	// 캔버스 설정에 적용된 후에는 더 이상 필요 없으므로 메모리를 해제합니다.
	chafa_symbol_map_unref(symbol_map);

	// 출력 문자열 생성
	// 캔버스에 그려진 이미지를 터미널에 출력할 수 있는 문자열(GString) 형태로 변환합니다.
	GString* gs = chafa_canvas_print(canvas, term_info);

	// 콘솔에 출력
	// 변환된 문자열을 표준 출력(std::cout)을 통해 콘솔에 출력합니다.
	if (gs && gs->str) {
		std::cout << gs->str << std::endl;
	}

	// 메모리 해제
	// 사용이 끝난 GString 객체의 메모리를 해제합니다.
  // 내부적으로 NULL 체크를 한다.
	if (gs) {
		g_string_free(gs, TRUE);
	}
	// 캔버스 객체의 메모리를 해제합니다.
	chafa_canvas_unref(canvas);
	// 캔버스 설정 객체의 메모리를 해제합니다.
	chafa_canvas_config_unref(config);
	// 터미널 정보 객체의 메모리를 해제합니다.
	chafa_term_info_unref(term_info);
	// stb_image로 로드한 픽셀 데이터의 메모리를 해제합니다.
	stbi_image_free(pixels);

	return 0;
}
