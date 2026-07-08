package app.novaclaw

import android.content.Context
import android.os.Build
import android.os.StatFs
import android.system.Os
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.util.zip.ZipInputStream

/**
 * Extrae el bootstrap de Termux desde los assets del APK al directorio de datos
 * privado de la app, creando un entorno Linux usable sin root.
 *
 * Portado del módulo Android de openclaw-android-assistant (MIT), adaptado al
 * package app.novaclaw. Sigue la misma lógica que TermuxInstaller.java:
 *   1. Extraer todas las entradas del zip a un staging.
 *   2. Parsear SYMLINKS.txt y crear los symlinks.
 *   3. Poner permisos de ejecución en bin/, libexec/, lib/apt/methods/, *.so.
 *   4. Renombrar atómicamente staging -> prefix final.
 */
object BootstrapInstaller {

    private const val TAG = "NovaClaw/Bootstrap"

    /** Prefix original con el que se compiló el bootstrap de Termux. */
    private const val TERMUX_PREFIX = "/data/data/com.termux/files/usr"

    /** Espacio libre mínimo para extraer el bootstrap (~150 MB extraído + margen). */
    private const val MIN_FREE_BYTES: Long = 300L * 1024 * 1024

    fun availableBytes(context: Context): Long {
        return try {
            StatFs(context.filesDir.absolutePath).availableBytes
        } catch (e: Exception) {
            Log.w(TAG, "No se pudo medir el espacio libre: ${e.message}")
            Long.MAX_VALUE // ante la duda, no bloquear la instalación
        }
    }

    private fun toMb(bytes: Long): Long = bytes / (1024 * 1024)

    data class Paths(
        val filesDir: String,
        val prefixDir: String,
        val homeDir: String,
        val tmpDir: String,
    )

    fun getPaths(context: Context): Paths {
        val filesDir = context.filesDir.absolutePath
        return Paths(
            filesDir = filesDir,
            prefixDir = "$filesDir/usr",
            homeDir = "$filesDir/home",
            tmpDir = "$filesDir/usr/tmp",
        )
    }

    fun isBootstrapInstalled(context: Context): Boolean {
        val paths = getPaths(context)
        return File(paths.prefixDir).isDirectory && File(paths.prefixDir, "bin/sh").exists()
    }

    /**
     * Extrae bootstrap-<arch>.zip de los assets al prefix.
     * Es idempotente: si el prefix ya existe, retorna de inmediato.
     * @Synchronized evita condiciones de carrera si se invoca desde varios threads.
     */
    @Synchronized
    fun install(
        context: Context,
        onProgress: (String) -> Unit = {},
    ) {
        val paths = getPaths(context)
        val prefixFile = File(paths.prefixDir)

        if (prefixFile.isDirectory && File(prefixFile, "bin/sh").exists()) {
            Log.i(TAG, "Bootstrap ya instalado en ${paths.prefixDir}")
            return
        }

        // Preflight: sin espacio suficiente la extracción muere a medias y deja
        // un prefix corrupto. Mejor avisar claro ANTES de empezar.
        val free = availableBytes(context)
        if (free < MIN_FREE_BYTES) {
            throw RuntimeException(
                "Espacio insuficiente: quedan ${toMb(free)} MB libres y se necesitan " +
                    "al menos ${toMb(MIN_FREE_BYTES)} MB para el entorno Linux. " +
                    "Liberá espacio en el teléfono e intentá de nuevo."
            )
        }

        onProgress("Extrayendo el entorno Linux…")

        val stagingPath = "${paths.filesDir}/usr-staging"
        val stagingFile = File(stagingPath)
        if (stagingFile.exists()) {
            deleteRecursive(stagingFile)
        }

        val archName = determineArchName()
        val assetName = "bootstrap-$archName.zip"

        Log.i(TAG, "Extrayendo $assetName a $stagingPath")

        val buffer = ByteArray(8192)
        val symlinks = mutableListOf<Pair<String, String>>()

        // Cada flavor del APK trae SOLO su bootstrap (arm64 o x86). Si no está,
        // el usuario instaló el APK de la arquitectura equivocada.
        val assetStream = try {
            context.assets.open(assetName)
        } catch (e: Exception) {
            throw RuntimeException(
                "Este APK no incluye el entorno Linux para $archName. " +
                    "Instalá el APK correcto: 'arm64' para teléfonos, 'x86' para emulador.",
                e,
            )
        }

        assetStream.use { _ ->
            ZipInputStream(assetStream).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (entry.name == "SYMLINKS.txt") {
                        val reader = BufferedReader(InputStreamReader(zip))
                        var line = reader.readLine()
                        while (line != null) {
                            val parts = line.split("←")
                            if (parts.size == 2) {
                                var target = parts[0]
                                if (target.startsWith(TERMUX_PREFIX)) {
                                    target = target.replace(TERMUX_PREFIX, paths.prefixDir)
                                }
                                val linkPath = "$stagingPath/${parts[1]}"
                                symlinks.add(target to linkPath)
                                File(linkPath).parentFile?.let { ensureParentDir(it) }
                            }
                            line = reader.readLine()
                        }
                    } else {
                        val targetFile = File(stagingPath, entry.name)
                        val isDir = entry.isDirectory
                        ensureParentDir(if (isDir) targetFile else targetFile.parentFile!!)
                        if (isDir) {
                            targetFile.mkdirs()
                        } else {
                            FileOutputStream(targetFile).use { out ->
                                var len = zip.read(buffer)
                                while (len != -1) {
                                    out.write(buffer, 0, len)
                                    len = zip.read(buffer)
                                }
                            }
                            if (shouldBeExecutable(entry.name)) {
                                try {
                                    Os.chmod(targetFile.absolutePath, 0b111_000_000) // 0700
                                } catch (e: Exception) {
                                    Log.w(TAG, "chmod falló en ${entry.name}: ${e.message}")
                                }
                            }
                        }
                    }
                    entry = zip.nextEntry
                }
            }
        }

        if (symlinks.isEmpty()) {
            throw RuntimeException("No se encontró SYMLINKS.txt en el bootstrap")
        }

        onProgress("Creando symlinks…")
        for ((target, linkPath) in symlinks) {
            try {
                val linkFile = File(linkPath)
                if (linkFile.exists() || linkFile.isDirectory) {
                    deleteRecursive(linkFile)
                }
                Os.symlink(target, linkPath)
            } catch (e: Exception) {
                Log.w(TAG, "Falló symlink $linkPath -> $target: ${e.message}")
            }
        }

        if (prefixFile.exists()) {
            deleteRecursive(prefixFile)
        }
        if (!stagingFile.renameTo(prefixFile)) {
            throw RuntimeException("Falló renombrar $stagingPath a ${paths.prefixDir}")
        }

        File(paths.homeDir).mkdirs()
        File(paths.tmpDir).mkdirs()

        onProgress("Configurando el gestor de paquetes…")
        fixTermuxPaths(paths)

        Log.i(TAG, "Bootstrap instalado correctamente en ${paths.prefixDir}")
    }

    /**
     * El bootstrap se compiló para com.termux. Reescribe la config de apt y los
     * metadatos de dpkg para que apunten a nuestro prefix real.
     */
    private fun fixTermuxPaths(paths: Paths) {
        val prefix = paths.prefixDir

        val aptConf = File(prefix, "etc/apt/apt.conf")
        aptConf.parentFile?.mkdirs()
        aptConf.writeText(
            """
            Dir "/";
            Dir::State "$prefix/var/lib/apt/";
            Dir::State::status "$prefix/var/lib/dpkg/status";
            Dir::Cache "$prefix/var/cache/apt/";
            Dir::Log "$prefix/var/log/apt/";
            Dir::Etc "$prefix/etc/apt/";
            Dir::Etc::SourceList "$prefix/etc/apt/sources.list";
            Dir::Etc::SourceParts "";
            Dir::Bin::dpkg "$prefix/bin/dpkg";
            Dir::Bin::Methods "$prefix/lib/apt/methods/";
            Dir::Bin::apt-key "$prefix/bin/apt-key";
            Dpkg::Options:: "--force-configure-any";
            Dpkg::Options:: "--force-bad-path";
            Dpkg::Options:: "--instdir=$prefix";
            Acquire::AllowInsecureRepositories "true";
            """.trimIndent() + "\n"
        )

        File(prefix, "var/log/apt").mkdirs()

        val sourcesList = File(prefix, "etc/apt/sources.list")
        if (sourcesList.exists()) {
            val content = sourcesList.readText()
            sourcesList.writeText(
                content
                    .replace("https://", "http://")
                    .replace("com.termux", "app.novaclaw")
            )
        }

        val dpkgStatus = File(prefix, "var/lib/dpkg/status")
        if (dpkgStatus.exists()) {
            val content = dpkgStatus.readText()
            dpkgStatus.writeText(content.replace(TERMUX_PREFIX, prefix))
        }

        File(prefix, "var/lib/dpkg/info").mkdirs()
        File(prefix, "var/lib/dpkg/updates").mkdirs()
        File(prefix, "var/lib/dpkg/triggers").mkdirs()
        File(prefix, "var/cache/apt/archives/partial").mkdirs()
        File(prefix, "var/lib/apt/lists/partial").mkdirs()

        val dpkgInfoDir = File(prefix, "var/lib/dpkg/info")
        if (dpkgInfoDir.isDirectory) {
            dpkgInfoDir.listFiles()?.forEach { file ->
                if (file.name.endsWith(".list")) {
                    try {
                        val text = file.readText()
                        if (text.contains(TERMUX_PREFIX)) {
                            file.writeText(text.replace(TERMUX_PREFIX, prefix))
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Falló arreglar ${file.name}: ${e.message}")
                    }
                }
            }
        }

        Log.i(TAG, "Rutas Termux corregidas -> $prefix")
    }

    private fun shouldBeExecutable(entryName: String): Boolean {
        return entryName.startsWith("bin/") ||
            entryName.startsWith("libexec/") ||
            entryName.startsWith("lib/apt/methods/") ||
            entryName.startsWith("lib/bash/") ||
            entryName.endsWith(".so") ||
            entryName.contains("/bin/")
    }

    private fun ensureParentDir(dir: File) {
        if (!dir.isDirectory && !dir.mkdirs()) {
            if (!dir.isDirectory) {
                throw RuntimeException("No se pudo crear el directorio: ${dir.absolutePath}")
            }
        }
    }

    private fun determineArchName(): String {
        for (abi in Build.SUPPORTED_ABIS) {
            when (abi) {
                "arm64-v8a" -> return "aarch64"
                "armeabi-v7a" -> return "arm"
                "x86_64" -> return "x86_64"
                "x86" -> return "i686"
            }
        }
        throw RuntimeException(
            "Arquitectura de CPU no soportada: ${Build.SUPPORTED_ABIS.joinToString()}"
        )
    }

    private fun deleteRecursive(fileOrDir: File) {
        if (fileOrDir.isDirectory) {
            fileOrDir.listFiles()?.forEach { child -> deleteRecursive(child) }
        }
        fileOrDir.delete()
    }
}
