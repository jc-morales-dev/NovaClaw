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
 * Dos modos de ejecución (se elige solo, ver [detectExecMode]):
 *
 *  - DIRECT: se ejecutan los binarios del prefix directamente. Solo funciona si
 *    la app apunta a targetSdk ≤ 28 (Android no impone W^X para esas apps). Es
 *    el camino histórico, validado en el OPPO.
 *
 *  - PROOT: para targetSdk ≥ 29 (Android 10+), donde SELinux bloquea ejecutar
 *    binarios desde el dir de datos (W^X). Se ejecuta todo bajo `proot`, cuyo
 *    binario + loader viven en `nativeLibraryDir` (extraído del APK, de solo
 *    lectura y EJECUTABLE en cualquier targetSdk). proot carga los ELF del
 *    prefix con su propio loader, sorteando la restricción. Es la técnica de
 *    proot-distro / UserLAnd / Andronix, y lo que destraba subir a targetSdk 34.
 */
class RuntimeManager(private val context: Context) {

    companion object {
        private const val TAG = "NovaClaw/Runtime"

        /** Nombres de los .so empaquetados en jniLibs (ver scripts/fetch-proot-so.sh). */
        private const val PROOT_LIB = "libproot.so"
        private const val PROOT_LOADER_LIB = "libproot-loader.so"
        private const val PROOT_LOADER32_LIB = "libproot-loader32.so"
    }

    enum class ExecMode { DIRECT, PROOT }

    data class Result(val exitCode: Int, val output: String)

    /** Prefix con el que se compilaron los paquetes .deb de Termux. */
    private val termuxPrefix = "/data/data/com.termux/files/usr"

    /** Directorio donde Android extrae los .so del APK: de solo lectura y ejecutable. */
    private val nativeLibDir: String
        get() = context.applicationInfo.nativeLibraryDir

    /** Ruta del binario `proot` extraído en nativeLibraryDir, o null si no está. */
    private fun findProotBinary(): File? {
        val f = File(nativeLibDir, PROOT_LIB)
        return if (f.exists() && f.canExecute()) f else null
    }

    /**
     * Elige el modo de ejecución. targetSdk ≤ 28 → DIRECT (comportamiento
     * histórico intacto). targetSdk ≥ 29 → PROOT si el binario está empaquetado;
     * si no, DIRECT como último recurso (funcionará en Android ≤ 9 y fallará con
     * un error claro en 10+, en vez de romper en silencio).
     */
    private val execMode: ExecMode by lazy {
        val legacyExecAllowed = context.applicationInfo.targetSdkVersion <= 28
        when {
            legacyExecAllowed -> ExecMode.DIRECT
            findProotBinary() != null -> ExecMode.PROOT
            else -> {
                Log.e(
                    TAG,
                    "targetSdk ${context.applicationInfo.targetSdkVersion} exige proot pero " +
                        "$PROOT_LIB no está en $nativeLibDir. Corré scripts/fetch-proot-so.sh " +
                        "antes de compilar. Cayendo a DIRECT (fallará en Android 10+)."
                )
                ExecMode.DIRECT
            }
        }
    }

    fun execModeName(): String = execMode.name

    /**
     * proot de Termux está enlazado dinámicamente contra `libtalloc.so.2` y
     * `libandroid-shmem.so`, que el bootstrap MÍNIMO de NovaClaw no incluye. Sin
     * ellas, proot muere con "CANNOT LINK EXECUTABLE ... library not found" y el
     * agente nunca levanta. Copiamos esas libs (empaquetadas como assets por
     * arquitectura en proot-libs/) al $PREFIX/lib, que está en LD_LIBRARY_PATH.
     * Idempotente: se salta si ya están (sirve para prefixes ya instalados).
     */
    @Volatile private var prootLibsReady = false
    private fun ensureProotLibs() {
        if (prootLibsReady) return
        val prefix = BootstrapInstaller.getPaths(context).prefixDir
        val libDir = File(prefix, "lib").apply { mkdirs() }
        try {
            val assets = context.assets.list("proot-libs") ?: emptyArray()
            for (name in assets) {
                val dest = File(libDir, name)
                if (!dest.exists() || dest.length() == 0L) {
                    context.assets.open("proot-libs/$name").use { input ->
                        FileOutputStream(dest).use { out -> input.copyTo(out) }
                    }
                }
                // libtalloc se distribuye como libtalloc.so.2.4.3; el soname que
                // proot pide es libtalloc.so.2 → crear el enlace (o copia) esperado.
                if (name.startsWith("libtalloc.so.2.")) {
                    val soname = File(libDir, "libtalloc.so.2")
                    if (!soname.exists()) {
                        try {
                            android.system.Os.symlink(name, soname.absolutePath)
                        } catch (_: Throwable) {
                            dest.copyTo(soname, overwrite = true) // fallback si symlink falla
                        }
                    }
                }
            }
            prootLibsReady = true
            Log.i(TAG, "Libs de proot listas en $libDir")
        } catch (e: Exception) {
            Log.e(TAG, "No pude preparar las libs de proot: ${e.message}")
        }
    }

    /**
     * Envuelve un argv para que corra bajo el modo activo. En DIRECT lo devuelve
     * tal cual; en PROOT antepone `proot` con sus binds. El `cwd` es el directorio
     * de trabajo del guest.
     */
    private fun wrapForExec(argv: List<String>, cwd: String): List<String> {
        if (execMode == ExecMode.DIRECT) return argv
        val proot = findProotBinary()?.absolutePath
            ?: return argv // no debería pasar (execMode ya lo verificó), pero por las dudas
        ensureProotLibs()
        val prefix = BootstrapInstaller.getPaths(context).prefixDir
        // proot con root real (/), bindeando el prefix también sobre la ruta
        // canónica de Termux para que cualquier shebang/ruta hardcodeada resuelva.
        return buildList {
            add(proot)
            add("--kill-on-exit")     // matar el árbol si el proceso raíz muere
            add("--link2symlink")     // emula hardlinks (apt/dpkg) sobre FS de Android
            add("-b"); add("/dev")
            add("-b"); add("/proc")
            add("-b"); add("/sys")
            add("-b"); add("$prefix:$termuxPrefix")
            // Shebangs de scripts npm/pip: `#!/usr/bin/env node`, `#!/bin/sh`, etc.
            // Bajo proot NO corre termux-exec (que en modo DIRECT reescribe estos
            // shebangs), así que bindeamos las rutas absolutas del sistema al
            // binario real del prefix. Sin esto, toda herramienta CLI instalada
            // (cowsay, tsc, eslint, etc.) muere con "env: not found".
            val envBin = File(prefix, "bin/env")
            if (envBin.exists()) { add("-b"); add("${envBin.absolutePath}:/usr/bin/env") }
            val shBin = File(prefix, "bin/sh")
            if (shBin.exists()) { add("-b"); add("${shBin.absolutePath}:/bin/sh") }
            add("-w"); add(cwd)
            addAll(argv)
        }
    }

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
        if (!File(agentDir, "agent.cjs").exists()) { onLog("Agente no instalado."); return false }

        // Si la distro glibc está instalada, el agente corre ADENTRO de ella
        // (node glibc real). Si no, cae al node bionic del bootstrap mínimo.
        val distro = DistroManager(context, this)
        val useDistro = distro.isInstalled()
        val bionicNode = "$prefix/bin/node"
        if (!useDistro && !File(bionicNode).exists()) {
            onLog("Node no está instalado."); return false
        }

        stopAgent()

        // Variables del agente independientes del modo (proveedor/clave/token).
        val agentVars = mutableMapOf(
            "NODE_ENV" to "production",
            "PORT" to port.toString(),
            // Token secreto: el agente exige X-Nova-Token en /api y /pty, y lo
            // reenvía al servidor nativo 8099. Sin esto, otra app podría hablarle.
            "NOVACLAW_TOKEN" to TokenStore.get(context),
        )

        // Config del proveedor de IA (novaclaw.config.json): baseUrl/model (NO
        // secretos). Se busca en el dir interno y en el external files dir.
        val configCandidates = listOfNotNull(
            File(paths.filesDir, "novaclaw.config.json"),
            context.getExternalFilesDir(null)?.let { File(it, "novaclaw.config.json") },
        )
        configCandidates.firstOrNull { it.exists() }?.let { applyProviderConfig(it, agentVars) }

        // ── API key POR PROVEEDOR: cifrada en el Android Keystore (mapa) ────────
        val provider = readProviderFromConfig(configCandidates)
        SecretStore.migrateLegacy(context, provider)
        val plain = agentVars["ZEN_API_KEY"]
        if (!plain.isNullOrBlank() && SecretStore.getApiKey(context, provider).isNullOrBlank()) {
            SecretStore.saveApiKey(context, provider, plain)
            Log.i(TAG, "API key migrada de texto plano al Keystore (provider=$provider).")
        }
        agentVars["ZEN_API_KEY"] = SecretStore.getApiKey(context, provider) ?: ""
        for (f in configCandidates) scrubApiKeyInFile(f)

        val argv: List<String>
        val procEnv: Map<String, String>
        if (useDistro) {
            // El agente corre con el node glibc de la distro. Se bindean el bundle
            // del agente (/opt/nova-agent), los datos config/sessions (/nova-data)
            // y la home real como workspace (/root), para que TODO persista fuera
            // del rootfs y sobreviva una reinstalación de la distro.
            agentVars["HOME"] = "/root"
            agentVars["SHELL"] = "/bin/bash"
            agentVars["NOVACLAW_DIST"] = "/opt/nova-agent/dist"
            agentVars["NOVACLAW_CONFIG"] = "/nova-data/novaclaw.config.json"
            // El node de Ubuntu usa el CA store del sistema (OpenSSL), que bajo
            // proot queda sin generar (dpkg no configura ca-certificates) → las
            // llamadas HTTPS del agente al modelo dan "unable to get local issuer
            // certificate". Con el CA embebido de Node, el TLS funciona sin depender
            // de que el paquete ca-certificates se haya configurado bien.
            agentVars["NODE_OPTIONS"] = "--use-bundled-ca"
            val binds = listOf(
                agentDir.absolutePath to "/opt/nova-agent",
                paths.filesDir to "/nova-data",
                paths.homeDir to "/root",
            )
            argv = distro.enterArgv(
                listOf("/usr/bin/node", "/opt/nova-agent/agent.cjs"),
                cwd = "/root",
                binds = binds,
                guestEnv = agentVars,
            )
            procEnv = prootHostEnv()
        } else {
            // Fallback bionic: node del prefix bajo proot directo (código histórico).
            val env = buildEnvironment(paths).toMutableMap()
            env.putAll(agentVars)
            env["NOVACLAW_DIST"] = "${agentDir.absolutePath}/dist"
            env["SHELL"] = "$prefix/bin/sh"
            env["NOVACLAW_CONFIG"] = File(paths.filesDir, "novaclaw.config.json").absolutePath
            argv = wrapForExec(listOf(bionicNode, "${agentDir.absolutePath}/agent.cjs"), paths.homeDir)
            procEnv = env
        }

        val pb = ProcessBuilder(argv)
        pb.environment().clear()
        pb.environment().putAll(procEnv)
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

    /** Lee el proveedor actual del primer novaclaw.config.json que exista. */
    private fun readProviderFromConfig(candidates: List<File>): String {
        for (f in candidates) {
            if (!f.exists()) continue
            try {
                val p = org.json.JSONObject(f.readText()).optString("provider")
                if (p.isNotBlank()) return p
            } catch (_: Exception) { /* archivo inválido */ }
        }
        return "opencode-zen"
    }

    /** Borra la apiKey en texto plano de un novaclaw.config.json (tras migrarla al Keystore). */
    private fun scrubApiKeyInFile(f: File) {
        if (!f.exists()) return
        try {
            val json = org.json.JSONObject(f.readText())
            if (json.optString("apiKey").isNotBlank()) {
                json.put("apiKey", "")
                f.writeText(json.toString(2))
                Log.i(TAG, "API key en texto plano removida de ${f.name}.")
            }
        } catch (_: Exception) { /* archivo inválido: se ignora */ }
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

    // ── Helpers públicos para DistroManager (distro glibc bajo proot) ───────

    fun deleteRecursivePublic(f: File) = deleteRecursive(f)
    fun prootBinaryPublic(): String? = findProotBinary()?.absolutePath
    fun ensureProotLibsPublic() = ensureProotLibs()

    /**
     * Entorno mínimo para que el binario `proot` arranque: encuentra libtalloc/
     * libandroid-shmem (LD_LIBRARY_PATH) y sus loaders. Es el entorno del HOST
     * (no el del guest, que se pasa aparte con `env -i` adentro).
     */
    private fun prootHostEnv(): Map<String, String> {
        val paths = BootstrapInstaller.getPaths(context)
        val prefix = paths.prefixDir
        val env = mutableMapOf(
            "HOME" to paths.homeDir,
            "PATH" to "$prefix/bin:$prefix/bin/applets:/system/bin",
            "LD_LIBRARY_PATH" to "$prefix/lib",
            "TMPDIR" to paths.tmpDir,
            "TMP" to paths.tmpDir,
            "PROOT_TMP_DIR" to paths.tmpDir,
            "TERM" to "xterm-256color",
        )
        File(nativeLibDir, PROOT_LOADER_LIB).takeIf { it.exists() }
            ?.let { env["PROOT_LOADER"] = it.absolutePath }
        File(nativeLibDir, PROOT_LOADER32_LIB).takeIf { it.exists() }
            ?.let { env["PROOT_LOADER_32"] = it.absolutePath }
        return env
    }

    /** Corre un argv arbitrario con el entorno de proot y captura stdout+stderr. */
    fun runArgv(argv: List<String>, onLine: (String) -> Unit = {}): Result {
        val paths = BootstrapInstaller.getPaths(context)
        val pb = ProcessBuilder(argv)
        pb.environment().clear()
        pb.environment().putAll(prootHostEnv())
        pb.directory(File(paths.homeDir))
        pb.redirectErrorStream(true)
        val sb = StringBuilder()
        return try {
            val proc = pb.start()
            BufferedReader(InputStreamReader(proc.inputStream)).use { r ->
                var l = r.readLine()
                while (l != null) { Log.d(TAG, l); onLine(l); sb.appendLine(l); l = r.readLine() }
            }
            Result(proc.waitFor(), sb.toString().trim())
        } catch (e: Exception) {
            Log.e(TAG, "Error corriendo argv", e)
            Result(-1, "ERROR: ${e.message}\n$sb".trim())
        }
    }

    /** Corre el binario `proot` directamente (p. ej. para extraer el rootfs). */
    fun runRawProot(args: List<String>, onLine: (String) -> Unit = {}): Result {
        ensureProotLibs()
        val proot = findProotBinary()?.absolutePath
            ?: return Result(-1, "proot no disponible en $nativeLibDir")
        return runArgv(listOf(proot) + args, onLine)
    }

    /**
     * Ejecuta un comando con `sh -c` dentro del prefix y captura stdout+stderr.
     */
    fun runInPrefix(command: String): Result {
        val paths = BootstrapInstaller.getPaths(context)
        val env = buildEnvironment(paths)
        val shell = "${paths.prefixDir}/bin/sh"

        val argv = wrapForExec(listOf(shell, "-c", command), paths.homeDir)
        val pb = ProcessBuilder(argv)
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

        if (execMode == ExecMode.PROOT) {
            // Bajo proot NO se usa el LD_PRELOAD de termux-exec: proot ya intercepta
            // execve y hacer ambos a la vez rompe. proot necesita saber dónde está
            // su loader (también en nativeLibraryDir, ejecutable).
            File(nativeLibDir, PROOT_LOADER_LIB).takeIf { it.exists() }
                ?.let { env["PROOT_LOADER"] = it.absolutePath }
            File(nativeLibDir, PROOT_LOADER32_LIB).takeIf { it.exists() }
                ?.let { env["PROOT_LOADER_32"] = it.absolutePath }
        } else {
            // DIRECT (targetSdk ≤ 28): termux-exec reescribe shebangs en tiempo real.
            findTermuxExecLib(prefix)?.let { env["LD_PRELOAD"] = it }
        }
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
