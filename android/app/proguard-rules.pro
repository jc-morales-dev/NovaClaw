# ── NovaClaw ProGuard Rules ──────────────────────────────────────────────────

# Preserve line numbers for crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ── Capacitor core ───────────────────────────────────────────────────────────
-keep class com.getcapacitor.** { *; }
-keepclassmembers class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }

# ── NovaClaw native plugins ──────────────────────────────────────────────────
-keep class com.novaclaw.app.plugins.** { *; }
-keepclassmembers class com.novaclaw.app.plugins.** { *; }

# ── JNI bridge ───────────────────────────────────────────────────────────────
-keep class com.novaclaw.app.NovaClawBootstrapLoader { *; }
-keepclassmembers class com.novaclaw.app.NovaClawBootstrapLoader { *; }

# ── Android Keystore / crypto ────────────────────────────────────────────────
-keep class javax.crypto.** { *; }
-keep class java.security.** { *; }

# ── AndroidX / Support Library ───────────────────────────────────────────────
-keep class androidx.** { *; }
-keepclassmembers class androidx.** { *; }
-dontwarn androidx.**

# ── Kotlin stdlib ────────────────────────────────────────────────────────────
-dontwarn kotlin.**
-keep class kotlin.** { *; }
-keepclassmembers class kotlin.** { *; }

# ── WebView JS interface ─────────────────────────────────────────────────────
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── Suppress warnings for native methods ─────────────────────────────────────
-dontwarn com.novaclaw.app.**
