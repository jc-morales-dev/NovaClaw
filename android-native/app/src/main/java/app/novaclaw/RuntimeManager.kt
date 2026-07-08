package app.novaclaw

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.Socket
import java.util.zip.ZipInputStream
import kotlin.concurrent.thread

/**
 * Ejecuta comandos dentro del entorno Linux embebido (bootstrap de Termux).
 *
 * En targetSdk 28 los binarios del prefix se ejecutan directamente (Android no
 * impone W^X para esta targetSdk). proot se agregará en fases posteriores para
 * montar un rootfs Debian completo; para la Fase 1 alcanza con el shell nativo.
 */
class RuntimeManager(private val context: Context) {

    companion object {
        private const val TAG = "NovaClaw/Runtime"
    }

    data class Result(val exitCode: Int, val output: String)

    /** Prefix con el que se compilaron los paquetes .deb de Termux. */
    private val termuxPrefix = "/data/data/com.termux/files/usr"

    fun isNodeInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.prefixDir, "bin/node").exists()
    }

    /**
     * Instala Node.js + npm dentro del prefix (Fase 2).
     *
     * Método portado de openclaw (CodexServerManager.installNode): descarga los
     * .deb con `apt-get download` (saltando la firma GPG, que el bootstrap recién
     * extraído no puede verificar) y los extrae con `dpkg-deb -x` en vez de
     * `apt install`, evitando los scripts postinst que asumen rutas de Termux.
     */
    fun installNode(onProgress: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir

        if (isNodeInstalled()) {
            onProgress("Node ya instalado.")
            return true
        }

        // Preflight de espacio: descarga (~25 MB) + extracción (~100 MB) + margen.
        val free = BootstrapInstaller.availableBytes(context)
        val minFree = 250L * 1024 * 1024
        if (free < minFree) {
            onProgress(
                "Espacio insuficiente: quedan ${free / (1024 * 1024)} MB libres y se " +
                    "necesitan al menos ${minFree / (1024 * 1024)} MB para Node.js. " +
                    "Liberá espacio e intentá de nuevo."
            )
            return false
        }

        onProgress("Descargando Node.js y dependencias…")
        val downloadCmd = """
            cd ${'$'}TMPDIR &&
            apt-get update --allow-insecure-repositories 2>&1;
            apt-get download --allow-unauthenticated c-ares libicu libsqlite nodejs-lts npm 2>&1
        """.trimIndent()
        val dl = runInPrefix(downloadCmd)
        onProgress(dl.output.takeLast(400))

        onProgress("Extrayendo paquetes…")
        val extractCmd = """
            cd ${'$'}TMPDIR &&
            mkdir -p _stage &&
            for deb in *.deb; do dpkg-deb -x "${'$'}deb" _stage/ 2>&1; done &&
            if [ -d "_stage$termuxPrefix" ]; then
                cp -a _stage$termuxPrefix/* "$prefix/" 2>&1
            elif [ -d "_stage/usr" ]; then
                cp -a _stage/usr/* "$prefix/" 2>&1
            fi
            rm -rf _stage *.deb 2>/dev/null
            echo "extraccion_ok"
        """.trimIndent()
        val ex = runInPrefix(extractCmd)
        if (ex.exitCode != 0) {
            onProgress("Error extrayendo: ${ex.output.takeLast(300)}")
            return false
        }

        // Wrappers: node ya es binario (solo chmod); npm es JS y necesita wrapper.
        val fixCmd = """
            chmod 700 "$prefix/bin/node" 2>/dev/null
            NPM_CLI="$prefix/lib/node_modules/npm/bin/npm-cli.js"
            if [ -f "${'$'}NPM_CLI" ]; then
                rm -f "$prefix/bin/npm"
                printf '#!%s/bin/sh\nexec %s/bin/node %s "${'$'}@"\n' "$prefix" "$prefix" "${'$'}NPM_CLI" > "$prefix/bin/npm"
                chmod 700 "$prefix/bin/npm"
            fi
            echo "wrappers_ok"
        """.trimIndent()
        runInPrefix(fixCmd)

        // Limpieza post-instalación: los índices de `apt-get update` y la caché de
        // paquetes quedan ocupando decenas de MB que ya no sirven para nada.
        onProgress("Limpiando cachés de apt…")
        val cleanupCmd = """
            rm -rf "$prefix/var/lib/apt/lists"/* "$prefix/var/cache/apt/archives"/*.deb 2>/dev/null
            mkdir -p "$prefix/var/lib/apt/lists/partial" "$prefix/var/cache/apt/archives/partial"
            echo "limpieza_ok"
        """.trimIndent()
        runInPrefix(cleanupCmd)

        val ver = runInPrefix("node --version")
        onProgress("node ${ver.output.trim()}")
        return isNodeInstalled()
    }

    // ── Agente propio (server.ts + src/agent) ──────────────────────────────

    @Volatile
    private var agentProcess: Process? = null

    fun isAgentInstalled(): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        return File(paths.filesDir, "agent/agent.cjs").exists()
    }

    /** Extrae agent.zip (bundle del server + UI React) desde assets al filesDir. */
    fun installAgent(onProgress: (String) -> Unit) {
        val paths = BootstrapInstaller.getPaths(context)
        val agentDir = File(paths.filesDir, "agent")
        if (agentDir.exists()) deleteRecursive(agentDir)
        agentDir.mkdirs()
        onProgress("Extrayendo el agente…")
        val buffer = ByteArray(8192)
        context.assets.open("agent.zip").use { s ->
            ZipInputStream(s).use { zip ->
                var e = zip.nextEntry
                while (e != null) {
                    val f = File(agentDir, e.name)
                    if (e.isDirectory) {
                        f.mkdirs()
                    } else {
                        f.parentFile?.mkdirs()
                        FileOutputStream(f).use { out ->
                            var n = zip.read(buffer)
                            while (n != -1) { out.write(buffer, 0, n); n = zip.read(buffer) }
                        }
                    }
                    e = zip.nextEntry
                }
            }
        }
        onProgress("Agente extraído.")

        // Puente Shizuku (Fase 3): se instala junto al agente para que el comando
        // `shizuku` esté siempre disponible en el prefix cuando arranca el agente.
        try {
            installShizukuBridge(onProgress)
        } catch (e: Exception) {
            Log.w(TAG, "No se pudo instalar el puente Shizuku: ${e.message}")
            onProgress("Aviso: puente Shizuku no instalado (${e.message}).")
        }
    }

    // ── Fase 3: puente Shizuku (control privilegiado del teléfono) ─────────
    //
    // Instala `rish` (el binario oficial de Shizuku) dentro del teléfono y crea
    // un wrapper `shizuku` en $PREFIX/bin. Con Shizuku corriendo y el permiso
    // concedido a app.novaclaw, el agente ejecuta comandos con identidad de shell
    // ADB (UID 2000): input tap/swipe/text, screencap, pm, dumpsys, am, etc.
    //
    // rish carga rish_shizuku.dex con app_process. En Android 14+ el dex NO puede
    // ser escribible (se chmod 400). Se guarda en el filesDir privado de la app,
    // donde quitarle el permiso de escritura sí es posible.

    /** Extrae rish + el dex y escribe el wrapper `shizuku` en el prefix. Idempotente. */
    fun installShizukuBridge(onProgress: (String) -> Unit = {}) {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val shizukuDir = File(paths.filesDir, "shizuku")
        shizukuDir.mkdirs()

        // 1) Copiar el dex desde assets y hacerlo de solo lectura (Android 14+).
        val dex = File(shizukuDir, "rish_shizuku.dex")
        context.assets.open("shizuku/rish_shizuku.dex").use { input ->
            FileOutputStream(dex).use { out -> input.copyTo(out) }
        }
        dex.setWritable(false, false)
        dex.setReadable(true, false)

        // 2) Escribir el wrapper `shizuku` en $PREFIX/bin.
        //    Corre app_process (binario de Android) con un entorno LIMPIO: sin el
        //    LD_PRELOAD/LD_LIBRARY_PATH del prefix, que romperían el linker de Android.
        val wrapper = File(prefix, "bin/shizuku")
        val script = buildString {
            append("#!/system/bin/sh\n")
            append("export RISH_APPLICATION_ID=${context.packageName}\n")
            append("unset LD_PRELOAD\n")
            append("unset LD_LIBRARY_PATH\n")
            append("DEX=${dex.absolutePath}\n")
            append("if [ ! -f \"\$DEX\" ]; then echo 'shizuku: falta rish_shizuku.dex' >&2; exit 1; fi\n")
            append("exec /system/bin/app_process -Djava.class.path=\"\$DEX\" /system/bin ")
            append("--nice-name=rish rikka.shizuku.shell.ShizukuShellLoader \"\$@\"\n")
        }
        wrapper.writeText(script)
        wrapper.setExecutable(true, false)

        onProgress("Puente Shizuku instalado (comando `shizuku`).")
        Log.i(TAG, "Shizuku bridge listo: ${wrapper.absolutePath}")
    }

    /** Lanza `node agent.cjs` como proceso de larga duración escuchando en 127.0.0.1:port. */
    fun startAgent(port: Int, onLog: (String) -> Unit): Boolean {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val agentDir = File(paths.filesDir, "agent")
        val node = "$prefix/bin/node"
        if (!File(node).exists()) { onLog("Node no está instalado (corré la Fase 2)."); return false }
        if (!File(agentDir, "agent.cjs").exists()) { onLog("Agente no instalado."); return false }

        stopAgent()

        val env = buildEnvironment(paths).toMutableMap()
        env["NODE_ENV"] = "production"
        env["PORT"] = port.toString()
        env["NOVACLAW_DIST"] = "${agentDir.absolutePath}/dist"
        env["SHELL"] = "$prefix/bin/sh"
        // Ruta del config del proveedor que la pantalla de Ajustes escribe/lee
        // (mismo archivo interno que applyProviderConfig prioriza al arrancar).
        env["NOVACLAW_CONFIG"] = File(paths.filesDir, "novaclaw.config.json").absolutePath

        // Config del proveedor de IA (fuera de git): novaclaw.config.json
        // { "baseUrl": "...", "apiKey": "...", "model": "..." }
        // Se busca en el dir interno y en el external files dir (este último es
        // fácil de escribir por USB: /sdcard/Android/data/app.novaclaw/files/).
        val configCandidates = listOfNotNull(
            File(paths.filesDir, "novaclaw.config.json"),
            context.getExternalFilesDir(null)?.let { File(it, "novaclaw.config.json") },
        )
        configCandidates.firstOrNull { it.exists() }?.let { applyProviderConfig(it, env) }

        val pb = ProcessBuilder(node, "${agentDir.absolutePath}/agent.cjs")
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val proc = pb.start()
        agentProcess = proc
        thread(isDaemon = true) {
            BufferedReader(InputStreamReader(proc.inputStream)).use { r ->
                var l = r.readLine()
                while (l != null) { Log.d(TAG, "[agent] $l"); onLog(l); l = r.readLine() }
            }
        }
        return true
    }

    /** Espera hasta que el puerto acepte conexiones (agente listo) o venza el timeout. */
    fun waitForPort(port: Int, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 500) }
                return true
            } catch (e: Exception) {
                Thread.sleep(300)
            }
        }
        return false
    }

    fun stopAgent() {
        agentProcess?.destroy()
        agentProcess = null
    }

    /** Lee la config del proveedor (URL/key/modelo) y la inyecta como env del agente. */
    private fun applyProviderConfig(configFile: File, env: MutableMap<String, String>) {
        if (!configFile.exists()) return
        try {
            val json = org.json.JSONObject(configFile.readText())
            json.optString("baseUrl").takeIf { it.isNotBlank() }?.let { env["ZEN_BASE_URL"] = it }
            json.optString("apiKey").takeIf { it.isNotBlank() }?.let { env["ZEN_API_KEY"] = it }
            json.optString("model").takeIf { it.isNotBlank() }?.let { env["ZEN_MODEL"] = it }
            Log.i(TAG, "Config de proveedor aplicada (modelo=${json.optString("model")})")
        } catch (e: Exception) {
            Log.w(TAG, "novaclaw.config.json inválido: ${e.message}")
        }
    }

    private fun deleteRecursive(f: File) {
        if (f.isDirectory) f.listFiles()?.forEach { deleteRecursive(it) }
        f.delete()
    }

    /**
     * Ejecuta un comando con `sh -c` dentro del prefix y captura stdout+stderr.
     */
    fun runInPrefix(command: String): Result {
        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths)
        val shell = "${paths.prefixDir}/bin/sh"

        val pb = ProcessBuilder(shell, "-c", command)
        pb.environment().clear()
        pb.environment().putAll(env)
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)

        val sb = StringBuilder()
        return try {
            val proc = pb.start()
            BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                var line = reader.readLine()
                while (line != null) {
                    Log.d(TAG, line)
                    sb.appendLine(line)
                    line = reader.readLine()
                }
            }
            val code = proc.waitFor()
            Result(code, sb.toString().trim())
        } catch (e: Exception) {
            Log.e(TAG, "Error ejecutando: $command", e)
            Result(-1, "ERROR: ${e.message}\n${sb}".trim())
        }
    }

    /**
     * Entorno de ejecución del prefix. Detecta la lib termux-exec disponible
     * (los bootstraps nuevos cambiaron el nombre) y la usa como LD_PRELOAD.
     */
    private fun buildEnvironment(paths: BootstrapInstaller.Paths): Map<String, String> {
        val prefix = paths.prefixDir
        val env = mutableMapOf(
            "PREFIX" to prefix,
            "HOME" to paths.homeDir,
            "PATH" to "$prefix/bin:$prefix/bin/applets:/system/bin",
            "LD_LIBRARY_PATH" to "$prefix/lib",
            "TERMUX_PREFIX" to prefix,
            "TERMUX__PREFIX" to prefix,
            "LANG" to "en_US.UTF-8",
            "TMPDIR" to paths.tmpDir,
            "TMP" to paths.tmpDir,
            "TEMP" to paths.tmpDir,
            "PROOT_TMP_DIR" to paths.tmpDir,
            "TERM" to "xterm-256color",
            "ANDROID_DATA" to "/data",
            "ANDROID_ROOT" to "/system",
            "APT_CONFIG" to "$prefix/etc/apt/apt.conf",
            "DPKG_ADMINDIR" to "$prefix/var/lib/dpkg",
            // OJO: NO setear SSL_CERT_FILE/CURL_CA_BUNDLE al cert.pem del prefix.
            // Ese cert está corrupto en este bootstrap y rompe el TLS de Node
            // (undici lee SSL_CERT_FILE) → "fetch failed". Node usa su CA interno.
            "CONTAINER" to "1",
        )

        findTermuxExecLib(prefix)?.let { env["LD_PRELOAD"] = it }
        return env
    }

    /**
     * Busca la librería termux-exec (shim que reescribe shebangs #!/bin/sh).
     * Los bootstraps nuevos traen varias; hay que elegir el LD_PRELOAD correcto
     * y NO una lib de tests (libtermux-exec_nos_c_tre.so).
     */
    private fun findTermuxExecLib(prefix: String): String? {
        val libDir = File(prefix, "lib")
        // Orden de preferencia: nombre nuevo del shim, luego clásico, luego variantes.
        val preferred = listOf(
            "libtermux-exec-ld-preload.so",
            "libtermux-exec.so",
            "libtermux-exec-direct-ld-preload.so",
        )
        for (name in preferred) {
            val f = File(libDir, name)
            if (f.exists()) return f.absolutePath
        }
        // Fallback: cualquier *ld-preload*.so, excluyendo las de tests.
        val candidate = libDir.listFiles()?.firstOrNull {
            it.name.startsWith("libtermux-exec") &&
                it.name.contains("ld-preload") &&
                it.name.endsWith(".so") &&
                !it.name.contains("nos_c_tre")
        }
        return candidate?.absolutePath
    }
}
