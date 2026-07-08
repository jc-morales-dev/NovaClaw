import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firma de release (fuera de git). Si falta keystore.properties, el release usa
// la firma debug para no romper el build en máquinas sin la key.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) load(FileInputStream(keystorePropsFile))
}

android {
    namespace = "app.novaclaw"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.novaclaw"
        minSdk = 24
        // targetSdk 28 permite ejecutar binarios desde el data dir de la app.
        // Android 10+ (targetSdk 29+) impone W^X y lo bloquea vía SELinux.
        // Termux (F-Droid) usa el mismo enfoque. Se distribuye por sideload/GitHub, no Play.
        targetSdk = 28
        versionCode = 1
        versionName = "0.1.0-fase1"
    }

    // Un APK por arquitectura: cada flavor empaqueta SOLO su bootstrap
    // (assets en src/<flavor>/assets/), así el APK del teléfono no arrastra
    // los ~29 MB del bootstrap x86_64 del emulador (y viceversa).
    //   Teléfono real:  ./gradlew assembleArm64Release  (o Arm64Debug)
    //   Emulador x86:   ./gradlew assembleX86Debug
    flavorDimensions += "arch"
    productFlavors {
        create("arm64") {
            dimension = "arch"
            ndk { abiFilters += listOf("arm64-v8a") }
        }
        create("x86") {
            dimension = "arch"
            ndk { abiFilters += listOf("x86_64") }
        }
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps["storeFile"] as String)
                storePassword = keystoreProps["storePassword"] as String
                keyAlias = keystoreProps["keyAlias"] as String
                keyPassword = keystoreProps["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePropsFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }

    // No comprimir el bootstrap en assets: se lee directo por streaming.
    androidResources {
        noCompress += listOf("zip")
    }

    // NovaClaw usa targetSdk 28 a propósito (ejecutar binarios sin root) y se
    // distribuye por sideload/GitHub, NO por Google Play. El lint "vital" de
    // release aborta por ExpiredTargetSdkVersion (regla de Play), que no aplica.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
        disable += "ExpiredTargetSdkVersion"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // Fase 3: Shizuku — permiso y estado del servicio privilegiado.
    // El agente ejecuta los comandos vía el binario `rish` (assets/shizuku),
    // pero la app necesita la API para pedir/consultar el permiso.
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}
