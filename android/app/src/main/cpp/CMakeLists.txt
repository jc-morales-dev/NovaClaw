# CMakeLists.txt — JNI bridge para el bootstrap ZIP embebido.
#
# Compila novaclaw_bootstrap_jni.c y opcionalmente linkea el .o del ZIP.
#
# El .o del ZIP se genera con scripts/build-bootstrap-so.sh:
#   ld -r -b binary -o novaclaw_bootstrap_zip.o novaclaw-bootstrap.zip
#
# Si el .o no existe, el JNI bridge compila igualmente pero getZip()
# retornará NULL (el loader Java usará el modo assets como fallback).

cmake_minimum_required(VERSION 3.18.1)
project("novaclaw-bootstrap")

# Buscar el .o del ZIP (generado por build-bootstrap-so.sh)
set(BOOTSTRAP_ZIP_OBJ "${CMAKE_CURRENT_SOURCE_DIR}/novaclaw_bootstrap_zip.o")

if(EXISTS "${BOOTSTRAP_ZIP_OBJ}")
    message(STATUS "Bootstrap ZIP .o encontrado — linkeando en el .so")
    add_library(novaclaw-bootstrap SHARED
        novaclaw_bootstrap_jni.c
        "${BOOTSTRAP_ZIP_OBJ}"
    )
else()
    message(STATUS "Bootstrap ZIP .o NO encontrado — compilando stub JNI")
    message(STATUS "El ZIP se cargará desde assets/ en lugar de JNI.")
    message(STATUS "Para embeber el ZIP en el .so, corre: bash scripts/build-bootstrap-so.sh")

    # Compilar solo el JNI bridge — getZip() retornará NULL
    # El Java loader (NovaClawBootstrapLoader) maneja este caso.
    add_library(novaclaw-bootstrap SHARED
        novaclaw_bootstrap_jni.c
    )

    # Definir STUB_MODE para que el código C sepa que no hay ZIP embebido
    target_compile_definitions(novaclaw-bootstrap PRIVATE NO_BOOTSTRAP_ZIP=1)
endif()

# Incluir logs de Android
find_library(log-lib log)
target_link_libraries(novaclaw-bootstrap ${log-lib})
