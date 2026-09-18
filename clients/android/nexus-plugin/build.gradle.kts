plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.nexus.plugin"
    compileSdk = 36

    defaultConfig {
        // 21 matches the gomobile -androidapi in core/scripts/build-android.sh. The two must
        // agree: a lower minSdk than the AAR was built for links but crashes at runtime on
        // old devices.
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs {
            // The gomobile AAR ships one .so per ABI and they are large. Splitting by ABI at
            // the app level is what keeps the download reasonable; do not bundle all four.
            useLegacyPackaging = false
        }
    }
}

dependencies {
    // Capacitor. Version must match the app's — a mismatched Plugin base class fails at
    // runtime with a confusing NoSuchMethodError rather than at build time.
    implementation("com.capacitorjs:core:+")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")

    // The gomobile output: libbox + nexuscore, bound together in one invocation.
    // Produced by core/scripts/build-android.sh — see core/README.md for why they must be
    // bound together rather than separately.
    implementation(files("libs/nexus.aar"))
}
