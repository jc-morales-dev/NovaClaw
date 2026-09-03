# Reglas de R8/ProGuard para el APK de release.
#
# El riesgo de minificar esta app no es el código propio: es todo lo que se
# resuelve por REFLEXIÓN o por nombre desde fuera del bytecode. R8 no puede ver
# esos usos, los da por muertos y los borra — y el fallo aparece recién en
# runtime, no al compilar. De ahí que cada bloque diga QUÉ lo alcanza.

# ── Shizuku ──────────────────────────────────────────────────────────────────
# ShizukuProvider se declara en el AndroidManifest por nombre de clase, y la
# librería resuelve el binder por reflexión. Si R8 renombra algo, la app pierde
# el acceso privilegiado sin ningún error visible.
-keep class rikka.shizuku.** { *; }
-keep class moe.shizuku.** { *; }
-dontwarn rikka.shizuku.**

# ── Clases referenciadas desde el AndroidManifest ────────────────────────────
# Activity, Service, Receiver y Provider se instancian por nombre: si se
# renombran, Android no los encuentra y la app no arranca.
-keep class app.novaclaw.MainActivity { *; }
-keep class app.novaclaw.NovaClawService { *; }
-keep class app.novaclaw.PackageRemovedReceiver { *; }

# ── Puente WebView ↔ Kotlin ──────────────────────────────────────────────────
# @JavascriptInterface se invoca desde JS por el NOMBRE del método. R8 no ve
# ninguna llamada desde Kotlin y los borraría: ahí muere el bridge con la UI.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class * implements android.webkit.WebViewClient { *; }

# ── AndroidX / Material ──────────────────────────────────────────────────────
# Los layouts inflan vistas por nombre de clase desde XML.
-keep public class * extends android.view.View {
    public <init>(android.content.Context);
    public <init>(android.content.Context, android.util.AttributeSet);
    public <init>(android.content.Context, android.util.AttributeSet, int);
}

# ── BiometricPrompt ──────────────────────────────────────────────────────────
# Callbacks invocados por el framework.
-keep class androidx.biometric.** { *; }

# ── Diagnóstico ──────────────────────────────────────────────────────────────
# Sin esto los stack traces de producción llegan con líneas inútiles y no se
# puede saber dónde reventó. El mapping queda en build/outputs/mapping/.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Anotaciones y firmas genéricas que usan las librerías en runtime.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
