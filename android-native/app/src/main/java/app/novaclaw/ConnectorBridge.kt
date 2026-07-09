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
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Puente que la UI (WebView) usa para pedir permisos reales de Android desde la
 * pantalla de Ajustes → Conectores. Cada "conector" mapea a uno o varios
 * permisos; una vez concedidos, el agente accede a esa parte del teléfono.
 *
 * Se expone en el WebView como `window.NovaClawNative`.
 */
class ConnectorBridge(private val activity: Activity) {

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

    /** Guarda la API key CIFRADA en el Android Keystore (reemplaza el texto plano). */
    @JavascriptInterface
    fun saveApiKey(key: String) {
        SecretStore.saveApiKey(activity, key)
    }

    /** ¿Hay una API key guardada (cifrada) en el Keystore? */
    @JavascriptInterface
    fun hasApiKey(): Boolean = SecretStore.hasApiKey(activity)

    /** Borra la API key cifrada. */
    @JavascriptInterface
    fun clearApiKey() {
        SecretStore.clear(activity)
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
