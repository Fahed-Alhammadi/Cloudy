import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Release signing comes from keystore.properties (git-ignored), see README.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "io.cloudy.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.cloudy.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 27
        versionName = "1.16.1"
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        // Installs next to the Play version (a different signing key) for testing.
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // Only the languages the app is translated into (keeps library translations for others out of the APK).
    androidResources {
        localeFilters += listOf("en", "ar", "de", "fr", "es")
    }
    // Every language ships in the bundle: the in-app language switch needs them even when the phone's language differs.
    bundle {
        language { enableSplit = false }
    }
}

// AGP 9 compiles Kotlin itself (built-in Kotlin): no org.jetbrains.kotlin.android plugin, options live here.
kotlin {
    compilerOptions { jvmTarget = JvmTarget.JVM_17 }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.10.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.5.1")
    // App lock (fingerprint / face / screen lock) and the document scanner (Google Play services, no camera permission).
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.9.1")
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0")
}
