/*
 * Android.mk — Build script para compilar el JNI bridge del bootstrap.
 *
 * Uso con ndk-build:
 *   cd android/app/src/main/cpp
 *   $NDK/ndk-build NDK_PROJECT_PATH=. APP_BUILD_SCRIPT=Android.mk \
 *     NDK_LIBS_OUT=../jniLibs
 *
 * Uso con Gradle (recomendado):
 *   Agregar a android/app/build.gradle:
 *   externalNativeBuild { ndkBuild { path "src/main/cpp/Android.mk" } }
 *
 * NOTA: El archivo novaclaw-bootstrap.zip debe existir antes de compilar.
 * Se convierte a .o con ld -r -b binary como paso previo.
 * Ver scripts/build-bootstrap-so.sh para automatizar esto.
 */

LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)

LOCAL_MODULE    := novaclaw-bootstrap
LOCAL_SRC_FILES := novaclaw_bootstrap_jni.c
LOCAL_LDLIBS    := -llog

# El .o del ZIP se genera antes del build y se linkea aquí
# Si existe novaclaw_bootstrap_zip.o en este directorio, se incluye
ifneq ($(wildcard $(LOCAL_PATH)/novaclaw_bootstrap_zip.o),)
LOCAL_SRC_FILES += novaclaw_bootstrap_zip.o
endif

include $(BUILD_SHARED_LIBRARY)
