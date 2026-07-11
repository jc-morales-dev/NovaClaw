package app.novaclaw

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Distro glibc completa (rootfs de Ubuntu) corriendo bajo proot — la técnica de
 * AnyClaw / proot-distro / UserLAnd. Es lo que le da a NovaClaw compatibilidad
 * TOTAL con binarios de Linux (opencode, el binario nativo de Claude Code, etc.),
 * que NO corren en el bootstrap bionic/musl mínimo porque piden el cargador glibc
 * `/lib/ld-linux-aarch64.so.1`.
 *
 * El bootstrap de Termux sigue instalado, pero solo como "toolkit instalador":
 * aporta `tar` (y proot vive en jniLibs) para bajar y desempacar este rootfs.
 * Una vez instalada la distro, el agente y TODOS los comandos corren adentro de
 * ella (glibc real: bash, node, apt, y cualquier binario que el usuario instale).
 *
 * Validado a mano en un OPPO CPH2557 (Android 15): Ubuntu 24.04.4 (glibc 2.39),
 * Node 18.19, y Claude Code 2.1.207 corriendo dentro del teléfono.
 */
class DistroManager(
    private val context: Context,
    private val runtime: RuntimeManager,
) {

    companion object {
        private const val TAG = "NovaClaw/Distro"

        // Ubuntu Base 24.04.4 (glibc). URL + sha256 por arquitectura. El sha
        // permite bajar con TLS relajado (el cert.pem del bootstrap está roto)
        // sin perder integridad: si el hash no coincide, se aborta.
        private const val UBUNTU_VER = "24.04.4"
        private const val BASE_URL =
            "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release"
        private const val SHA_ARM64 =
            "04207713ece899c3740823d33690441ad3a7f0ded1101aca744e2b0f37ac7ff2"
        private const val SHA_AMD64 =
            "c1e67ef7b17a6300e136118bd1dc04725009cb376c1aad10abcf8cd453628d58"

        /** Espacio libre mínimo para la distro (rootfs + node + margen). */
        private const val MIN_FREE_BYTES: Long = 900L * 1024 * 1024
    }

    private val filesDir: String get() = BootstrapInstaller.getPaths(context).filesDir
    val distroRoot: File get() = File(filesDir, "distro")

    /** ubuntu-base-<ver>-base-<arch>.tar.gz + su sha, según la CPU del teléfono. */
    private data class Tarball(val url: String, val sha256: String)

    private fun tarballFor(): Tarball? {
        for (abi in Build.SUPPORTED_ABIS) {
            when (abi) {
                "arm64-v8a" -> return Tarball(
                    "$BASE_URL/ubuntu-base-$UBUNTU_VER-base-arm64.tar.gz", SHA_ARM64,
                )
                "x86_64" -> return Tarball(
                    "$BASE_URL/ubuntu-base-$UBUNTU_VER-base-amd64.tar.gz", SHA_AMD64,
                )
            }
        }
        return null
    }

    /** La distro está lista cuando el node de adentro existe. */
    fun isInstalled(): Boolean = File(distroRoot, "usr/bin/node").exists()

    /**
     * Instala la distro completa (idempotente por etapas): baja el rootfs, lo
     * verifica, lo extrae bajo proot con fake-root, configura DNS e instala Node.
     */
    fun install(onProgress: (String) -> Unit) {
        if (isInstalled()) { onProgress("La distro ya está instalada."); return }

        val free = BootstrapInstaller.availableBytes(context)
        if (free < MIN_FREE_BYTES) {
            throw IllegalStateException(
                "Espacio insuficiente: quedan ${free / (1024 * 1024)} MB y se necesitan " +
                    "al menos ${MIN_FREE_BYTES / (1024 * 1024)} MB para el entorno Linux completo.",
            )
        }

        val tb = tarballFor()
            ?: throw IllegalStateException("Arquitectura no soportada para la distro glibc.")

        val tmp = File(filesDir, "tmp").apply { mkdirs() }
        val tarGz = File(tmp, "rootfs.tar.gz")

        // 1) Descargar (en Kotlin, con la CA de Android → sin el cert roto del prefix)
        //    solo si no está ya bajado y verificado.
        if (!tarGz.exists() || sha256(tarGz) != tb.sha256) {
            onProgress("Descargando el entorno Linux completo (~30 MB)…")
            // Reintentos: en redes flojas la descarga se corta; en vez de romper el
            // primer arranque, reintentamos unas veces antes de rendirnos.
            var lastErr: Exception? = null
            var ok = false
            for (attempt in 1..3) {
                try {
                    download(tb.url, tarGz, onProgress)
                    if (sha256(tarGz) == tb.sha256) { ok = true; break }
                    onProgress("La descarga quedó incompleta, reintentando ($attempt/3)…")
                } catch (e: Exception) {
                    lastErr = e
                    onProgress("Fallo de red, reintentando ($attempt/3)…")
                }
                tarGz.delete()
            }
            if (!ok) {
                throw IllegalStateException(
                    "No se pudo descargar el entorno Linux. Revisá tu conexión e intentá de nuevo." +
                        (lastErr?.message?.let { " ($it)" } ?: ""),
                )
            }
        }

        // 2) Extraer el rootfs bajo proot con fake-root (para permisos/symlinks).
        onProgress("Descomprimiendo el entorno Linux…")
        val staging = File(filesDir, "distro-staging")
        if (staging.exists()) runtime.deleteRecursivePublic(staging)
        staging.mkdirs()
        val prefix = BootstrapInstaller.getPaths(context).prefixDir
        val extract = runtime.runRawProot(
            listOf(
                "--link2symlink", "-0",
                "$prefix/bin/tar", "-xzf", tarGz.absolutePath, "-C", staging.absolutePath,
            ),
        )
        // tar puede emitir warnings de chmod inofensivos; validamos por el resultado.
        if (!File(staging, "usr/bin").isDirectory && !File(staging, "bin").exists()) {
            throw IllegalStateException("Falló al descomprimir el entorno: ${extract.output.takeLast(200)}")
        }

        // 3) DNS + hosts (sin esto no hay red dentro de la distro).
        File(staging, "etc").mkdirs()
        File(staging, "etc/resolv.conf").writeText("nameserver 8.8.8.8\nnameserver 1.1.1.1\n")
        File(staging, "etc/hosts").writeText("127.0.0.1 localhost\n::1 localhost\n")
        File(staging, "tmp").mkdirs()
        File(staging, "root").mkdirs()

        // Publicar la distro (rename atómico) antes de instalar Node adentro.
        if (distroRoot.exists()) runtime.deleteRecursivePublic(distroRoot)
        if (!staging.renameTo(distroRoot)) {
            throw IllegalStateException("No se pudo finalizar la instalación del entorno.")
        }

        // 4) Instalar Node dentro de la distro (apt, SIN recomendados para no
        //    arrastrar cientos de MB de X11/servicios que además cuelgan bajo proot).
        onProgress("Instalando Node.js dentro del entorno…")
        // `musl` aporta el loader /lib/ld-musl-aarch64.so.1: muchos CLIs modernos
        // (incluido el binario nativo de Claude Code) se distribuyen musl-linked y
        // sin ese loader dan "required file not found" sobre un rootfs glibc.
        // `timeout` (coreutils, viene en ubuntu-base) evita que un apt colgado bajo
        // proot deje el primer arranque girando para siempre: si se pasa, muere,
        // node no queda instalado, y el setup muestra error + Reintentar en vez de
        // un spinner eterno.
        val apt = enter(
            "timeout 300 apt-get update && " +
                "timeout 1200 apt-get install -y --no-install-recommends nodejs npm ca-certificates musl " +
                "; node --version",
            onLine = { onProgress("· $it") },
        )
        if (!isInstalled()) {
            throw IllegalStateException("No se pudo instalar Node dentro del entorno: ${apt.output.takeLast(300)}")
        }
        onProgress("Entorno Linux completo listo.")
        Log.i(TAG, "Distro glibc instalada en ${distroRoot.absolutePath}")
    }

    /**
     * Construye el argv para correr un comando DENTRO de la distro glibc.
     * `guestArgv` corre con un entorno limpio; `binds` son pares host:guest extra
     * (además de /dev,/proc,/sys y los que el agente necesita).
     */
    fun enterArgv(
        guestArgv: List<String>,
        cwd: String,
        binds: List<Pair<String, String>> = emptyList(),
        guestEnv: Map<String, String> = emptyMap(),
    ): List<String> {
        val proot = runtime.prootBinaryPublic()
            ?: throw IllegalStateException("proot no disponible.")
        runtime.ensureProotLibsPublic()
        val defaultEnv = linkedMapOf(
            "HOME" to "/root",
            "PATH" to "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TERM" to "xterm-256color",
            "LANG" to "C.UTF-8",
            "DEBIAN_FRONTEND" to "noninteractive",
        )
        defaultEnv.putAll(guestEnv)
        return buildList {
            add(proot)
            add("-r"); add(distroRoot.absolutePath)
            add("-0")                        // fake-root: apt/dpkg necesitan uid 0
            add("--link2symlink")
            add("--kill-on-exit")
            add("-b"); add("/dev")
            add("-b"); add("/proc")
            add("-b"); add("/sys")
            for ((host, guest) in binds) { add("-b"); add("$host:$guest") }
            add("-w"); add(cwd)
            add("/usr/bin/env"); add("-i")
            for ((k, v) in defaultEnv) add("$k=$v")
            addAll(guestArgv)
        }
    }

    /** Corre un comando de shell dentro de la distro y captura la salida. */
    fun enter(
        command: String,
        binds: List<Pair<String, String>> = emptyList(),
        guestEnv: Map<String, String> = emptyMap(),
        onLine: (String) -> Unit = {},
    ): RuntimeManager.Result {
        val argv = enterArgv(
            listOf("/bin/bash", "-lc", command),
            cwd = "/root",
            binds = binds,
            guestEnv = guestEnv,
        )
        return runtime.runArgv(argv, onLine)
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(1 shl 16)
            var n = input.read(buf)
            while (n != -1) { md.update(buf, 0, n); n = input.read(buf) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Descarga con la CA de Android (evita el cert.pem roto del prefix). */
    private fun download(url: String, dest: File, onProgress: (String) -> Unit) {
        var current = url
        var redirects = 0
        while (true) {
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                connectTimeout = 30_000
                readTimeout = 60_000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "NovaClaw/1.0")
            }
            val code = conn.responseCode
            if (code in 300..399 && redirects < 5) {
                val loc = conn.getHeaderField("Location") ?: break
                conn.disconnect()
                current = if (loc.startsWith("http")) loc else URL(URL(current), loc).toString()
                redirects++
                continue
            }
            if (code != 200) {
                conn.disconnect()
                throw IllegalStateException("Descarga falló (HTTP $code) para $current")
            }
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                FileOutputStream(dest).use { out ->
                    val buf = ByteArray(1 shl 16)
                    var read = 0L
                    var lastPct = -1
                    var n = input.read(buf)
                    while (n != -1) {
                        out.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val pct = (read * 100 / total).toInt()
                            if (pct >= lastPct + 10) { onProgress("Descargando… $pct%"); lastPct = pct }
                        }
                        n = input.read(buf)
                    }
                }
            }
            conn.disconnect()
            return
        }
        throw IllegalStateException("Demasiados redirects descargando $url")
    }
}
