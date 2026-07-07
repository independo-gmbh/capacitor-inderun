plugins {
    id("com.android.library") version "9.2.1"
}

android {
    namespace = "app.independo.inderun.capacitor"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    compileOnly("com.capacitorjs:core:8.4.1")
    testImplementation("com.capacitorjs:core:8.4.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.19.0")
    implementation("app.independo.inderun:inderun-contracts:0.1.2")
    implementation("app.independo.inderun:inderun-core:0.1.2")
    implementation("app.independo.inderun:inderun-kotlin:0.1.2")
    implementation("app.independo.inderun:inderun-mlkit-providers:0.1.2")
    implementation("app.independo.inderun:inderun-openai-providers:0.1.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260522")
}
