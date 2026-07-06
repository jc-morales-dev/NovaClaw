/*
 * novaclaw_bootstrap_jni.c — JNI bridge para exponer el bootstrap ZIP
 * embebido dentro del .so como un array de bytes Java.
 *
 * Compilación:
 *   - Con CMake (recomendado): integrado en el build de Gradle
 *   - Con ndk-build: ndk-build NDK_PROJECT_PATH=. APP_BUILD_SCRIPT=Android.mk
 *
 * Modos:
 *   1. ZIP embebido: El .o del ZIP se genera con:
 *      ld -r -b binary -o novaclaw_bootstrap_zip.o novaclaw-bootstrap.zip
 *      Esto crea los símbolos _binary_novaclaw_bootstrap_zip_start/end/size.
 *
 *   2. Stub (sin ZIP): Si no existe el .o, se compila con -DNO_BOOTSTRAP_ZIP=1.
 *      getZip() retorna NULL y el Java loader usa assets/ como fallback.
 */

#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <android/log.h>

#define TAG "NovaClawJNI"

#ifndef NO_BOOTSTRAP_ZIP
/* Símbolos generados por ld -r -b binary */
extern const char _binary_novaclaw_bootstrap_zip_start[];
extern const char _binary_novaclaw_bootstrap_zip_end[];
extern const size_t _binary_novaclaw_bootstrap_zip_size;
#endif

/**
 * Java_com_novaclaw_app_NovaClawBootstrap_getZip
 *
 * Retorna el contenido del ZIP embebido como un nuevo byte[] Java.
 * El array es una copia, así que el GC de Java puede liberarlo
 * independientemente del .so.
 *
 * Retorna NULL si:
 * - No hay ZIP embebido (modo stub)
 * - El ZIP tiene tamaño 0
 * - Falla la asignación de memoria
 */
JNIEXPORT jbyteArray JNICALL
Java_com_novaclaw_app_NovaClawBootstrap_getZip(JNIEnv *env, jclass cls)
{
    (void)cls; /* unused */

#ifdef NO_BOOTSTRAP_ZIP
    __android_log_print(ANDROID_LOG_INFO, TAG,
        "getZip() called in stub mode — no ZIP embedded, using assets fallback");
    return NULL;
#else
    const size_t size = (size_t)_binary_novaclaw_bootstrap_zip_size;
    const char *data = _binary_novaclaw_bootstrap_zip_start;

    if (size == 0 || data == NULL) {
        __android_log_print(ANDROID_LOG_WARN, TAG,
            "getZip() — embedded ZIP is empty or NULL (size=%zu)", size);
        return NULL;
    }

    __android_log_print(ANDROID_LOG_INFO, TAG,
        "getZip() — returning embedded ZIP (%zu bytes)", size);

    jbyteArray result = (*env)->NewByteArray(env, (jsize)size);
    if (result == NULL) {
        __android_log_print(ANDROID_LOG_ERROR, TAG,
            "getZip() — NewByteArray failed (OOM?)");
        return NULL;
    }

    (*env)->SetByteArrayRegion(env, result, 0, (jsize)size, (const jbyte *)data);
    return result;
#endif
}
