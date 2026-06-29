/* Pre-generated autotools config.h for MSVC builds (gnd/chafa submodule).
 * Source of truth: gnd/chafa/configure.ac (version + feature flags). */

#ifndef CHAFA_MSVC_CONFIG_H
#define CHAFA_MSVC_CONFIG_H

#define PACKAGE "chafa"
#define VERSION "1.19.0"
#define CHAFA_VERSION "1.19.0"

#define CHAFA_MAJOR_VERSION 1
#define CHAFA_MINOR_VERSION 19
#define CHAFA_MICRO_VERSION 0

#define HAVE_CONFIG_H 1

/* Image loaders (provided via vcpkg manifest in gnd/vcpkg.json). */
#define HAVE_AVIF 1
#define HAVE_HEIF 1
#define HAVE_JPEG 1
#define HAVE_SVG 1
#define HAVE_TIFF 1
#define HAVE_WEBP 1
#define HAVE_JXL 1

#define HAVE_WINDOWS_H 1

/* CPU feature detection (see chafa/chafa-features.c MSVC shims). */
#define HAVE_GCC_X86_FEATURE_BUILTINS 1
#define HAVE_MMX_INTRINSICS 1
#define HAVE_SSE41_INTRINSICS 1
#define HAVE_AVX2_INTRINSICS 1
#define HAVE_POPCNT_INTRINSICS 1
#define HAVE_POPCNT64_INTRINSICS 1
#define HAVE_POPCNT32_INTRINSICS 1

#ifdef _MSC_VER
#ifndef CHAFA_NO_SANITIZE_INTEGER
#define CHAFA_NO_SANITIZE_INTEGER
#endif
#endif

#endif /* CHAFA_MSVC_CONFIG_H */
