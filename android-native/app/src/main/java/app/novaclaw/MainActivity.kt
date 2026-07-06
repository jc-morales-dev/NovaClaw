package app.novaclaw

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import app.novaclaw.databinding.ActivityMainBinding
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Arranque de NovaClaw pensado para usuarios finales: al abrir la app se
 * prepara todo solo (sistema base, Node y agente) mostrando una pantalla de
 * carga con la marca, y al terminar se entra directo a la interfaz real.
 * Nada técnico queda a la vista; el log completo vive detrás de "Ver detalles".
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var runtime: RuntimeManager
    private lateinit var shizuku: ShizukuManager
    @Volatile private var shizukuStatus = ShizukuManager.Status.NOT_RUNNING
    private val isRunning = AtomicBoolean(false)

    private companion object {
        const val AGENT_PORT = 8088
        const val AGENT_BOOT_TIMEOUT_MS = 45_000L
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        runtime = RuntimeManager(this)
        // Shizuku es opcional y silencioso: si no está, la app funciona igual y
        // el usuario jamás se entera de que existe.
        shizuku = ShizukuManager { status -> shizukuStatus = status }
        shizuku.register()

        binding.btnRetry.setOnClickListener { startSetup() }
        binding.btnDetails.setOnClickListener {
            binding.logScroll.visibility =
                if (binding.logScroll.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }

        startSetup()
    }

    /** Prepara el entorno completo sin intervención del usuario y abre la UI. */
    private fun startSetup() {
        if (!isRunning.compareAndSet(false, true)) return
        runOnUiThread {
            binding.btnRetry.visibility = View.GONE
            binding.progress.visibility = View.VISIBLE
            binding.txtHint.text = "La primera vez se descarga todo lo necesario.\nPuede tardar unos minutos."
        }
        thread {
            try {
                if (!BootstrapInstaller.isBootstrapInstalled(this)) {
                    setStatus("Descargando el sistema base…")
                    BootstrapInstaller.install(this) { log("· $it") }
                }

                if (!runtime.isNodeInstalled()) {
                    setStatus("Instalando las herramientas…")
                    if (!runtime.installNode { log("· $it") }) {
                        throw IllegalStateException("No se pudieron instalar las herramientas.")
                    }
                }

                setStatus("Preparando tu asistente…")
                runtime.installAgent { log("· $it") }

                setStatus("Iniciando…")
                // El agente lo arranca y lo mantiene vivo el ForegroundService, así
                // sobrevive aunque la app pase a segundo plano o se apague la pantalla.
                NovaClawService.start(this, AGENT_PORT)
                if (!runtime.waitForPort(AGENT_PORT, AGENT_BOOT_TIMEOUT_MS)) {
                    throw IllegalStateException("El asistente no respondió a tiempo.")
                }

                // Si Shizuku está corriendo pero sin permiso, pedirlo ahora (antes
                // de tapar la vista con el WebView) para que se vea el diálogo.
                if (shizukuStatus == ShizukuManager.Status.NEEDS_PERMISSION) {
                    log("Shizuku detectado. Pidiendo permiso…")
                    runOnUiThread { shizuku.ensurePermission() }
                    Thread.sleep(1200)
                }

                runOnUiThread { showWebApp() }
            } catch (e: Exception) {
                log("❌ ERROR: ${e.message}")
                log(android.util.Log.getStackTraceString(e))
                showError(e.message ?: "Error desconocido")
            } finally {
                isRunning.set(false)
            }
        }
    }

    private fun showError(message: String) {
        runOnUiThread {
            binding.progress.visibility = View.INVISIBLE
            binding.txtStatus.text = "Algo salió mal"
            binding.txtHint.text = "$message\nRevisá tu conexión e intentá de nuevo."
            binding.btnRetry.visibility = View.VISIBLE
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebApp() {
        val wv = binding.webView
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.webViewClient = WebViewClient()
        wv.loadUrl("http://127.0.0.1:$AGENT_PORT")
        binding.setupRoot.visibility = View.GONE
        wv.visibility = View.VISIBLE
    }

    override fun onDestroy() {
        super.onDestroy()
        // NO matamos el agente: es dueño el NovaClawService y debe seguir vivo en
        // background. Se detiene desde la acción "Detener" de la notificación.
        shizuku.unregister()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val wv = binding.webView
        if (wv.visibility == View.VISIBLE && wv.canGoBack()) wv.goBack() else super.onBackPressed()
    }

    private fun setStatus(text: String) {
        log("== $text")
        runOnUiThread { binding.txtStatus.text = text }
    }

    private fun log(text: String) {
        android.util.Log.i("NovaClaw/Main", text)
        runOnUiThread {
            binding.txtOutput.append(text + "\n")
            binding.logScroll.post { binding.logScroll.fullScroll(View.FOCUS_DOWN) }
        }
    }
}
