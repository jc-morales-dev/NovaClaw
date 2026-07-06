package com.novaclaw.app;

/**
 * NovaClawBootstrap — Carga el bootstrap ZIP embebido como librería nativa (.so).
 *
 * Ténica tomada de Termux: el archivo ZIP que contiene el root filesystem
 * mínimo (bash, coreutils, apt, etc.) se empaqueta como una shared library
 * nativa dentro del APK. Android garantiza que los .so se incluyen sin
 * compresión adicional, y se pueden leer como byte[] desde Java.
 *
 * El ZIP se almacena en:
 *   jniLibs/arm64-v8a/libnovaclaw-bootstrap.so
 *   jniLibs/armeabi-v7a/libnovaclaw-bootstrap.so
 *   jniLibs/x86_64/libnovaclaw-bootstrap.so
 *   jniLibs/x86/libnovaclaw-bootstrap.so
 *
 * Flujo:
 * 1. System.loadLibrary("novaclaw-bootstrap") carga el .so
 * 2. El constructor estático JNI llama a getZip() y cachea el byte[]
 * 3. RuntimeInstallerPlugin usa getZipBytes() para extraer el contenido
 */
public class NovaClawBootstrap {

    private static byte[] cachedZipBytes = null;
    private static boolean loadAttempted = false;
    private static String loadError = null;

    /**
     * Método nativo implementado en C que retorna el contenido del ZIP
     * embebido dentro del .so como un array de bytes.
     *
     * El código C simplemente expone los símbolos del .so como datos:
     * - _binary_novaclaw_bootstrap_zip_start
     * - _binary_novaclaw_bootstrap_zip_end
     */
    private static native byte[] getZip();

    /**
     * Carga la librería nativa y cachea el ZIP.
     * Se llama automáticamente la primera vez que se necesita el bootstrap.
     *
     * @return true si el ZIP se cargó correctamente, false si falló
     */
    public static synchronized boolean ensureLoaded() {
        if (cachedZipBytes != null) return true;
        if (loadAttempted) return false;

        loadAttempted = true;
        try {
            System.loadLibrary("novaclaw-bootstrap");
            cachedZipBytes = getZip();
            return cachedZipBytes != null && cachedZipBytes.length > 0;
        } catch (UnsatisfiedLinkError e) {
            // La librería no existe — probablemente un build de desarrollo
            // sin el bootstrap embebido. No es fatal, el instalador usará
            // el modo fallback (descarga o entorno mínimo).
            loadError = e.getMessage();
            return false;
        } catch (Exception e) {
            loadError = e.getMessage();
            return false;
        }
    }

    /**
     * Retorna los bytes del ZIP de bootstrap, o null si no está disponible.
     */
    public static byte[] getZipBytes() {
        if (!ensureLoaded()) return null;
        return cachedZipBytes;
    }

    /**
     * Retorna el error de carga si falló, o null si no se intentó o tuvo éxito.
     */
    public static String getLoadError() {
        return loadError;
    }

    /**
     * Retorna true si el bootstrap ZIP está disponible y cargado.
     */
    public static boolean isAvailable() {
        return cachedZipBytes != null && cachedZipBytes.length > 0;
    }
}
