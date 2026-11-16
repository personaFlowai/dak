// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Dak",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "Dak", path: "Sources/DakApp"),
    ]
)
