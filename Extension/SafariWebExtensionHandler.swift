import Foundation
import SafariServices
import os

private let log = Logger(subsystem: "ai.sebastiaan.RejectCookies", category: "native")

/// Answers `browser.runtime.sendNativeMessage` calls from web/src/background.ts.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let request = Self.parse(item?.userInfo?[SFExtensionMessageKey])
        nonisolated(unsafe) let context = context
        Task {
            let response = await Self.respond(to: request)
            let reply = NSExtensionItem()
            reply.userInfo = [SFExtensionMessageKey: response]
            context.completeRequest(returningItems: [reply])
        }
    }

    private struct Request: Decodable, Sendable {
        var type: String
        var dialog: DialogSnapshot?
    }

    private static func parse(_ message: Any?) -> Result<Request, Error> {
        Result {
            guard let message, JSONSerialization.isValidJSONObject(message) else { throw HandlerError.badMessage }
            return try JSONDecoder().decode(Request.self, from: JSONSerialization.data(withJSONObject: message))
        }
    }

    private static func respond(to parsed: Result<Request, Error>) async -> [String: Any] {
        do {
            let request = try parsed.get()
            switch (request.type, request.dialog) {
            case ("availability", _):
                let availability = ConsentDecider.availability
                var body: [String: Any] = ["available": availability.available]
                if let reason = availability.reason { body["reason"] = reason }
                return ["ok": true, "availability": body]
            case ("decide", let dialog?):
                let started = ContinuousClock.now
                let decision = try await ConsentDecider.decide(dialog)
                log.info("\(dialog.host, privacy: .public): \(decision.kind.rawValue, privacy: .public) target=\(decision.target) in \(ContinuousClock.now - started, privacy: .public)")
                return ["ok": true, "decision": [
                    "kind": decision.kind.rawValue,
                    "target": decision.target,
                    "turnOff": decision.turnOff,
                ]]
            default:
                throw HandlerError.badMessage
            }
        } catch {
            log.error("native request failed: \(String(describing: error), privacy: .public)")
            return ["ok": false, "error": String(describing: error)]
        }
    }

    private enum HandlerError: Error { case badMessage }
}
