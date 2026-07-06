package com.novaclaw.app.plugins

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.terminal.TerminalEmulator
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * PtyPlugin — Interactive PTY terminal using com.termux:terminal-emulator.
 *
 * Provides persistent terminal sessions with real PTY (pseudo-terminal),
 * enabling interactive programs like vim, htop, tail -f, python REPL, etc.
 *
 * This complements ShellPlugin (which is request/response for agent tool calls).
 * PtyPlugin is for the human user's interactive terminal.
 *
 * Methods:
 *   createSession(cwd?) — starts a new PTY session, returns sessionId
 *   write(sessionId, data) — sends input to the PTY's stdin
 *   resize(sessionId, cols, rows) — resizes the terminal
 *   destroySession(sessionId) — kills the PTY process
 *
 * Events emitted to JS:
 *   "pty-output" — { sessionId, data } with raw terminal output bytes
 *   "pty-exit" — { sessionId, exitCode } when the session process exits
 */
@CapacitorPlugin(
    name = "Pty",
    events = ["pty-output", "pty-exit"]
)
class PtyPlugin : Plugin() {

    companion object {
        private const val TAG = "NovaClaw/Pty"
        private const val DEFAULT_COLS = 80
        private const val DEFAULT_ROWS = 24
    }

    private val sessions = ConcurrentHashMap<String, TerminalSession>()
    private var sessionCounter = 0

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        for ((_, session) in sessions) {
            session.finishIfRunning()
        }
        sessions.clear()
    }

    @PluginMethod
    fun createSession(call: PluginCall) {
        val cwd = call.getString("cwd") ?: context.filesDir.absolutePath + "/workspace"
        val cols = call.getInt("cols", DEFAULT_COLS)
        val rows = call.getInt("rows", DEFAULT_ROWS)

        val cwdDir = File(cwd)
        if (!cwdDir.exists()) cwdDir.mkdirs()

        val sessionId = "pty-${++sessionCounter}"

        val prefixDir = File(context.filesDir, "usr")
        val shellPath = if (File(prefixDir, "bin/bash").exists()) {
            prefixDir.absolutePath + "/bin/bash"
        } else {
            "/system/bin/sh"
        }

        val env = mutableListOf(
            "HOME=${context.filesDir.absolutePath}/home",
            "PATH=${prefixDir.absolutePath}/bin:/system/bin:/system/xbin",
            "PREFIX=${prefixDir.absolutePath}",
            "TERM=xterm-256color",
            "ANDROID_DATA=/data",
            "ANDROID_ROOT=/system"
        )
        if (File(prefixDir, "lib").exists()) {
            env.add("LD_LIBRARY_PATH=${prefixDir.absolutePath}/lib")
        }

        val callback = object : TerminalSessionClient {
            override fun onTextChanged(changedSession: TerminalSession) {
                // Terminal output is handled by the TerminalEmulator internally.
                // We read the transcript and emit it to JS.
                val transcript = changedSession.transcriptText
                if (transcript != null && transcript.isNotEmpty()) {
                    val outputData = JSObject().apply {
                        put("sessionId", sessionId)
                        put("data", transcript)
                    }
                    notifyListeners("pty-output", outputData)
                }
            }

            override fun onTitleChanged(changedSession: TerminalSession) {
                // Could emit a title-change event in the future
            }

            override fun onSessionFinished(finishedSession: TerminalSession) {
                val exitCode = finishedSession.exitStatus
                val exitData = JSObject().apply {
                    put("sessionId", sessionId)
                    put("exitCode", exitCode)
                }
                notifyListeners("pty-exit", exitData)
                sessions.remove(sessionId)
            }

            override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {
                // Not used
            }

            override fun onPasteTextFromClipboard(session: TerminalSession) {
                // Not used
            }

            override fun onBell(session: TerminalSession) {
                // Not used
            }

            override fun onColorsChanged(session: TerminalSession) {
                // Not used
            }

            override fun onTerminalCursorStateChange(state: Boolean) {
                // Not used
            }

            override fun getTerminalCursorStyle(): Integer? {
                return TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
            }

            override fun logError(tag: String?, message: String?) {
                Log.e(tag ?: TAG, message ?: "")
            }

            override fun logWarn(tag: String?, message: String?) {
                Log.w(tag ?: TAG, message ?: "")
            }

            override fun logInfo(tag: String?, message: String?) {
                Log.i(tag ?: TAG, message ?: "")
            }

            override fun logDebug(tag: String?, message: String?) {
                Log.d(tag ?: TAG, message ?: "")
            }

            override fun logVerbose(tag: String?, message: String?) {
                Log.v(tag ?: TAG, message ?: "")
            }

            override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {
                Log.e(tag ?: TAG, message, e)
            }

            override fun logStackTrace(tag: String?, e: Exception?) {
                Log.e(tag ?: TAG, "", e)
            }
        }

        try {
            val session = TerminalSession(
                shellPath,
                cwd,
                null, // args — no extra arguments to the shell
                env.toTypedArray(),
                TerminalEmulator.DEFAULT_TERMINAL_TRANSCRIPT_ROWS,
                callback
            )

            session.updateSize(cols, rows)

            sessions[sessionId] = session

            call.resolve(JSObject().apply {
                put("sessionId", sessionId)
                put("shell", shellPath)
                put("cwd", cwd)
            })
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create PTY session", e)
            call.reject("Failed to create PTY session: ${e.message}", e)
        }
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val sessionId = call.getString("sessionId")
        val data = call.getString("data")
        if (sessionId.isNullOrBlank() || data == null) {
            call.reject("sessionId and data are required")
            return
        }

        val session = sessions[sessionId]
        if (session == null) {
            call.reject("Session not found: $sessionId")
            return
        }

        try {
            session.write(data)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to write to PTY: ${e.message}", e)
        }
    }

    @PluginMethod
    fun resize(call: PluginCall) {
        val sessionId = call.getString("sessionId")
        val cols = call.getInt("cols", DEFAULT_COLS)
        val rows = call.getInt("rows", DEFAULT_ROWS)
        if (sessionId.isNullOrBlank()) {
            call.reject("sessionId is required")
            return
        }

        val session = sessions[sessionId]
        if (session == null) {
            call.reject("Session not found: $sessionId")
            return
        }

        try {
            session.updateSize(cols, rows)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to resize PTY: ${e.message}", e)
        }
    }

    @PluginMethod
    fun destroySession(call: PluginCall) {
        val sessionId = call.getString("sessionId")
        if (sessionId.isNullOrBlank()) {
            call.reject("sessionId is required")
            return
        }

        val session = sessions.remove(sessionId)
        if (session != null) {
            session.finishIfRunning()
        }
        call.resolve()
    }
}
