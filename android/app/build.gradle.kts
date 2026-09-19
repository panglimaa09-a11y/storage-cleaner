plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.panglimaa.storagecleaner"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.panglimaa.storagecleaner"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.1.0"
    }
}
