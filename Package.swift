// swift-tools-version: 5.9
import PackageDescription

// This manifest lives at the repo root so it is both the npm package's SwiftPM
// manifest (consumed by Capacitor's SwiftPM support) and directly resolvable by
// URL + git tag. The IndeRun Swift SDK is consumed as a released dependency from
// the main monorepo (github.com/independo-gmbh/inderun, tag vX.Y.Z).

let package = Package(
    name: "IndeRunCapacitor",
    platforms: [
        .iOS(.v16),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "IndeRunCapacitor",
            targets: ["IndeRunCapacitorPlugin"]
        ),
        // The Capacitor CLI derives a product name from the npm package name
        // (`@independo/capacitor-inderun` -> `IndependoCapacitorInderun`) and writes exactly
        // that into the app's generated CapApp-SPM manifest. Without a product under this
        // name, `cap add ios` produces a project that cannot resolve its dependencies at all.
        // Kept alongside the original name rather than replacing it, so anything already
        // depending on `IndeRunCapacitor` by URL keeps resolving.
        .library(
            name: "IndependoCapacitorInderun",
            targets: ["IndeRunCapacitorPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // `exact:` while the bridge tracks an inderun prerelease: SwiftPM's range operators
        // exclude prereleases, so `.upToNextMinor(from: "0.5.0-rc.N")` would silently resolve
        // an older stable. Go back to `.upToNextMinor(from:)` once a stable 0.5.0 is pinned,
        // so a consumer that also depends on `inderun` directly can unify the graph. See the
        // versioning policy in AGENTS.md.
        .package(url: "https://github.com/independo-gmbh/inderun.git", exact: "0.5.0-rc.20")
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
