package app.novaclaw

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Historial de APKs instaladas/desinstaladas del teléfono.
 *
 * Android no ofrece un "log de desinstalaciones" a las apps normales, así que se
 * arma con dos fuentes que se complementan:
 *   1. Broadcast ACTION_PACKAGE_FULLY_REMOVED (PackageRemovedReceiver): llega en
 *      el momento exacto de la desinstalación, incluso con la app cerrada (es de
 *      los pocos broadcasts implícitos permitidos en manifest desde Android 8).
 *   2. Diff de snapshots: cada consulta compara la lista instalada AHORA contra
 *      el último snapshot guardado; si un paquete desapareció y el broadcast se
 *      perdió (ColorOS matando procesos, reinicio…), igual queda registrado con
 *      una fecha aproximada.
 *
 * Todo persiste en SharedPreferences privadas: nada sale del teléfono.
 */
object PackageTracker {
    private const val PREFS = "novaclaw_packages"
    private const val KEY_REMOVED = "removed_history"     // JSONArray de {package,label?,at,approx?}
    private const val KEY_SNAPSHOT = "installed_snapshot" // JSONObject {package: label}
    private const val KEY_SNAPSHOT_AT = "snapshot_at"
    private const val MAX_HISTORY = 300
    private const val TAG = "NovaClaw/Pkg"

    private fun prefs(c: Context) =
        c.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ── Registro de desinstalaciones ─────────────────────────────────────────

    /** Registra una desinstalación (del broadcast o del diff de snapshots). */
    @Synchronized
    fun recordRemoval(context: Context, pkg: String, approxSince: Long? = null) {
        if (pkg.isBlank()) return
        val arr = loadRemoved(context)
        // Dedupe: si la última entrada del mismo paquete es de hace <10s (broadcast
        // duplicado o diff que pisa al broadcast), no se repite.
        for (i in arr.length() - 1 downTo 0) {
            val e = arr.optJSONObject(i) ?: continue
            if (e.optString("package") == pkg &&
                System.currentTimeMillis() - e.optLong("at") < 10_000) return
        }
        val label = loadSnapshot(context)?.optString(pkg).orEmpty()
        val entry = JSONObject()
            .put("package", pkg)
            .put("at", System.currentTimeMillis())
        if (label.isNotBlank()) entry.put("label", label)
        // approx=true: no vimos el broadcast; solo sabemos que ocurrió después
        // del snapshot anterior (approxSince).
        if (approxSince != null) entry.put("approx", true).put("since", approxSince)
        arr.put(entry)
        // Cap del historial: se quedan las MAX_HISTORY más recientes.
        val trimmed = JSONArray()
        val start = maxOf(0, arr.length() - MAX_HISTORY)
        for (i in start until arr.length()) trimmed.put(arr.get(i))
        prefs(context).edit().putString(KEY_REMOVED, trimmed.toString()).apply()
        Log.i(TAG, "removal recorded: $pkg")
    }

    /** Historial de desinstalaciones, la más reciente primero. */
    fun removedHistory(context: Context): JSONArray {
        val arr = loadRemoved(context)
        val out = JSONArray()
        for (i in arr.length() - 1 downTo 0) out.put(arr.get(i))
        return out
    }

    private fun loadRemoved(context: Context): JSONArray = try {
        JSONArray(prefs(context).getString(KEY_REMOVED, null) ?: "[]")
    } catch (_: Exception) { JSONArray() }

    // ── Snapshot de instaladas (para el diff) ────────────────────────────────

    private fun loadSnapshot(context: Context): JSONObject? = try {
        prefs(context).getString(KEY_SNAPSHOT, null)?.let { JSONObject(it) }
    } catch (_: Exception) { null }

    /**
     * Compara el snapshot previo con lo instalado ahora: registra como
     * desinstalado (con fecha aproximada) todo paquete que desapareció sin que
     * viéramos el broadcast, y guarda el snapshot nuevo. Llamar antes de leer
     * el historial y al arrancar la app (baseline).
     */
    @Synchronized
    fun syncSnapshot(context: Context) {
        try {
            val pm = context.packageManager
            val current = JSONObject()
            for (info in pm.getInstalledPackages(0)) {
                val app = info.applicationInfo ?: continue
                // Solo apps visibles al usuario: las de sistema puras generan ruido
                // en el historial (los OEM las tocan en updates de firmware).
                val isSystem = (app.flags and ApplicationInfo.FLAG_SYSTEM) != 0 &&
                    (app.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0
                if (isSystem) continue
                current.put(info.packageName, app.loadLabel(pm).toString())
            }
            val previous = loadSnapshot(context)
            val since = prefs(context).getLong(KEY_SNAPSHOT_AT, 0L)
            if (previous != null) {
                for (pkg in previous.keys()) {
                    if (!current.has(pkg)) recordRemoval(context, pkg, approxSince = since)
                }
            }
            prefs(context).edit()
                .putString(KEY_SNAPSHOT, current.toString())
                .putLong(KEY_SNAPSHOT_AT, System.currentTimeMillis())
                .apply()
        } catch (e: Exception) {
            Log.e(TAG, "syncSnapshot failed: ${e.message}")
        }
    }
}

/**
 * Recibe ACTION_PACKAGE_FULLY_REMOVED del sistema (declarado en el manifest).
 * FULLY_REMOVED (y no REMOVED) para ignorar las actualizaciones de apps, que
 * disparan REMOVED+REPLACING sin que la app se haya ido de verdad.
 */
class PackageRemovedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_PACKAGE_FULLY_REMOVED) return
        val pkg = intent.data?.schemeSpecificPart ?: return
        PackageTracker.recordRemoval(context, pkg)
    }
}
