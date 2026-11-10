// swift-tools-version: 5.9
import PackageDescription

// CI-only. `swift build` on macOS never compiles the plugin sources (they sit behind
// `#if canImport(Capacitor)`, and the macOS build has no Capacitor), and building the root
// package's own scheme for iOS fails with "module 'Cordova' not found", because the plugin
// target depends only on the Capacitor product and a Capacitor app is what supplies Cordova.
// This package plays that app: it depends on the plugin and on Capacitor + Cordova, so
// `xcodebuild -scheme Probe -destination 'generic/platform=iOS Simulator' build`
// (from this directory) compiles IndeRunCapacitorPlugin for the iOS simulator. Not published.
let package = Package(
    name: "Probe",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "Probe", targets: ["Probe"])
    ],
    dependencies: [
        .package(path: "../.."),
        // Keep in step with the range in the root Package.swift.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "Probe",
            dependencies: [
                .product(name: "IndeRunCapacitor", package: "capacitor-inderun"),
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ]
        )
    ]
)
