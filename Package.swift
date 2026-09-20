// swift-tools-version: 5.9
import PackageDescription

// This manifest lives at the repo root so it is both the npm package's SwiftPM
// manifest (consumed by Capacitor's SwiftPM support) and directly resolvable by
// URL + git tag. The IndeRun Swift SDK is consumed as a released dependency from
// the main monorepo (github.com/independo-gmbh/inderun, tag vX.Y.Z).

let package = Package(
    name: "IndeRunCapacitor",
    platforms: [
        .iOS(.v15),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "IndeRunCapacitor",
            targets: ["IndeRunCapacitorPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // `exact:` rather than `from:` while tracking a prerelease: SwiftPM's range
        // operators exclude prerelease versions, so `from: "0.3.0-dev.14"` would
        // silently keep resolving 0.2.2 and fail on the missing stream(). Move back
        // to `from: "0.3.0"` once the stable release is out.
        .package(url: "https://github.com/independo-gmbh/inderun.git", exact: "0.3.0-dev.14")
    ],
    targets: [
        .target(
            name: "IndeRunCapacitorPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm", condition: .when(platforms: [.iOS])),
                .product(name: "IndeRun", package: "IndeRun"),
                .product(name: "IndeRunCore", package: "IndeRun"),
                .product(name: "IndeRunAppleProviders", package: "IndeRun"),
                .product(name: "IndeRunOpenAIProviders", package: "IndeRun")
            ],
            path: "ios/Sources/IndeRunCapacitorPlugin"
        ),
        .testTarget(
            name: "IndeRunCapacitorTests",
            dependencies: [
                .target(name: "IndeRunCapacitorPlugin"),
                .product(name: "IndeRun", package: "IndeRun"),
                .product(name: "IndeRunCore", package: "IndeRun"),
                .product(name: "IndeRunContracts", package: "IndeRun")
            ],
            path: "ios/Tests/IndeRunCapacitorTests"
        )
    ]
)
