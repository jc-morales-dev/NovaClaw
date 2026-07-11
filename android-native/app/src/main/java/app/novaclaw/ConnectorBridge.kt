package app.novaclaw

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONArray
import org.json.JSONObject

/**
 * Puente que la UI (WebView) usa para pedir permisos reales de Android desde la
 * pantalla de Ajustes → Conectores. Cada "conector" mapea a uno o varios
 * permisos; una vez concedidos, el agente accede a esa parte del teléfono.
 *
 * Se expone en el WebView como `window.NovaClawNative`.
 */
class ConnectorBridge(private val activity: Activity) {

    /** Ejecuta JS en el WebView (lo setea MainActivity). Para devolver el
     *  resultado de la huella al front por evento. */
    var evalJs: ((String) -> Unit)? = null

    companion object {
        const val REQUEST_CODE = 4711

        /** Conector -> permisos de Android que necesita. */
        private val CONNECTORS: Map<String, Array<String>> = mapOf(
            "files" to arrayOf(
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            ),
            "camera" to arrayOf(Manifest.permission.CAMERA),
            "location" to arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
            "contacts" to arrayOf(Manifest.permission.READ_CONTACTS),
            "calendar" to arrayOf(
                Manifest.permission.READ_CALENDAR,
                Manifest.permission.WRITE_CALENDAR,
            ),
        )
    }

    /** Devuelve, como JSON, si cada conector está concedido: {"files":true,...} */
    @JavascriptInterface
    fun getConnectors(): String {
        val json = JSONObject()
        for ((key, _) in CONNECTORS) {
            json.put(key, isGranted(key))
        }
        // Acceso total a archivos (Android 11+) va aparte: es una pantalla del sistema.
        json.put("allFiles", hasAllFilesAccess())
        return json.toString()
    }

    /** Pide el permiso del conector. Para "files" en Android 11+ abre la pantalla
     *  de "Acceso a todos los archivos"; el resto usa el diálogo normal. */
    @JavascriptInterface
    fun requestConnector(key: String) {
        activity.runOnUiThread {
            if (key == "allFiles") {
                openAllFilesAccess()
                return@runOnUiThread
            }
            val perms = CONNECTORS[key] ?: return@runOnUiThread
            ActivityCompat.requestPermissions(activity, perms, REQUEST_CODE)
        }
    }

    /** Guarda la API key CIFRADA del proveedor en el Android Keystore. */
    @JavascriptInterface
    fun saveApiKey(provider: String, key: String) {
        SecretStore.saveApiKey(activity, provider, key)
    }

    /** Devuelve la API key guardada del proveedor (para verla/editarla), o "". */
    @JavascriptInterface
    fun getApiKey(provider: String): String = SecretStore.getApiKey(activity, provider) ?: ""

    /** ¿Hay una API key guardada para ese proveedor? */
    @JavascriptInterface
    fun hasApiKey(provider: String): Boolean = SecretStore.hasApiKey(activity, provider)

    /** Borra la API key del proveedor. */
    @JavascriptInterface
    fun clearApiKey(provider: String) {
        SecretStore.clear(activity, provider)
    }

    /** JSON array de los proveedores que tienen key guardada. */
    @JavascriptInterface
    fun apiKeyProviders(): String =
        JSONArray(SecretStore.providersWithKeys(activity)).toString()

    // ── Secretos de MCP (tokens) ────────────────────────────────────────────
    // El VALOR nunca vuelve al WebView: solo se puede guardar, o consultar si
    // existe. El token real lo lee únicamente el agente Node por loopback
    // (NativeToolsServer /secret), no el front.

    /** Guarda (cifrado en el Keystore) el token de un servidor MCP. */
    @JavascriptInterface
    fun saveMcpSecret(id: String, value: String) {
        SecretStore.saveMcpSecret(activity, id, value)
    }

    /** ¿Hay un token guardado para ese MCP? (no devuelve el valor) */
    @JavascriptInterface
    fun hasMcpSecret(id: String): Boolean = SecretStore.hasMcpSecret(activity, id)

    /** Borra el token de un MCP. */
    @JavascriptInterface
    fun clearMcpSecret(id: String) {
        SecretStore.saveMcpSecret(activity, id, "")
    }

    /** JSON array de los ids de MCP con token guardado. */
    @JavascriptInterface
    fun mcpSecretIds(): String = JSONArray(SecretStore.mcpSecretIds(activity)).toString()

    // ── Confirmación por huella (BiometricPrompt) ───────────────────────────
    // Se usa al INSTALAR un MCP nuevo (corre código de terceros). El resultado
    // vuelve al front por el evento 'novaclaw-biometric-result' con {requestId, ok}.

    /** Dispara la huella/PIN. Si el equipo no tiene biometría, deja pasar (no
     *  bloquear a quien no tiene hardware), informándolo. */
    @JavascriptInterface
    fun confirmWithBiometric(requestId: String, title: String, subtitle: String) {
        activity.runOnUiThread {
            val fa = activity as? FragmentActivity
            val bm = BiometricManager.from(activity)
            val allowed = BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            val canAuth = bm.canAuthenticate(allowed) == BiometricManager.BIOMETRIC_SUCCESS
            if (fa == null || !canAuth) {
                dispatchBiometric(requestId, true, "sin-biometria")
                return@runOnUiThread
            }
            val prompt = BiometricPrompt(
                fa,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        dispatchBiometric(requestId, true, "ok")
                    }
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        dispatchBiometric(requestId, false, errString.toString())
                    }
                    // onAuthenticationFailed: un intento falló pero el prompt sigue; se ignora.
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title.ifBlank { "Confirmá con tu huella" })
                .setSubtitle(subtitle.ifBlank { "" })
                .setAllowedAuthenticators(allowed)
                .build()
            try {
                prompt.authenticate(info)
            } catch (e: Exception) {
                dispatchBiometric(requestId, false, e.message ?: "error de biometría")
            }
        }
    }

    private fun dispatchBiometric(requestId: String, ok: Boolean, detail: String) {
        val payload = JSONObject().put("requestId", requestId).put("ok", ok).put("detail", detail)
        val js = "window.dispatchEvent(new CustomEvent('novaclaw-biometric-result'," +
            "{detail:$payload}));"
        activity.runOnUiThread { evalJs?.invoke(js) }
    }

    /** Abre los ajustes de la app para revocar permisos (Android no deja hacerlo por API). */
    @JavascriptInterface
    fun openAppSettings() {
        activity.runOnUiThread {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", activity.packageName, null)
            }
            activity.startActivity(intent)
        }
    }

    private fun isGranted(key: String): Boolean {
        val perms = CONNECTORS[key] ?: return false
        // Con acceso total a archivos, "files" cuenta como concedido igual.
        if (key == "files" && hasAllFilesAccess()) return true
        return perms.all {
            ContextCompat.checkSelfPermission(activity, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasAllFilesAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            true // En Android 10 y menos, el permiso legacy ya da acceso amplio.
        }
    }

    private fun openAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.fromParts("package", activity.packageName, null)
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
        }
    }
}
