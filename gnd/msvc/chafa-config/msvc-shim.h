/* Forced include for chafa MSVC builds (see gnd/Directory.Build.props). */

#ifndef GND_CHAFA_MSVC_SHIM_H
#define GND_CHAFA_MSVC_SHIM_H

#ifdef _MSC_VER

#ifndef CHAFA_NO_SANITIZE_INTEGER
#define CHAFA_NO_SANITIZE_INTEGER
#endif

#include <intrin.h>
#include <stdbool.h>
#include <sys/stat.h>

#ifndef S_IRUSR
#define S_IRUSR _S_IREAD
#endif
#ifndef S_IWUSR
#define S_IWUSR _S_IWRITE
#endif

#ifndef strcasecmp
#define strcasecmp _stricmp
#endif

#endif /* _MSC_VER */

#endif /* GND_CHAFA_MSVC_SHIM_H */
