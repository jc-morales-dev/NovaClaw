package app.novaclaw

import android.content.Context
import java.security.SecureRandom

/**
 * Token secreto compartido entre la capa nativa (Kotlin) y el agente Node.
 *
 * Se genera UNA vez por instalación y se guarda en el SharedPreferences privado de
 * la app. Sirve para autenticar:
 *   - las llamadas a /api del agente (server.ts exige el header X-Nova-Token),
 *   - las llamadas al servidor nativo 8099 (cámara/GPS/contactos),
 *   - el WebSocket /pty (terminal).
 *
 * Así, aunque el agente escuche en loopback, NINGUNA otra app del teléfono puede
 * hablarle sin conocer el token.
 */
object TokenStore {
    private const val PREFS = "novaclaw_secure"
    private const val KEY = "agent_token"

    @Volatile private var cached: String? = null

    fun get(context: Context): String {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val prefs = context.applicationContext
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            var t = prefs.getString(KEY, null)
            if (t.isNullOrBlank()) {
                t = generate()
                prefs.edit().putString(KEY, t).apply()
            }
            cached = t
            return t!!
        }
    }

    private fun generate(): String {
        val bytes = ByteArray(24)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
