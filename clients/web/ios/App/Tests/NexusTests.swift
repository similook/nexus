import Network
import NetworkExtension
import XCTest

@testable import App

/// Unit tests for the iOS app's own Swift, run on the Simulator in CI (ios-phase1.yml). What
/// needs the tunnel or a real network stays for the device session (ios-plan/DEVICE-SESSION.md);
/// these use loopback only.
final class NexusRouterTests: XCTestCase {
    private let router: NexusRouter = {
        var router = NexusRouter()
        router.basePath = "/bundle/public"
        return router
    }()

    func testStartPathAndRoutesServeIndex() {
        for path in ["", "/", "/servers", "/settings/advanced"] {
            XCTAssertEqual(router.route(for: path), "/bundle/public/index.html", "path \(path)")
        }
    }

    func testFilesAreServedAsThemselves() {
        XCTAssertEqual(router.route(for: "/assets/index-abc.js"), "/bundle/public/assets/index-abc.js")
        XCTAssertEqual(router.route(for: "/cordova.js"), "/bundle/public/cordova.js")
    }

    /// The bug it replaces: with a working directory such as App.app, CapacitorRouter served the
    /// public folder itself for the start URL's empty path.
    func testTheWorkingDirectoryDoesNotMatter() {
        let previous = FileManager.default.currentDirectoryPath
        defer { FileManager.default.changeCurrentDirectoryPath(previous) }
        XCTAssertTrue(FileManager.default.changeCurrentDirectoryPath(Bundle.main.bundlePath))
        XCTAssertEqual(router.route(for: ""), "/bundle/public/index.html")
    }
}

final class ProbeResolverTests: XCTestCase {
    func testFakeIPRange() {
        for literal in ["198.18.0.1", "198.19.255.254", "198.18.10.20"] {
            XCTAssertTrue(ProbeResolver.isFakeIP(literal), literal)
        }
        for literal in ["198.17.255.255", "198.20.0.1", "203.0.113.9", "::1", "fe80::1"] {
            XCTAssertFalse(ProbeResolver.isFakeIP(literal), literal)
        }
    }

    /// The DNSServiceGetAddrInfo path end to end, unscoped: both families answered, then done.
    func testResolvesLocalhostWithinTheTimeout() {
        let started = Date()
        let answers = ProbeResolver(interfaceIndex: 0).resolve("localhost").split(separator: ",").map(String.init)
        XCTAssertLessThan(Date().timeIntervalSince(started), ProbeResolver.timeout + 1)
        XCTAssertTrue(answers.contains("127.0.0.1") || answers.contains("::1"), "answers \(answers)")
    }

    func testUnresolvableAndEmptyNamesGiveNothing() {
        XCTAssertEqual(ProbeResolver(interfaceIndex: 0).resolve(""), "")
        XCTAssertEqual(ProbeResolver(interfaceIndex: 0).resolve("nexus-test.invalid"), "")
    }
}

final class TCPPingerTests: XCTestCase {
    /// A listener on loopback answers; a port nobody listens on does not.
    func testOpenAndClosedPorts() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            connection.cancel()
        }
        let ready = expectation(description: "listener ready")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.start(queue: .global())
        wait(for: [ready], timeout: 5)
        defer { listener.cancel() }
        let open = try XCTUnwrap(listener.port?.rawValue)

        let done = expectation(description: "pinged")
        var results: [[String: Any]] = []
        TCPPinger.run([
            .init(id: "open", host: "127.0.0.1", port: open),
            .init(id: "closed", host: "127.0.0.1", port: 9),
        ], interface: nil) {
            results = $0
            done.fulfill()
        }
        wait(for: [done], timeout: TCPPinger.timeout + 3)

        let ms = Dictionary(uniqueKeysWithValues: results.map { ($0["id"] as? String ?? "", $0["ms"] as? Int ?? -2) })
        XCTAssertGreaterThanOrEqual(ms["open"] ?? -2, 1)
        XCTAssertEqual(ms["closed"], -1)
    }
}

final class AppMessageTests: XCTestCase {
    func testRoundTrip() throws {
        let reload = try JSONDecoder().decode(
            AppMessage.self, from: JSONEncoder().encode(AppMessage.reload(config: "{}", name: "node"))
        )
        XCTAssertEqual(reload.op, .reload)
        XCTAssertEqual(reload.config, "{}")
        XCTAssertEqual(reload.name, "node")

        let visible = try JSONDecoder().decode(AppMessage.self, from: JSONEncoder().encode(AppMessage.uiForeground(true)))
        XCTAssertEqual(visible.op, .uiForeground)
        XCTAssertEqual(visible.on, true)
    }

    func testReplyWithoutErrorMeansDone() throws {
        let reply = try JSONDecoder().decode(AppMessage.Reply.self, from: Data("{}".utf8))
        XCTAssertNil(reply.error)
    }
}

final class TunnelManagerTests: XCTestCase {
    func testServiceStateMapping() {
        XCTAssertEqual(TunnelManager.serviceState(of: .connected), "started")
        XCTAssertEqual(TunnelManager.serviceState(of: .connecting), "starting")
        XCTAssertEqual(TunnelManager.serviceState(of: .reasserting), "starting")
        XCTAssertEqual(TunnelManager.serviceState(of: .disconnecting), "stopped")
        XCTAssertEqual(TunnelManager.serviceState(of: .disconnected), "stopped")
        XCTAssertEqual(TunnelManager.serviceState(of: .invalid), "stopped")
    }
}
