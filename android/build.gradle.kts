buildscript {
    dependencies {
        // AGP's built-in Kotlin support defaults to Kotlin Gradle Plugin 2.2.10,
        // which can't read inderun-contracts' 2.4.x metadata. Putting a newer KGP
        // on the buildscript classpath (without applying org.jetbrains.kotlin.android,
        // which would register competing compile tasks) elevates the version AGP's
        // built-in Kotlin compilation actually resolves and uses.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10")
    }
}

plugins {
    // No version here on purpose. When a Capacitor app includes this module, AGP is already
    // on the app's classpath and a versioned request fails with "the plugin is already on the
    // classpath with an unknown version, so compatibility cannot be checked" — i.e. the plugin
    // could not be consumed at all. The version for a standalone build of this directory is
    // declared in settings.gradle's pluginManagement instead, which a consuming app's own
    // settings file replaces.
    id("com.android.library")
}

android {
    namespace = "app.independo.inderun.capacitor"
    compileSdk = 37

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
    compileOnly("com.capacitorjs:core:8.0.0")
    testImplementation("com.capacitorjs:core:8.0.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("app.independo.inderun:inderun-contracts:0.3.0")
    implementation("app.independo.inderun:inderun-core:0.3.0")
    implementation("app.independo.inderun:inderun-kotlin:0.3.0")
    implementation("app.independo.inderun:inderun-mlkit-providers:0.3.0")
    implementation("app.independo.inderun:inderun-openai-providers:0.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260522")
}
