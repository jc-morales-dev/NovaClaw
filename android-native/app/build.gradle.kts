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
        // targetSdk 34 por defecto: la app ya NO depende del truco de targetSdk 28.
        // En 29+ Android impone W^X (SELinux) y NO se pueden ejecutar binarios desde
        // el data dir; NovaClaw lo sortea corriendo todo bajo `proot` (binario en
        // nativeLibraryDir, ejecutable en cualquier targetSdk). Ver RuntimeManager.
        //
        // Requisito de build: correr scripts/fetch-proot-so.sh para poblar
        // src/main/jniLibs con proot + loader ANTES de compilar el APK de 34.
        //
        // Escape hatch: para reproducir el camino DIRECT histórico (validado en el
        // OPPO, sin proot), compilá con -Pnovaclaw.targetSdk=28.
        targetSdk = (project.findProperty("novaclaw.targetSdk") as String?)?.toInt() ?: 34
        versionCode = 2
        versionName = "0.2.0"
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
                // v3 permite ROTAR la clave si algún día se compromete, sin
                // perder la identidad de la app. v1 no aplica: minSdk es 24.
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            // R8: achica y ofusca. Lo que se resuelve por reflexión o por nombre
            // (Shizuku, clases del manifest, @JavascriptInterface) está protegido
            // en proguard-rules.pro — sin esas reglas la app compila igual y
            // revienta recién en el teléfono.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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

    // proot + loader viajan como .so en jniLibs. useLegacyPackaging=true fuerza a
    // Android a EXTRAERLOS al disco (nativeLibraryDir), condición para poder
    // ejecutarlos: un binario dentro del APK comprimido no tiene ruta ejecutable.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
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
    // Huella/PIN para confirmar la instalación de un MCP nuevo (BiometricPrompt).
    implementation("androidx.biometric:biometric:1.1.0")

    // Fase 3: Shizuku — permiso y estado del servicio privilegiado.
    // El agente ejecuta los comandos vía el binario `rish` (assets/shizuku),
    // pero la app necesita la API para pedir/consultar el permiso.
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}
