package com.novaclaw.app.plugins

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * SecureKeyPlugin — Gestiona la ZEN_API_KEY en Android Keystore.
 *
 * Flujo:
 *  1) En el primer arranque, la app lee el blob ofuscado embebido en assets
 *     (generado por scripts/embedKey.mjs) y lo decodifica en memoria.
 *  2) Inmediatamente lo re-encripta con una clave AES generada en el
 *     Android Keystore (hardware-backed si el dispositivo lo soporta).
 *  3) Guarda el blob encriptado en SharedPreferences.
 *  4) En arranques posteriores, solo se desencripta cuando el plugin
 *     de Agent lo necesita para llamar al endpoint Zen.
 *
 * IMPORTANTE: idealmente, el frontend JS NUNCA recibe la key en claro.
 * El plugin Agent debería hacer la llamada HTTP a Zen directamente desde
 * Kotlin y devolver solo el contenido de la respuesta al WebView.
 */
@CapacitorPlugin(name = "SecureKey")
class SecureKeyPlugin : Plugin() {

    companion object {
        private const val KEYSTORE_ALIAS = "novaclaw.zenkey.v1"
        private const val PREF_NAME = "novaclaw.secure"
        private const val PREF_KEY_ENCRYPTED = "zen_encrypted"
        private const val PREF_KEY_IV = "zen_iv"
    }

    @PluginMethod
    fun store(call: PluginCall) {
        val plaintext = call.getString("value")
        if (plaintext.isNullOrBlank()) {
            call.reject("value is required")
            return
        }
        try {
            val secretKey = getOrCreateSecretKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            val iv = cipher.iv
            val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

            val prefs = context.getSharedPreferences(PREF_NAME, 0)
            prefs.edit()
                .putString(PREF_KEY_ENCRYPTED, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(PREF_KEY_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                .apply()
            call.resolve(JSObject().apply { put("success", true) })
        } catch (e: Exception) {
            call.reject("Failed to store key: ${e.message}", e)
        }
    }

    @PluginMethod
    fun has(call: PluginCall) {
        val prefs = context.getSharedPreferences(PREF_NAME, 0)
        val present = prefs.contains(PREF_KEY_ENCRYPTED) && prefs.contains(PREF_KEY_IV)
        call.resolve(JSObject().apply { put("has", present) })
    }

    /**
     * NOTE: This method intentionally is NOT exposed to JS in production builds.
     * The Agent plugin should call getInternal() directly from Kotlin.
     * It is kept here for diagnostic builds only. Remove for release.
     */
    @PluginMethod
    fun getForDebug(call: PluginCall) {
        try {
            val value = getInternal()
            call.resolve(JSObject().apply { put("value", value) })
        } catch (e: Exception) {
            call.reject("Failed to get key: ${e.message}", e)
        }
    }

    fun getInternal(): String {
        val prefs = context.getSharedPreferences(PREF_NAME, 0)
        val encryptedB64 = prefs.getString(PREF_KEY_ENCRYPTED, null) ?: return ""
        val ivB64 = prefs.getString(PREF_KEY_IV, null) ?: return ""

        val encrypted = Base64.decode(encryptedB64, Base64.NO_WRAP)
        val iv = Base64.decode(ivB64, Base64.NO_WRAP)

        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val secretKey = keyStore.getKey(KEYSTORE_ALIAS, null) as SecretKey

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(128, iv))
        val decrypted = cipher.doFinal(encrypted)
        return String(decrypted, Charsets.UTF_8)
    }

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = keyStore.getKey(KEYSTORE_ALIAS, null)
        if (existing != null) return existing as SecretKey

        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        kg.init(spec)
        return kg.generateKey()
    }
}