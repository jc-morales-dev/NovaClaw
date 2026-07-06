package com.novaclaw.app.plugins

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * ShellPlugin — Shell 100% autónoma, sin Termux.
 *
 * Usa /system/bin/sh (incluido en todo Android) con ProcessBuilder.
 * El workspace vive en el storage privado de la app, siempre escribible
 * sin permisos extra:  /data/data/com.novaclaw.app/files/workspace/
 *
 * Métodos:
 *  run(command, cwd, timeoutMs?)  — ejecuta un comando de shell
 *  writeFile(path, content)       — escribe un archivo directamente desde Kotlin
 *  readFile(path)                 — lee un archivo directamente desde Kotlin
 *  getWorkspaceRoot()             — devuelve la ruta del workspace
 *  isReady()                      — true si el workspace ya fue inicializado
 */
@CapacitorPlugin(name = "Shell")
class ShellPlugin : Plugin() {

    companion object {
        private val EXECUTOR = Executors.newCachedThreadPool()
        private const val CWD_MARKER = "__NOVA_CWD__:"

        /** Escaping mínimo POSIX single-quote para inyección de shell segura. */
        private fun sq(s: String) = "'${s.replace("'", "'\\''")}'"
    }

    /** Ruta raíz del workspace privado de la app. */
    private val workspaceRoot: String by lazy {
        "${context.filesDir.absolutePath}/workspace"
    }

    /** Shell disponible en el sistema. */
    private val shellPath: String by lazy {
        listOf("/system/bin/sh", "/bin/sh", "/system/xbin/sh").firstOrNull {
            File(it).exists()
        } ?: "/system/bin/sh"
    }

    // ─── run ──────────────────────────────────────────────────────────────────

    @PluginMethod
    fun run(call: PluginCall) {
        val command    = call.getString("command") ?: run { call.reject("command required"); return }
        val cwd        = call.getString("cwd") ?: workspaceRoot
        val timeoutMs  = (call.getInt("timeoutMs") ?: 30_000).toLong()

        EXECUTOR.submit {
            try {
                val result = execute(command, cwd, timeoutMs)
                call.resolve(result)
            } catch (e: Exception) {
                call.resolve(JSObject().apply {
                    put("status",   "error")
                    put("output",   "ShellPlugin error: ${e.message}")
                    put("exitCode", -1)
                    put("cwd",      cwd)
                })
            }
        }
    }

    // ─── writeFile ────────────────────────────────────────────────────────────

    @PluginMethod
    fun writeFile(call: PluginCall) {
        val path    = call.getString("path")    ?: run { call.reject("path required"); return }
        val content = call.getString("content") ?: ""

        EXECUTOR.submit {
            try {
                val file = resolveFile(path)
                file.parentFile?.mkdirs()
                file.writeText(content, Charsets.UTF_8)
                call.resolve(JSObject().apply {
                    put("success", true)
                    put("path",    file.absolutePath)
                })
            } catch (e: Exception) {
                call.reject("writeFile failed: ${e.message}", e)
            }
        }
    }

    // ─── readFile ─────────────────────────────────────────────────────────────

    @PluginMethod
    fun readFile(call: PluginCall) {
        val path = call.getString("path") ?: run { call.reject("path required"); return }

        EXECUTOR.submit {
            try {
                val file = resolveFile(path)
                if (!file.exists()) {
                    call.reject("File not found: ${file.absolutePath}")
                    return@submit
                }
                val content = file.readText(Charsets.UTF_8)
                call.resolve(JSObject().apply {
                    put("content", content)
                    put("path",    file.absolutePath)
                })
            } catch (e: Exception) {
                call.reject("readFile failed: ${e.message}", e)
            }
        }
    }

    // ─── getWorkspaceRoot ─────────────────────────────────────────────────────

    @PluginMethod
    fun getWorkspaceRoot(call: PluginCall) {
        call.resolve(JSObject().apply { put("path", workspaceRoot) })
    }

    // ─── isReady ─────────────────────────────────────────────────────────────

    @PluginMethod
    fun isReady(call: PluginCall) {
        val ready = File(workspaceRoot, ".nova_ready").exists()
        call.resolve(JSObject().apply {
            put("ready",         ready)
            put("workspaceRoot", workspaceRoot)
        })
    }

    // ─── Internal execution engine ────────────────────────────────────────────

    /**
     * Ejecuta un comando en el shell del sistema.
     *
     * Estrategia de cwd tracking:
     *  Envuelve el comando en una sub-shell que imprime __NOVA_CWD__:<pwd>
     *  al final del stdout, sin importar si el comando cambia de directorio.
     *  De este modo `cd proyecto && ls` actualiza el cwd en el frontend.
     */
    private fun execute(command: String, cwd: String, timeoutMs: Long): JSObject {
        // Asegurar que el cwd existe antes de ejecutar
        val cwdFile = File(cwd.ifBlank { workspaceRoot })
        val effectiveCwd = if (cwdFile.isDirectory) cwdFile else File(workspaceRoot).also { it.mkdirs() }

        // Wrapper que captura el cwd real después de ejecutar el comando
        val wrapped = """
            (
              ${command}
              echo "${CWD_MARKER}$(pwd)"
            ) 2>&1
        """.trimIndent()

        val pb = ProcessBuilder(shellPath, "-c", wrapped).apply {
            directory(effectiveCwd)
            environment().apply {
                put("HOME",    workspaceRoot)
                put("TMPDIR",  "${context.cacheDir.absolutePath}")
                put("PATH",    "/system/bin:/system/xbin:/data/data/com.novaclaw.app/files/bin")
                put("TERM",    "xterm-256color")
                put("NOVA_WORKSPACE", workspaceRoot)
                // Quitar variables que pueden causar problemas en un env Android mínimo
                remove("LD_PRELOAD")
            }
            redirectErrorStream(true)
        }

        val proc = pb.start()
        val outputBuilder = StringBuilder()

        // Leer la salida completa en un thread separado
        val readerFuture = EXECUTOR.submit<Unit> {
            BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    outputBuilder.append(line).append('\n')
                }
            }
        }

        val finished = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)

        if (!finished) {
            proc.destroyForcibly()
            return JSObject().apply {
                put("status",   "error")
                put("output",   "Command timed out after ${timeoutMs}ms")
                put("exitCode", -2)
                put("cwd",      effectiveCwd.absolutePath)
            }
        }

        readerFuture.get(5, TimeUnit.SECONDS)
        val exitCode = proc.exitValue()
        val raw = outputBuilder.toString()

        // Extraer el cwd del marcador y limpiar la salida
        val markerIdx = raw.lastIndexOf(CWD_MARKER)
        val (cleanOutput, resolvedCwd) = if (markerIdx >= 0) {
            val out = raw.substring(0, markerIdx).trimEnd('\n')
            val newCwd = raw.substring(markerIdx + CWD_MARKER.length).trim()
            out to newCwd.ifBlank { effectiveCwd.absolutePath }
        } else {
            raw.trimEnd('\n') to effectiveCwd.absolutePath
        }

        return JSObject().apply {
            put("status",   if (exitCode == 0) "success" else "error")
            put("output",   cleanOutput.ifBlank { "(no output)" })
            put("exitCode", exitCode)
            put("cwd",      resolvedCwd)
        }
    }

    /** Resuelve una ruta relativa o absoluta contra el workspace. */
    private fun resolveFile(path: String): File {
        val expanded = path.replace("~", workspaceRoot)
        return if (File(expanded).isAbsolute) File(expanded)
        else File(workspaceRoot, expanded)
    }
}
