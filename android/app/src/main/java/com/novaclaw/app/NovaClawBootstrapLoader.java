package com.novaclaw.app;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * NovaClawBootstrapLoader — Carga el bootstrap ZIP desde assets/ o JNI.
 *
 * Estrategia de carga (en orden de prioridad):
 * 1. JNI (.so embebido) — más rápido, no requiere assets separados
 * 2. Assets (novaclaw-bootstrap.zip) — fallback para builds de desarrollo
 * 3. null — sin bootstrap disponible (modo mínimo sin Termux)
 *
 * El ZIP contiene el root filesystem mínimo de Termux:
 * bash, coreutils, grep, sed, awk, tar, apt/pkg, etc.
 */
public class NovaClawBootstrapLoader {

    private static final String ASSET_BOOTSTRAP_ZIP = "novaclaw-bootstrap.zip";

    /**
     * Carga los bytes del bootstrap ZIP usando la primera fuente disponible.
     *
     * @param context Contexto de la aplicación para acceder a assets
     * @return bytes del ZIP, o null si no hay bootstrap disponible
     */
    public static byte[] loadBootstrapZip(Context context) {
        // Intento 1: JNI (.so embebido)
        if (NovaClawBootstrap.ensureLoaded()) {
            byte[] jniBytes = NovaClawBootstrap.getZipBytes();
            if (jniBytes != null && jniBytes.length > 0) {
                return jniBytes;
            }
        }

        // Intento 2: Assets
        byte[] assetBytes = loadFromAssets(context);
        if (assetBytes != null && assetBytes.length > 0) {
            return assetBytes;
        }

        // Intento 3: Sin bootstrap
        return null;
    }

    /**
     * Verifica si hay un bootstrap disponible (JNI o assets).
     */
    public static boolean isBootstrapAvailable(Context context) {
        // Check JNI
        if (NovaClawBootstrap.ensureLoaded() && NovaClawBootstrap.isAvailable()) {
            return true;
        }

        // Check assets
        try {
            String[] assets = context.getAssets().list("");
            if (assets != null) {
                for (String asset : assets) {
                    if (ASSET_BOOTSTRAP_ZIP.equals(asset)) {
                        return true;
                    }
                }
            }
        } catch (IOException ignored) {
        }

        return false;
    }

    /**
     * Lee el ZIP desde assets/ y retorna los bytes.
     */
    private static byte[] loadFromAssets(Context context) {
        AssetManager am = context.getAssets();
        InputStream is = null;
        try {
            is = am.open(ASSET_BOOTSTRAP_ZIP);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = is.read(buffer)) != -1) {
                bos.write(buffer, 0, read);
            }
            return bos.toByteArray();
        } catch (IOException e) {
            // Asset no existe — normal en builds sin bootstrap
            return null;
        } finally {
            if (is != null) {
                try { is.close(); } catch (IOException ignored) {}
            }
        }
    }
}
