package app.novaclaw

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Guarda la API key del usuario CIFRADA con el Android Keystore (AES-256/GCM,
 * clave respaldada por hardware que nunca sale del TEE). El texto cifrado se
 * guarda en SharedPreferences; sin la clave del Keystore no se puede descifrar.
 *
 * Reemplaza el guardado en texto plano de novaclaw.config.json. RuntimeManager
 * descifra la key al arrancar y se la pasa al agente por env (en memoria), así
 * el disco nunca tiene la key legible.
 */
object SecretStore {
    private const val PREFS = "novaclaw_secure"
    private const val PREF_KEY = "api_key_enc"
    private const val KS_ALIAS = "novaclaw_api_key"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_LEN = 12
    private const val TAG_BITS = 128

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(KS_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                KS_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    /** Cifra y guarda la API key. Vacío = borra. */
    fun saveApiKey(context: Context, apiKey: String) {
        if (apiKey.isBlank()) { clear(context); return }
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val iv = cipher.iv
            val ct = cipher.doFinal(apiKey.toByteArray(Charsets.UTF_8))
            val blob = ByteArray(iv.size + ct.size)
            System.arraycopy(iv, 0, blob, 0, iv.size)
            System.arraycopy(ct, 0, blob, iv.size, ct.size)
            prefs(context).edit()
                .putString(PREF_KEY, Base64.encodeToString(blob, Base64.NO_WRAP))
                .apply()
        } catch (e: Exception) {
            android.util.Log.e("NovaClaw/Secret", "No se pudo cifrar la key: ${e.message}")
        }
    }

    /** Descifra y devuelve la API key, o null si no hay o falla. */
    fun getApiKey(context: Context): String? {
        val b64 = prefs(context).getString(PREF_KEY, null) ?: return null
        return try {
            val blob = Base64.decode(b64, Base64.NO_WRAP)
            if (blob.size <= IV_LEN) return null
            val iv = blob.copyOfRange(0, IV_LEN)
            val ct = blob.copyOfRange(IV_LEN, blob.size)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (e: Exception) {
            android.util.Log.e("NovaClaw/Secret", "No se pudo descifrar la key: ${e.message}")
            null
        }
    }

    fun hasApiKey(context: Context): Boolean =
        !prefs(context).getString(PREF_KEY, null).isNullOrBlank()

    fun clear(context: Context) {
        prefs(context).edit().remove(PREF_KEY).apply()
    }
}
