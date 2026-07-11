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
    private lateinit var distro: DistroManager
    private lateinit var shizuku: ShizukuManager
    private lateinit var connectors: ConnectorBridge
    private val nativeTools by lazy { NativeToolsServer(applicationContext, TokenStore.get(this)) }
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
        distro = DistroManager(this, runtime)
        connectors = ConnectorBridge(this)
        // Servidor de capacidades nativas (cámara/GPS/contactos) para el agente.
        nativeTools.start()
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
            binding.spinner.visibility = View.VISIBLE
            binding.txtHint.text = "La primera vez se descarga todo lo necesario.\nPuede tardar unos minutos."
        }
        thread {
            try {
                // Primera instalación: mostrar progreso detallado. Arranques
                // normales: splash limpio solo con el logo y un spinner.
                val isFirstRun = !BootstrapInstaller.isBootstrapInstalled(this) || !distro.isInstalled()
                runOnUiThread {
                    val detail = if (isFirstRun) View.VISIBLE else View.GONE
                    binding.progress.visibility = detail
                    binding.txtStatus.visibility = detail
                    binding.txtHint.visibility = detail
                    binding.spinner.visibility = if (isFirstRun) View.GONE else View.VISIBLE
                }

                // El bootstrap mínimo sigue instalado como "toolkit" (aporta tar +
                // proot para bajar y desempacar la distro glibc completa).
                if (!BootstrapInstaller.isBootstrapInstalled(this)) {
                    setStatus("Descargando el sistema base…")
                    BootstrapInstaller.install(this) { log("· $it") }
                }

                // Entorno Linux COMPLETO (rootfs Ubuntu glibc): el agente y todos
                // los comandos corren adentro, así cualquier binario de Linux
                // funciona (opencode, Claude Code, etc.), igual que AnyClaw.
                if (!distro.isInstalled()) {
                    setStatus("Instalando el entorno Linux completo…")
                    distro.install { log("· $it") }
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
            binding.progress.visibility = View.GONE
            binding.spinner.visibility = View.GONE
            binding.txtStatus.visibility = View.VISIBLE
            binding.txtHint.visibility = View.VISIBLE
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
        // Hardening: el WebView no necesita leer file:// ni content:// del dispositivo.
        wv.settings.allowFileAccess = false
        wv.settings.allowContentAccess = false
        @Suppress("DEPRECATION")
        run {
            wv.settings.allowFileAccessFromFileURLs = false
            wv.settings.allowUniversalAccessFromFileURLs = false
        }
        // Puente de conectores: la UI pide permisos reales vía window.NovaClawNative.
        wv.addJavascriptInterface(connectors, "NovaClawNative")
        // El bridge devuelve resultados asíncronos (huella) al front por JS.
        connectors.evalJs = { js -> wv.post { wv.evaluateJavascript(js, null) } }
        // Mismo fondo que la UI para que no haya flash blanco al aparecer.
        wv.setBackgroundColor(android.graphics.Color.parseColor("#0B0908"))
        wv.webViewClient = object : WebViewClient() {
            // Solo se navega dentro del agente local (127.0.0.1). Cualquier link
            // externo se abre en el navegador del sistema, NUNCA dentro del WebView
            // (donde tendría acceso al puente NovaClawNative).
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: android.webkit.WebResourceRequest?,
            ): Boolean {
                val uri = request?.url ?: return false
                val host = uri.host ?: ""
                if (host == "127.0.0.1" || host == "localhost") return false
                return try {
                    startActivity(
                        android.content.Intent(android.content.Intent.ACTION_VIEW, uri)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    true
                } catch (_: Exception) {
                    true // sin app que lo abra: no cargarlo en el WebView igualmente
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                // El splash se va recién cuando la UI terminó de cargar; el
                // margen extra cubre la animación de bienvenida de React para
                // que el usuario pase del logo directo al home ya pintado.
                binding.root.postDelayed({
                    binding.setupRoot.visibility = View.GONE
                    wv.visibility = View.VISIBLE
                }, 1200)
            }
        }
        // INVISIBLE (no GONE) para que el WebView renderice detrás del splash.
        wv.visibility = View.INVISIBLE
        wv.loadUrl("http://127.0.0.1:$AGENT_PORT")
    }

    /** Tras conceder/denegar un permiso de conector, avisa a la UI para refrescar. */
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == ConnectorBridge.REQUEST_CODE) notifyConnectorsChanged()
    }

    /** Al volver de la pantalla de "Acceso a todos los archivos", refresca la UI. */
    override fun onResume() {
        super.onResume()
        if (binding.webView.visibility == View.VISIBLE) notifyConnectorsChanged()
    }

    private fun notifyConnectorsChanged() {
        runOnUiThread {
            binding.webView.evaluateJavascript(
                "window.dispatchEvent(new Event('novaclaw-connectors-changed'));",
                null,
            )
        }
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
