package app.novaclaw

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Guarda las API keys del usuario CIFRADAS con el Android Keystore (AES-256/GCM,
 * clave respaldada por hardware que nunca sale del TEE).
 *
 * Modelo: UNA key POR PROVEEDOR. Se guarda un mapa {provider: key} como un solo
 * blob cifrado. Así el usuario puede tener la de OpenCode, la de OpenRouter, etc.,
 * todas a la vez, y al cambiar de proveedor se usa la que corresponde.
 */
object SecretStore {
    private const val PREFS = "novaclaw_secure"
    private const val PREF_MAP = "api_keys_enc"     // mapa {provider: key} cifrado
    private const val PREF_LEGACY = "api_key_enc"   // key única vieja (para migrar)
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

    private fun encrypt(plain: String): String? = try {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val blob = ByteArray(iv.size + ct.size)
        System.arraycopy(iv, 0, blob, 0, iv.size)
        System.arraycopy(ct, 0, blob, iv.size, ct.size)
        Base64.encodeToString(blob, Base64.NO_WRAP)
    } catch (e: Exception) {
        android.util.Log.e("NovaClaw/Secret", "No se pudo cifrar: ${e.message}"); null
    }

    private fun decrypt(b64: String): String? = try {
        val blob = Base64.decode(b64, Base64.NO_WRAP)
        if (blob.size <= IV_LEN) null else {
            val iv = blob.copyOfRange(0, IV_LEN)
            val ct = blob.copyOfRange(IV_LEN, blob.size)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        }
    } catch (e: Exception) {
        android.util.Log.e("NovaClaw/Secret", "No se pudo descifrar: ${e.message}"); null
    }

    private fun loadMap(context: Context): JSONObject {
        val b64 = prefs(context).getString(PREF_MAP, null) ?: return JSONObject()
        val dec = decrypt(b64) ?: return JSONObject()
        return try { JSONObject(dec) } catch (_: Exception) { JSONObject() }
    }

    private fun storeMap(context: Context, map: JSONObject) {
        val enc = encrypt(map.toString()) ?: return
        prefs(context).edit().putString(PREF_MAP, enc).apply()
    }

    /** Guarda (o borra si vacío) la key de un proveedor. */
    fun saveApiKey(context: Context, provider: String, key: String) {
        val map = loadMap(context)
        if (key.isBlank()) map.remove(provider) else map.put(provider, key)
        storeMap(context, map)
    }

    /** Devuelve la key del proveedor, o null si no hay. */
    fun getApiKey(context: Context, provider: String): String? {
        val v = loadMap(context).optString(provider, "")
        return v.ifBlank { null }
    }

    fun hasApiKey(context: Context, provider: String): Boolean =
        !getApiKey(context, provider).isNullOrBlank()

    fun clear(context: Context, provider: String) {
        val map = loadMap(context)
        map.remove(provider)
        storeMap(context, map)
    }

    /** Lista de proveedores que tienen una key guardada. */
    fun providersWithKeys(context: Context): List<String> =
        loadMap(context).keys().asSequence().toList()

    // ── Secretos de MCP (tokens de servidores) ──────────────────────────────
    // Mismo cifrado AES-256/GCM, en un mapa aparte {mcpId: token}. El agente los
    // pide por loopback (NativeToolsServer /secret) al conectar un MCP; el archivo
    // de config solo guarda el placeholder ${SECRET:<id>}, nunca el token.
    private const val PREF_MCP_MAP = "mcp_secrets_enc"

    private fun loadMcpMap(context: Context): JSONObject {
        val b64 = prefs(context).getString(PREF_MCP_MAP, null) ?: return JSONObject()
        val dec = decrypt(b64) ?: return JSONObject()
        return try { JSONObject(dec) } catch (_: Exception) { JSONObject() }
    }

    private fun storeMcpMap(context: Context, map: JSONObject) {
        val enc = encrypt(map.toString()) ?: return
        prefs(context).edit().putString(PREF_MCP_MAP, enc).apply()
    }

    /** Guarda (o borra si vacío) el secreto de un MCP por id. */
    fun saveMcpSecret(context: Context, id: String, value: String) {
        val map = loadMcpMap(context)
        if (value.isBlank()) map.remove(id) else map.put(id, value)
        storeMcpMap(context, map)
    }

    /** Devuelve el secreto de un MCP por id, o null si no hay. */
    fun getMcpSecret(context: Context, id: String): String? {
        val v = loadMcpMap(context).optString(id, "")
        return v.ifBlank { null }
    }

    fun hasMcpSecret(context: Context, id: String): Boolean =
        !getMcpSecret(context, id).isNullOrBlank()

    /** Ids de MCP que tienen un secreto guardado. */
    fun mcpSecretIds(context: Context): List<String> =
        loadMcpMap(context).keys().asSequence().toList()

    /**
     * Migra la key ÚNICA vieja (esquema previo) al mapa, bajo `provider`. Idempotente.
     * Devuelve la key migrada o null si no había.
     */
    fun migrateLegacy(context: Context, provider: String): String? {
        val b64 = prefs(context).getString(PREF_LEGACY, null) ?: return null
        val key = decrypt(b64)
        prefs(context).edit().remove(PREF_LEGACY).apply()
        if (!key.isNullOrBlank()) {
            if (getApiKey(context, provider).isNullOrBlank()) saveApiKey(context, provider, key)
            return key
        }
        return null
    }
}
